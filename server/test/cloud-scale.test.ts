import { describe, it, expect, afterEach, vi } from 'vitest';
import webpush from 'web-push';
import { createDb, genId, nowSec } from '../src/db.js';
import { fetchGuarded } from '../src/net-guard.js';
import { notifyPush } from '../src/push.js';
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

describe('fetchGuarded SSRF / DNS-rebind protection', () => {
  afterEach(() => { delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS; });

  it('rejects non-http(s) schemes', async () => {
    await expect(fetchGuarded('ftp://example.com/x')).rejects.toThrow(/http/i);
  });

  it('rejects literal private IPs before connecting', async () => {
    await expect(fetchGuarded('http://127.0.0.1:1/')).rejects.toThrow(/private/i);
    await expect(fetchGuarded('http://169.254.169.254/latest/')).rejects.toThrow(/private/i);
    await expect(fetchGuarded('http://10.0.0.1/')).rejects.toThrow(/private/i);
  });

  it('rejects hostnames that resolve to loopback (pin blocks at connect)', async () => {
    await expect(fetchGuarded('http://localhost:1/')).rejects.toThrow();
  });
});

describe('web push', () => {
  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    vi.restoreAllMocks();
  });

  it('is disabled without VAPID keys', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    expect(res.json().enabled).toBe(false);
    expect(res.json().public_key).toBeNull();
  });

  it('subscribe is rejected when push is disabled', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/push/subscribe', headers: auth(adminKey),
      payload: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exposes the key and stores a subscription when enabled', async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const { db, app, adminKey } = await setup();

    const pk = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    expect(pk.json().enabled).toBe(true);
    expect(pk.json().public_key).toBe(keys.publicKey);

    const res = await app.inject({
      method: 'POST', url: '/v1/push/subscribe', headers: auth(adminKey),
      payload: { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(res.statusCode).toBe(201);
    expect((db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get() as { c: number }).c).toBe(1);
  });

  it('notifyPush prunes dead (410) subscriptions', async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const { db, projectId } = await setup();
    db.prepare('INSERT INTO push_subscriptions (id, project_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)')
      .run(genId('push_'), projectId, 'https://push.example.com/dead', 'p', 'a', nowSec());

    vi.spyOn(webpush, 'sendNotification').mockRejectedValue({ statusCode: 410 });
    await notifyPush(db, projectId, { title: 't', body: 'b', url: 'https://x/inbox' });

    expect((db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get() as { c: number }).c).toBe(0);
  });

  it('notifyPush is a no-op when push is disabled', async () => {
    const { db, projectId } = await setup();
    await expect(notifyPush(db, projectId, { title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});
