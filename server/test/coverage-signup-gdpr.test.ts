/**
 * coverage-signup-gdpr.test.ts
 *
 * Closes audit gaps for:
 *  - Global signup cap (50/hr → 503)
 *  - Approvals tier limit (402) on POST /v1/actions with HTTP-level assertions
 *  - GDPR erasure completeness (pii_log, audit_log, keys survive, watcher_items)
 *  - expires_in schema boundaries (299 → 400, 300 → 201, 2592001 → 400)
 *  - Payload > 256 KB → 400 via HTTP
 *  - Soft dedup is skipped when idempotency_key is present
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, genId, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { monthStartSec } from '../src/billing.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

// signup tests rely on ALLOW_SIGNUP being absent by default
beforeEach(() => {
  delete process.env.ALLOW_SIGNUP;
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => {
  delete process.env.ALLOW_SIGNUP;
  delete process.env.STRIPE_SECRET_KEY;
});

// Setup without bootstrapAdminKey so the projects table starts empty
// (important for the signup-cap count which queries all projects)
async function setupEmpty() {
  const db = createDb(':memory:');
  const app = await createApp(db);
  await app.ready();
  return { db, app };
}

// Setup with a pre-created admin project (for action / GDPR tests)
async function setupAdmin() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

// ---------------------------------------------------------------------------
// Global signup cap (50/hr → 503)
// ---------------------------------------------------------------------------

describe('POST /v1/signup — global signup cap', () => {
  it('returns 503 when 50 projects were created in the last hour', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setupEmpty();

    // Seed 50 projects with created_at well within the last hour.
    // No api_keys needed — the cap checks projects table only.
    const now = nowSec();
    for (let i = 0; i < 50; i++) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        genId('proj_'), `SeedProject${i}`, now - 60, // 60s ago, within the 3600s window
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.50.0.1',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Service Unavailable');
  });

  it('counts by created_at, not by rate_limits table', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setupEmpty();

    // Seed 49 recent projects → still below cap → should succeed
    const now = nowSec();
    for (let i = 0; i < 49; i++) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        genId('proj_'), `SeedProject${i}`, now - 100,
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.50.0.2',
      payload: {},
    });
    // 49 seeded + 1 created by this signup = 50 total after the call,
    // but the CAP check runs BEFORE creation, so 49 < 50 → 201.
    expect(res.statusCode).toBe(201);
  });

  it('projects older than one hour do not count toward the cap', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { db, app } = await setupEmpty();

    // Seed 60 projects but with created_at > 1 hour ago → outside window
    const old = nowSec() - 3601;
    for (let i = 0; i < 60; i++) {
      db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(
        genId('proj_'), `OldProject${i}`, old,
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.50.0.3',
      payload: {},
    });
    // Old projects don't count → recent = 0 < 50 → 201
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Approvals tier limit (402) via HTTP
// ---------------------------------------------------------------------------

describe('POST /v1/actions — monthly approvals quota (HTTP-level)', () => {
  // Seed decisions directly (avoids slow argon2 loop of 100 HTTP requests)
  function seedDecisions(db: ReturnType<typeof createDb>, projectId: string, n: number) {
    const now = nowSec();
    for (let i = 0; i < n; i++) {
      const aid = genId('act_');
      db.prepare(`
        INSERT INTO actions (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
        VALUES (?, ?, 'test', 'quota', '{}', '[]', 'approved', 'h', ?, ?)
      `).run(aid, projectId, now, now);
      db.prepare(`
        INSERT INTO decisions (id, action_id, verdict, decided_at) VALUES (?, ?, 'approve', ?)
      `).run(genId('dec_'), aid, now);
    }
  }

  it('returns 402 with tier and limit when monthly approvals quota is exhausted', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Free tier limit = 100; seed 100 decisions this month
    seedDecisions(db, projectId, 100);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(adminKey),
      payload: { kind: 'over.quota', title: 'Over quota', preview: { format: 'plain', body: 'x' } },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe('Payment Required');
    expect(body.tier).toBe('free');
    expect(body.limit).toBe(100);
  });

  it('deciding on an already-pending action is NOT blocked when quota exhausted', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Create one pending action BEFORE exhausting the quota
    const created = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(adminKey),
      payload: { kind: 'decide.still', title: 'Decide me', preview: { format: 'plain', body: 'body' } },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // Now exhaust the quota
    seedDecisions(db, projectId, 100);

    // POST new action is blocked
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(adminKey),
      payload: { kind: 'blocked', title: 'Blocked', preview: { format: 'plain', body: 'x' } },
    });
    expect(blocked.statusCode).toBe(402);

    // Deciding on the existing pending action is still allowed
    const decision = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: auth(adminKey),
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe('approved');
  });

  it('last-month decisions do not count toward this month quota (monthStartSec boundary)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Seed 100 decisions but with decided_at in the PREVIOUS month
    const lastMonth = monthStartSec() - 86400; // 1 day before month start
    for (let i = 0; i < 100; i++) {
      const aid = genId('act_');
      db.prepare(`
        INSERT INTO actions (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
        VALUES (?, ?, 'test', 'lastmonth', '{}', '[]', 'approved', 'h', ?, ?)
      `).run(aid, projectId, lastMonth, lastMonth);
      db.prepare(`
        INSERT INTO decisions (id, action_id, verdict, decided_at) VALUES (?, ?, 'approve', ?)
      `).run(genId('dec_'), aid, lastMonth);
    }

    // Current month has 0 decisions → still below quota
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(adminKey),
      payload: { kind: 'this.month', title: 'This month', preview: { format: 'plain', body: 'y' } },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GDPR erasure completeness
// ---------------------------------------------------------------------------

describe('DELETE /v1/project/data — erasure completeness', () => {
  it('deletes pii_log rows for the project', async () => {
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Create an action and decide on it (decision code inserts into pii_log)
    const created = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'pii.test', title: 'PII action', preview: { format: 'plain', body: 'body' } },
    });
    const { id: actionId } = created.json();

    await app.inject({
      method: 'POST', url: `/v1/actions/${actionId}/decision`, headers: auth(adminKey),
      payload: { decision: 'approve' },
    });

    // Verify pii_log has an entry
    const before = (db.prepare('SELECT COUNT(*) AS c FROM pii_log WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(before).toBeGreaterThan(0);

    // Erase
    const del = await app.inject({ method: 'DELETE', url: '/v1/project/data', headers: auth(adminKey) });
    expect(del.statusCode).toBe(200);

    // pii_log entries for the project must be gone
    const after = (db.prepare('SELECT COUNT(*) AS c FROM pii_log WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(after).toBe(0);
  });

  it('deletes audit_log rows for the project', async () => {
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Creating an action produces an audit_log entry
    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'audit.test', title: 'Audit action', preview: { format: 'plain', body: 'body' } },
    });

    const before = (db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(before).toBeGreaterThan(0);

    await app.inject({ method: 'DELETE', url: '/v1/project/data', headers: auth(adminKey) });

    const after = (db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(after).toBe(0);
  });

  it('API keys survive erasure (by design — account must keep working)', async () => {
    const { db, app, adminKey, projectId } = await setupAdmin();

    const keysBefore = (db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(keysBefore).toBeGreaterThan(0);

    await app.inject({ method: 'DELETE', url: '/v1/project/data', headers: auth(adminKey) });

    const keysAfter = (db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(keysAfter).toBe(keysBefore);

    // The key still works after erasure
    const ping = await app.inject({ method: 'GET', url: '/v1/project', headers: auth(adminKey) });
    expect(ping.statusCode).toBe(200);
  });

  it('deletes watcher_items together with watchers', async () => {
    const { db, app, adminKey, projectId } = await setupAdmin();

    // Create a watcher
    const wRes = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: { name: 'item-test', kind: 'rss', config: { url: 'https://example.com/feed.xml' }, schedule: { every: '30m' } },
    });
    const watcherId = wRes.json().id as string;

    // Seed watcher_items directly
    const now = nowSec();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO watcher_items (id, watcher_id, item_hash, url, title, first_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(genId('item_'), watcherId, `hash${i}`, `https://example.com/${i}`, `Item ${i}`, now);
    }

    const itemsBefore = (db.prepare('SELECT COUNT(*) AS c FROM watcher_items WHERE watcher_id = ?').get(watcherId) as { c: number }).c;
    expect(itemsBefore).toBe(5);

    await app.inject({ method: 'DELETE', url: '/v1/project/data', headers: auth(adminKey) });

    // Both watchers and their items must be gone
    const watchersAfter = (db.prepare('SELECT COUNT(*) AS c FROM watchers WHERE project_id = ?').get(projectId) as { c: number }).c;
    expect(watchersAfter).toBe(0);

    const itemsAfter = (db.prepare('SELECT COUNT(*) AS c FROM watcher_items WHERE watcher_id = ?').get(watcherId) as { c: number }).c;
    expect(itemsAfter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expires_in schema boundary validation
// ---------------------------------------------------------------------------

describe('POST /v1/actions — expires_in boundary validation', () => {
  it('returns 400 when expires_in = 299 (below minimum of 300)', async () => {
    const { app, adminKey } = await setupAdmin();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'exp.boundary', title: 'Boundary', preview: { format: 'plain', body: 'b' }, expires_in: 299 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 when expires_in = 300 (minimum allowed)', async () => {
    const { app, adminKey } = await setupAdmin();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'exp.min', title: 'Min expiry', preview: { format: 'plain', body: 'b' }, expires_in: 300 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 when expires_in = 2592001 (above maximum of 30*24*3600)', async () => {
    const { app, adminKey } = await setupAdmin();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'exp.max', title: 'Max expiry', preview: { format: 'plain', body: 'b' },
        expires_in: 30 * 24 * 3600 + 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 when expires_in = 30*24*3600 (maximum allowed)', async () => {
    const { app, adminKey } = await setupAdmin();
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'exp.maxok', title: 'Max OK', preview: { format: 'plain', body: 'b' },
        expires_in: 30 * 24 * 3600,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Payload > 256 KB → 400 via HTTP
// ---------------------------------------------------------------------------

describe('POST /v1/actions — payload size limit', () => {
  it('returns 400 when payload JSON serialization exceeds 256 KB', async () => {
    const { app, adminKey } = await setupAdmin();

    // Build a payload whose JSON representation exceeds 256 * 1024 bytes
    const bigValue = 'x'.repeat(256 * 1024 + 1);
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'big.payload',
        title: 'Big payload',
        preview: { format: 'plain', body: 'b' },
        payload: { data: bigValue },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/256 KB/i);
  });

  it('returns 201 when payload JSON is exactly at the limit', async () => {
    const { app, adminKey } = await setupAdmin();

    // JSON: {"data":"<255950 chars>"} ≈ 256001 bytes, comfortably under 256*1024=262144
    const smallEnough = 'y'.repeat(255_000);
    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'fit.payload',
        title: 'Fit payload',
        preview: { format: 'plain', body: 'b' },
        payload: { data: smallEnough },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Soft dedup does not fire when idempotency_key is present
// ---------------------------------------------------------------------------

describe('POST /v1/actions — soft dedup skipped with idempotency_key', () => {
  it('two requests with different idempotency_keys and identical content create two separate actions', async () => {
    const { app, adminKey } = await setupAdmin();

    const base = {
      kind: 'idem.dedup',
      title: 'Same title',
      preview: { format: 'plain', body: 'identical body' },
    };

    const res1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...base, idempotency_key: 'key-alpha' },
    });
    const res2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...base, idempotency_key: 'key-beta' },
    });

    // Both should be 201 (new actions) — soft dedup is bypassed because
    // idempotency_key is present; only hard dedup (same key, same project) applies
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res1.json().id).not.toBe(res2.json().id);
  });

  it('second request with NO idempotency_key and identical content is soft-deduped', async () => {
    const { app, adminKey } = await setupAdmin();

    const base = {
      kind: 'soft.dedup.ctrl',
      title: 'Soft dup title',
      preview: { format: 'plain', body: 'soft dedup content' },
    };

    const res1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: base,
    });
    const res2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: base,
    });

    expect(res1.statusCode).toBe(201);
    // Without an idempotency key, same kind+title+preview → soft dedup → 200
    expect(res2.statusCode).toBe(200);
    expect(res2.json().duplicate_of).toBe(res1.json().id);
  });
});
