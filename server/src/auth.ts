import argon2 from 'argon2';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Db } from './db.js';
import { nowSec, genId } from './db.js';
import { incCounter } from './metrics.js';

// Optional Redis backend for the rate limiter — enables a SHARED window across
// multiple instances (horizontal scale-out). Without REDIS_URL we use the
// per-instance SQLite table, which is correct for the single-instance MVP.
let redis: Redis | null = null;
let redisInit = false;
function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!redisInit) {
    redisInit = true;
    try {
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      redis.on('error', (e: Error) => console.error('[ratelimit] redis error:', e.message));
    } catch (e) {
      console.error('[ratelimit] redis init failed, using SQLite:', e instanceof Error ? e.message : e);
      redis = null;
    }
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) { await redis.quit().catch(() => {}); redis = null; redisInit = false; }
}

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  name: string;
  scopes: string[];
  key_hash: string;
  key_prefix: string;
}

// Fixed-window rate limiter, one window per (key, route, minute). Uses Redis
// when REDIS_URL is set (shared across instances) and otherwise a per-instance
// SQLite table. Both survive restart; Redis errors fall back to SQLite.
export async function checkRateLimit(db: Db, keyId: string, route: string, limitPerMin = 60): Promise<boolean> {
  const windowStart = Math.floor(nowSec() / 60) * 60;

  const r = getRedis();
  if (r) {
    try {
      const rkey = `rl:${keyId}:${route}:${windowStart}`;
      const count = await r.incr(rkey);
      if (count === 1) await r.expire(rkey, 120);
      if (count > limitPerMin) {
        incCounter('impri_rate_limited_total', { bucket: route });
        return false;
      }
      return true;
    } catch {
      // Redis unavailable → fall through to SQLite (fail to a working limiter).
    }
  }

  const allowed = checkRateLimitSqlite(db, keyId, route, windowStart, limitPerMin);
  if (!allowed) incCounter('impri_rate_limited_total', { bucket: route });
  return allowed;
}

function checkRateLimitSqlite(db: Db, keyId: string, route: string, windowStart: number, limitPerMin: number): boolean {
  const row = db.prepare(
    'SELECT count FROM rate_limits WHERE key_id = ? AND route = ? AND window_start = ?',
  ).get(keyId, route, windowStart) as { count: number } | undefined;

  if ((row?.count ?? 0) >= limitPerMin) return false;

  db.prepare(`
    INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(key_id, route, window_start) DO UPDATE SET count = count + 1
  `).run(keyId, route, windowStart);

  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(windowStart - 120);
  return true;
}

// Smithery's hosted gateway forwards a user-provided parameter value
// straight into the upstream Authorization header, with no "Bearer " scheme
// added — a user who pastes just the raw key ends up sending
// "Authorization: im_xxxx" instead of "Authorization: Bearer im_xxxx". Accept
// both forms on every route (this feeds the one global auth preHandler in
// index.ts, shared by /mcp and the REST API), while "Bearer im_…" stays the
// documented canonical form in docs/mcp.md and the README. This only
// loosens header *syntax* — the extracted key still goes through
// verifyApiKey()'s argon2 check unchanged, so anything else (missing
// header, wrong scheme, garbage value) still falls through to a 401 same as
// before.
export function extractRawApiKey(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith('Bearer im_')) return authHeader.slice('Bearer '.length);
  if (authHeader.startsWith('im_')) return authHeader;
  return null;
}

export async function verifyApiKey(db: Db, rawKey: string): Promise<ApiKeyRecord | null> {
  if (!rawKey.startsWith('im_')) return null;
  const prefix = rawKey.slice(0, 16);
  const row = db.prepare(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL',
  ).get(prefix) as Record<string, unknown> | undefined;
  if (!row) return null;

  const valid = await argon2.verify(row.key_hash as string, rawKey);
  if (!valid) return null;

  // Update last_used_at
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowSec(), row.id);

  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    scopes: JSON.parse(row.scopes as string) as string[],
    key_hash: row.key_hash as string,
    key_prefix: row.key_prefix as string,
  };
}

export function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope) || scopes.includes('admin');
}

