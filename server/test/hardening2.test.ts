import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { checkRateLimit } from '../src/auth.js';
// checkRateLimit is async (may hit Redis); tests below await it.
import { isInWindow } from '../src/scheduler.js';
import { checkRobots } from '../src/robots.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}
const auth = (k: string) => ({ Authorization: `Bearer ${k}` });
const validAction = { kind: 'test', title: 'Hi', preview: { format: 'plain', body: 'b' } };

describe('persistent rate limiter', () => {
  it('blocks after the limit and persists in the db', async () => {
    const db = createDb(':memory:');
    expect(await checkRateLimit(db, 'k1', 'r', 3)).toBe(true);
    expect(await checkRateLimit(db, 'k1', 'r', 3)).toBe(true);
    expect(await checkRateLimit(db, 'k1', 'r', 3)).toBe(true);
    expect(await checkRateLimit(db, 'k1', 'r', 3)).toBe(false); // 4th over limit 3
    // A different key/route is independent
    expect(await checkRateLimit(db, 'k2', 'r', 3)).toBe(true);
    const row = db.prepare('SELECT count FROM rate_limits WHERE key_id = ? AND route = ?').get('k1', 'r') as { count: number };
    expect(row.count).toBeGreaterThanOrEqual(3);
  });
});

describe('isInWindow timezone awareness (DST-correct)', () => {
  it('interprets the window in the given IANA zone, not UTC', () => {
    // 2026-01-01 23:30 UTC = 18:30 in New York (EST, UTC-5)
    const ms = Date.UTC(2026, 0, 1, 23, 30);
    expect(isInWindow('06:00-22:00', ms, 'UTC')).toBe(false);          // 23:30 UTC outside
    expect(isInWindow('06:00-22:00', ms, 'America/New_York')).toBe(true); // 18:30 local inside
  });
});

describe('robots.txt pure check', () => {
  it('allows unmatched paths and blocks disallowed ones', () => {
    const txt = 'User-agent: *\nDisallow: /private';
    expect(checkRobots('https://x/robots.txt', txt, 'https://x/public', 'Impri-Watcher')).toBe(true);
    expect(checkRobots('https://x/robots.txt', txt, 'https://x/private/p', 'Impri-Watcher')).toBe(false);
  });
});

describe('per-project webhook secret', () => {
  it('is exposed to admin and can be rotated', async () => {
    const { app, adminKey } = await setup();
    const first = await app.inject({ method: 'GET', url: '/v1/project', headers: auth(adminKey) });
    expect(first.statusCode).toBe(200);
    const secret1 = first.json().webhook_secret as string;
    expect(secret1).toBeTruthy();

    const rotated = await app.inject({ method: 'POST', url: '/v1/project/rotate-webhook-secret', headers: auth(adminKey) });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().webhook_secret).not.toBe(secret1);
  });
});

describe('project timezone', () => {
  it('accepts a valid IANA zone and rejects garbage', async () => {
    const { app, adminKey } = await setup();
    const ok = await app.inject({ method: 'PATCH', url: '/v1/project', headers: auth(adminKey), payload: { timezone: 'Europe/Prague' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().timezone).toBe('Europe/Prague');

    const bad = await app.inject({ method: 'PATCH', url: '/v1/project', headers: auth(adminKey), payload: { timezone: 'Mars/Olympus' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GDPR export and erasure', () => {
  it('exports project-scoped data and erases it', async () => {
    const { app, adminKey } = await setup();
    await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: validAction });

    const exp = await app.inject({ method: 'GET', url: '/v1/project/export', headers: auth(adminKey) });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().actions.length).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: '/v1/project/data', headers: auth(adminKey) });
    expect(del.statusCode).toBe(200);
    expect(del.json().actions).toBe(1);

    const after = await app.inject({ method: 'GET', url: '/v1/project/export', headers: auth(adminKey) });
    expect(after.json().actions.length).toBe(0);
  });
});

describe('watcher serialization surfaces degraded diagnostics', () => {
  it('returns last_error so the UI can show why a watcher degraded', async () => {
    const { db, app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: { name: 'w', kind: 'rss', config: { url: 'https://example.com/feed.xml' }, schedule: { every: '30m' } },
    });
    const id = created.json().id as string;
    db.prepare("UPDATE watchers SET status = 'degraded', last_error = ? WHERE id = ?").run('Connection refused', id);

    const got = await app.inject({ method: 'GET', url: `/v1/watchers/${id}`, headers: auth(adminKey) });
    expect(got.json().last_error).toBe('Connection refused');
  });
});

describe('composite cursor pagination', () => {
  it('walks all actions with no dupes even within the same second', async () => {
    const { app, adminKey } = await setup();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: { ...validAction, title: `A${i}` } });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `/v1/actions?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: auth(adminKey) });
      const body = res.json();
      for (const item of body.items) seen.add(item.id);
      if (!body.has_more) break;
      cursor = body.next_cursor;
    }
    expect(seen.size).toBe(3);
  });
});
