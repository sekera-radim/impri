import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope } from '../auth.js';
import { CreateKeyBody } from '../schemas.js';

export function registerKeyRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/keys — create new key (admin scope)
  app.post('/v1/keys', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const parsed = CreateKeyBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const projectId = body.project_id ?? key.projectId;

    const secret = randomBytes(32).toString('base64url');
    const rawKey = `im_${secret}`;
    const prefix = rawKey.slice(0, 16);
    const hash = await argon2.hash(rawKey);

    const keyId = genId('key_');
    const now = nowSec();

    db.prepare(
      'INSERT INTO api_keys (id, project_id, key_hash, key_prefix, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(keyId, projectId, hash, prefix, body.name, JSON.stringify(body.scopes), now);

    reply.status(201);
    return {
      id: keyId,
      name: body.name,
      key: rawKey,
      prefix,
      scopes: body.scopes,
      project_id: projectId,
      created_at: now,
      note: 'Store this key securely — it will not be shown again.',
    };
  });

  // GET /v1/keys — list keys (admin scope)
  app.get('/v1/keys', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const rows = db.prepare(
      'SELECT id, project_id, key_prefix, name, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE project_id = ?',
    ).all(key.projectId) as Array<Record<string, unknown>>;

    return {
      items: rows.map(r => ({
        id: r.id,
        project_id: r.project_id,
        prefix: r.key_prefix,
        name: r.name,
        scopes: JSON.parse(r.scopes as string),
        created_at: r.created_at,
        last_used_at: r.last_used_at ?? undefined,
        revoked: r.revoked_at != null,
      })),
    };
  });

  // DELETE /v1/keys/:id — revoke key (admin scope)
  app.delete<{ Params: { id: string } }>('/v1/keys/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const row = db.prepare(
      'SELECT id FROM api_keys WHERE id = ? AND project_id = ? AND revoked_at IS NULL',
    ).get(request.params.id, key.projectId);

    if (!row) return reply.status(404).send({ error: 'Not Found' });

    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowSec(), request.params.id);

    reply.status(204);
    return;
  });
}
