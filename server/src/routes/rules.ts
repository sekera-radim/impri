import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope } from '../auth.js';
import { CreateRuleBody, UpdateRuleBody } from '../schemas.js';
import { invalidateRuleCache } from '../rules.js';

type DbRule = {
  id: string;
  project_id: string;
  name: string;
  priority: number;
  enabled: number;
  kind_pattern: string;
  payload_conditions: string;
  target_url_hosts: string;
  rule_action: string;
  outcome_params: string;
  created_at: number;
  updated_at: number;
};

function serializeRule(row: DbRule) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled === 1,
    kind_pattern: row.kind_pattern,
    payload_conditions: JSON.parse(row.payload_conditions),
    target_url_hosts: JSON.parse(row.target_url_hosts),
    rule_action: row.rule_action,
    outcome_params: JSON.parse(row.outcome_params),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerRuleRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/rules — create a new rule (admin scope)
  app.post('/v1/rules', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const parsed = CreateRuleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // Enforce max 50 rules per project to bound the O(n) scan per action creation
    const count = (db.prepare(
      'SELECT COUNT(*) AS c FROM approval_rules WHERE project_id = ?',
    ).get(key.projectId) as { c: number }).c;
    if (count >= 50) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Project has reached the maximum of 50 rules. Delete an existing rule before creating a new one.',
      });
    }

    const id = genId('rul_');
    const now = nowSec();

    db.prepare(`
      INSERT INTO approval_rules
        (id, project_id, name, priority, enabled, kind_pattern,
         payload_conditions, target_url_hosts, rule_action, outcome_params,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key.projectId,
      body.name,
      body.priority,
      body.enabled ? 1 : 0,
      body.kind_pattern,
      JSON.stringify(body.payload_conditions),
      JSON.stringify(body.target_url_hosts),
      body.rule_action,
      JSON.stringify(body.outcome_params),
      now,
      now,
    );

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, actor, data, created_at) VALUES (?, NULL, 'rule.created', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ rule_id: id }), now);

    invalidateRuleCache(key.projectId);

    const row = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(id) as DbRule;
    reply.status(201);
    return serializeRule(row);
  });

  // GET /v1/rules — list rules ordered by priority ASC (admin scope)
  app.get('/v1/rules', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const rows = db.prepare(
      'SELECT * FROM approval_rules WHERE project_id = ? ORDER BY priority ASC',
    ).all(key.projectId) as DbRule[];

    return { items: rows.map(serializeRule) };
  });

  // GET /v1/rules/:id — get one rule (admin scope)
  app.get<{ Params: { id: string } }>('/v1/rules/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const row = db.prepare(
      'SELECT * FROM approval_rules WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as DbRule | undefined;

    if (!row) return reply.status(404).send({ error: 'Not Found' });

    return serializeRule(row);
  });

  // PATCH /v1/rules/:id — partial update (admin scope)
  // outcome_params is replaced atomically — caller must always send the full object.
  app.patch<{ Params: { id: string } }>('/v1/rules/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const existing = db.prepare(
      'SELECT * FROM approval_rules WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as DbRule | undefined;
    if (!existing) return reply.status(404).send({ error: 'Not Found' });

    const parsed = UpdateRuleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const now = nowSec();

    db.prepare(`
      UPDATE approval_rules SET
        name               = ?,
        priority           = ?,
        enabled            = ?,
        kind_pattern       = ?,
        payload_conditions = ?,
        target_url_hosts   = ?,
        rule_action        = ?,
        outcome_params     = ?,
        updated_at         = ?
      WHERE id = ? AND project_id = ?
    `).run(
      body.name                !== undefined ? body.name                : existing.name,
      body.priority            !== undefined ? body.priority            : existing.priority,
      body.enabled             !== undefined ? (body.enabled ? 1 : 0)  : existing.enabled,
      body.kind_pattern        !== undefined ? body.kind_pattern        : existing.kind_pattern,
      body.payload_conditions  !== undefined ? JSON.stringify(body.payload_conditions) : existing.payload_conditions,
      body.target_url_hosts    !== undefined ? JSON.stringify(body.target_url_hosts)   : existing.target_url_hosts,
      body.rule_action         !== undefined ? body.rule_action         : existing.rule_action,
      body.outcome_params      !== undefined ? JSON.stringify(body.outcome_params)     : existing.outcome_params,
      now,
      request.params.id,
      key.projectId,
    );

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, actor, data, created_at) VALUES (?, NULL, 'rule.updated', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ rule_id: request.params.id }), now);

    invalidateRuleCache(key.projectId);

    const updated = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(request.params.id) as DbRule;
    return serializeRule(updated);
  });

  // DELETE /v1/rules/:id — permanently delete a rule (admin scope)
  app.delete<{ Params: { id: string } }>('/v1/rules/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const existing = db.prepare(
      'SELECT id FROM approval_rules WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId);
    if (!existing) return reply.status(404).send({ error: 'Not Found' });

    const now = nowSec();

    db.prepare('DELETE FROM approval_rules WHERE id = ? AND project_id = ?').run(
      request.params.id,
      key.projectId,
    );

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, actor, data, created_at) VALUES (?, NULL, 'rule.deleted', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ rule_id: request.params.id }), now);

    invalidateRuleCache(key.projectId);

    reply.status(204);
    return;
  });
}
