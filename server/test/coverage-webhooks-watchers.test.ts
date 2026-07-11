/**
 * coverage-webhooks-watchers.test.ts
 *
 * Closes audit gaps for:
 *  - Webhook delivery integration (success, non-2xx retry, DLQ, 410, SSRF, runExpiryTick with callback_url)
 *  - Per-project webhook secret fallback to instance-level secret
 *  - minWatcherIntervalSec tier limit — never enforced (HIGH BUG, tests document desired behavior)
 *  - watcherLimitReached billing bypass via pause/create/reactivate (HIGH BUG)
 *  - Scope enforcement with limited-scope keys
 *  - Key revocation effectiveness
 *  - Decision on non-pending actions (expired, rejected)
 *  - Edited fields beyond preview.body silently ignored (MEDIUM BUG)
 *  - Cross-project idempotency isolation
 *  - Admin stats endpoint
 *  - Route-level rate limiting (actions and watchers)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDb, genId, nowSec } from '../src/db.js';
import { bootstrapAdminKey, createProjectWithAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import {
  deliverWebhook,
  scheduleWebhookDelivery,
  runWebhookTick,
  runExpiryTick,
} from '../src/webhooks.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

// Helper: insert an action row without going through auth/routes
function seedAction(
  db: ReturnType<typeof createDb>,
  projectId: string,
  opts: { status?: string; callbackUrl?: string | null } = {},
): string {
  const id = genId('act_');
  const now = nowSec();
  db.prepare(`
    INSERT INTO actions
      (id, project_id, kind, title, preview, editable, status, preview_hash,
       created_at, updated_at, callback_url)
    VALUES (?, ?, 'test', 'Seed action', '{"format":"plain","body":"b"}', '[]', ?, 'h', ?, ?, ?)
  `).run(id, projectId, opts.status ?? 'approved', now, now, opts.callbackUrl ?? null);
  return id;
}

// ---------------------------------------------------------------------------
// Webhook delivery integration
// ---------------------------------------------------------------------------

describe('deliverWebhook — success path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('marks delivery as "delivered" with last_status_code on 2xx response', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    const actionId = seedAction(db, projectId, { callbackUrl: 'http://1.2.3.4/cb' });
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');
    const { id: deliveryId } = db.prepare(
      'SELECT id FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { id: string };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 }),
    );

    const result = await deliverWebhook(
      db, deliveryId, 'http://1.2.3.4/cb',
      { event: 'action.updated', action_id: actionId, status: 'approved' },
      'test-secret',
    );

    const row = db.prepare(
      'SELECT status, last_status_code FROM webhook_deliveries WHERE id = ?',
    ).get(deliveryId) as { status: string; last_status_code: number };
    expect(result).toBe(true);
    expect(row.status).toBe('delivered');
    expect(row.last_status_code).toBe(200);
  });
});

describe('deliverWebhook — non-2xx retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('sets status="retry" and increments attempt on non-2xx response', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    const actionId = seedAction(db, projectId);
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');
    const { id: deliveryId } = db.prepare(
      'SELECT id FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { id: string };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('error', { status: 500 }),
    );

    const result = await deliverWebhook(
      db, deliveryId, 'http://1.2.3.4/cb',
      { event: 'action.updated', action_id: actionId, status: 'approved' },
      'test-secret',
    );

    const row = db.prepare(
      'SELECT status, attempt, next_attempt_at FROM webhook_deliveries WHERE id = ?',
    ).get(deliveryId) as { status: string; attempt: number; next_attempt_at: number };
    expect(result).toBe(false);
    expect(row.status).toBe('retry');
    expect(row.attempt).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThan(nowSec());
  });
});

describe('deliverWebhook — DLQ after exhausted retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('moves delivery to DLQ when attempt count reaches the retry limit (5 delays + 1)', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    const actionId = seedAction(db, projectId);
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');
    const { id: deliveryId } = db.prepare(
      'SELECT id FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { id: string };

    // Simulate already at the last retry: attempt = 5 (= RETRY_DELAYS.length)
    db.prepare("UPDATE webhook_deliveries SET attempt = 5 WHERE id = ?").run(deliveryId);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('server down', { status: 503 }),
    );

    const result = await deliverWebhook(
      db, deliveryId, 'http://1.2.3.4/cb',
      { event: 'action.updated', action_id: actionId, status: 'approved' },
      'test-secret',
    );

    const row = db.prepare(
      'SELECT status, attempt FROM webhook_deliveries WHERE id = ?',
    ).get(deliveryId) as { status: string; attempt: number };
    expect(result).toBe(false);
    expect(row.status).toBe('dlq');
    expect(row.attempt).toBe(6);
  });
});

describe('deliverWebhook — HTTP 410 deregisters callback_url', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('sets status="gone" and nulls the action callback_url on 410 response', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    const actionId = seedAction(db, projectId, { callbackUrl: 'http://1.2.3.4/cb' });
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');
    const { id: deliveryId } = db.prepare(
      'SELECT id FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { id: string };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('gone', { status: 410 }),
    );

    await deliverWebhook(
      db, deliveryId, 'http://1.2.3.4/cb',
      { event: 'action.updated', action_id: actionId, status: 'approved' },
      'test-secret',
    );

    const delivery = db.prepare(
      'SELECT status FROM webhook_deliveries WHERE id = ?',
    ).get(deliveryId) as { status: string };
    expect(delivery.status).toBe('gone');

    const action = db.prepare('SELECT callback_url FROM actions WHERE id = ?').get(actionId) as { callback_url: string | null };
    expect(action.callback_url).toBeNull();
  });
});

describe('deliverWebhook — SSRF guard at delivery time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('immediately DLQs when callback_url resolves to a private address', async () => {
    const { db, projectId } = await setup();
    // Do NOT set IMPRI_ALLOW_PRIVATE_TARGETS — SSRF guard must be active

    const actionId = seedAction(db, projectId, { callbackUrl: 'http://127.0.0.1/cb' });
    scheduleWebhookDelivery(db, actionId, 'http://127.0.0.1/cb');
    const { id: deliveryId } = db.prepare(
      'SELECT id FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { id: string };

    const result = await deliverWebhook(
      db, deliveryId, 'http://127.0.0.1/cb',
      { event: 'action.updated', action_id: actionId, status: 'approved' },
      'test-secret',
    );

    const row = db.prepare(
      'SELECT status, last_error FROM webhook_deliveries WHERE id = ?',
    ).get(deliveryId) as { status: string; last_error: string };
    expect(result).toBe(false);
    expect(row.status).toBe('dlq');
    expect(row.last_error).toMatch(/SSRF blocked/i);
  });
});

describe('runExpiryTick — schedules and delivers webhook on expiry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('schedules a webhook delivery row AND delivers it in the same tick', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    const actionId = seedAction(db, projectId, {
      status: 'pending',
      callbackUrl: 'http://1.2.3.4/cb',
    });
    // Backdate expires_at so the tick picks it up
    db.prepare('UPDATE actions SET expires_at = ? WHERE id = ?').run(nowSec() - 1, actionId);

    await runExpiryTick(db, 'test-secret');

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('expired');

    // Delivery row must exist and be in delivered state
    const delivery = db.prepare(
      'SELECT status FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { status: string } | undefined;
    expect(delivery).toBeTruthy();
    expect(delivery!.status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// Webhook per-project secret / fallback
// ---------------------------------------------------------------------------

describe('runWebhookTick — per-project secret and fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IMPRI_ALLOW_PRIVATE_TARGETS;
  });

  it('delivers successfully when project has its own webhook_secret', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    db.prepare('UPDATE projects SET webhook_secret = ? WHERE id = ?').run('proj-secret-xyz', projectId);

    const actionId = seedAction(db, projectId);
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 }),
    );

    await runWebhookTick(db, 'instance-fallback-secret');

    const delivery = db.prepare(
      'SELECT status FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { status: string };
    expect(delivery.status).toBe('delivered');
  });

  it('falls back to instance WEBHOOK_SECRET when project webhook_secret is NULL', async () => {
    const { db, projectId } = await setup();
    process.env.IMPRI_ALLOW_PRIVATE_TARGETS = '1';

    // Clear the per-project secret (simulates pre-per-project-secret migration)
    db.prepare('UPDATE projects SET webhook_secret = NULL WHERE id = ?').run(projectId);

    const actionId = seedAction(db, projectId);
    scheduleWebhookDelivery(db, actionId, 'http://1.2.3.4/cb');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 }),
    );

    // Should not throw — fallback secret is used instead of null
    await expect(runWebhookTick(db, 'fallback-instance-secret')).resolves.toBeUndefined();

    const delivery = db.prepare(
      'SELECT status FROM webhook_deliveries WHERE action_id = ?',
    ).get(actionId) as { status: string };
    expect(delivery.status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// minWatcherIntervalSec tier enforcement (HIGH BUG — tests assert desired behavior)
// ---------------------------------------------------------------------------

describe('watcher interval tier enforcement', () => {
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  /**
   * BUG: routes/watchers.ts POST /v1/watchers does not enforce
   * TIER_LIMITS[tier].minWatcherIntervalSec. The Zod schema only enforces
   * a global 60 s minimum. A free-tier user can create a watcher with
   * schedule: { every: '1m' } and get 201, hammering external hosts 15×
   * more often than the tier allows.
   *
   * These tests assert the DESIRED behavior. They will FAIL until the bug
   * is fixed in routes/watchers.ts.
   */
  it('rejects a free-tier watcher whose schedule is below the tier minimum (900 s)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: {
        name: 'Too-frequent watcher',
        kind: 'rss',
        config: { url: 'https://example.com/feed.xml' },
        // 60 s < 900 s (free-tier minWatcherIntervalSec)
        schedule: { every: '1m' },
      },
    });
    // BUG: currently returns 201; correct behavior: 402 (tier limit exceeded)
    expect(res.statusCode).toBe(402);
  });

  it('rejects PATCH that changes schedule below the tier minimum', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    // Create watcher at acceptable interval (1 800 s ≥ 900 s free minimum)
    const created = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: {
        name: 'Interval test', kind: 'rss',
        config: { url: 'https://example.com/feed.xml' },
        schedule: { every: '30m' },
      },
    });
    // Skip the rest of the test if creation was itself blocked (after a fix)
    if (created.statusCode !== 201) return;
    const { id } = created.json();

    const patch = await app.inject({
      method: 'PATCH', url: `/v1/watchers/${id}`, headers: auth(adminKey),
      payload: { schedule: { every: '1m' } }, // 60 s < 900 s minimum
    });
    // BUG: currently returns 200; correct behavior: 402
    expect(patch.statusCode).toBe(402);
  });
});

