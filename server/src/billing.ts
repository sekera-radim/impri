import Stripe from 'stripe';
import type { Db } from './db.js';
import { nowSec } from './db.js';

// Billing is OPT-IN via env. With no STRIPE_SECRET_KEY the whole product runs
// as free/self-host: no limits enforced, no checkout — exactly the open-core
// promise. Cloud sets the keys and every project gets a tier + Stripe customer.

// Read env dynamically so tests can toggle billing and deployments can set keys
// before boot without import-order surprises.
export function billingActive(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? '').length > 0;
}
export function webhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET ?? '';
}

let _stripe: Stripe | null = null;
export function getStripe(): Stripe | null {
  if (!billingActive()) return null;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  return _stripe;
}

export type Tier = 'free' | 'indie' | 'team';

// null = unlimited
export interface TierLimits {
  watchers: number | null;
  approvalsPerMonth: number | null;
  minWatcherIntervalSec: number;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { watchers: 3, approvalsPerMonth: 100, minWatcherIntervalSec: 15 * 60 },
  indie: { watchers: 20, approvalsPerMonth: 2000, minWatcherIntervalSec: 5 * 60 },
  team: { watchers: null, approvalsPerMonth: null, minWatcherIntervalSec: 60 },
};

// Map a Stripe price id to a tier (both billing periods point at the same tier).
export function priceToTier(priceId: string): Tier | null {
  const map: Record<string, Tier> = {};
  const add = (env: string | undefined, tier: Tier) => { if (env) map[env] = tier; };
  add(process.env.STRIPE_PRICE_INDIE, 'indie');
  add(process.env.STRIPE_PRICE_INDIE_YEARLY, 'indie');
  add(process.env.STRIPE_PRICE_TEAM, 'team');
  add(process.env.STRIPE_PRICE_TEAM_YEARLY, 'team');
  return map[priceId] ?? null;
}

export function priceIdFor(plan: 'indie' | 'team', period: 'monthly' | 'yearly'): string | null {
  const key =
    plan === 'indie'
      ? (period === 'yearly' ? 'STRIPE_PRICE_INDIE_YEARLY' : 'STRIPE_PRICE_INDIE')
      : (period === 'yearly' ? 'STRIPE_PRICE_TEAM_YEARLY' : 'STRIPE_PRICE_TEAM');
  return process.env[key] ?? null;
}

export interface ProjectBilling {
  tier: Tier;
  subscription_status: string | null;
  current_period_end: number | null;
  stripe_customer_id: string | null;
}

export function getProjectBilling(db: Db, projectId: string): ProjectBilling {
  const row = db.prepare(
    'SELECT tier, subscription_status, current_period_end, stripe_customer_id FROM projects WHERE id = ?',
  ).get(projectId) as ProjectBilling | undefined;
  return {
    tier: (row?.tier as Tier) ?? 'free',
    subscription_status: row?.subscription_status ?? null,
    current_period_end: row?.current_period_end ?? null,
    stripe_customer_id: row?.stripe_customer_id ?? null,
  };
}

// Start of the current UTC calendar month, in unix seconds.
export function monthStartSec(now = nowSec()): number {
  const d = new Date(now * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

export interface Usage {
  watchers: { used: number; limit: number | null };
  approvals: { used: number; limit: number | null };
}

export function getUsage(db: Db, projectId: string): Usage {
  const tier = getProjectBilling(db, projectId).tier;
  const limits = TIER_LIMITS[tier];

  const watchers = (db.prepare(
    "SELECT COUNT(*) AS c FROM watchers WHERE project_id = ? AND status != 'paused'",
  ).get(projectId) as { c: number }).c;

  // "approvals" = decisions made this month (the value-metric we bill on)
  const approvals = (db.prepare(
    `SELECT COUNT(*) AS c FROM decisions d
       JOIN actions a ON a.id = d.action_id
      WHERE a.project_id = ? AND d.decided_at >= ?`,
  ).get(projectId, monthStartSec()) as { c: number }).c;

  return {
    watchers: { used: watchers, limit: limits.watchers },
    approvals: { used: approvals, limit: limits.approvalsPerMonth },
  };
}

/** True when the project is at/over its watcher limit (billing enabled only). */
export function watcherLimitReached(db: Db, projectId: string): boolean {
  if (!billingActive()) return false;
  const { watchers } = getUsage(db, projectId);
  return watchers.limit !== null && watchers.used >= watchers.limit;
}

/** True when the project is at/over its monthly approvals limit. */
export function approvalsLimitReached(db: Db, projectId: string): boolean {
  if (!billingActive()) return false;
  const { approvals } = getUsage(db, projectId);
  return approvals.limit !== null && approvals.used >= approvals.limit;
}
