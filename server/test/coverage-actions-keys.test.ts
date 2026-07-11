/**
 * coverage-actions-keys.test.ts
 *
 * Covers the highest-priority gaps related to:
 *  - Auth scope enforcement (limited-scope keys)
 *  - Key CRUD and revocation effectiveness
 *  - Decision on non-pending actions (expired, rejected)
 *  - Result reporting on non-approved actions
 *  - Edited-field payload bug (silently ignored — see BUG comment)
 *  - Approvals tier limit at the HTTP level
 *  - Global signup cap (503)
 *  - Admin stats endpoint
 *  - Cross-project idempotency isolation
 *
 * Run: cd server && npm test -- coverage-actions-keys
 *
 * KNOWN FAILING TEST (documents a bug in server/src/routes/actions.ts):
 *   "edited payload.amount passes whitelist but is silently ignored"
 *   The for-loop at lines 304-313 only handles 'preview.body'; any other
 *   whitelisted field passes the 422 check but is never written to the DB.
 *   Expected fix: extend the loop to apply payload dot-path edits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createDb, genId, nowSec } from '../src/db.js';
import { bootstrapAdminKey, createProjectWithAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { runExpiryTick } from '../src/webhooks.js';
import { monthStartSec } from '../src/billing.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

/** Create a limited-scope key via the API; returns the raw key string. */
async function createScopedKey(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  scopes: string[],
  name = 'test-key',
): Promise<{ key: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/keys',
    headers: auth(adminKey),
    payload: { name, scopes },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createScopedKey failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  return { key: body.key as string, id: body.id as string };
}

