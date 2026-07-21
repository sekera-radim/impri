import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import type { Tier } from '../billing.js';

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

  // Operator-only daily series for the last N days (dashboard "Stats").
  //
  // Signups, activity and failures are reconstructed from created_at, so history is
  // available retroactively. Paid counts are NOT: projects.tier holds only the CURRENT
  // tier and tier changes aren't versioned, so a past day's paid count is unknowable —
  // it is reported as null for past days rather than back-filled with today's number,
  // which would silently misrepresent growth. Today's row carries the live count.
  app.get('/v1/admin/stats/daily', async (request, reply) => {
    const key = request.apiKey;
    const operator = process.env.OPERATOR_PROJECT_ID;
    if (!key || !hasScope(key.scopes, 'admin') || !operator || key.projectId !== operator) {
      return reply.status(404).send({ error: 'Not Found' });
    }
    const days = Math.min(Math.max(Number((request.query as { days?: string }).days ?? 7) || 7, 1), 90);

    const now = nowSec();
    const one = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { c: number }).c;

    // Dny řežeme na UTC půlnoci, ať je hranice stabilní bez ohledu na timezone volajícího.
    const midnight = Math.floor(now / 86_400) * 86_400;
    const tierRows = db
      .prepare('SELECT tier, COUNT(*) AS c FROM projects GROUP BY tier')
      .all() as { tier: string | null; c: number }[];
    const byTier: Record<string, number> = {};
    for (const r of tierRows) byTier[r.tier ?? 'free'] = r.c;
    const paidNow = (byTier.indie ?? 0) + (byTier.team ?? 0);

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = midnight - i * 86_400;
      const end = start + 86_400;
      const isToday = i === 0;
      series.push({
        date: new Date(start * 1000).toISOString().slice(0, 10),
        // Kumulativní stav ke KONCI dne (u dneška k teď) — růst uživatelské základny.
        signups_total: one('SELECT COUNT(*) AS c FROM projects WHERE created_at < ?', end),
        signups_new: one(
          'SELECT COUNT(*) AS c FROM projects WHERE created_at >= ? AND created_at < ?',
          start,
          end,
        ),
        // Historii tierů DB nedrží → minulé dny null (viz komentář výše).
        paid_total: isToday ? paidNow : null,
        // „Aktivní" = projekt, který ten den založil aspoň jednu akci.
        active: one(
          'SELECT COUNT(DISTINCT project_id) AS c FROM actions WHERE created_at >= ? AND created_at < ?',
          start,
          end,
        ),
        actions: one(
          'SELECT COUNT(*) AS c FROM actions WHERE created_at >= ? AND created_at < ?',
          start,
          end,
        ),
        // Akce toho dne, které SKONČILY chybou a v tom stavu zůstaly (execute_failed je
        // terminální) — přesně ta třída tichých selhání, kterou jinak nikdo nezachytí.
        failed: one(
          "SELECT COUNT(*) AS c FROM actions WHERE status = 'execute_failed' AND created_at >= ? AND created_at < ?",
          start,
          end,
        ),
        // Schválené, ale nikdy nevykonané akce — druhý typ zaseknutí (vykonavatel neběží).
        stuck_approved: one(
          "SELECT COUNT(*) AS c FROM actions WHERE status = 'approved' AND created_at >= ? AND created_at < ?",
          start,
          end,
        ),
      });
    }

    // Konkrétní nevyřešené případy, ať se nemusí dohledávat ručně.
    const unresolved = db
      .prepare(
        `SELECT id, project_id, kind, title, status, created_at
           FROM actions
          WHERE status IN ('execute_failed', 'approved')
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 50`,
      )
      .all(midnight - (days - 1) * 86_400) as unknown[];

    return { days, series, paid_now: paidNow, by_tier: byTier, unresolved, ts: now };
  });

  // Operator-only tier grant — sets a project's tier directly, bypassing
  // Stripe. For comping accounts (e.g. the operator's own working project)
  // where a real subscription doesn't apply. Same 404-if-not-operator gate
  // as /v1/admin/stats. Safe against Stripe reconciliation: applySubscription
  // in billing.ts only ever updates rows matched by stripe_customer_id, so a
  // project with no Stripe customer (the common case here) is never touched
  // by a webhook after this.
  const CompTierBody = z.object({
    project_id: z.string().min(1),
    tier: z.enum(['free', 'indie', 'team']),
    // Seconds until this grant should be considered expired (cosmetic only —
    // current_period_end is displayed but never enforced). Cap at 10 years.
    expires_in: z.number().int().positive().max(10 * 365 * 86_400).optional(),
  });

  app.post('/v1/admin/comp-tier', async (request, reply) => {
    const key = request.apiKey;
    const operator = process.env.OPERATOR_PROJECT_ID;
    if (!key || !hasScope(key.scopes, 'admin') || !operator || key.projectId !== operator) {
      return reply.status(404).send({ error: 'Not Found' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'admin:comp-tier', 10))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 10 requests/min per key' });
    }

    const parsed = CompTierBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const { project_id, expires_in } = parsed.data;
    const tier: Tier = parsed.data.tier;

    const exists = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
    if (!exists) return reply.status(404).send({ error: 'Not Found', message: 'No project with that id' });

    const now = nowSec();
    const periodEnd = expires_in ? now + expires_in : null;
    db.prepare(
      "UPDATE projects SET tier = ?, subscription_status = 'comped', current_period_end = ? WHERE id = ?",
    ).run(tier, periodEnd, project_id);

    // Written to the TARGET project's audit log (not the operator's) so its
    // owner can see who granted the tier and when — same transparency
    // principle as every other audit_log event.
    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'admin.tier_comped', ?, ?, ?)",
    ).run(project_id, key.keyId, JSON.stringify({ tier, expires_at: periodEnd }), now);

    return db.prepare(
      'SELECT id, tier, subscription_status, current_period_end FROM projects WHERE id = ?',
    ).get(project_id);
  });
}
