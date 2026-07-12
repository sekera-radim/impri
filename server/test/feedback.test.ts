/**
 * Tests for in-app feedback routes:
 *   POST /v1/feedback       — signed-in user submits feedback
 *   GET  /v1/admin/feedback — operator-only read (404 otherwise)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/index.js';

beforeEach(() => {
  delete process.env.ALLOW_SIGNUP;
  delete process.env.OPERATOR_PROJECT_ID;
});
afterEach(() => {
  delete process.env.ALLOW_SIGNUP;
  delete process.env.OPERATOR_PROJECT_ID;
});

async function setup() {
  const db = createDb(':memory:');
  const app = await createApp(db);
  await app.ready();
  return { db, app };
}

async function signupProject(app: Awaited<ReturnType<typeof setup>>['app'], ip = '10.0.5.1') {
  process.env.ALLOW_SIGNUP = '1';
  const res = await app.inject({ method: 'POST', url: '/v1/signup', remoteAddress: ip, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json() as { key: string; project_id: string };
}

describe('POST /v1/feedback', () => {
  it('stores feedback for a signed-in user', async () => {
    const { app } = await setup();
    const { key } = await signupProject(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: { authorization: `Bearer ${key}` },
      payload: { message: 'love it, but dark mode flickers', rating: 4, context: '/inbox' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects an empty message', async () => {
    const { app } = await setup();
    const { key } = await signupProject(app);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: { authorization: `Bearer ${key}` },
      payload: { message: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/feedback', payload: { message: 'hi' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/admin/feedback', () => {
  it('returns feedback to the operator and 404 to everyone else', async () => {
    const { app } = await setup();
    const operator = await signupProject(app, '10.0.5.2');
    const other = await signupProject(app, '10.0.5.3');
    process.env.OPERATOR_PROJECT_ID = operator.project_id;

    await app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: { authorization: `Bearer ${other.key}` },
      payload: { message: 'from another project' },
    });

    // Operator sees it (cross-project).
    const asOperator = await app.inject({
      method: 'GET',
      url: '/v1/admin/feedback',
      headers: { authorization: `Bearer ${operator.key}` },
    });
    expect(asOperator.statusCode).toBe(200);
    const items = (asOperator.json() as { items: { message: string }[] }).items;
    expect(items.some((f) => f.message === 'from another project')).toBe(true);

    // A non-operator project gets 404 (endpoint not even discoverable).
    const asOther = await app.inject({
      method: 'GET',
      url: '/v1/admin/feedback',
      headers: { authorization: `Bearer ${other.key}` },
    });
    expect(asOther.statusCode).toBe(404);
  });
});
