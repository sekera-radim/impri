/**
 * Rules engine evaluator.
 *
 * evaluateRules() is called from POST /v1/actions AFTER idempotency/dedup
 * checks and BEFORE the INSERT, so it can mutate expires_in or short-circuit
 * to auto_approve / auto_reject before the action ever becomes pending.
 *
 * Off by default: when a project has no rows in approval_rules the SELECT
 * returns an empty array, the loop body never runs, and we return null.
 * The INSERT in POST /v1/actions then proceeds with status='pending' exactly
 * as it did before the rules engine was introduced.
 */

import type { Db } from './db.js';
import type { CreateActionBody } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DbRule = {
  id: string;
  project_id: string;
  name: string;
  priority: number;
  enabled: number;
  kind_pattern: string;
  payload_conditions: string;  // JSON string
  target_url_hosts: string;    // JSON string
  rule_action: string;
  outcome_params: string;      // JSON string
  created_at: number;
  updated_at: number;
};

type PayloadCondition = {
  path: string;
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'not_in';
  value: unknown;
};

/** A rule with pre-parsed JSON fields and a pre-compiled kindRegex. */
type CompiledRule = {
  id: string;
  name: string;
  priority: number;
  kindRegex: RegExp;
  payloadConditions: PayloadCondition[];
  targetUrlHosts: string[];
  ruleAction: string;
  outcomeParams: Record<string, unknown>;
};

export type RuleResult =
  | { action: 'auto_approve' | 'auto_reject'; ruleId: string; ruleName: string }
  | { action: 'set_expiry'; expiresIn: number; ruleId: string; ruleName: string }
  | { action: 'require_n_approvers'; n: number; ruleId: string; ruleName: string }
  | { action: 'escalate'; channel: string | undefined; ruleId: string; ruleName: string };

// ---------------------------------------------------------------------------
// Per-project rule cache (5-second TTL, invalidated immediately on mutations)
// ---------------------------------------------------------------------------

type CacheEntry = {
  rules: CompiledRule[];
  expiresAt: number;  // Date.now() ms
};

const ruleCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;

/** Called from route handlers after any mutation to /v1/rules. */
export function invalidateRuleCache(projectId: string): void {
  ruleCache.delete(projectId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern (only * and ? wildcards; everything else is literal)
 * to an anchored RegExp. The input must already have been validated by the Zod
 * schema to contain no dangerous regex metacharacters beyond * and ?.
 *
 * Strategy: escape all regex metacharacters except the wildcard chars (* and ?),
 * then replace those bare wildcards with their regex equivalents. Because * and ?
 * are not in the escape character class, they remain as bare chars in the
 * intermediate string, so the second and third replaces find them directly.
 */
function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    // Escape . + ^ $ { } ( ) | [ ] \ — but NOT * or ?, which are handled next.
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')   // * → .*  (glob "any sequence of chars")
    .replace(/\?/g, '.');   // ? → .   (glob "any single char")
  return new RegExp(`^${regexStr}$`);
}

/**
 * Safely traverse a dot-path into an arbitrary JSON value.
 * Returns undefined (not throws) if the key is absent or an intermediate
 * value is null/non-object. This prevents payload_conditions from crashing
 * the action creation flow on unexpected payload shapes.
 */
function resolvePath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Evaluate a single payload condition against a resolved value.
 * Returns false (no match) rather than throwing on type mismatches.
 */
function matchCondition(actual: unknown, op: PayloadCondition['op'], ruleValue: unknown): boolean {
  if (actual === undefined || actual === null) return false;

  switch (op) {
    case 'eq':
      return actual === ruleValue;
    case 'lt':
      return typeof actual === 'number' && typeof ruleValue === 'number' && actual < ruleValue;
    case 'lte':
      return typeof actual === 'number' && typeof ruleValue === 'number' && actual <= ruleValue;
    case 'gt':
      return typeof actual === 'number' && typeof ruleValue === 'number' && actual > ruleValue;
    case 'gte':
      return typeof actual === 'number' && typeof ruleValue === 'number' && actual >= ruleValue;
    case 'contains':
      if (typeof actual === 'string' && typeof ruleValue === 'string') {
        return actual.includes(ruleValue);
      }
      if (Array.isArray(actual)) {
        return actual.includes(ruleValue);
      }
      return false;
    case 'in':
      return Array.isArray(ruleValue) && ruleValue.includes(actual);
    case 'not_in':
      return Array.isArray(ruleValue) && !ruleValue.includes(actual);
    default:
      return false;
  }
}

/** Compile a raw DB row into a CompiledRule with a prebuilt regex and parsed JSON. */
function compileRule(row: DbRule): CompiledRule {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    kindRegex: globToRegex(row.kind_pattern),
    payloadConditions: JSON.parse(row.payload_conditions) as PayloadCondition[],
    targetUrlHosts: JSON.parse(row.target_url_hosts) as string[],
    ruleAction: row.rule_action,
    outcomeParams: JSON.parse(row.outcome_params) as Record<string, unknown>,
  };
}

