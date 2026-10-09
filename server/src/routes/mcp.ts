import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { checkRateLimit, mintInternalAuthToken } from '../auth.js';
import { incCounter } from '../metrics.js';
import { buildServerCard } from '../mcp/serverCard.js';
import { TOOLS } from '@impri/mcp/toolDefs';
import { callTool } from '@impri/mcp/dispatch';
import type { ImpriConfig, Transport } from '@impri/mcp/client';
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, VERSION } from '@impri/mcp/serverInfo';

const PROTOCOL_VERSION = '2025-06-18';

// Fly's edge proxy and most MCP clients assume a tool call resolves well
// under a minute. impri_await_decision normally polls for up to 300s — here
// we clamp the per-request wait so a single POST /mcp never holds the
// connection open longer than this, no matter what the caller asked for.
// The tool's own "still pending, call me again" guidance (see
// mcp/src/tools.ts formatDecision/timeout message) is what makes repeated
// short waits the correct pattern instead of one long one.
// Read lazily (not as a module-level constant) so it can be overridden
// per-test without needing to reset the module registry.
function awaitDecisionMaxS(): number {
  return Number(process.env.MCP_AWAIT_DECISION_MAX_S ?? 20);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope (2025-06-18 removed batching, so we only accept a
// single request/notification object per POST — an array is rejected below).
// ---------------------------------------------------------------------------

const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1).max(200),
  params: z.record(z.unknown()).optional(),
});

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

// Executes a REST call in-process via `app.inject` instead of a real HTTP
// round trip back to this same server. The injected request carries a
// short-lived internal auth token (see auth.ts mintInternalAuthToken) for
// the same keyId already verified for the outer /mcp request, so it runs
// through the exact same per-route scope check, rate limit, zod validation,
// tier/billing gate, notification fan-out, and audit log write as a direct
// REST call — no business logic is duplicated for the MCP surface, and the
// key's argon2 verification is paid once (for the outer request), not again
// per tool call.
function makeInjectTransport(app: FastifyInstance, keyId: string): Transport {
  return async (method, path, body) => {
    const res = await app.inject({
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: `/v1${path}`,
      headers: {
        'x-impri-internal-auth': mintInternalAuthToken(keyId),
        'content-type': 'application/json',
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.statusCode,
      json: async () => (res.payload ? res.json() : {}),
    };
  };
}

export function registerMcpRoutes(app: FastifyInstance, db: Db): void {
  // ---------------------------------------------------------------------------
  // GET /.well-known/mcp/server-card.json — PUBLIC, no Authorization required.
  // Directories (Smithery, the Claude connectors directory, ...) fetch this
  // before ever trying to connect, specifically because they cannot see past
  // the 401 on /mcp itself.
  // ---------------------------------------------------------------------------
  app.get('/.well-known/mcp/server-card.json', async (_request, reply) => {
    const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? '8484'}`;
    reply.header('Cache-Control', 'public, max-age=300');
    return buildServerCard(baseUrl);
  });

  // GET /mcp — this is a stateless server (no sessions, no server-initiated
  // push), so there is no SSE stream to open. 405 is the spec-correct
  // response, not an error condition.
  app.get('/mcp', async (_request, reply) => {
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send(rpcError(null, -32000, 'This server is stateless: GET (server-initiated stream) is not supported — use POST'));
  });

  // DELETE /mcp — session termination. This server never issues a session
  // id, so there is nothing to terminate.
  app.delete('/mcp', async (_request, reply) => {
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send(rpcError(null, -32000, 'This server is stateless: there is no session to terminate'));
  });

  // POST /mcp — the one real entry point. bodyLimit is tighter than the
  // Fastify-wide 1 MiB default: JSON-RPC envelopes here are small (the
  // largest legitimate payload is impri_push_action's args, and that body
  // is separately capped at 256 KB by POST /v1/actions itself).
  app.post('/mcp', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const key = request.apiKey;
    // An Authorization header that IS present but doesn't verify already
    // 401s in the shared preHandler (index.ts) before this handler ever
    // runs — so reaching here with no `key` always means no header was
    // sent at all, never a wrong one silently downgraded to anonymous.
    if (key) {
      // Generic envelope-level rate limit (initialize/list/ping floods). Each
      // tools/call additionally runs through the target REST route's own
      // rate limit (e.g. actions:create 60/min) via the inject transport below.
      if (!(await checkRateLimit(db, key.keyId, 'mcp:request', 120))) {
        return reply.status(429).send(rpcError(null, -32000, 'Rate limit: 120 requests/min per key'));
      }
    } else {
      // Anonymous metadata browsing (directories, Smithery's "works without
      // a key" check) is allowed for everything except tools/call — see the
      // 'tools/call' case below — but still gets its own per-IP bucket so it
      // can't be used to flood the server for free. Never touches argon2:
      // that only runs inside verifyApiKey, for a request that presents a
      // key at all (see the preHandler).
      const ip =
        (request.headers['fly-client-ip'] as string | undefined) ??
        (request.headers['cf-connecting-ip'] as string | undefined) ??
        request.ip ??
        'unknown';
      if (!(await checkRateLimit(db, `ip:${ip}`, 'mcp:anon', 60))) {
        return reply.status(429).send(rpcError(null, -32000, 'Rate limit: 60 anonymous requests/min per IP'));
      }
    }

    if (Array.isArray(request.body)) {
      return reply.status(400).send(rpcError(null, -32600, 'Batched JSON-RPC requests are not supported'));
    }

    const parsed = JsonRpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(rpcError(null, -32600, 'Invalid JSON-RPC request'));
    }
    const rpc = parsed.data;
    const id = rpc.id ?? null;
    const isNotification = rpc.id === undefined;

    reply.header('Content-Type', 'application/json');

    switch (rpc.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
          instructions: INSTRUCTIONS,
        });

      // Notifications never get a JSON-RPC response body — 202 and done.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return reply.status(202).send();

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        // The only method that actually does something — everything above
        // (initialize/tools/list/ping/notifications) just describes the
        // server, which the public server card already exposes with no
        // auth at all.
        if (!key) {
          return reply
            .status(401)
            .header('WWW-Authenticate', 'Bearer realm="impri"')
            .send(rpcError(
              id,
              -32001,
              'Impri API key required: pass Authorization: Bearer im_… — create a free workspace at https://app.impri.dev',
            ));
        }

        const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
        const toolName = typeof params.name === 'string' ? params.name : '';
        const rawArgs = { ...((params.arguments ?? {}) as Record<string, unknown>) };

        if (!TOOLS.some(t => t.name === toolName)) {
          return reply.status(200).send(rpcError(id, -32602, `Unknown tool: ${toolName}`));
        }

        if (toolName === 'impri_await_decision') {
          const requested = typeof rawArgs['timeout_s'] === 'number' ? (rawArgs['timeout_s'] as number) : 300;
          rawArgs['timeout_s'] = Math.max(1, Math.min(requested, awaitDecisionMaxS()));
        }

        const config: ImpriConfig = {
          apiKey: '', // unused: the transport below forwards the real header
          baseUrl: '',
          transport: makeInjectTransport(app, key.keyId),
        };

        const result = await callTool(config, toolName, rawArgs);
        incCounter('impri_mcp_tool_calls_total', { tool: toolName, result: result.isError ? 'error' : 'ok' });
        return rpcResult(id, result);
      }

      default:
        if (isNotification) return reply.status(202).send();
        return reply.status(200).send(rpcError(id, -32601, `Method not found: ${rpc.method}`));
    }
  });
}
