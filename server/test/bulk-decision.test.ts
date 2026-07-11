/**
 * bulk-decision.test.ts
 *
 * Tests for:
 *  - POST /v1/actions/bulk-decision (bulk approve / reject)
 *  - Cross-project isolation (IDs from another project are rejected as not_found)
 *  - Scope enforcement (key without "actions" scope → 403)
 *  - Batch size cap (> 50 IDs → 400)
 *  - Partial-failure result array (mix of pending and already-decided)
 *  - Text search filter q on GET /v1/actions
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey, createProjectWithAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

/** Create a limited-scope key and return its raw key string + id. */
async function createScopedKey(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  scopes: string[],
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/keys',
    headers: auth(adminKey),
    payload: { name: 'scoped-key', scopes },
  });
  if (res.statusCode !== 201) throw new Error(`createScopedKey failed: ${res.body}`);
  return res.json().key as string;
}

/** Create a pending action and return its id. */
async function createAction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: auth(adminKey),
    payload: {
      kind: 'test.bulk',
      title: 'Bulk test action',
      preview: { format: 'plain', body: 'body text' },
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createAction failed: ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

describe('POST /v1/actions/bulk-decision — bulk approve', () => {
  it('approves multiple pending actions and returns succeeded count', async () => {
    const { app, adminKey } = await setup();
    const id1 = await createAction(app, adminKey);
    const id2 = await createAction(app, adminKey, { title: 'Second action' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [id1, id2], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(2);

    for (const r of body.results as Array<{ ok: boolean; status: string }>) {
      expect(r.ok).toBe(true);
      expect(r.status).toBe('approved');
    }

    // Verify DB state via GET
    const get1 = await app.inject({ method: 'GET', url: `/v1/actions/${id1}`, headers: auth(adminKey) });
    expect(get1.json().status).toBe('approved');
  });

  it('rejects multiple pending actions and transitions status to rejected', async () => {
    const { app, adminKey } = await setup();
    const id1 = await createAction(app, adminKey);
    const id2 = await createAction(app, adminKey, { title: 'Another' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [id1, id2], verdict: 'reject' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toBe(2);
    expect(body.results.every((r: { status: string }) => r.status === 'rejected')).toBe(true);
  });

  it('stores optional comment in the decision row', async () => {
    const { app, adminKey, db } = await setup();
    const id = await createAction(app, adminKey);

    await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [id], verdict: 'approve', comment: 'Looks good' },
    });

    const dec = db.prepare('SELECT comment FROM decisions WHERE action_id = ?').get(id) as { comment: string } | undefined;
    expect(dec?.comment).toBe('Looks good');
  });
});

describe('POST /v1/actions/bulk-decision — partial failure', () => {
  it('returns already_decided for non-pending actions without failing the whole batch', async () => {
    const { app, adminKey } = await setup();
    const pendingId = await createAction(app, adminKey);
    const alreadyId = await createAction(app, adminKey, { title: 'Pre-decided' });

    // Decide one of them first
    await app.inject({
      method: 'POST',
      url: `/v1/actions/${alreadyId}/decision`,
      headers: auth(adminKey),
      payload: { decision: 'approve' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [pendingId, alreadyId], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);

    const results = body.results as Array<{ id: string; ok: boolean; error?: string; current_status?: string }>;
    const ok = results.find(r => r.id === pendingId);
    const fail = results.find(r => r.id === alreadyId);
    expect(ok?.ok).toBe(true);
    expect(fail?.ok).toBe(false);
    expect(fail?.error).toBe('already_decided');
    expect(fail?.current_status).toBe('approved');
  });

  it('returns not_found for unknown action IDs without failing the batch', async () => {
    const { app, adminKey } = await setup();
    const validId = await createAction(app, adminKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [validId, 'act_doesnotexist'], verdict: 'reject' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);

    const miss = (body.results as Array<{ id: string; error?: string }>).find(r => r.id === 'act_doesnotexist');
    expect(miss?.error).toBe('not_found');
  });

  it('deduplicates repeated IDs before processing', async () => {
    const { app, adminKey } = await setup();
    const id = await createAction(app, adminKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [id, id, id], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // After dedup, only one unique ID — should succeed once
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(1);
  });
});

describe('POST /v1/actions/bulk-decision — cross-project isolation', () => {
  it('returns not_found for IDs belonging to another project', async () => {
    const db = createDb(':memory:');
    const bootstrap = await bootstrapAdminKey(db);
    const app = await createApp(db);
    await app.ready();
    const adminKey = bootstrap!.key;

    // Create a second project
    const { key: otherKey } = await createProjectWithAdminKey(db, 'Other Project');

    // Create action under the second (other) project
    const otherRes = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(otherKey),
      payload: { kind: 'other', title: 'Other project action', preview: { format: 'plain', body: 'x' } },
    });
    const otherId = otherRes.json().id as string;

    // Try to bulk-decide the other project's action using adminKey (project 1)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [otherId], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    // Must appear as not_found — no information disclosure about other project's IDs
    const result = (body.results as Array<{ error: string }>)[0];
    expect(result.error).toBe('not_found');

    // Verify the other project's action was NOT touched
    const check = await app.inject({
      method: 'GET',
      url: `/v1/actions/${otherId}`,
      headers: auth(otherKey),
    });
    expect(check.json().status).toBe('pending');
  });
});

describe('POST /v1/actions/bulk-decision — scope enforcement', () => {
  it('returns 403 when the key has no "actions" scope', async () => {
    const { app, adminKey } = await setup();
    // "watch" scope has no access to actions
    const watchKey = await createScopedKey(app, adminKey, ['watch']);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(watchKey),
      payload: { ids: ['act_anything'], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when no auth header is provided', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      payload: { ids: ['act_x'], verdict: 'approve' },
    });
    // No auth → apiKey is undefined → 403
    expect(res.statusCode).toBe(403);
  });

  it('allows a key with "actions" scope (non-admin)', async () => {
    const { app, adminKey } = await setup();
    const actionsKey = await createScopedKey(app, adminKey, ['actions']);
    const id = await createAction(app, adminKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(actionsKey),
      payload: { ids: [id], verdict: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toBe(1);
  });
});

describe('POST /v1/actions/bulk-decision — batch size cap', () => {
  it('returns 400 when ids array exceeds 50 items', async () => {
    const { app, adminKey } = await setup();
    const ids = Array.from({ length: 51 }, (_, i) => `act_fake_${i}`);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids, verdict: 'approve' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Bad Request');
  });

  it('returns 400 when ids array is empty', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: [], verdict: 'approve' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when verdict is not approve or reject', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: ['act_x'], verdict: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when comment exceeds 500 chars', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids: ['act_x'], verdict: 'approve', comment: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts exactly 50 IDs (boundary)', async () => {
    const { app, adminKey } = await setup();
    const ids = Array.from({ length: 50 }, (_, i) => `act_fake_${i}`);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions/bulk-decision',
      headers: auth(adminKey),
      payload: { ids, verdict: 'approve' },
    });

    // 50 IDs all return not_found (they don't exist), but the request itself is valid → 200
    expect(res.statusCode).toBe(200);
    expect(res.json().failed).toBe(50);
    expect(res.json().succeeded).toBe(0);
  });
});

describe('GET /v1/actions — text search filter (q)', () => {
  it('filters actions by title using q parameter', async () => {
    const { app, adminKey } = await setup();
    await createAction(app, adminKey, { title: 'Send invoice to Acme Corp' });
    await createAction(app, adminKey, { title: 'Deploy to production' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?q=Acme',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((a: { title: string }) => a.title.includes('Acme'))).toBe(true);
  });

  it('filters actions by preview body using q parameter', async () => {
    const { app, adminKey } = await setup();
    await createAction(app, adminKey, {
      title: 'Action with unique preview',
      preview: { format: 'plain', body: 'xq9zspecialterm99' },
    });
    await createAction(app, adminKey, {
      title: 'Other action',
      preview: { format: 'plain', body: 'nothing special here' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?q=xq9zspecialterm99',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ preview: { body: string } }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(a => a.preview.body.includes('xq9zspecialterm99'))).toBe(true);
  });

  it('returns empty items when q matches nothing', async () => {
    const { app, adminKey } = await setup();
    await createAction(app, adminKey, { title: 'Some action' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?q=zzznomatch99xyz',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });

  it('treats LIKE metacharacters in q as literals (no wildcard injection)', async () => {
    const { app, adminKey } = await setup();
    await createAction(app, adminKey, { title: 'Normal action' });

    // If % were not escaped, this would match everything
    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?q=%25',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    // % should match nothing since no title/body contains a literal %
    expect(res.json().items).toHaveLength(0);
  });

  it('returns 400 when q exceeds 200 chars', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/actions?q=${'a'.repeat(201)}`,
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(400);
  });

  it('can combine q with kind filter', async () => {
    const { app, adminKey } = await setup();
    await createAction(app, adminKey, { kind: 'email.send', title: 'Send invoice email' });
    await createAction(app, adminKey, { kind: 'sms.send', title: 'Send invoice sms' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?q=invoice&kind=email.send',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ kind: string }>;
    expect(items.every(a => a.kind === 'email.send')).toBe(true);
  });
});
