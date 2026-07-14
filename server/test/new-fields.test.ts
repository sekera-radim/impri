/**
 * new-fields.test.ts
 *
 * Tests for three backward-compatible feature additions:
 *   Feature 1: per-action `idempotent` boolean flag
 *   Feature 2: structured result payload (result_payload)
 *   Feature 3: `undo` hint at proposal time
 *
 * Backward-compatibility requirement: when the new fields are absent, the
 * handler behaviour must be byte-for-byte unchanged.
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key };
}

// ──────────────────────────────────────────────────────────────────────────────
// Feature 1: idempotent flag
// ──────────────────────────────────────────────────────────────────────────────

describe('Feature 1: idempotent flag', () => {
  it('stores idempotent=true and returns it from GET', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'idem.flag',
        title: 'Idempotent action',
        preview: { format: 'plain', body: 'body' },
        idempotent: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().idempotent).toBe(true);
  });

  it('stores idempotent=false and returns it from GET', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'idem.not',
        title: 'Non-idempotent action',
        preview: { format: 'plain', body: 'body' },
        idempotent: false,
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().idempotent).toBe(false);
  });

  it('returns idempotent=undefined (absent) when not provided — backward compat', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'idem.absent',
        title: 'No idempotent field',
        preview: { format: 'plain', body: 'body' },
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    // Field must be absent (undefined serialises to missing key in JSON)
    expect(get.json()).not.toHaveProperty('idempotent');
  });

  it('idempotent appears in list results', async () => {
    const { app, adminKey } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'idem.list',
        title: 'List idempotent',
        preview: { format: 'plain', body: 'body' },
        idempotent: false,
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/actions?kind=idem.list',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].idempotent).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Feature 2: structured result payload
// ──────────────────────────────────────────────────────────────────────────────

describe('Feature 2: result payload', () => {
  async function createAndApprove(app: Awaited<ReturnType<typeof setup>>['app'], adminKey: string) {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'receipt.test', title: 'Receipt action', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();
    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve' },
    });
    return id;
  }

  it('stores result payload and returns it parsed from GET', async () => {
    const { app, adminKey } = await setup();
    const id = await createAndApprove(app, adminKey);

    const result = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        status: 'executed',
        payload: { ids: [1, 2, 3], url: 'https://example.com/record/1' },
      },
    });
    expect(result.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    const action = get.json();
    expect(action.status).toBe('executed');
    expect(action.result_payload).toEqual({ ids: [1, 2, 3], url: 'https://example.com/record/1' });
  });

  it('result_payload absent when not provided — backward compat', async () => {
    const { app, adminKey } = await setup();
    const id = await createAndApprove(app, adminKey);

    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { status: 'executed' },
    });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).not.toHaveProperty('result_payload');
  });

  it('rejects result payload exceeding 16 KB', async () => {
    const { app, adminKey } = await setup();
    const id = await createAndApprove(app, adminKey);

    // Build a payload just over 16 KB
    const bigValue = 'x'.repeat(16 * 1024 + 1);

    const result = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { status: 'executed', payload: { data: bigValue } },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().message).toContain('16 KB');
  });

  it('stores result payload on execute_failed status', async () => {
    const { app, adminKey } = await setup();
    const id = await createAndApprove(app, adminKey);

    const result = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        status: 'execute_failed',
        detail: 'upstream timeout',
        payload: { error_code: 'TIMEOUT', attempt: 1 },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe('execute_failed');

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.json().result_payload).toEqual({ error_code: 'TIMEOUT', attempt: 1 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Feature 3: undo hint
// ──────────────────────────────────────────────────────────────────────────────

describe('Feature 3: undo hint', () => {
  it('stores undo and returns it from GET', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'undo.test',
        title: 'Undo-able action',
        preview: { format: 'plain', body: 'body' },
        undo: 'DELETE /api/records/42',
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().undo).toBe('DELETE /api/records/42');
  });

  it('undo absent when not provided — backward compat', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'undo.absent',
        title: 'No undo',
        preview: { format: 'plain', body: 'body' },
      },
    });
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.json()).not.toHaveProperty('undo');
  });

  it('rejects undo longer than 2000 chars', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'undo.toolong',
        title: 'Too long undo',
        preview: { format: 'plain', body: 'body' },
        undo: 'x'.repeat(2001),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('undo appears in list results', async () => {
    const { app, adminKey } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'undo.list',
        title: 'List undo',
        preview: { format: 'plain', body: 'body' },
        undo: 'rollback command',
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/actions?kind=undo.list',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(list.json().items[0].undo).toBe('rollback command');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// All three fields together
// ──────────────────────────────────────────────────────────────────────────────

describe('All three new fields combined', () => {
  it('creates action with all new fields and reads them back correctly', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'combined.test',
        title: 'All fields action',
        preview: { format: 'plain', body: 'body' },
        idempotent: false,
        undo: 'remove the created entry',
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    // Approve
    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve' },
    });

    // Report result with payload
    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { status: 'executed', payload: { created_id: 99 } },
    });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    const action = get.json();
    expect(action.idempotent).toBe(false);
    expect(action.undo).toBe('remove the created entry');
    expect(action.result_payload).toEqual({ created_id: 99 });
    expect(action.status).toBe('executed');
  });
});
