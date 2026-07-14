export type ActionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'execute_failed'

export interface Preview {
  format: 'markdown' | 'plain' | 'diff'
  body: string
}

export interface Decision {
  verdict: 'approve' | 'reject'
  decided_at: number
  channel?: string
  final_preview?: Preview
  diff?: string
}

export interface WebhookDelivery {
  status: string
  attempt: number
  last_status_code?: number
  last_error?: string
}

export interface Action {
  id: string
  kind: string
  title: string
  preview: Preview
  payload?: unknown
  target_url?: string
  callback_url?: string
  expires_at?: number
  idempotency_key?: string
  editable: string[]
  status: ActionStatus
  created_at: number
  updated_at: number
  color?: string | null
  decision?: Decision
  webhook_delivery?: WebhookDelivery
  /** Whether re-executing this action is safe. true = idempotent, false = not idempotent (show warning), absent = unknown. */
  idempotent?: boolean
  /** Plain-English description of how to undo this action, if applicable. */
  undo?: string
  /** Free-form execution receipt returned via POST /result. Present only on executed/execute_failed actions. */
  result_payload?: Record<string, unknown>
}

export interface ListActionsResponse {
  items: Action[]
  has_more: boolean
  next_cursor?: string
}

export interface ApiKey {
  id: string
  project_id: string
  prefix: string
  name: string
  scopes: string[]
  created_at: number
  last_used_at?: number
  revoked: boolean
}

export interface DecisionRequest {
  decision: 'approve' | 'reject'
  edited?: Record<string, unknown>
  channel?: string
}

export interface DecisionResponse {
  id: string
  status: ActionStatus
  verdict: 'approve' | 'reject'
  decided_at: number
  final_preview: Preview
  diff?: string
}

export interface ApiError {
  error: string
  message?: string
  issues?: Array<{ message: string; path: (string | number)[] }>
  invalid_keys?: string[]
  editable?: string[]
  current_status?: ActionStatus
}

// --- Watchers ---

export type WatcherStatus = 'active' | 'paused' | 'degraded'
export type WatcherKind = 'rss' | 'reddit_search' | 'url_diff'

export interface ScoringRule {
  pattern: string
  points: number
}

export interface WatcherSchedule {
  every: string
  jitter?: string
  window?: string
}

export interface WatcherConfig {
  url?: string
  query?: string
  subreddit?: string
}

export interface Watcher {
  id: string
  name: string
  kind: WatcherKind
  config: WatcherConfig
  keywords: ScoringRule[]
  keywords_none: string[]
  min_score: number
  schedule: WatcherSchedule
  status: WatcherStatus
  fail_count: number
  first_run_done: boolean
  last_run_at?: number
  next_run_at: number
  last_error?: string
  created_at: number
  updated_at: number
  color?: string | null
}

export interface ListWatchersResponse {
  items: Watcher[]
  has_more: boolean
  next_cursor?: string
}

export interface CreateWatcherRequest {
  name: string
  kind: WatcherKind
  config: WatcherConfig
  keywords?: ScoringRule[]
  keywords_none?: string[]
  min_score?: number
  schedule: WatcherSchedule
  color?: string | null
}

export interface UpdateWatcherRequest {
  status?: 'active' | 'paused'
  name?: string
  config?: WatcherConfig
  keywords?: ScoringRule[]
  keywords_none?: string[]
  min_score?: number
  schedule?: WatcherSchedule
  color?: string | null
}

// --- Watcher Presets ---

export interface WatcherPresetParam {
  name: string
  required: boolean
  description: string
  example: string
}

export interface WatcherPreset {
  id: string
  title: string
  description: string
  category: string
  kind: WatcherKind
  params: WatcherPresetParam[]
  defaultScheduleEvery: string
}

export interface ListWatcherPresetsResponse {
  presets: WatcherPreset[]
}

export interface CreateWatcherFromPresetRequest {
  preset_id: string
  params: Record<string, string>
  name?: string
  schedule?: {
    every: string
    jitter?: string
    window?: string
  }
}

