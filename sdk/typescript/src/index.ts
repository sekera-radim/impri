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
  BulkDecisionRequest,
  BulkDecisionResponse,
  BulkDecisionResult,
  ChannelConfig,
  ChannelTestResult,
  ChannelType,
  CreateActionParams,
  CreateNotificationChannelParams,
  CreateWatcherFromPresetParams,
  CreateWatcherParams,
  Decision,
  DecisionResult,
  DiscordChannelConfig,
  EmailChannelConfig,
  KeyScope,
  ListActionsParams,
  ListWatchersParams,
  NotificationChannel,
  NtfyChannelConfig,
  PagedResult,
  Preview,
  PresetParam,
  PreviewFormat,
  Project,
  ProjectExport,
  ResultAck,
  ScoringRule,
  SlackChannelConfig,
  TelegramChannelConfig,
  UpdateNotificationChannelParams,
  UpdateProjectParams,
  UpdateWatcherParams,
  Watcher,
  WatcherConfig,
  WatcherKind,
  WatcherPreset,
  WatcherSchedule,
  WatcherStatus,
  WatcherWithItemCount,
  WebhookChannelConfig,
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
