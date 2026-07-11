import { z } from 'zod';
import { isIP } from 'node:net';
import { isPrivateIp } from './net-guard.js';
import safeRegex from 'safe-regex';

// Only http/https — z.string().url() also accepts javascript:/data:/file:,
// which would become an XSS sink when rendered as an "Open" link in the UI.
const httpUrl = (msg = 'Only http/https URLs are allowed') =>
  z.string().url().refine(u => /^https?:\/\//i.test(u), msg);

export const PreviewSchema = z.object({
  format: z.enum(['markdown', 'plain', 'diff']).default('plain'),
  body: z.string().max(256 * 1024),
});
export type Preview = z.infer<typeof PreviewSchema>;

export const CreateActionBody = z.object({
  kind: z.string().min(1).max(100),
  // No CR/LF — title flows into notification headers (ntfy Title:, email
  // subject); a newline there is HTTP header / email header injection.
  title: z.string().min(1).max(500).regex(/^[^\r\n]+$/, 'Title must not contain newlines'),
  preview: PreviewSchema,
  payload: z.unknown().optional(),
  target_url: httpUrl().optional(),
  callback_url: httpUrl().optional(),
  expires_in: z.number().int().min(300).max(30 * 24 * 3600).default(72 * 3600),
  idempotency_key: z.string().max(255).optional(),
  editable: z.array(z.string()).default([]),
});
export type CreateActionBody = z.infer<typeof CreateActionBody>;

export const ActionStatus = z.enum([
  'pending', 'approved', 'rejected', 'expired', 'executed', 'execute_failed',
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const DecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  // dot-path keys matching the action's `editable` whitelist (e.g. "preview.body")
  edited: z.record(z.unknown()).optional(),
  channel: z.string().optional(),
});
export type DecisionBody = z.infer<typeof DecisionBody>;

export const ResultBody = z.object({
  status: z.enum(['executed', 'execute_failed']),
  detail: z.string().optional(),
});
export type ResultBody = z.infer<typeof ResultBody>;

export const PushSubscribeBody = z.object({
  endpoint: httpUrl().refine(u => /^https:\/\//i.test(u), 'endpoint must be https'),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

export const ListActionsQuery = z.object({
  status: ActionStatus.optional(),
  since: z.coerce.number().int().optional(),
  kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListActionsQuery = z.infer<typeof ListActionsQuery>;

export const CreateKeyBody = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['actions', 'watch', 'admin'])).min(1),
  // No project_id: a key always belongs to the caller's project. Accepting a
  // client-supplied project_id let an admin key mint keys into another project.
});
export type CreateKeyBody = z.infer<typeof CreateKeyBody>;

// --- Watcher schemas ---

// Reject ReDoS-prone regex patterns at the boundary. Patterns that don't parse
// as a regex are matched literally at runtime (scheduler matchesPattern), so
// they're safe to allow.
function isSafePattern(p: string): boolean {
  try {
    return safeRegex(p);
  } catch {
    return true;
  }
}
const keywordPattern = z.string().min(1).max(500).refine(isSafePattern, 'Pattern is too complex (possible ReDoS)');

export const ScoringRule = z.object({
  pattern: keywordPattern,
  points: z.number().int().min(1).max(100),
});
export type ScoringRule = z.infer<typeof ScoringRule>;

const DURATION_UNIT_SEC: Record<string, number> = { m: 60, h: 3600, d: 86_400 };
export function durationToSec(s: string): number {
  const unit = s.slice(-1);
  return parseInt(s.slice(0, -1), 10) * (DURATION_UNIT_SEC[unit] ?? 0);
}

export const WatcherSchedule = z.object({
  // Min 60s: "0m" would otherwise fire every scheduler tick and hammer the
  // source (rate-ban risk); anything below the tick is meaningless anyway.
  every: z.string().regex(/^\d+[mhd]$/, 'Invalid duration (e.g. "8h", "30m", "1d")')
    .refine(v => durationToSec(v) >= 60, 'Minimum interval is 60 seconds'),
  jitter: z.string().regex(/^\d+[mhd]$/).optional(),
  window: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Invalid window (e.g. "06:00-22:00")').optional(),
});
export type WatcherSchedule = z.infer<typeof WatcherSchedule>;

const WatcherConfig = z.object({
  url: z.string().url().refine(v => {
    try {
      const u = new URL(v);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const host = u.hostname.replace(/^\[|\]$/g, '');
      return !(isIP(host) && isPrivateIp(host));
    } catch {
      return false;
    }
  }, 'Only http/https URLs to non-private addresses are allowed').optional(),
  query: z.string().min(1).max(500).optional(),
  subreddit: z.string().min(1).max(100).optional(),
});

export const WatcherKind = z.enum(['rss', 'reddit_search', 'url_diff']);
export type WatcherKind = z.infer<typeof WatcherKind>;

export const CreateWatcherBody = z.object({
  name: z.string().min(1).max(200),
  kind: WatcherKind,
  config: WatcherConfig,
  keywords: z.array(ScoringRule).default([]),
  keywords_none: z.array(keywordPattern).default([]),
  min_score: z.number().int().min(0).default(1),
  schedule: WatcherSchedule,
}).superRefine((data, ctx) => {
  if (data.kind === 'rss' || data.kind === 'url_diff') {
    if (!data.config.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'url'],
        message: `"url" is required for kind "${data.kind}"`,
      });
    } else {
      try {
        const u = new URL(data.config.url);
        if (!['http:', 'https:'].includes(u.protocol)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'url'],
            message: 'Only http/https URLs are allowed',
          });
        } else {
          // Reject obvious private-IP literals at create time (defense in
          // depth; DNS-resolving hostnames are caught by the SSRF guard at
          // fetch time). PLAYBOOK B1.
          const host = u.hostname.replace(/^\[|\]$/g, '');
          if (isIP(host) && isPrivateIp(host)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['config', 'url'],
              message: `Blocked private address: ${host}`,
            });
          }
        }
      } catch {
        // URL format already validated by z.string().url()
      }
    }
  }
  if (data.kind === 'reddit_search') {
    if (!data.config.subreddit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'subreddit'],
        message: '"subreddit" is required for kind "reddit_search"',
      });
    }
    if (!data.config.query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'query'],
        message: '"query" is required for kind "reddit_search"',
      });
    }
  }
});
export type CreateWatcherBody = z.infer<typeof CreateWatcherBody>;