/** Seed n decisions in the CURRENT calendar month. */
function seedDecisionsThisMonth(
  db: ReturnType<typeof createDb>,
  projectId: string,
  n: number,
): void {
  const now = nowSec();
  const decidedAt = monthStartSec() + 1; // safely within this month
  for (let i = 0; i < n; i++) {
    const aid = genId('act_');
    db.prepare(
      `INSERT INTO actions
         (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
       VALUES (?, ?, 'test', 'title', '{}', '[]', 'approved', 'h', ?, ?)`,
    ).run(aid, projectId, now, now);
    db.prepare(
      `INSERT INTO decisions (id, action_id, verdict, decided_at) VALUES (?, ?, 'approve', ?)`,
    ).run(genId('dec_'), aid, decidedAt);
  }
}

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.ALLOW_SIGNUP;
  delete process.env.OPERATOR_PROJECT_ID;
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('Scope enforcement — limited-scope keys', () => {
  it('actions-scoped key cannot reach GET /v1/keys (requires admin)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['actions'], 'actions-only');
    const res = await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(key) });
    expect(res.statusCode).toBe(403);
  });

  it('actions-scoped key cannot reach POST /v1/keys (requires admin)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['actions'], 'actions-only');
    const res = await app.inject({
      method: 'POST', url: '/v1/keys', headers: auth(key),
      payload: { name: 'evil', scopes: ['admin'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('actions-scoped key cannot reach GET /v1/project (requires admin)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['actions'], 'actions-only');
    const res = await app.inject({ method: 'GET', url: '/v1/project', headers: auth(key) });
    expect(res.statusCode).toBe(403);
  });

  it('actions-scoped key cannot reach PATCH /v1/project (requires admin)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['actions'], 'actions-only');
    const res = await app.inject({
      method: 'PATCH', url: '/v1/project', headers: auth(key),
      payload: { name: 'hacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('actions-scoped key cannot reach GET /v1/billing (requires admin)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['actions'], 'actions-only');
    const res = await app.inject({ method: 'GET', url: '/v1/billing', headers: auth(key) });
    expect(res.statusCode).toBe(403);
  });

  it('watch-scoped key cannot create actions (POST /v1/actions requires actions scope)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['watch'], 'watch-only');
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(key),
      payload: { kind: 'test', title: 'hi', preview: { format: 'plain', body: 'b' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('watch-scoped key cannot list actions (GET /v1/actions requires actions scope)', async () => {
    const { app, adminKey } = await setup();
    const { key } = await createScopedKey(app, adminKey, ['watch'], 'watch-only');
    const res = await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(key) });
    expect(res.statusCode).toBe(403);
  });

  it('watch-scoped key cannot decide actions (POST /v1/actions/:id/decision requires actions scope)', async () => {
    const { app, adminKey } = await setup();
    // Create an action with the admin key first
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'test', title: 'decide me', preview: { format: 'plain', body: 'b' } },
    });
    const { id } = created.json();

    const { key: watchKey } = await createScopedKey(app, adminKey, ['watch'], 'watch-only');
    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(watchKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin scope is super-scope and passes all scope checks', async () => {
    const { app, adminKey } = await setup();
    // admin key created in setup already has ['admin'] scope

    // Can access action routes (hasScope checks 'actions')
    const actions = await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(adminKey) });
    expect(actions.statusCode).toBe(200);

    // Can access watcher routes (hasScope checks 'watch')
    const watchers = await app.inject({ method: 'GET', url: '/v1/watchers', headers: auth(adminKey) });
    expect(watchers.statusCode).toBe(200);

    // Can access key management routes (hasScope checks 'admin')
    const keys = await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(adminKey) });
    expect(keys.statusCode).toBe(200);
  });

  it('watch-scoped key gets 404 (not data leak) when accessing another project watcher', async () => {
    const { db, app, adminKey } = await setup();

    // Create a watcher in project 1 (the bootstrap project)
    const wRes = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: { name: 'secret', kind: 'rss', config: { url: 'https://example.com/feed.xml' }, schedule: { every: '30m' } },
    });
    const watcherId = wRes.json().id as string;

    // Create a second project and get a watch-scoped key for it
    const project2 = await createProjectWithAdminKey(db, 'Project 2');
    const { key: watchKey2 } = await createScopedKey(app, project2.key, ['watch'], 'proj2-watch');

    // project2's watch key must NOT see project1's watcher — 404, not 200 or 403
    const res = await app.inject({
      method: 'GET',
      url: `/v1/watchers/${watcherId}`,
      headers: auth(watchKey2),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key CRUD and revocation
// ─────────────────────────────────────────────────────────────────────────────

describe('Key revocation', () => {
  it('revoked key returns 401 on next request (verifyApiKey filters revoked_at IS NULL)', async () => {
    const { app, adminKey } = await setup();

    // Create a new limited-scope key
    const { key: scopedKey, id: keyId } = await createScopedKey(app, adminKey, ['actions'], 'to-revoke');

    // It should work before revocation
    const before = await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(scopedKey) });
    expect(before.statusCode).toBe(200);

    // Revoke it
    const del = await app.inject({
      method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey),
    });
    expect(del.statusCode).toBe(204);

    // Now the key must be rejected
    const after = await app.inject({ method: 'GET', url: '/v1/actions', headers: auth(scopedKey) });
    expect(after.statusCode).toBe(401);
  });

  it('DELETE on an already-revoked key returns 404', async () => {
    const { app, adminKey } = await setup();
    const { id: keyId } = await createScopedKey(app, adminKey, ['actions'], 'revoke-twice');

    // First DELETE — succeeds
    const first = await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });
    expect(first.statusCode).toBe(204);

    // Second DELETE — already revoked, should 404
    const second = await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });
    expect(second.statusCode).toBe(404);
  });

  it('GET /v1/keys includes revoked:true for revoked keys', async () => {
    const { app, adminKey } = await setup();
    const { id: keyId } = await createScopedKey(app, adminKey, ['actions'], 'list-revoked');

    // Revoke the key
    await app.inject({ method: 'DELETE', url: `/v1/keys/${keyId}`, headers: auth(adminKey) });

    // List keys — revoked entry should be present with revoked:true
    const list = await app.inject({ method: 'GET', url: '/v1/keys', headers: auth(adminKey) });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ id: string; revoked: boolean }>;
    const found = items.find(k => k.id === keyId);
    expect(found).toBeDefined();
    expect(found!.revoked).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision on non-pending actions
// ─────────────────────────────────────────────────────────────────────────────

describe('Decision on non-pending actions', () => {
  it('decision on an expired action returns 409 with current_status="expired"', async () => {
    const { db, app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'exp.test', title: 'Expire me', preview: { format: 'plain', body: 'b' }, expires_in: 300 },
    });
    const { id } = created.json();

    // Force expiry
    db.prepare('UPDATE actions SET expires_at = ? WHERE id = ?').run(nowSec() - 1, id);
    await runExpiryTick(db, 'test-secret');

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('expired');
  });

  it('decision on a rejected action returns 409 with current_status="rejected"', async () => {
    const { app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'rej.test', title: 'Reject me', preview: { format: 'plain', body: 'b' } },
    });
    const { id } = created.json();

    // First decision — reject
    await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'reject' },
    });

    // Second decision attempt — must 409
    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('rejected');
  });

  it('result reporting on a pending action returns 409', async () => {
    const { app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'res.pend', title: 'Still pending', preview: { format: 'plain', body: 'b' } },
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/result`, headers: auth(adminKey),
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('pending');
  });

  it('result reporting on a rejected action returns 409', async () => {
    const { app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'res.rej', title: 'Rejected result', preview: { format: 'plain', body: 'b' } },
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
    expect(res.json().current_status).toBe('rejected');
  });

  it('result reporting on an expired action returns 409', async () => {
    const { db, app, adminKey } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'res.exp', title: 'Expired result', preview: { format: 'plain', body: 'b' }, expires_in: 300 },
    });
    const { id } = created.json();

    db.prepare('UPDATE actions SET expires_at = ? WHERE id = ?').run(nowSec() - 1, id);
    await runExpiryTick(db, 'test-secret');

    const res = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/result`, headers: auth(adminKey),
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().current_status).toBe('expired');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edited-field bug: payload edits silently ignored
// ─────────────────────────────────────────────────────────────────────────────

describe('Edited field — payload dot-path silently ignored [BUG]', () => {
  /**
   * BUG: server/src/routes/actions.ts lines 304-313
   *
   * The for-loop that applies edited fields only handles `field === 'preview.body'`.
   * Any other field that passes the 422 whitelist check (e.g., 'payload.amount') is
   * silently dropped — the payload in the DB is never updated and the agent has no
   * way to know the edit was ignored.
   *
   * This test expresses the CORRECT expected behaviour (the stored payload is
   * updated to the edited value) and will FAIL until the bug is fixed.
   */
  it('approving with edited payload.amount should update the stored payload [BUG — currently ignored]', async () => {
    const { db, app, adminKey } = await setup();

    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'pay.edit',
        title: 'Payment approval',
        preview: { format: 'plain', body: 'Approve $100 payment?' },
        payload: { amount: 100, currency: 'USD' },
        editable: ['payload.amount'],
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // Human approves and edits the amount from 100 to 42
    const decision = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve', edited: { 'payload.amount': 42 } },
    });
    // The whitelist check must not 422 (payload.amount IS in editable)
    expect(decision.statusCode).toBe(200);

    // The stored payload SHOULD reflect the human edit.
    // BUG: currently the loop never updates payload.amount, so the DB still has 100.
    const row = db.prepare('SELECT payload FROM actions WHERE id = ?').get(id) as { payload: string };
    const stored = JSON.parse(row.payload) as { amount: number };
    expect(stored.amount).toBe(42); // FAILS: still 100 due to the bug
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Approvals tier limit at HTTP level
// ─────────────────────────────────────────────────────────────────────────────

describe('Approvals tier limit — HTTP level', () => {
  it('POST /v1/actions returns 402 when monthly approvals quota is exhausted', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();

    // Seed exactly 100 decisions in the current month (free-tier limit)
    seedDecisionsThisMonth(db, projectId, 100);

    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'overlimit', title: 'Over limit', preview: { format: 'plain', body: 'b' } },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.tier).toBe('free');
    expect(body.limit).toBe(100);
  });

  it('deciding on an already-pending action is NOT blocked when approvals limit is reached', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();

    // Create 1 pending action while still under limit (99 decisions so far)
    seedDecisionsThisMonth(db, projectId, 99);
    const pendingRes = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'pre.limit', title: 'Pre-limit action', preview: { format: 'plain', body: 'b' } },
    });
    expect(pendingRes.statusCode).toBe(201);
    const { id } = pendingRes.json();

    // Push to exactly 100 (at limit)
    seedDecisionsThisMonth(db, projectId, 1);

    // Creating a new action is now blocked
    const blocked = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'new.blocked', title: 'New blocked', preview: { format: 'plain', body: 'b' } },
    });
    expect(blocked.statusCode).toBe(402);

    // But deciding on the pre-existing pending action must NOT be blocked — safety principle.
    const decide = await app.inject({
      method: 'POST', url: `/v1/actions/${id}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(decide.statusCode).toBe(200); // decision route does not call approvalsLimitReached
  });

  it('decisions from last month do not count toward this month quota', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();

    // Seed 100 decisions with decided_at in the PREVIOUS month
    const lastMonth = monthStartSec() - 1; // 1 second before this month started
    const now = nowSec();
    for (let i = 0; i < 100; i++) {
      const aid = genId('act_');
      db.prepare(
        `INSERT INTO actions
           (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
         VALUES (?, ?, 'test', 'old', '{}', '[]', 'approved', 'h', ?, ?)`,
      ).run(aid, projectId, now, now);
      db.prepare(
        `INSERT INTO decisions (id, action_id, verdict, decided_at) VALUES (?, ?, 'approve', ?)`,
      ).run(genId('dec_'), aid, lastMonth);
    }

    // Creating a new action this month should be allowed (last-month decisions don't count)
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'new.month', title: 'New month', preview: { format: 'plain', body: 'b' } },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global signup cap
// ─────────────────────────────────────────────────────────────────────────────

describe('Global signup cap — 503 when 50+ projects in last hour', () => {
  it('returns 503 when 50 or more projects were created in the last hour', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setup();

    // The fresh DB already contains 1 project (the bootstrap one). Seed 49 more
    // with created_at in the last hour so the total recent count reaches 50.
    const recentTs = nowSec() - 100; // 100 seconds ago, well within 1 hour
    for (let i = 0; i < 49; i++) {
      db.prepare(
        "INSERT INTO projects (id, name, webhook_secret, created_at) VALUES (?, ?, NULL, ?)",
      ).run(genId('proj_'), `seed-${i}`, recentTs);
    }

    const res = await app.inject({
      method: 'POST', url: '/v1/signup',
      remoteAddress: '10.99.0.1',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Service Unavailable');
  });

  it('allows signup when recent count is exactly 49 (under the 50 cap)', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setup();

    // Bootstrap project already counts. Seed 48 more → total 49 (under cap).
    const recentTs = nowSec() - 100;
    for (let i = 0; i < 48; i++) {
      db.prepare(
        "INSERT INTO projects (id, name, webhook_secret, created_at) VALUES (?, ?, NULL, ?)",
      ).run(genId('proj_'), `seed-${i}`, recentTs);
    }

    const res = await app.inject({
      method: 'POST', url: '/v1/signup',
      remoteAddress: '10.99.0.2',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('does not count projects created more than 1 hour ago toward the cap', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setup();

    // Seed 60 projects created 2 hours ago — outside the 1-hour window
    const oldTs = nowSec() - 7201; // 2 hours + 1 second ago
    for (let i = 0; i < 60; i++) {
      db.prepare(
        "INSERT INTO projects (id, name, webhook_secret, created_at) VALUES (?, ?, NULL, ?)",
      ).run(genId('proj_'), `old-${i}`, oldTs);
    }

    // Only the 1 bootstrap project is recent → well under 50
    const res = await app.inject({
      method: 'POST', url: '/v1/signup',
      remoteAddress: '10.99.0.3',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin stats endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin stats endpoint (GET /v1/admin/stats)', () => {
  it('returns 200 with expected shape when admin key belongs to OPERATOR_PROJECT_ID project', async () => {
    const { app, adminKey, projectId } = await setup();
    process.env.OPERATOR_PROJECT_ID = projectId;

    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(adminKey) });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(typeof body.signups).toBe('object');
    expect(typeof body.signups.total).toBe('number');
    expect(typeof body.signups.last_24h).toBe('number');
    expect(typeof body.signups.last_7d).toBe('number');
    expect(typeof body.signups.last_30d).toBe('number');
    expect(typeof body.by_tier).toBe('object');
    expect(typeof body.paid).toBe('number');
    expect(typeof body.activity).toBe('object');
    expect(typeof body.activity.actions_total).toBe('number');
    expect(typeof body.ts).toBe('number');
  });

  it('returns 404 when admin key belongs to a non-operator project', async () => {
    const { db, app } = await setup();

    // Create a second project and set ONLY it as the operator
    const project2 = await createProjectWithAdminKey(db, 'Project 2');
    process.env.OPERATOR_PROJECT_ID = project2.projectId;

    // The bootstrap project's admin key must not see the endpoint
    const bootstrap2 = await bootstrapAdminKey(createDb(':memory:')); // unrelated — get fresh bootstrap
    // Use project2's key — but query with a THIRD project's key (neither is operator... wait)
    // Simpler: create project3, set project2 as operator, use project3's key
    const project3 = await createProjectWithAdminKey(db, 'Project 3');
    const res = await app.inject({
      method: 'GET', url: '/v1/admin/stats',
      headers: auth(project3.key),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when no OPERATOR_PROJECT_ID is configured', async () => {
    const { app, adminKey } = await setup();
    // OPERATOR_PROJECT_ID is NOT set (afterEach cleans it)

    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(adminKey) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a non-admin scope key even on the operator project', async () => {
    const { app, adminKey, projectId } = await setup();
    process.env.OPERATOR_PROJECT_ID = projectId;

    // Create an actions-scoped key for the same (operator) project
    const { key: actionsKey } = await createScopedKey(app, adminKey, ['actions'], 'no-admin');
    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth(actionsKey) });
    // hasScope(['actions'], 'admin') is false → 404 (same as non-operator)
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-project idempotency isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-project idempotency isolation', () => {
  it('same idempotency_key in two different projects creates two separate actions', async () => {
    const { db, app, adminKey } = await setup();

    // Create a second project
    const project2 = await createProjectWithAdminKey(db, 'Project 2');

    const sharedKey = 'shared-idem-key-001';
    const payload = {
      kind: 'cross.idem',
      title: 'Cross-project idempotency test',
      preview: { format: 'plain', body: 'body' },
      idempotency_key: sharedKey,
    };

    // Project 1: POST with idempotency_key
    const res1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload,
    });
    expect(res1.statusCode).toBe(201);

    // Project 2: same idempotency_key — must create a NEW action (201), not 200
    const res2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(project2.key), payload,
    });
    expect(res2.statusCode).toBe(201);

    // The two actions must be distinct
    expect(res1.json().id).not.toBe(res2.json().id);
  });

  it('repeated POST with same key within the same project returns the existing action (200)', async () => {
    const { app, adminKey } = await setup();

    const payload = {
      kind: 'same.proj.idem',
      title: 'Same project idempotency',
      preview: { format: 'plain', body: 'body' },
      idempotency_key: 'same-proj-key-001',
    };

    const r1 = await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload });
    const r2 = await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().id).toBe(r2.json().id);
  });
});
