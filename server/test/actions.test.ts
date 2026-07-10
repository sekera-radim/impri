import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { signWebhookBody, runExpiryTick } from '../src/webhooks.js';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key };
}

describe('Action lifecycle', () => {
  it('creates a pending action and returns 201', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'test.action',
        title: 'Test action',
        preview: { format: 'plain', body: 'Do the thing?' },
        expires_in: 3600,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^act_/);
    expect(body.status).toBe('pending');
    expect(body.inbox_url).toBeTruthy();
  });

  it('returns full action on GET /v1/actions/:id', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'get.test', title: 'Get test', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.status).toBe('pending');
  });

  it('lists actions with status filter', async () => {
    const { app, adminKey } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'list.test', title: 'List action', preview: { format: 'plain', body: 'x' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?status=pending',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((a: { status: string }) => a.status === 'pending')).toBe(true);
  });

  it('lists actions with kind filter', async () => {
    const { app, adminKey } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'unique.kind', title: 'Unique kind action', preview: { format: 'plain', body: 'y' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions?kind=unique.kind',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.every((a: { kind: string }) => a.kind === 'unique.kind')).toBe(true);
  });

  it('filters actions by since timestamp', async () => {
    const { app, adminKey } = await setup();
    const before = nowSec() - 1;
    await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'since.test', title: 'Since action', preview: { format: 'plain', body: 'z' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/actions?since=${before}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe('Idempotency', () => {
  it('returns same action for repeated POST with idempotency_key', async () => {
    const { app, adminKey } = await setup();
    const payload = {
      kind: 'idem.test',
      title: 'Idempotent action',
      preview: { format: 'plain', body: 'same' },
      idempotency_key: 'idem-key-001',
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload,
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(200);
    expect(res1.json().id).toBe(res2.json().id);
  });

  it('returns duplicate_of for soft dedup (same kind+title+preview, no key)', async () => {
    const { app, adminKey } = await setup();
    const payload = {
      kind: 'dedup.test',
      title: 'Duplicate action',
      preview: { format: 'plain', body: 'identical content' },
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload,
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(200);
    expect(res2.json().duplicate_of).toBe(res1.json().id);
  });
});

describe('Decision flow', () => {
  it('approves an action and transitions status to approved', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'approve.test', title: 'Approve me', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve', channel: 'test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('approved');

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.json().status).toBe('approved');
  });

  it('rejects an action and transitions status to rejected', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'reject.test', title: 'Reject me', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
  });

  it('returns 409 on second decision attempt', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'double.test', title: 'Double decide', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve' },
    });

    const second = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'reject' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects edited keys not in editable whitelist with 422', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'edit.test',
        title: 'Edit test',
        preview: { format: 'markdown', body: '# Draft\n\nHello' },
        editable: ['preview.body'],
      },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      // 'payload.secret' is not in editable whitelist → must be rejected
      payload: { decision: 'approve', edited: { 'payload.secret': 'injected' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('not in editable whitelist');
    expect(res.json().invalid_keys).toContain('payload.secret');
  });

  it('applies whitelisted edited field to final_preview on approve', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'edit.ok',
        title: 'Edit OK',
        preview: { format: 'markdown', body: 'Original body' },
        editable: ['preview.body'],
      },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve', edited: { 'preview.body': 'Edited body' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Edit must actually propagate — not silently ignored (PLAYBOOK A3)
    expect(body.final_preview.body).toBe('Edited body');
    expect(body.diff).toContain('Edited body');
    expect(body.diff).toContain('Original body');
  });

  it('GET /v1/actions/:id returns final_preview and diff from decision', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'edit.get',
        title: 'Edit GET test',
        preview: { format: 'plain', body: 'Before edit' },
        editable: ['preview.body'],
      },
    });
    const { id } = create.json();

    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve', edited: { 'preview.body': 'After human edit' } },
    });

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    const action = get.json();
    expect(action.status).toBe('approved');
    expect(action.decision).toBeTruthy();
    expect(action.decision.final_preview.body).toBe('After human edit');
    expect(action.decision.diff).toContain('After human edit');
  });
});

describe('Result reporting', () => {
  it('marks action as executed after approval', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'result.test', title: 'Result action', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('executed');
  });

  it('returns 409 when reporting result on non-approved action', async () => {
    const { app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { kind: 'result.bad', title: 'Result bad', preview: { format: 'plain', body: 'body' } },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/result`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { status: 'executed' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('HMAC webhook signature', () => {
  it('produces a valid HMAC-SHA256 signature verifiable independently', () => {
    const secret = 'test-secret';
    const body = JSON.stringify({ event: 'action.updated', action_id: 'act_123', status: 'approved' });
    const timestamp = 1700000000;
    const nonce = 'abc123';

    const sig = signWebhookBody(secret, body, timestamp, nonce);

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest('hex');

    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('Action expiry', () => {
  it('marks expired actions as expired on tick', async () => {
    const { db, app, adminKey } = await setup();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: {
        kind: 'expire.test',
        title: 'About to expire',
        preview: { format: 'plain', body: 'body' },
        expires_in: 300, // min allowed
      },
    });
    const { id } = create.json();

    // Manually backdate expires_at to past
    db.prepare('UPDATE actions SET expires_at = ? WHERE id = ?').run(nowSec() - 1, id);

    await runExpiryTick(db, 'test-secret');

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.json().status).toBe('expired');
  });
});

describe('Authentication', () => {
  it('rejects requests without Authorization header', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions',
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests with invalid key', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/actions',
      headers: { Authorization: 'Bearer so_invalidkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.statusCode).toBe(401);
  });
});