// ---------------------------------------------------------------------------
// watcherLimitReached billing bypass (HIGH BUG)
// ---------------------------------------------------------------------------

describe('watcher limit — pause/create/reactivate billing bypass', () => {
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  const makeWatcher = (app: Awaited<ReturnType<typeof setup>>['app'], key: string, n: number) =>
    app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(key),
      payload: {
        name: `w${n}`, kind: 'rss',
        config: { url: 'https://example.com/f.xml' },
        schedule: { every: '30m' },
      },
    });

  it('paused watchers do not count toward the active-watcher limit', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    // Fill the free-tier limit (3 active)
    for (let i = 0; i < 3; i++) {
      expect((await makeWatcher(app, adminKey, i)).statusCode).toBe(201);
    }
    // 4th is blocked
    expect((await makeWatcher(app, adminKey, 3)).statusCode).toBe(402);

    // Pause all 3 — now the active count is 0
    const list = await app.inject({ method: 'GET', url: '/v1/watchers', headers: auth(adminKey) });
    for (const w of list.json().items) {
      await app.inject({
        method: 'PATCH', url: `/v1/watchers/${w.id}`, headers: auth(adminKey),
        payload: { status: 'paused' },
      });
    }

    // With 0 active watchers the limit check allows another creation
    const extra = await makeWatcher(app, adminKey, 99);
    expect(extra.statusCode).toBe(201);
  });

  /**
   * BUG: PATCH /v1/watchers/:id does not check watcherLimitReached when
   * changing status to 'active'. A user who has 3 active watchers can insert
   * a 4th as 'paused' (or via the exploit above) and then reactivate it via
   * PATCH, bypassing the 402 gate.
   *
   * This test asserts the DESIRED behavior (will FAIL until bug is fixed).
   */
  it('PATCH status=active is blocked (402) when project is already at the watcher limit', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();

    // Fill to the free-tier limit (3 active)
    for (let i = 0; i < 3; i++) {
      expect((await makeWatcher(app, adminKey, i)).statusCode).toBe(201);
    }

    // Insert a 4th watcher directly as 'paused' (bypasses route limit check)
    const extraId = genId('wat_');
    const now = nowSec();
    db.prepare(`
      INSERT INTO watchers
        (id, project_id, name, kind, config, keywords, keywords_none, min_score,
         schedule, status, fail_count, first_run_done, next_run_at, created_at, updated_at)
      VALUES (?, ?, 'extra', 'rss', '{"url":"https://x.com/f.xml"}', '[]', '[]', 0,
              '{"every":"1h"}', 'paused', 0, 0, ?, ?, ?)
    `).run(extraId, projectId, now, now, now);

    // Reactivate the paused watcher — project already has 3 active
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/watchers/${extraId}`, headers: auth(adminKey),
      payload: { status: 'active' },
    });
    // BUG: currently returns 200; correct behavior: 402
    expect(patch.statusCode).toBe(402);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement with limited-scope keys
// ---------------------------------------------------------------------------

describe('scope enforcement — limited-scope keys', () => {
  it('actions-scoped key is blocked from /v1/keys, /v1/project, /v1/billing', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'actions-only', scopes: ['actions'] },
    });
    expect(created.statusCode).toBe(201);
    const actionsKey = created.json().key as string;

    // Key-management routes require admin scope
    expect((await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(actionsKey) })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(actionsKey),
      payload: { name: 'k', scopes: ['actions'] },
    })).statusCode).toBe(403);

    // Project / billing routes require admin scope
    expect((await app.inject({ method: 'GET', url: '/v1/project', headers: auth(actionsKey) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/v1/project', headers: auth(actionsKey), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/billing', headers: auth(actionsKey) })).statusCode).toBe(403);
  });

  it('watch-scoped key cannot POST or GET actions', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'watch-only', scopes: ['watch'] },
    });
    const watchKey = created.json().key as string;

    expect((await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(watchKey),
      payload: { kind: 'x', title: 'T', preview: { format: 'plain', body: 'b' } },
    })).statusCode).toBe(403);

    expect((await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(watchKey) })).statusCode).toBe(403);
  });

  it('admin-scoped key is accepted by all route-level scope checks', async () => {
    const { app, adminKey } = await setup();

    expect((await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(adminKey) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/project', headers: auth(adminKey) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/billing', headers: auth(adminKey) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/watchers', headers: auth(adminKey) })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'admin.scope', title: 'T', preview: { format: 'plain', body: 'b' } },
    })).statusCode).toBe(201);
  });

  it('watch-scoped key gets 404 (not data leak) when accessing a watcher from another project', async () => {
    const db = createDb(':memory:');
    const bootA = await createProjectWithAdminKey(db, 'Project A');
    const bootB = await createProjectWithAdminKey(db, 'Project B');
    const app = await createApp(db);
    await app.ready();

    // Project B creates a watcher
    const wRes = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(bootB.key),
      payload: { name: 'B watcher', kind: 'rss', config: { url: 'https://example.com/feed.xml' }, schedule: { every: '30m' } },
    });
    const watcherId = wRes.json().id as string;

    // Project A cannot see project B's watcher — must return 404
    const res = await app.inject({
      method: 'GET', url: `/v1/watchers/${watcherId}`, headers: auth(bootA.key),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Key revocation
// ---------------------------------------------------------------------------

describe('key revocation', () => {
  it('a revoked key is rejected with 401 on the next request', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'revoke-me', scopes: ['actions'] },
    });
    const { id: keyId, key: newKey } = created.json();

    // Verify it works before revocation
    expect((await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(newKey) })).statusCode).toBe(200);

    // Revoke
    expect((await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) })).statusCode).toBe(204);

    // Revoked key must be rejected
    expect((await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(newKey) })).statusCode).toBe(401);
  });

  it('DELETE on an already-revoked key returns 404', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'double-revoke', scopes: ['actions'] },
    });
    const { id: keyId } = created.json();

    await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });
    const second = await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });
    expect(second.statusCode).toBe(404);
  });

  it('GET /v1/keys shows revoked keys with revoked:true', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'show-revoked', scopes: ['actions'] },
    });
    const { id: keyId } = created.json();

    await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });

    const list = await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(adminKey) });
    const items = list.json().items as Array<{ id: string; revoked: boolean }>;
    const revokedKey = items.find(k => k.id === keyId);
    expect(revokedKey).toBeDefined();
    expect(revokedKey!.revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision on non-pending actions
// ---------------------------------------------------------------------------

describe('decision on non-pending actions', () => {
  const validAction = { kind: 'state.test', title: 'State test', preview: { format: 'plain', body: 'b' } };

  it('returns 409 with current_status="expired" when deciding on an expired action', async () => {
    const { app, adminKey, db } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: validAction,
    });
    const { id } = created.json();
    db.prepare("UPDATE actions SET status = 'expired' WHERE id = ?").run(id);

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('expired');
  });

  it('returns 409 with current_status="rejected" when deciding on an already-rejected action', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: validAction,
    });
    const { id } = created.json();

    await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'reject' },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('rejected');
  });

  it('returns 409 when reporting a result on a rejected action', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: validAction,
    });
    const { id } = created.json();
    await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'reject' },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/result`, headers: auth(adminKey),
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 409 when reporting a result on an expired action', async () => {
    const { app, adminKey, db } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload: validAction,
    });
    const { id } = created.json();
    db.prepare("UPDATE actions SET status = 'expired' WHERE id = ?").run(id);

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/result`, headers: auth(adminKey),
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Edited fields beyond preview.body (MEDIUM BUG)
// ---------------------------------------------------------------------------

describe('edited fields beyond "preview.body" in decision', () => {
  /**
   * BUG (routes/actions.ts lines 304-313): the for-loop over edited fields
   * only applies changes when field === 'preview.body'. Any other field in
   * the editable whitelist (e.g. 'payload.amount') passes the 422 whitelist
   * check but is silently discarded.
   *
   * An agent that specifies editable: ['payload.amount'] and a human edits
   * it will receive a 200 response, but the payload in the DB is never
   * updated — the agent proceeds with the original value.
   *
   * This test asserts the DESIRED behavior (will FAIL until bug is fixed).
   */
  it('payload.amount edit is reflected in the action payload after approval', async () => {
    const { app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'payment',
        title: 'Approve payment',
        preview: { format: 'plain', body: 'Pay $100' },
        payload: { amount: 100, currency: 'USD' },
        editable: ['payload.amount'],
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const decision = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve', edited: { 'payload.amount': 42 } },
    });
    // No 422 — 'payload.amount' is in the editable whitelist
    expect(decision.statusCode).toBe(200);

    // BUG: after the decision, payload.amount should be 42 but is still 100.
    // The GET endpoint returns payload from the DB (never updated).
    const get = await app.inject({
      method: 'GET', url: `/v1/actions/${id}`, headers: auth(adminKey),
    });
    expect(get.statusCode).toBe(200);
    // This assertion FAILS currently (bug): amount is still 100, not 42
    expect(get.json().payload.amount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Cross-project idempotency isolation
// ---------------------------------------------------------------------------

describe('cross-project idempotency isolation', () => {
  it('same idempotency_key string in two projects creates two separate actions', async () => {
    const db = createDb(':memory:');
    const bootA = await createProjectWithAdminKey(db, 'Project A');
    const bootB = await createProjectWithAdminKey(db, 'Project B');
    const app = await createApp(db);
    await app.ready();

    const payload = {
      kind: 'idem.cross',
      title: 'Cross-project idem',
      preview: { format: 'plain', body: 'same body' },
      idempotency_key: 'shared-key-001',
    };

    const res1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(bootA.key), payload,
    });
    const res2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(bootB.key), payload,
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res1.json().id).not.toBe(res2.json().id);
  });
});

// ---------------------------------------------------------------------------
// Admin stats endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/admin/stats', () => {
  afterEach(() => {
    delete process.env.OPERATOR_PROJECT_ID;
  });

  it('returns 404 when OPERATOR_PROJECT_ID is not set', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(adminKey) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the caller is not the operator project (even with valid admin key)', async () => {
    const db = createDb(':memory:');
    const operator = await createProjectWithAdminKey(db, 'Operator');
    const other = await createProjectWithAdminKey(db, 'Other');
    const app = await createApp(db);
    await app.ready();

    process.env.OPERATOR_PROJECT_ID = operator.projectId;

    // Other project's admin key cannot access stats
    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(other.key) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with correct stats shape for the operator project', async () => {
    const { app, adminKey, projectId } = await setup();
    process.env.OPERATOR_PROJECT_ID = projectId;

    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(adminKey) });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(typeof b.signups.total).toBe('number');
    expect(typeof b.signups.last_24h).toBe('number');
    expect(typeof b.signups.last_7d).toBe('number');
    expect(typeof b.signups.last_30d).toBe('number');
    expect(typeof b.by_tier).toBe('object');
    expect(typeof b.paid).toBe('number');
    expect(typeof b.activity.actions_total).toBe('number');
    expect(typeof b.activity.actions_7d).toBe('number');
    expect(typeof b.activity.watchers).toBe('number');
    expect(typeof b.ts).toBe('number');
  });

  it('returns 404 when a non-admin scoped key of the operator project calls it', async () => {
    const { app, adminKey, projectId } = await setup();
    process.env.OPERATOR_PROJECT_ID = projectId;

    // Create a limited-scope key for the operator project
    const created = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(adminKey),
      payload: { name: 'limited', scopes: ['actions'] },
    });
    const limitedKey = created.json().key as string;

    // Stats endpoint returns 404 (hidden), not 403, for non-admin scopes
    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(limitedKey) });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route-level rate limiting (pre-seed the counter to avoid argon2 loops)
// ---------------------------------------------------------------------------

describe('route-level rate limiting', () => {
  // Extract the api_key id so we can pre-seed the rate_limits table
  function keyId(db: ReturnType<typeof createDb>, rawKey: string): string {
    const prefix = rawKey.slice(0, 16);
    const row = db.prepare('SELECT id FROM api_keys WHERE key_prefix = ?').get(prefix) as { id: string };
    return row.id;
  }

  function windowStart(): number {
    return Math.floor(nowSec() / 60) * 60;
  }

  it('POST /v1/actions returns 429 when the per-key 60/min limit is reached', async () => {
    const { db, app, adminKey } = await setup();

    // Pre-seed rate_limits at the limit (60) for the actions:create route
    db.prepare(
      'INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, ?)',
    ).run(keyId(db, adminKey), 'actions:create', windowStart(), 60);

    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'rl.act', title: 'RL action', preview: { format: 'plain', body: 'b' } },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('Too Many Requests');
  });

  it('POST /v1/watchers returns 429 when the per-key 30/min limit is reached', async () => {
    const { db, app, adminKey } = await setup();

    db.prepare(
      'INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, ?)',
    ).run(keyId(db, adminKey), 'watchers:create', windowStart(), 30);

    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: {
        name: 'rl-watcher', kind: 'rss',
        config: { url: 'https://example.com/feed.xml' },
        schedule: { every: '30m' },
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('Too Many Requests');
  });

  it('POST /v1/actions/:id/decision returns 429 when the per-key 60/min limit is reached', async () => {
    const { db, app, adminKey } = await setup();

    // Create a pending action to decide on
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'rl.dec', title: 'RL decide', preview: { format: 'plain', body: 'b' } },
    });
    const { id } = created.json();

    // Pre-seed the decision rate limit
    db.prepare(
      'INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, ?)',
    ).run(keyId(db, adminKey), 'actions:decide', windowStart(), 60);

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('Too Many Requests');
  });

  it('GET /v1/actions returns 429 when the per-key 300/min list limit is reached', async () => {
    const { db, app, adminKey } = await setup();

    db.prepare(
      'INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, ?)',
    ).run(keyId(db, adminKey), 'actions:list', windowStart(), 300);

    const res = await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(adminKey) });
    expect(res.statusCode).toBe(429);
  });
});
