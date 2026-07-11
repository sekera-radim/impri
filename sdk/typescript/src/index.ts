// @impri/sdk — TypeScript SDK for the Impri human-in-the-loop approval API

export { ImpriClient } from './client.js'
export type { ImpriClientOptions } from './client.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  Action,
  ActionCreated,
  ActionStatus,
  ApiKey,
  ApiKeyCreated,
  ApprovedAction,
  CreateActionParams,
  CreateWatcherParams,
  Decision,
  DecisionResult,
  KeyScope,
  ListActionsParams,
  ListWatchersParams,
  PagedResult,
  Preview,
  PreviewFormat,
  Project,
  ProjectExport,
  ResultAck,
  ScoringRule,
  UpdateProjectParams,
  UpdateWatcherParams,
  Watcher,
  WatcherConfig,
  WatcherKind,
  WatcherSchedule,
  WatcherStatus,
  WatcherWithItemCount,
  WebhookDelivery,
} from './types.js'

// ─── Errors ───────────────────────────────────────────────────────────────────

export {
  ImpriError,
  ImpriConfigError,
  ImpriUnauthorized,
  ImpriNotFound,
  ImpriConflict,
  ImpriExpired,
  ImpriRateLimited,
  ImpriQuotaExceeded,
  ImpriRejected,
  ImpriTimeout,
  ImpriValidationError,
  ImpriApiError,
  ImpriWebhookSignatureError,
} from './errors.js'

// ─── Webhook ──────────────────────────────────────────────────────────────────

export { verifyWebhook } from './webhook.js'