// --- Bulk decisions ---

export interface BulkDecisionRequest {
  ids: string[]
  verdict: 'approve' | 'reject'
  comment?: string
}

export interface BulkDecisionResult {
  id: string
  ok: boolean
  status?: ActionStatus
  error?: string
  current_status?: ActionStatus
}

export interface BulkDecisionResponse {
  results: BulkDecisionResult[]
  succeeded: number
  failed: number
}

// --- Push notifications ---

export interface VapidPublicKeyResponse {
  enabled: boolean
  public_key: string | null
}

export interface PushSubscriptionBody {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

// --- Notification channels ---

export type ChannelType = 'slack' | 'discord' | 'telegram' | 'ntfy' | 'email' | 'webhook'

export interface NotificationChannel {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  /**
   * Config values; secrets are masked to '****{last4}' in API responses.
   * Telegram channels with approval_mode carry boolean and number[] values
   * alongside strings, so this is typed as Record<string, unknown>.
   */
  config: Record<string, unknown>
  digest_window_sec: number
  last_fired_at?: number | null
  fail_count: number
  last_error?: string | null
  created_at: number
  updated_at: number
}

export interface ListChannelsResponse {
  items: NotificationChannel[]
}

export interface CreateChannelRequest {
  name: string
  type: ChannelType
  config: Record<string, unknown>
  enabled?: boolean
  digest_window_sec?: number
}

export interface UpdateChannelRequest {
  name?: string
  config?: Record<string, unknown>
  enabled?: boolean
  digest_window_sec?: number
}

export interface TestChannelResponse {
  ok: boolean
  error?: string
}

// --- Audit log ---

export interface AuditEvent {
  id: number
  event: string
  action_id?: string | null
  actor?: string | null
  channel?: string | null
  data?: Record<string, unknown> | null
  created_at: number
}

export interface ListAuditResponse {
  items: AuditEvent[]
  has_more: boolean
  next_cursor?: string
}

// --- Usage ---

export interface UsagePeriod {
  start: number
  end: number
}

export interface UsageActions {
  created_this_period: number
  pending: number
  approved: number
  rejected: number
  expired: number
  executed: number
  execute_failed: number
}

export interface UsageApprovals {
  used: number
  limit: number | null
  remaining: number | null
}

export interface UsageWatchers {
  active: number
  degraded: number
  paused: number
  total: number
  limit: number | null
  remaining: number | null
}

export interface UsageLimits {
  approvals_per_month: number | null
  watchers: number | null
  min_watcher_interval_sec: number
}

export interface UsageWebhookDelivery {
  dlq_size: number
  pending: number
  in_retry: number
}

export interface UsageResponse {
  project_id: string
  billing_active: boolean
  tier: string
  subscription_status: string | null
  current_period_end: number | null
  period: UsagePeriod
  actions: UsageActions
  approvals: UsageApprovals
  watchers: UsageWatchers
  limits: UsageLimits
  webhook_delivery: UsageWebhookDelivery
  /** Whether a recovery code is currently set for this project. */
  has_recovery_code: boolean
  ts: number
}

/** Response from POST /v1/recover — new key and rotated recovery code (shown once). */
export interface RecoverResponse {
  key: string
  recovery_code: string
  project_id: string
  note: string
}

/** Response from POST /v1/recovery-code — new plaintext recovery code (shown once). */
export interface RecoveryCodeResponse {
  recovery_code: string
  note: string
}

// --- Billing ---

export type Tier = 'free' | 'indie' | 'team'
export type BillingStatus = 'active' | 'past_due' | 'canceled' | 'none'

export interface BillingUsage {
  watchers: { used: number; limit: number | null }
  approvals: { used: number; limit: number | null }
}

export interface Billing {
  tier: Tier
  status: BillingStatus
  current_period_end?: number
  usage: BillingUsage
  billing_enabled: boolean
}