/** Load rules for a project, using the 5-second per-project cache. */
function loadRules(db: Db, projectId: string): CompiledRule[] {
  const cached = ruleCache.get(projectId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.rules;
  }

  const rows = db.prepare(
    'SELECT * FROM approval_rules WHERE project_id = ? AND enabled = 1 ORDER BY priority ASC',
  ).all(projectId) as DbRule[];

  const compiled = rows.map(compileRule);
  ruleCache.set(projectId, { rules: compiled, expiresAt: Date.now() + CACHE_TTL_MS });
  return compiled;
}

// ---------------------------------------------------------------------------
// Public evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate the enabled rules for `projectId` against the incoming action body.
 *
 * Returns a RuleResult describing the first matching rule, or null if no rule
 * matched. The caller is responsible for acting on the result.
 *
 * Zero-rule guarantee: if the project has no enabled rules, this function
 * returns null on every call and the caller's default (status='pending') is
 * preserved byte-for-byte.
 */
export function evaluateRules(
  db: Db,
  projectId: string,
  body: CreateActionBody,
): RuleResult | null {
  const rules = loadRules(db, projectId);

  for (const rule of rules) {
    // --- kind_pattern ---
    if (!rule.kindRegex.test(body.kind)) continue;

    // --- payload_conditions (ALL must match) ---
    let payloadOk = true;
    if (rule.payloadConditions.length > 0) {
      const payload = body.payload ?? null;
      for (const cond of rule.payloadConditions) {
        const actual = resolvePath(payload, cond.path);
        if (!matchCondition(actual, cond.op, cond.value)) {
          payloadOk = false;
          break;
        }
      }
    }
    if (!payloadOk) continue;

    // --- target_url_hosts ---
    if (rule.targetUrlHosts.length > 0) {
      if (!body.target_url) continue;  // no URL on the action → skip rule
      let hostname: string;
      try {
        hostname = new URL(body.target_url).hostname.toLowerCase();
      } catch {
        continue;  // unparseable URL → skip rule (should not happen after Zod)
      }
      if (!rule.targetUrlHosts.map(h => h.toLowerCase()).includes(hostname)) continue;
    }

    // --- All conditions matched — return the outcome ---
    const p = rule.outcomeParams;
    switch (rule.ruleAction) {
      case 'auto_approve':
      case 'auto_reject':
        return { action: rule.ruleAction as 'auto_approve' | 'auto_reject', ruleId: rule.id, ruleName: rule.name };

      case 'set_expiry':
        return { action: 'set_expiry', expiresIn: p.expires_in as number, ruleId: rule.id, ruleName: rule.name };

      case 'require_n_approvers':
        return { action: 'require_n_approvers', n: p.n as number, ruleId: rule.id, ruleName: rule.name };

      case 'escalate':
        return { action: 'escalate', channel: typeof p.channel === 'string' ? p.channel : undefined, ruleId: rule.id, ruleName: rule.name };

      default:
        // Unknown action — skip (forward-compatibility: don't crash on new action types)
        continue;
    }
  }

  return null;
}
