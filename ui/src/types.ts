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
