import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/index.js';

// Isolate env so ALLOW_SIGNUP doesn't leak between tests.
// Each test that needs it sets it explicitly.
beforeEach(() => {
  delete process.env.ALLOW_SIGNUP;
});
afterEach(() => {
  delete process.env.ALLOW_SIGNUP;
});

// Each setup() creates a fresh in-memory DB so rate-limit counters never bleed
// between tests (the SQLite rate_limits table is test-local).
async function setup() {
  const db = createDb(':memory:');
  const app = await createApp(db);
  await app.ready();
  return { db, app };
}

describe('POST /v1/signup — gate', () => {
  it('returns 404 when ALLOW_SIGNUP is not set', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/signup', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when ALLOW_SIGNUP is set to something other than "1"', async () => {
    process.env.ALLOW_SIGNUP = '0';
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/signup', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/signup — happy path', () => {
  it('creates a project and returns key + project_id with ALLOW_SIGNUP=1', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.1',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^im_/);
    expect(body.project_id).toMatch(/^proj_/);
    expect(typeof body.note).toBe('string');
  });

  it('accepts optional {name} and uses it as the project name', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.2',
      payload: { name: 'Acme Corp' },
    });
    expect(res.statusCode).toBe(201);
    const { key } = res.json();

    // Verify the name was persisted by calling GET /v1/project with the new key.
    const proj = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(proj.statusCode).toBe(200);
    expect(proj.json().name).toBe('Acme Corp');
  });

  it('defaults to "My Project" when name is omitted', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.3',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const { key } = res.json();

    const proj = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(proj.statusCode).toBe(200);
    expect(proj.json().name).toBe('My Project');
  });
});

describe('POST /v1/signup — key authentication', () => {
  it('returned key authenticates follow-up requests to GET /v1/project', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.4',
      payload: {},
    });
    expect(signup.statusCode).toBe(201);
    const { key } = signup.json();

    const proj = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(proj.statusCode).toBe(200);
    // project_id in the signup response should match the project returned
    expect(proj.json().id).toBe(signup.json().project_id);
  });

  it('returned key authenticates follow-up requests to GET /v1/billing', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.5',
      payload: {},
    });
    expect(signup.statusCode).toBe(201);
    const { key } = signup.json();

    const billing = await app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(billing.statusCode).toBe(200);
  });
});

describe('POST /v1/signup — rate limiting', () => {
  // The rate limiter uses checkRateLimit(db, `ip:${ip}`, 'signup', 3) — limit 3
  // per minute per IP. Fastify inject accepts `remoteAddress` to set request.ip.
  // Each test below uses a unique IP subnet so windows don't bleed across tests.
  it('allows 3 signups from the same IP and blocks the 4th with 429', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const ip = '10.1.0.1'; // unique to this test

    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/signup',
        remoteAddress: ip,
        payload: {},
      });
      expect(res.statusCode).toBe(201);
    }

    const fourth = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: ip,
      payload: {},
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error).toBe('Too Many Requests');
  });

  it('does not rate-limit a different IP independently', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const ipA = '10.2.0.1';
    const ipB = '10.2.0.2';

    // Exhaust the limit for ipA
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/v1/signup', remoteAddress: ipA, payload: {} });
    }

    // ipB should still succeed
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: ipB,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /v1/signup — validation', () => {
  it('returns 400 when name exceeds 80 characters', async () => {
    process.env.ALLOW_SIGNUP = '1';
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      remoteAddress: '10.0.0.9',
      payload: { name: 'a'.repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });
});