// ---------------------------------------------------------------------------
// Internal fast-lane auth token — lets the server re-enter its own REST
// routes (the /mcp endpoint invokes them via Fastify `app.inject` to reuse
// their auth/scope/rate-limit/validation logic verbatim for tool calls)
// without paying a second argon2.verify for a key that was already
// authenticated once in the same request. argon2's default cost (~tens of
// ms) is fine to pay once per HTTP request but not twice per MCP tool call.
//
// Security: the HMAC secret is generated fresh per process, lives only in
// memory, and is never logged, returned by any endpoint, or sent over the
// network — an external caller has no way to produce a valid token, so this
// grants no new trust to real network requests. It only shortcuts a
// same-process caller that already holds a verified ApiKeyRecord.
const INTERNAL_TOKEN_SECRET = randomBytes(32);
const INTERNAL_TOKEN_TTL_MS = 5_000;

export function mintInternalAuthToken(keyId: string): string {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', INTERNAL_TOKEN_SECRET).update(`${keyId}.${ts}`).digest('hex');
  return `${keyId}.${ts}.${sig}`;
}

// Returns the keyId when the token is a validly-signed, unexpired token
// minted by mintInternalAuthToken in this same process — null otherwise.
// Caller still has to look up the key row (it may have been revoked since).
export function verifyInternalAuthToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [keyId, ts, sig] = parts;
  if (!keyId || !ts || !sig) return null;

  const expected = createHmac('sha256', INTERNAL_TOKEN_SECRET).update(`${keyId}.${ts}`).digest('hex');
  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return null;
  }
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > INTERNAL_TOKEN_TTL_MS) return null;

  return keyId;
}

// Looks up an api_keys row by id (no secret comparison — the caller already
// proved it holds a token only this process could have minted). Used by the
// preHandler's internal-token branch instead of verifyApiKey's argon2 path.
export function lookupApiKeyById(db: Db, keyId: string): ApiKeyRecord | null {
  const row = db.prepare(
    'SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL',
  ).get(keyId) as Record<string, unknown> | undefined;
  if (!row) return null;

  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowSec(), row.id);

  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    scopes: JSON.parse(row.scopes as string) as string[],
    key_hash: row.key_hash as string,
    key_prefix: row.key_prefix as string,
  };
}

export interface BootstrapResult {
  key: string;
  projectId: string;
  recoveryCode: string;
}

// Mint a one-time recovery code: `imr_` prefix + 24 random bytes (base64url).
// Returns the plaintext (returned to caller once, never stored) and the argon2
// hash (stored in projects.recovery_hash). Never log the plaintext.
export async function mintRecoveryCode(): Promise<{ plaintext: string; hash: string }> {
  const plaintext = `imr_${randomBytes(24).toString('base64url')}`;
  const hash = await argon2.hash(plaintext);
  return { plaintext, hash };
}

// Create a fresh project with its own webhook secret and a single admin key.
// Shared by first-run bootstrap and self-serve signup.
export async function createProjectWithAdminKey(db: Db, projectName: string): Promise<BootstrapResult> {
  const projectId = genId('proj_');
  const webhookSecret = randomBytes(32).toString('base64url');

  const recovery = await mintRecoveryCode();

  db.prepare('INSERT INTO projects (id, name, webhook_secret, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    projectId,
    projectName,
    webhookSecret,
    recovery.hash,
    nowSec(),
  );

  const secret = randomBytes(32).toString('base64url');
  const key = `im_${secret}`;
  const prefix = key.slice(0, 16);
  const hash = await argon2.hash(key);

  const keyId = genId('key_');
  db.prepare(
    'INSERT INTO api_keys (id, project_id, key_hash, key_prefix, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(keyId, projectId, hash, prefix, 'Admin Key', JSON.stringify(['admin']), nowSec());

  return { key, projectId, recoveryCode: recovery.plaintext };
}

export async function bootstrapAdminKey(db: Db): Promise<BootstrapResult | null> {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM api_keys').get() as { cnt: number };
  if (existing.cnt > 0) return null;
  return createProjectWithAdminKey(db, 'Default Project');
}