export const UpdateWatcherBody = z.object({
  name: z.string().min(1).max(200).optional(),
  config: WatcherConfig.optional(),
  keywords: z.array(ScoringRule).optional(),
  keywords_none: z.array(keywordPattern).optional(),
  min_score: z.number().int().min(0).optional(),
  schedule: WatcherSchedule.optional(),
  // Only active/paused allowed via API; degraded is set by the scheduler
  status: z.enum(['active', 'paused']).optional(),
});
export type UpdateWatcherBody = z.infer<typeof UpdateWatcherBody>;

export const ListWatchersQuery = z.object({
  status: z.enum(['active', 'paused', 'degraded']).optional(),
  kind: WatcherKind.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListWatchersQuery = z.infer<typeof ListWatchersQuery>;

// --- Rules engine schemas ---

export const PayloadCondition = z.object({
  path:  z.string().min(1).max(200),
  op:    z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'not_in']),
  value: z.unknown(),
});
export type PayloadCondition = z.infer<typeof PayloadCondition>;

export const RuleAction = z.enum([
  'auto_approve', 'auto_reject', 'require_n_approvers', 'set_expiry', 'escalate',
]);
export type RuleAction = z.infer<typeof RuleAction>;

// Shared validation for rule outcome_params and kind_pattern — applied to both
// CreateRuleBody and UpdateRuleBody so a malformed PATCH cannot bypass the
// guards that CREATE enforces. Parameters are typed loosely to accept both the
// required-field shape (Create) and the optional-field shape (Update).
function applyRuleOutcomeValidation(
  data: {
    rule_action?: string;
    outcome_params?: Record<string, unknown>;
    kind_pattern?: string;
  },
  ctx: z.RefinementCtx,
): void {
  // Validate outcome_params shape per action type
  if (data.rule_action === 'require_n_approvers') {
    const n = data.outcome_params?.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome_params', 'n'],
        message: '"n" must be an integer 2–100 for require_n_approvers',
      });
    }
  }
  if (data.rule_action === 'set_expiry') {
    const ei = data.outcome_params?.expires_in;
    if (typeof ei !== 'number' || !Number.isInteger(ei) || ei < 300 || ei > 30 * 24 * 3600) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome_params', 'expires_in'],
        message: '"expires_in" must be an integer 300–2592000 for set_expiry',
      });
    }
  }
  if (data.rule_action === 'escalate') {
    const channel = data.outcome_params?.channel;
    // Channel is interpolated directly into the ntfy topic URL path; restrict to
    // safe characters to prevent path traversal / URL injection.
    if (typeof channel !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(channel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome_params', 'channel'],
        message: '"channel" must be 1–64 alphanumeric, underscore, or hyphen characters',
      });
    }
  }
  // kind_pattern glob safety: reject characters that become dangerous regex metacharacters
  // (. is allowed — it's literal in globs and becomes \. after escaping, which is safe).
  if (data.kind_pattern !== undefined && /[+^${}()|[\]\\]/.test(data.kind_pattern.replace(/[*?]/g, ''))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kind_pattern'],
      message: 'kind_pattern supports only * and ? wildcards; unsafe characters rejected',
    });
  }
}

export const CreateRuleBody = z.object({
  name:               z.string().min(1).max(200),
  priority:           z.number().int().min(1).max(9999).default(100),
  enabled:            z.boolean().default(true),
  // kind_pattern: glob with * and ? wildcards only. Dots are allowed (common in
  // kind names like "email.send") but characters that would become dangerous regex
  // metacharacters (+, ^, $, {, }, (, ), |, [, ], \) are rejected to prevent ReDoS.
  kind_pattern:       z.string().min(1).max(100).default('*'),
  payload_conditions: z.array(PayloadCondition).max(20).default([]),
  target_url_hosts:   z.array(z.string().min(1).max(253)).max(50).default([]),
  rule_action:        RuleAction,
  outcome_params:     z.record(z.unknown()).default({}),
}).superRefine(applyRuleOutcomeValidation);
export type CreateRuleBody = z.infer<typeof CreateRuleBody>;

export const UpdateRuleBody = z.object({
  name:               z.string().min(1).max(200).optional(),
  priority:           z.number().int().min(1).max(9999).optional(),
  enabled:            z.boolean().optional(),
  kind_pattern:       z.string().min(1).max(100).optional(),
  payload_conditions: z.array(PayloadCondition).max(20).optional(),
  target_url_hosts:   z.array(z.string().min(1).max(253)).max(50).optional(),
  rule_action:        RuleAction.optional(),
  outcome_params:     z.record(z.unknown()).optional(),
}).superRefine(applyRuleOutcomeValidation);
export type UpdateRuleBody = z.infer<typeof UpdateRuleBody>;
