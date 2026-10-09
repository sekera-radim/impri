/**
 * Tests for the hosted streamable-HTTP MCP endpoint (/mcp) and the public
 * server card.
 *
 * Coverage:
 *  - auth: 401 with no key / wrong key, key never appears in logs
 *  - initialize + tools/list return the 8 shared tool definitions
 *  - tools/call happy path (impri_push_action -> impri_inbox_status)
 *  - body-too-large (413)
 *  - impri_await_decision's timeout_s is capped regardless of what was requested
 *  - GET/DELETE /mcp -> 405 (stateless server)
 *  - GET /.well-known/mcp/server-card.json is public and matches the tool list
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { TOOLS } from '@impri/mcp/toolDefs';
import { VERSION as MCP_PKG_VERSION } from '@impri/mcp/serverInfo';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key };
}

// Fastify's pino logger writes straight to process.stdout by default (no
// custom destination is configured) — intercepting it here is the only
// reliable way to assert end-to-end that a value never reaches a log line,
// rather than just trusting the `redact` config in createApp.
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

const auth = (k: string) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' });

const rpc = (method: string, params?: unknown, id: string | number = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

afterEach(() => {
  delete process.env.MCP_AWAIT_DECISION_MAX_S;
});

describe('POST /mcp — anonymous access (metadata only, same as the public server card)', () => {
  it('initialize works with no Authorization header', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      payload: rpc('initialize', { protocolVersion: '2025-06-18' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.name).toBe('@impri/mcp');
  });

  it('tools/list works with no Authorization header', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      payload: rpc('tools/list'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.tools).toHaveLength(8);
  });

  it('ping works with no Authorization header', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      payload: rpc('ping'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('tools/call 401s with no Authorization header, explaining how to fix it', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      payload: rpc('tools/call', { name: 'impri_inbox_status', arguments: {} }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    const body = res.json();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Authorization: Bearer im_');
    expect(body.error.message).toContain('https://app.impri.dev');
    // The error still carries the request's own id, unlike the old blanket
    // 401 (which couldn't — it ran before the body was even parsed).
    expect(body.id).toBe(1);
  });

  it('anonymous requests are rate-limited per IP, separately from keyed traffic', async () => {
    const { app } = await setup();
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json' }, payload: rpc('ping') });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json' }, payload: rpc('ping') });
    expect(res.statusCode).toBe(429);
  });
});

describe('POST /mcp — auth', () => {
  it('401s with a wrong/invalid key, for every method (never silently downgraded to anonymous)', async () => {
    const { app } = await setup();
    for (const method of ['initialize', 'tools/list', 'ping']) {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: auth('im_totally_bogus_key_0000000000000000'),
        payload: rpc(method),
      });
      expect(res.statusCode, method).toBe(401);
    }
  });

  it('never logs the raw API key, valid or invalid', async () => {
    const { app, adminKey } = await setup();

    const stdout = await captureStdout(async () => {
      await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('tools/list') });
      await app.inject({ method: 'POST', url: '/mcp', headers: auth('im_bogus_should_not_appear_anywhere'), payload: rpc('tools/list') });
      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: auth(adminKey),
        payload: rpc('tools/call', { name: 'impri_push_action', arguments: { kind: 'x', title: 'x', preview: { format: 'plain', body: 'x' } } }),
      });
    });

    expect(stdout).not.toContain(adminKey);
    expect(stdout).not.toContain('im_bogus_should_not_appear_anywhere');
  });
});

describe('POST /mcp — protocol', () => {
  it('initialize returns protocolVersion and serverInfo', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('initialize', { protocolVersion: '2025-06-18' }) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('@impri/mcp');
    expect(body.result.serverInfo.title).toBe('Impri');
    // Must track @impri/mcp's own version, not @impri/server's — this used
    // to leak the server package's version (0.1.0) while mcp was at 0.1.2.
    expect(body.result.serverInfo.version).toBe(MCP_PKG_VERSION);
  });

  it('initialize returns server-level instructions (push/await/report flow)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('initialize', { protocolVersion: '2025-06-18' }) });
    const body = res.json();
    expect(typeof body.result.instructions).toBe('string');
    expect(body.result.instructions.length).toBeGreaterThan(100);
    expect(body.result.instructions).toContain('impri_push_action');
    expect(body.result.instructions).toContain('impri_await_decision');
    expect(body.result.instructions).toContain('impri_report_result');
  });

  it('tools/list returns exactly the 8 shared tool definitions', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('tools/list') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.tools).toHaveLength(8);
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      TOOLS.map(t => t.name).sort(),
    );
    // Same object shape the server card and the stdio package expose.
    for (const t of body.result.tools) {
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('inputSchema');
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
      expect(t.annotations.readOnlyHint, t.name).toBeTypeOf('boolean');
      expect(t.annotations.destructiveHint, t.name).toBeTypeOf('boolean');
      expect(t.annotations.idempotentHint, t.name).toBeTypeOf('boolean');
      expect(t.annotations.openWorldHint, t.name).toBeTypeOf('boolean');
      expect(t.outputSchema, t.name).toBeTruthy();
      expect(t.outputSchema.type).toBe('object');
    }
  });

  it('a notification (no id) gets 202 with no JSON-RPC body', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.payload).toBe('');
  });

  it('unknown method returns JSON-RPC -32601', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('totally/unknown') });
    const body = res.json();
    expect(body.error.code).toBe(-32601);
  });

  it('rejects a batched (array) request', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: [rpc('ping')] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(-32600);
  });
});

describe('GET/DELETE /mcp — stateless server', () => {
  it('GET /mcp returns 405 with Allow: POST', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('DELETE /mcp returns 405', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(res.statusCode).toBe(405);
  });
});

describe('POST /mcp — tools/call happy path', () => {
  it('impri_push_action then impri_inbox_status round-trips through the real REST routes', async () => {
    const { app, adminKey } = await setup();

    const pushRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', {
        name: 'impri_push_action',
        arguments: {
          kind: 'test.mcp',
          title: 'MCP endpoint test',
          preview: { format: 'plain', body: 'Approve this?' },
        },
      }),
    });
    expect(pushRes.statusCode).toBe(200);
    const pushBody = pushRes.json();
    expect(pushBody.result.isError).toBeFalsy();
    const pushText = JSON.parse(pushBody.result.content[0].text);
    expect(pushText.action_id).toMatch(/^act_/);
    expect(pushText.status).toBe('pending');

    // Confirm the action really landed via the ordinary REST API, not just
    // in the tool's own text response — proves the inject transport wrote
    // through to the same DB the REST routes use.
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/actions/${pushText.action_id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().title).toBe('MCP endpoint test');

    const inboxRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', { name: 'impri_inbox_status', arguments: {} }),
    });
    expect(inboxRes.statusCode).toBe(200);
    const inboxBody = inboxRes.json();
    expect(inboxBody.result.content[0].text).toContain(pushText.action_id);
  });

  it('impri_push_action result carries structuredContent matching its outputSchema', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', {
        name: 'impri_push_action',
        arguments: { kind: 'test.mcp', title: 'x', preview: { format: 'plain', body: 'x' } },
      }),
    });
    const body = res.json();
    expect(body.result.structuredContent).toEqual({
      action_id: expect.stringMatching(/^act_/),
      status: 'pending',
      inbox_url: expect.any(String),
    });
    // text and structuredContent must describe the same thing, not drift.
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
  });

  it('calling an unknown tool returns a JSON-RPC error, not a 500', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', { name: 'impri_does_not_exist', arguments: {} }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32602);
  });
});

describe('POST /mcp — body size limit', () => {
  it('rejects an oversized body', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', {
        name: 'impri_push_action',
        arguments: { kind: 'x', title: 'x', preview: { format: 'plain', body: 'x'.repeat(600 * 1024) } },
      }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('POST /mcp — impri_await_decision timeout cap', () => {
  it('clamps a requested 300s wait to the configured max', async () => {
    process.env.MCP_AWAIT_DECISION_MAX_S = '1';
    const { app, adminKey } = await setup();

    const pushRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', {
        name: 'impri_push_action',
        arguments: { kind: 'test.await', title: 'Await cap test', preview: { format: 'plain', body: 'x' } },
      }),
    });
    const actionId = JSON.parse(pushRes.json().result.content[0].text).action_id;

    const start = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth(adminKey),
      payload: rpc('tools/call', {
        name: 'impri_await_decision',
        arguments: { action_id: actionId, timeout_s: 300 },
      }),
    });
    const elapsedMs = Date.now() - start;

    // The requested 300s must have been clamped to ~1s — a real 300s wait
    // would time out this test long before it got here.
    expect(elapsedMs).toBeLessThan(10_000);
    const body = res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Timed out after 1s');
  });
});

describe('GET /.well-known/mcp/server-card.json', () => {
  it('is public (no Authorization needed) and lists the same tools', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/.well-known/mcp/server-card.json' });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.transport.type).toBe('streamable-http');
    expect(card.transport.url).toMatch(/\/mcp$/);
    expect(card.authentication).toEqual({ required: true, schemes: ['bearer'] });
    expect(card.tools.map((t: { name: string }) => t.name).sort()).toEqual(TOOLS.map(t => t.name).sort());
    // The richer metadata (title/annotations/outputSchema) is what raised the
    // Smithery quality score — assert it actually reaches this public card.
    for (const t of card.tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
      expect(t.outputSchema, t.name).toBeTruthy();
    }
    // Same version/instructions gap the /mcp initialize response had to fix.
    expect(card.serverInfo.title).toBe('Impri');
    expect(card.serverInfo.version).toBe(MCP_PKG_VERSION);
    expect(typeof card.instructions).toBe('string');
    expect(card.instructions.length).toBeGreaterThan(100);
  });
});

describe('POST /mcp — Authorization without the "Bearer " prefix (Smithery gateway compat)', () => {
  it('accepts a bare "im_…" key, same as "Bearer im_…"', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: adminKey, 'Content-Type': 'application/json' },
      payload: rpc('tools/list'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.tools).toHaveLength(8);
  });

  it('still accepts the canonical "Bearer im_…" form', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: auth(adminKey), payload: rpc('tools/list') });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a bare invalid key the same as before', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: 'im_totally_bogus_key_0000000000000000', 'Content-Type': 'application/json' },
      payload: rpc('tools/list'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('an unrelated auth scheme is treated as anonymous, not as a key (extractRawApiKey returns null for it, same as no header)', async () => {
    const { app } = await setup();
    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: 'Basic dXNlcjpwYXNz', 'Content-Type': 'application/json' },
      payload: rpc('tools/list'),
    });
    expect(listRes.statusCode).toBe(200);

    const callRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: 'Basic dXNlcjpwYXNz', 'Content-Type': 'application/json' },
      payload: rpc('tools/call', { name: 'impri_inbox_status', arguments: {} }),
    });
    expect(callRes.statusCode).toBe(401);
  });

  it('also works on a plain REST route (shared preHandler), and never logs the bare key', async () => {
    const { app, adminKey } = await setup();
    let res!: Awaited<ReturnType<typeof app.inject>>;
    const stdout = await captureStdout(async () => {
      res = await app.inject({ method: 'GET', url: '/v1/actions?status=pending', headers: { Authorization: adminKey } });
    });
    expect(res.statusCode).toBe(200);
    expect(stdout).not.toContain(adminKey);
  });
});
