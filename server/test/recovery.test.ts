/**
 * Tests for account recovery routes:
 *   POST /v1/recovery-code  — rotate recovery code (admin scope)
 *   POST /v1/recover        — regain access via recovery code (public)
 * and for signup returning recovery_code, and has_recovery_code in usage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/index.js';

beforeEach(() => {
  delete process.env.ALLOW_SIGNUP;
});
afterEach(() => {
  delete process.env.ALLOW_SIGNUP;
});

async function setup() {
  const db = createDb(':memory:');
  const app = await createApp(db);
  await app.ready();
  return { db, app };
}

/** Sign up and return key + recovery_code + project_id */
async function signupProject(app: Awaited<ReturnType<typeof setup>>['app'], ip = '10.0.1.1') {
  process.env.ALLOW_SIGNUP = '1';
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signup',
    remoteAddress: ip,
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { key: string; project_id: string; recovery_code: string };
  return body;
}

// ---------------------------------------------------------------------------
// signup returns recovery_code
// ---------------------------------------------------------------------------

describe('POST /v1/signup — recovery_code', () => {
  it('returns recovery_code alongside key and project_id', async () => {
    const { app } = await setup();
    const body = await signupProject(app);
    expect(body.recovery_code).toMatch(/^imr_/);
    expect(body.key).toMatch(/^im_/);
    expect(body.project_id).toMatch(/^proj_/);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/usage — has_recovery_code
// ---------------------------------------------------------------------------

describe('GET /v1/usage — has_recovery_code', () => {
  it('returns has_recovery_code=true after signup (code set at creation)', async () => {
    const { app } = await setup();
    const { key } = await signupProject(app, '10.0.2.1');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().has_recovery_code).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/recovery-code — rotate (admin scope required)
// ---------------------------------------------------------------------------

describe('POST /v1/recovery-code — rotation', () => {
  it('requires admin scope (403 without it)', async () => {
    const { db, app } = await setup();
    // Create a project directly so we can set a non-admin key
    const { key: adminKey, project_id } = await signupProject(app, '10.0.3.1');

    // Create a non-admin key for that project
    const keyRes = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { name: 'Actions Key', scopes: ['actions'] },
    });
    expect(keyRes.statusCode).toBe(201);
    const actionsKey = keyRes.json().key as string;
    void project_id; void db;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recovery-code',
      headers: { Authorization: `Bearer ${actionsKey}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rotates the recovery code and returns new plaintext (admin key)', async () => {
    const { app } = await setup();
    const { key, recovery_code: originalCode } = await signupProject(app, '10.0.4.1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recovery-code',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recovery_code).toMatch(/^imr_/);
    // New code must differ from the original
    expect(body.recovery_code).not.toBe(originalCode);
    expect(typeof body.note).toBe('string');
  });

  it('old recovery code no longer works after rotation', async () => {
    const { app } = await setup();
    const { key, recovery_code: oldCode, project_id } = await signupProject(app, '10.0.5.1');

    // Rotate
    const rotateRes = await app.inject({
      method: 'POST',
      url: '/v1/recovery-code',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(rotateRes.statusCode).toBe(200);

    // Old code should now fail
    const recoverRes = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.5.2',
      payload: { project_id, recovery_code: oldCode },
    });
    expect(recoverRes.statusCode).toBe(401);
    expect(recoverRes.json().error).toBe('Unauthorized');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/recover — happy path
// ---------------------------------------------------------------------------

describe('POST /v1/recover — happy path', () => {
  it('returns a new admin key and a new recovery_code', async () => {
    const { app } = await setup();
    const { recovery_code, project_id } = await signupProject(app, '10.0.6.1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.6.2',
      payload: { project_id, recovery_code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key).toMatch(/^im_/);
    expect(body.recovery_code).toMatch(/^imr_/);
    // New recovery code must differ from the one used
    expect(body.recovery_code).not.toBe(recovery_code);
    expect(body.project_id).toBe(project_id);
  });

  it('new key authenticates follow-up requests', async () => {
    const { app } = await setup();
    const { recovery_code, project_id } = await signupProject(app, '10.0.7.1');

    const recoverRes = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.7.2',
      payload: { project_id, recovery_code },
    });
    expect(recoverRes.statusCode).toBe(200);
    const { key: recoveredKey } = recoverRes.json();

    const projRes = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${recoveredKey}` },
    });
    expect(projRes.statusCode).toBe(200);
    expect(projRes.json().id).toBe(project_id);
  });

  it('recovery code is one-time: second use of same code returns 401', async () => {
    const { app } = await setup();
    const { recovery_code, project_id } = await signupProject(app, '10.0.8.1');

    // First use succeeds
    const first = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.8.2',
      payload: { project_id, recovery_code },
    });
    expect(first.statusCode).toBe(200);

    // Second use of same code must fail (code was rotated)
    const second = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.8.3',
      payload: { project_id, recovery_code },
    });
    expect(second.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/recover — error paths
// ---------------------------------------------------------------------------

describe('POST /v1/recover — error paths', () => {
  it('returns 401 for wrong recovery code (same generic error)', async () => {
    const { app } = await setup();
    const { project_id } = await signupProject(app, '10.0.9.1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.9.2',
      payload: { project_id, recovery_code: 'imr_totally_wrong_code_xxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Invalid project or recovery code.');
  });

  it('returns 401 for non-existent project_id (same generic error — anti-enumeration)', async () => {
    const { app } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.10.1',
      payload: { project_id: 'proj_does_not_exist_at_all', recovery_code: 'imr_anything' },
    });
    expect(res.statusCode).toBe(401);
    // Must match EXACTLY the same error as wrong-code case (anti-enumeration)
    expect(res.json().message).toBe('Invalid project or recovery code.');
  });

  it('returns 400 for missing required fields', async () => {
    const { app } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: '10.0.11.1',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rate-limits by IP after 5 attempts', async () => {
    const { app } = await setup();
    const { project_id } = await signupProject(app, '10.0.12.1');
    const ip = '10.0.12.100';

    // 5 attempts (wrong code — allowed but fail 401)
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/recover',
        remoteAddress: ip,
        payload: { project_id, recovery_code: `imr_wrong_${i}` },
      });
      // All should be 401 (wrong code), not yet rate-limited
      expect(r.statusCode).toBe(401);
    }

    // 6th attempt from same IP → 429
    const sixth = await app.inject({
      method: 'POST',
      url: '/v1/recover',
      remoteAddress: ip,
      payload: { project_id, recovery_code: 'imr_still_wrong' },
    });
    expect(sixth.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// has_recovery_code reflects rotated state
// ---------------------------------------------------------------------------

describe('has_recovery_code stays true after rotation', () => {
  it('is true after rotating the code via POST /v1/recovery-code', async () => {
    const { app } = await setup();
    const { key } = await signupProject(app, '10.0.13.1');

    await app.inject({
      method: 'POST',
      url: '/v1/recovery-code',
      headers: { Authorization: `Bearer ${key}` },
    });

    const usageRes = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(usageRes.json().has_recovery_code).toBe(true);
  });
});
