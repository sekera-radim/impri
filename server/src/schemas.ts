import { z } from 'zod';

export const PreviewSchema = z.object({
  format: z.enum(['markdown', 'plain', 'diff']).default('plain'),
  body: z.string().max(256 * 1024),
});
export type Preview = z.infer<typeof PreviewSchema>;

export const CreateActionBody = z.object({
  kind: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  preview: PreviewSchema,
  payload: z.unknown().optional(),
  target_url: z.string().url().optional(),
  callback_url: z.string().url().optional(),
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
  project_id: z.string().optional(),
});
export type CreateKeyBody = z.infer<typeof CreateKeyBody>;

// --- Watcher schemas ---

export const ScoringRule = z.object({
  pattern: z.string().min(1).max(500),
  points: z.number().int().min(1).max(100),
});
export type ScoringRule = z.infer<typeof ScoringRule>;

export const WatcherSchedule = z.object({
  every: z.string().regex(/^\d+[mhd]$/, 'Invalid duration (e.g. "8h", "30m", "1d")'),
  jitter: z.string().regex(/^\d+[mhd]$/).optional(),
  window: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Invalid window (e.g. "06:00-22:00")').optional(),
});
export type WatcherSchedule = z.infer<typeof WatcherSchedule>;

const WatcherConfig = z.object({
  url: z.string().url().optional(),
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
  keywords_none: z.array(z.string().min(1).max(500)).default([]),
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
  keywords_none: z.array(z.string().min(1).max(500)).optional(),
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
