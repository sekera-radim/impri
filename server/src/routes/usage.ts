/**
 * GET /v1/usage — per-project usage snapshot for the current billing period.
 *
 * Auth: requires admin scope. project_id is always derived from the verified
 * API key — never from the request body or query string.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import {
  billingActive,
  getProjectBilling,
  getUsage,
  monthStartSec,
  TIER_LIMITS,
  type Tier,
} from '../billing.js';

/**
 * First second of the UTC calendar month that follows the month containing `now`.
 */
function nextMonthStartSec(now = nowSec()): number {
  const d = new Date(now * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

export function registerUsageRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/usage', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    // Rate-limit: 60/min — not a hot path, same ceiling as actions:decide.
    if (!(await checkRateLimit(db, key.keyId, 'usage:get', 60))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 60 requests/min per key' });
    }

    const projectId = key.projectId;
    const billing = getProjectBilling(db, projectId);
    const tier = billing.tier as Tier;
    const limits = TIER_LIMITS[tier];

    const periodStart = monthStartSec();
    const periodEnd = nextMonthStartSec();

    // Actions breakdown for the current period
    const createdThisPeriod = (db.prepare(
      'SELECT COUNT(*) AS cnt FROM actions WHERE project_id = ? AND created_at >= ?',
    ).get(projectId, periodStart) as { cnt: number }).cnt;

    // Period-scoped so the per-status counts sum exactly to created_this_period
    // (every action created this period is in exactly one status). Without the
    // created_at filter the breakdown counted all-time actions and no longer
    // added up to "created this period".
    const actionsByStatus = (db.prepare(
      'SELECT status, COUNT(*) AS cnt FROM actions WHERE project_id = ? AND created_at >= ? GROUP BY status',
    ).all(projectId, periodStart) as { status: string; cnt: number }[]).reduce(
      (acc, row) => { acc[row.status] = row.cnt; return acc; },
      {} as Record<string, number>,
    );

    // Approvals (decisions made this period) — reuse billing.getUsage for
    // consistency with the value billed on.
    const usage = getUsage(db, projectId);
    const approvalsUsed = usage.approvals.used;
    const approvalsLimit = limits.approvalsPerMonth;

    // Watchers breakdown
    const watcherRows = (db.prepare(
      'SELECT status, COUNT(*) AS cnt FROM watchers WHERE project_id = ? GROUP BY status',
    ).all(projectId) as { status: string; cnt: number }[]).reduce(
      (acc, row) => { acc[row.status] = row.cnt; return acc; },
      {} as Record<string, number>,
    );
    const watcherActive = watcherRows['active'] ?? 0;
    const watcherDegraded = watcherRows['degraded'] ?? 0;
    const watcherPaused = watcherRows['paused'] ?? 0;
    const watcherTotal = watcherActive + watcherDegraded + watcherPaused;
    const watcherLimit = limits.watchers;

    // Webhook delivery breakdown — scoped to this project via action join.
    const webhookPending = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM webhook_deliveries wd JOIN actions a ON a.id = wd.action_id WHERE a.project_id = ? AND wd.status = 'pending'",
    ).get(projectId) as { cnt: number }).cnt;
    const webhookRetry = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM webhook_deliveries wd JOIN actions a ON a.id = wd.action_id WHERE a.project_id = ? AND wd.status = 'retry'",
    ).get(projectId) as { cnt: number }).cnt;
    const webhookDlq = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM webhook_deliveries wd JOIN actions a ON a.id = wd.action_id WHERE a.project_id = ? AND wd.status = 'dlq'",
    ).get(projectId) as { cnt: number }).cnt;

    const ts = nowSec();

    const hasRecoveryCode = (db.prepare(
      'SELECT recovery_hash FROM projects WHERE id = ?',
    ).get(projectId) as { recovery_hash: string | null } | undefined)?.recovery_hash != null;

    return {
      project_id: projectId,
      has_recovery_code: hasRecoveryCode,
      billing_active: billingActive(),
      tier,
      subscription_status: billing.subscription_status,
      current_period_end: billing.current_period_end,

      period: {
        start: periodStart,
        end: periodEnd,
      },

      actions: {
        created_this_period: createdThisPeriod,
        pending: actionsByStatus['pending'] ?? 0,
        approved: actionsByStatus['approved'] ?? 0,
        rejected: actionsByStatus['rejected'] ?? 0,
        expired: actionsByStatus['expired'] ?? 0,
        executed: actionsByStatus['executed'] ?? 0,
        execute_failed: actionsByStatus['execute_failed'] ?? 0,
      },

      approvals: {
        used: approvalsUsed,
        limit: approvalsLimit,
        remaining: approvalsLimit === null ? null : Math.max(0, approvalsLimit - approvalsUsed),
      },

      watchers: {
        active: watcherActive,
        degraded: watcherDegraded,
        paused: watcherPaused,
        total: watcherTotal,
        limit: watcherLimit,
        remaining: watcherLimit === null ? null : Math.max(0, watcherLimit - watcherActive),
      },

      limits: {
        approvals_per_month: limits.approvalsPerMonth,
        watchers: limits.watchers,
        min_watcher_interval_sec: limits.minWatcherIntervalSec,
      },

      webhook_delivery: {
        dlq_size: webhookDlq,
        pending: webhookPending,
        in_retry: webhookRetry,
      },

      ts,
    };
  });
}
