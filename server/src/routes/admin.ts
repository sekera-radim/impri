import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope } from '../auth.js';

// Operator-only platform stats. Restricted to the operator's own project
// (OPERATOR_PROJECT_ID) so no signed-up user can read cross-tenant totals.
// Returns 404 for anyone else, so the endpoint isn't even discoverable.
export function registerAdminRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/admin/stats', async (request, reply) => {
    const key = request.apiKey;
    const operator = process.env.OPERATOR_PROJECT_ID;
    if (!key || !hasScope(key.scopes, 'admin') || !operator || key.projectId !== operator) {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const now = nowSec();
    const count = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { c: number }).c;

    const tierRows = db
      .prepare('SELECT tier, COUNT(*) AS c FROM projects GROUP BY tier')
      .all() as { tier: string | null; c: number }[];
    const byTier: Record<string, number> = {};
    for (const row of tierRows) byTier[row.tier ?? 'free'] = row.c;

    return {
      signups: {
        total: count('SELECT COUNT(*) AS c FROM projects'),
        last_24h: count('SELECT COUNT(*) AS c FROM projects WHERE created_at > ?', now - 86_400),
        last_7d: count('SELECT COUNT(*) AS c FROM projects WHERE created_at > ?', now - 604_800),
        last_30d: count('SELECT COUNT(*) AS c FROM projects WHERE created_at > ?', now - 2_592_000),
      },
      by_tier: byTier,
      paid: (byTier.indie ?? 0) + (byTier.team ?? 0),
      activity: {
        actions_total: count('SELECT COUNT(*) AS c FROM actions'),
        actions_7d: count('SELECT COUNT(*) AS c FROM actions WHERE created_at > ?', now - 604_800),
        watchers: count("SELECT COUNT(*) AS c FROM watchers WHERE status != 'paused'"),
      },
      ts: now,
    };
  });
}
