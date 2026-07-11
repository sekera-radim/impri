/**
 * TypeScript types mirroring the Impri REST API contract.
 * These match the types in docs/llms.txt and the OpenAPI spec.
 */

// ─── Shared primitives ────────────────────────────────────────────────────────

export type ActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "execute_failed";

export interface Preview {
  format: "markdown" | "plain" | "diff";
  /** The content body — max 256 KB. */
  body: string;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export interface ActionCreated {
  id: string;
  status: "pending";
  inbox_url: string;
  expires_at: number;
  created_at: number;
  /** Set when a pending action with same kind+title+preview hash already exists. */
  duplicate_of?: string;
}

export interface Decision {
  verdict: "approve" | "reject";
  decided_at: number;
  channel?: string;
  /**
   * Human-edited preview — present only when the reviewer used edit-before-approve.
   * Always prefer this over the original preview when executing the action.
   */
  final_preview?: Preview;
  /** Unified-style diff against the original body; present when final_preview differs. */
  diff?: string;
}

export interface WebhookDelivery {
  status: string;
  attempt: number;
  last_status_code?: number;
  last_error?: string;
}

export interface Action {
  id: string;
  kind: string;
  title: string;
  status: ActionStatus;
  preview: Preview;
  payload?: unknown;
  target_url?: string;
  callback_url?: string;
  expires_at: number;
  idempotency_key?: string;
  editable: string[];
  created_at: number;
  updated_at: number;
  webhook_delivery?: WebhookDelivery;
  /** Present only after a human has made a decision. */
  decision?: Decision;
}

export interface CreateActionParams {
  kind: string;
  title: string;
  preview: Preview;
  payload?: unknown;
  target_url?: string;
  callback_url?: string;
  /** Seconds until expiry — min 300, max 2592000, default 259200 (72 h). */
  expires_in?: number;
  idempotency_key?: string;
  /** Dot-path fields the reviewer may edit before approving, e.g. ['preview.body']. */
  editable?: string[];
}

export interface PagedResult<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

export interface ListActionsParams {
  status?: ActionStatus;
  kind?: string;
  since?: number;
  limit?: number;
  cursor?: string;
}

export interface DecisionResult {
  id: string;
  status: string;
  verdict: string;
  decided_at: number;
  final_preview: Preview;
  diff?: string;
}

export interface DecideParams {
  verdict: "approve" | "reject";
  edited?: Record<string, unknown>;
  channel?: string;
}

export interface ResultAck {
  id: string;
  status: string;
  updated_at: number;
}

export interface ReportResultParams {
  status: "executed" | "execute_failed";
  detail?: string;
}

// ─── Approved action (returned from awaitDecision) ────────────────────────────

export interface ApprovedAction {
  actionId: string;
  decision: Decision;
  finalPreview: Preview;
  /** True when the action carried payload.untrusted === true (watcher-sourced). */
  isUntrusted: boolean;
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

export type WatcherKind = "rss" | "reddit_search" | "url_diff";
export type WatcherStatus = "active" | "paused" | "degraded";

export interface WatcherConfig {
  /** Required for rss and url_diff kinds. */
  url?: string;
  /** Required for reddit_search kind. */
  query?: string;
  subreddit?: string;
}

export interface WatcherSchedule {
  /** Minimum interval string: '30m' | '8h' | '1d'. */
  every: string;
  jitter?: string;
  /** Active window in project timezone: 'HH:MM-HH:MM'. */
  window?: string;
}

export interface ScoringRule {
  pattern: string;
  /** Points contributed to match score: 1–100. */
  points: number;
}

export interface Watcher {
  id: string;
  name: string;
  kind: WatcherKind;
  config: WatcherConfig;
  keywords: ScoringRule[];
  keywords_none: string[];
  min_score: number;
  schedule: WatcherSchedule;
  status: WatcherStatus;
  fail_count: number;
  last_error?: string;
  degraded_since?: number;
  first_run_done: boolean;
  last_run_at?: number;
  next_run_at: number;
  created_at: number;
  updated_at: number;
  /** Included only on GET /v1/watchers/:id. */
  item_count?: number;
}

export interface CreateWatcherParams {
  name: string;
  kind: WatcherKind;
  config: WatcherConfig;
  schedule: WatcherSchedule;
  keywords?: ScoringRule[];
  keywords_none?: string[];
  min_score?: number;
}

export interface UpdateWatcherParams {
  name?: string;
  config?: WatcherConfig;
  keywords?: ScoringRule[];
  keywords_none?: string[];
  min_score?: number;
  schedule?: WatcherSchedule;
  status?: "active" | "paused";
}

export interface ListWatchersParams {
  status?: WatcherStatus;
  kind?: WatcherKind;
  limit?: number;
  cursor?: string;
}

// ─── API keys ─────────────────────────────────────────────────────────────────

export type KeyScope = "actions" | "watch" | "admin";

export interface ApiKey {
  id: string;
  project_id: string;
  prefix: string;
  name: string;
  scopes: KeyScope[];
  created_at: number;
  last_used_at?: number;
  revoked: boolean;
}

export interface ApiKeyCreated extends ApiKey {
  /** Raw im_... value — returned ONCE; store immediately. */
  key: string;
  note: string;
}

// ─── Project ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  timezone: string;
  webhook_secret?: string;
  created_at: number;
}

export interface ProjectExport {
  exported_at: number;
  project: Record<string, unknown>;
  actions: Action[];
  decisions: Decision[];
  watchers: Watcher[];
  audit_log: unknown[];
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface ImpriClientConfig {
  /** Bearer token (im_...). Defaults to IMPRI_API_KEY env var. */
  apiKey?: string;
  /**
   * Base URL without a trailing slash and without /v1.
   * Defaults to IMPRI_BASE_URL env var, then http://localhost:8484.
   * Cloud: https://api.impri.dev
   */
  baseUrl?: string;
}

// ─── Ergonomics helpers ───────────────────────────────────────────────────────

export interface ApprovalGateOpts {
  kind: string;
  title: string;
  preview: Preview;
  editable?: string[];
  /** Seconds to wait before raising ImpriTimeout. Default 300. */
  timeoutS?: number;
  /** Override any CreateActionParams field (payload, target_url, etc.). */
  [key: string]: unknown;
}
