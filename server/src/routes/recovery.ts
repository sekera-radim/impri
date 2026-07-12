/**
 * Recovery-code routes — allow a user to regain access after losing all keys.
 *
 * POST /v1/recovery-code  (Bearer admin scope)  — rotate recovery code
 * POST /v1/recover        (public)              — exchange recovery code for new admin key
 *
 * Security model:
 * - Recovery codes are one-time: consuming one immediately rotates to a new one.
 * - /v1/recover is rate-limited per IP AND per project_id before any DB lookup.
 * - Anti-enumeration: non-existent project and wrong code produce identical 401.
 * - Plaintext codes are never logged, never stored in audit data.
 */

import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit, mintRecoveryCode } from '../auth.js';
import { randomBytes } from 'node:crypto';

// Stable dummy hash used in constant-time anti-enumeration path.
// Pre-computed at module load so it doesn't slow down the first request.
let _dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!_dummyHash) {
    _dummyHash = await argon2.hash('imr_dummy_constant_time_placeholder_do_not_use');
  }
  return _dummyHash;
}
// Warm up the dummy hash at import time (async, fire-and-forget).
getDummyHash().catch(() => {});

function writeAudit(db: Db, projectId: string, event: string, actor: string | null, data: object | null, now: number): void {
  db.prepare(
    'INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, event, actor, data !== null ? JSON.stringify(data) : null, now);
}

const RecoverBody = z.object({
  project_id: z.string().min(1),
  recovery_code: z.string().min(1),
});

export function registerRecoveryRoutes(app: FastifyInstance, db: Db): void {
  // -------------------------------------------------------------------------
  // POST /v1/recovery-code — rotate recovery code (admin scope, authed)
  // Returns the new plaintext code once. Use to set the initial code on
  // projects created before this feature, or to rotate an existing one.
  // -------------------------------------------------------------------------
  app.post('/v1/recovery-code', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    // Rate-limit: 10/min — rotation is not a frequent operation.
    if (!(await checkRateLimit(db, key.keyId, 'recovery-code:rotate', 10))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 10 rotations/min per key' });
    }

    const recovery = await mintRecoveryCode();
    const now = nowSec();

    db.prepare(
      'UPDATE projects SET recovery_hash = ? WHERE id = ?',
    ).run(recovery.hash, key.projectId);

    // Audit without the plaintext — only record that a rotation happened.
    writeAudit(db, key.projectId, 'recovery_code.set', key.keyId, null, now);

    reply.status(200);
    return {
      recovery_code: recovery.plaintext,
      note: 'Store this code securely (e.g. a password manager) — it will not be shown again. It replaces any previous recovery code.',
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/recover — exchange recovery code for a new admin key (public)
  // -------------------------------------------------------------------------
  app.post('/v1/recover', async (request, reply) => {
    // Rate-limit BEFORE any DB lookup — prevents project enumeration via timing.
    // Two separate buckets: per-IP (block spray attacks) and per-project_id
    // (block targeted brute-force even from rotating IPs).
    const ip =
      (request.headers['fly-client-ip'] as string | undefined) ??
      (request.headers['cf-connecting-ip'] as string | undefined) ??
      request.ip ??
      'unknown';

    const [ipAllowed, parsed] = await Promise.all([
      checkRateLimit(db, `ip:${ip}`, 'recover', 5),
      Promise.resolve(RecoverBody.safeParse(request.body ?? {})),
    ]);

    if (!ipAllowed) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many recovery attempts from this IP. Try again in a minute.' });
    }

    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }

    const { project_id, recovery_code } = parsed.data;

    // Per-project rate limit (checked after IP to avoid leaking project existence).
    const projectAllowed = await checkRateLimit(db, `proj:${project_id}`, 'recover', 5);
    if (!projectAllowed) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many recovery attempts for this project. Try again in a minute.' });
    }

    // Load project — but do NOT short-circuit on missing project; always verify
    // against something to keep timing constant (anti-enumeration).
    const project = db.prepare(
      'SELECT id, recovery_hash FROM projects WHERE id = ?',
    ).get(project_id) as { id: string; recovery_hash: string | null } | undefined;

    const storedHash = project?.recovery_hash ?? null;

    // When there is no project or no recovery hash: verify against the dummy
    // hash so the argon2 work takes the same time as a real verify — then
    // return the same generic error regardless.
    let codeValid = false;
    if (storedHash) {
      codeValid = await argon2.verify(storedHash, recovery_code);
    } else {
      // Constant-time dummy verify — result discarded.
      await argon2.verify(await getDummyHash(), recovery_code).catch(() => false);
    }

    if (!codeValid) {
      // Same error for wrong code, no project, and no recovery_hash — prevents
      // leaking whether a project_id exists or has a recovery code set.
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid project or recovery code.' });
    }

    // Code is valid. Mint a new admin key and rotate the recovery code atomically.
    const rawSecret = randomBytes(32).toString('base64url');
    const newKey = `im_${rawSecret}`;
    const prefix = newKey.slice(0, 16);
    const [keyHash, newRecovery] = await Promise.all([
      argon2.hash(newKey),
      mintRecoveryCode(),
    ]);

    const keyId = genId('key_');
    const now = nowSec();

    // Atomic transaction: INSERT new key + UPDATE recovery_hash together.
    db.transaction(() => {
      db.prepare(
        'INSERT INTO api_keys (id, project_id, key_hash, key_prefix, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(keyId, project_id, keyHash, prefix, 'Recovery Key', JSON.stringify(['admin']), now);

      db.prepare(
        'UPDATE projects SET recovery_hash = ? WHERE id = ?',
      ).run(newRecovery.hash, project_id);
    })();

    // Audit the recovery event — no key material, no recovery code in data.
    writeAudit(db, project_id, 'project.recovered', null, { new_key_id: keyId }, now);

    reply.status(200);
    return {
      key: newKey,
      recovery_code: newRecovery.plaintext,
      project_id,
      note: 'Store the new key and recovery code securely — they will not be shown again.',
    };
  });
}
