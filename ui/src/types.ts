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
  decision?: Decision
  webhook_delivery?: WebhookDelivery
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
}

export interface UpdateWatcherRequest {
  status?: 'active' | 'paused'
  name?: string
  config?: WatcherConfig
  keywords?: ScoringRule[]
  keywords_none?: string[]
  min_score?: number
  schedule?: WatcherSchedule
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
