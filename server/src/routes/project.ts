import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope } from '../auth.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const UpdateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).max(100).refine(isValidTimezone, 'Invalid IANA timezone').optional(),
});

export function registerProjectRoutes(app: FastifyInstance, db: Db): void {
  // GET /v1/project — includes the webhook signing secret so an integration
  // can verify X-Impri-Signature. Admin scope only (it's a credential).
  app.get('/v1/project', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const row = db.prepare('SELECT id, name, timezone, webhook_secret, created_at FROM projects WHERE id = ?')
      .get(key.projectId) as Record<string, unknown> | undefined;
    if (!row) return reply.status(404).send({ error: 'Not Found' });
    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      webhook_secret: row.webhook_secret ?? undefined,
      created_at: row.created_at,
    };
  });

  // PATCH /v1/project — update name / timezone (timezone drives watcher windows)
  app.patch('/v1/project', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const parsed = UpdateProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const { name, timezone } = parsed.data;
    if (name !== undefined) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, key.projectId);
    if (timezone !== undefined) db.prepare('UPDATE projects SET timezone = ? WHERE id = ?').run(timezone, key.projectId);

    const row = db.prepare('SELECT id, name, timezone FROM projects WHERE id = ?').get(key.projectId);
    return row;
  });

  // POST /v1/project/rotate-webhook-secret — invalidates the old secret
  app.post('/v1/project/rotate-webhook-secret', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const secret = randomBytes(32).toString('base64url');
    db.prepare('UPDATE projects SET webhook_secret = ? WHERE id = ?').run(secret, key.projectId);
    return { webhook_secret: secret, note: 'Update your webhook verification with this new secret.' };
  });

  // GET /v1/project/export — GDPR data export (everything scoped to the project)
  app.get('/v1/project/export', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const pid = key.projectId;
    const all = (sql: string) => db.prepare(sql).all(pid);
    return {
      exported_at: nowSec(),
      project: db.prepare('SELECT id, name, timezone, created_at FROM projects WHERE id = ?').get(pid),
      actions: all('SELECT * FROM actions WHERE project_id = ?'),
      decisions: all(
        'SELECT d.* FROM decisions d JOIN actions a ON a.id = d.action_id WHERE a.project_id = ?',
      ),
      watchers: all('SELECT * FROM watchers WHERE project_id = ?'),
      audit_log: all('SELECT * FROM audit_log WHERE project_id = ?'),
    };
  });

  // DELETE /v1/project/data — GDPR erasure. Wipes content + PII but keeps the
  // project and its API keys so the account keeps working.
  app.delete('/v1/project/data', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const pid = key.projectId;
    const erase = db.transaction(() => {
      db.prepare(
        'DELETE FROM webhook_deliveries WHERE action_id IN (SELECT id FROM actions WHERE project_id = ?)',
      ).run(pid);
      db.prepare(
        'DELETE FROM decisions WHERE action_id IN (SELECT id FROM actions WHERE project_id = ?)',
      ).run(pid);
      db.prepare(
        'DELETE FROM watcher_items WHERE watcher_id IN (SELECT id FROM watchers WHERE project_id = ?)',
      ).run(pid);
      const actions = db.prepare('DELETE FROM actions WHERE project_id = ?').run(pid).changes;
      const watchers = db.prepare('DELETE FROM watchers WHERE project_id = ?').run(pid).changes;
      db.prepare('DELETE FROM audit_log WHERE project_id = ?').run(pid);
      db.prepare('DELETE FROM pii_log WHERE project_id = ?').run(pid);
      return { actions, watchers };
    });
    const counts = erase();
    return { erased: true, ...counts };
  });
}
