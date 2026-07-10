import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import { computeNextRunAt } from '../scheduler.js';
import { watcherLimitReached, getProjectBilling, TIER_LIMITS } from '../billing.js';
import { CreateWatcherBody, UpdateWatcherBody, ListWatchersQuery } from '../schemas.js';

function serializeWatcher(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: JSON.parse(row.config as string),
    keywords: JSON.parse(row.keywords as string),
    keywords_none: JSON.parse(row.keywords_none as string),
    min_score: row.min_score,
    schedule: JSON.parse(row.schedule as string),
    status: row.status,
    fail_count: row.fail_count,
    last_error: row.last_error ?? undefined,
    degraded_since: row.degraded_since ?? undefined,
    first_run_done: Boolean(row.first_run_done),
    last_run_at: row.last_run_at ?? undefined,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerWatcherRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/watchers
  app.post('/v1/watchers', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'watchers:create', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    // Tier limit: watcher count (no-op when billing is disabled / self-host)
    if (watcherLimitReached(db, key.projectId)) {
      const tier = getProjectBilling(db, key.projectId).tier;
      return reply.status(402).send({
        error: 'Payment Required',
        message: `Watcher limit reached for the ${tier} plan (${TIER_LIMITS[tier].watchers}). Upgrade to add more.`,
        limit: TIER_LIMITS[tier].watchers,
        tier,
      });
    }

    const parsed = CreateWatcherBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const now = nowSec();
    const id = genId('wat_');
    // First run scheduled immediately so the scheduler can baseline ASAP
    const nextRunAt = now;

    db.prepare(`
      INSERT INTO watchers
        (id, project_id, name, kind, config, keywords, keywords_none, min_score,
         schedule, status, fail_count, first_run_done, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)
    `).run(
      id,
      key.projectId,
      body.name,
      body.kind,
      JSON.stringify(body.config),
      JSON.stringify(body.keywords),
      JSON.stringify(body.keywords_none),
      body.min_score,
      JSON.stringify(body.schedule),
      nextRunAt,
      now,
      now,
    );

    reply.status(201);
    const row = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id) as Record<string, unknown>;
    return serializeWatcher(row);
  });

  // GET /v1/watchers
  app.get('/v1/watchers', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    const parsed = ListWatchersQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const q = parsed.data;

    let sql = 'SELECT * FROM watchers WHERE project_id = ?';
    const params: unknown[] = [key.projectId];

    if (q.status) { sql += ' AND status = ?'; params.push(q.status); }
    if (q.kind) { sql += ' AND kind = ?'; params.push(q.kind); }
    if (q.cursor) { sql += ' AND created_at < ?'; params.push(Number(q.cursor)); }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(q.limit + 1);

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: items.map(r => serializeWatcher(r)),
      has_more: hasMore,
      next_cursor: hasMore ? String(items[items.length - 1].created_at) : undefined,
    };
  });

  // GET /v1/watchers/:id
  app.get<{ Params: { id: string } }>('/v1/watchers/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    const row = db.prepare('SELECT * FROM watchers WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    ) as Record<string, unknown> | undefined;

    if (!row) return reply.status(404).send({ error: 'Not Found' });

    const itemCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM watcher_items WHERE watcher_id = ?').get(
        request.params.id,
      ) as { cnt: number }
    ).cnt;

    return { ...serializeWatcher(row), item_count: itemCount };
  });

  // PATCH /v1/watchers/:id
  app.patch<{ Params: { id: string } }>('/v1/watchers/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    const parsed = UpdateWatcherBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const existing = db.prepare('SELECT * FROM watchers WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    ) as Record<string, unknown> | undefined;

    if (!existing) return reply.status(404).send({ error: 'Not Found' });

    const now = nowSec();
    const currentSchedule = JSON.parse(existing.schedule as string) as {
      every: string;
      jitter?: string;
    };
    const newSchedule = body.schedule
      ? JSON.stringify(body.schedule)
      : (existing.schedule as string);
    const effectiveSchedule = body.schedule ?? currentSchedule;

    // Reactivation: setting status=active resets fail_count, schedules immediately
    const newStatus = body.status ?? (existing.status as string);
    let failCount = existing.fail_count as number;
    let degradedSince = existing.degraded_since as number | null;
    let nextRunAt = existing.next_run_at as number;

    if (body.status === 'active') {
      failCount = 0;
      degradedSince = null;
      nextRunAt = now; // run immediately on reactivation
    } else if (body.status === 'paused') {
      // Keep next_run_at as-is; scheduler won't pick up paused watchers
    } else if (body.schedule) {
      // Schedule changed — recompute next_run_at
      nextRunAt = computeNextRunAt(effectiveSchedule.every, effectiveSchedule.jitter, now);
    }

    db.prepare(`
      UPDATE watchers
      SET name = ?, config = ?, keywords = ?, keywords_none = ?, min_score = ?,
          schedule = ?, status = ?, fail_count = ?, degraded_since = ?,
          next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      body.name ?? existing.name,
      body.config ? JSON.stringify(body.config) : existing.config,
      body.keywords ? JSON.stringify(body.keywords) : existing.keywords,
      body.keywords_none ? JSON.stringify(body.keywords_none) : existing.keywords_none,
      body.min_score !== undefined ? body.min_score : existing.min_score,
      newSchedule,
      newStatus,
      failCount,
      degradedSince,
      nextRunAt,
      now,
      request.params.id,
    );

    const updated = db.prepare('SELECT * FROM watchers WHERE id = ?').get(
      request.params.id,
    ) as Record<string, unknown>;
    return serializeWatcher(updated);
  });

  // DELETE /v1/watchers/:id
  app.delete<{ Params: { id: string } }>('/v1/watchers/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    const existing = db.prepare('SELECT id FROM watchers WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    );

    if (!existing) return reply.status(404).send({ error: 'Not Found' });

    // Cascade: delete watcher_items first (no FK cascade in SQLite for this)
    db.prepare('DELETE FROM watcher_items WHERE watcher_id = ?').run(request.params.id);
    db.prepare('DELETE FROM watchers WHERE id = ?').run(request.params.id);

    reply.status(204);
    return;
  });
}
