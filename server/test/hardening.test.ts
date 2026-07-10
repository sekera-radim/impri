import { describe, it, expect } from 'vitest';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { runExpiryTick } from '../src/webhooks.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

const validAction = {
  kind: 'test',
  title: 'Hello',
  preview: { format: 'plain', body: 'body' },
};

describe('action input hardening', () => {
  it('rejects javascript: target_url (XSS sink)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...validAction, target_url: 'javascript:alert(document.cookie)' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects file:// callback_url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...validAction, callback_url: 'file:///etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects title with newline (header injection)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...validAction, title: 'Normal\r\nX-Injected: yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a clean https target_url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...validAction, target_url: 'https://reddit.com/r/x' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('watcher input hardening', () => {
  it('rejects "0m" interval (min 60s)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: {
        name: 'w', kind: 'rss', config: { url: 'https://example.com/feed.xml' },
        schedule: { every: '0m' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects private-IP literal source URL', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: {
        name: 'w', kind: 'rss', config: { url: 'http://10.0.0.1/feed.xml' },
        schedule: { every: '30m' },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('key creation cannot target another project', () => {
  it('ignores client-supplied project_id', async () => {
    const { app, adminKey, projectId } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'k', scopes: ['actions'], project_id: 'proj_someone_else' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().project_id).toBe(projectId);
  });
});

describe('expiry does not clobber a decided action (TOCTOU)', () => {
  it('leaves an approved action approved even when past its expiry', async () => {
    const { db, app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...validAction, expires_in: 300 },
    });
    const id = created.json().id as string;

    const decided = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(200);

    // Force the action past its expiry, then run the expiry tick.
    db.prepare('UPDATE actions SET expires_at = ? WHERE id = ?').run(nowSec() - 10, id);
    await runExpiryTick(db, 'test-secret');

    const row = db.prepare('SELECT status FROM actions WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('approved');
  });
});
