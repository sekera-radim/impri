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
  edits: z.record(z.unknown()).optional(),
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
  scopes: z.array(z.enum(['actions', 'admin'])).min(1),
  project_id: z.string().optional(),
});
export type CreateKeyBody = z.infer<typeof CreateKeyBody>;
