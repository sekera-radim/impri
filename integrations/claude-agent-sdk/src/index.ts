/**
 * @impri/claude-agent-sdk
 *
 * Human-in-the-loop approval for Claude Agent SDK tool calls via Impri.
 *
 * Main exports:
 *   - ImpriClient           — full REST API client
 *   - withImpriApproval     — gate a Claude Agent SDK tool behind Impri approval
 *   - makeToolResult        — build a tool_result message param
 *   - verifyWebhook         — verify an Impri webhook delivery (standalone)
 *   - ImpriError and all subclasses
 */

// Client
export { ImpriClient } from "./client.js";
export type { RequiresApprovalOpts } from "./client.js";

// Tool wrapper
export { makeToolResult, withImpriApproval } from "./tool.js";
export type {
  AnthropicTool,
  GatedTool,
  GatedToolOptions,
  ToolExecutor,
  ToolUseBlock,
} from "./tool.js";

// Webhook verification
export { verifyWebhook } from "./webhook.js";
export type { VerifyWebhookParams } from "./webhook.js";

// Error classes — export all so callers can narrow catches
export {
  ImpriApiError,
  ImpriConfigError,
  ImpriConflict,
  ImpriError,
  ImpriExpired,
  ImpriNotFound,
  ImpriQuotaExceeded,
  ImpriRateLimited,
  ImpriRejected,
  ImpriTimeout,
  ImpriUnauthorized,
  ImpriValidationError,
  ImpriWebhookSignatureError,
} from "./errors.js";

// All API types
export type {
  Action,
  ActionCreated,
  ActionStatus,
  ApiKey,
  ApiKeyCreated,
  ApprovalGateOpts,
  ApprovedAction,
  CreateActionParams,
  CreateWatcherParams,
  DecideParams,
  Decision,
  DecisionResult,
  ImpriClientConfig,
  KeyScope,
  ListActionsParams,
  ListWatchersParams,
  PagedResult,
  Preview,
  Project,
  ProjectExport,
  ReportResultParams,
  ResultAck,
  ScoringRule,
  UpdateWatcherParams,
  Watcher,
  WatcherConfig,
  WatcherKind,
  WatcherSchedule,
  WatcherStatus,
  WebhookDelivery,
} from "./types.js";
