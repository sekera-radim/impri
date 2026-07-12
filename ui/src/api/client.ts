import type {
  Action,
  ActionStatus,
  ApiError,
  ApiKey,
  Billing,
  BulkDecisionRequest,
  BulkDecisionResponse,
  DecisionRequest,
  DecisionResponse,
  ListActionsResponse,
  ListAuditResponse,
  Watcher,
  WatcherStatus,
  WatcherKind,
  ListWatchersResponse,
  CreateWatcherRequest,
  UpdateWatcherRequest,
  VapidPublicKeyResponse,
  PushSubscriptionBody,
  ListWatcherPresetsResponse,
  CreateWatcherFromPresetRequest,
  NotificationChannel,
  ListChannelsResponse,
  CreateChannelRequest,
  UpdateChannelRequest,
  TestChannelResponse,
  UsageResponse,
  RecoverResponse,
  RecoveryCodeResponse,
} from '../types'

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message ?? body.error ?? `HTTP ${status}`)
    this.name = 'ApiClientError'
  }
}

export class ApiClient {
  private readonly baseUrl: string

  constructor(
    private readonly apiKey: string,
    // Same-origin '/v1' by default (dev proxy / nginx). A hosted UI on a
    // different origin sets VITE_API_BASE (e.g. https://api.impri.dev/v1).
    baseUrl: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1',
  ) {
    this.baseUrl = baseUrl
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (response.status === 204) {
      return undefined as T
    }

    const json = await response.json() as T | ApiError

    if (!response.ok) {
      throw new ApiClientError(response.status, json as ApiError)
    }

    return json as T
  }

  async listActions(params: {
    status?: ActionStatus
    limit?: number
    since?: number
    kind?: string
    cursor?: string
    q?: string
  } = {}): Promise<ListActionsResponse> {
    const query = new URLSearchParams()
    if (params.status) query.set('status', params.status)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.since !== undefined) query.set('since', String(params.since))
    if (params.kind) query.set('kind', params.kind)
    if (params.cursor) query.set('cursor', params.cursor)
    if (params.q) query.set('q', params.q)
    const qs = query.toString()
    return this.request<ListActionsResponse>('GET', `/actions${qs ? `?${qs}` : ''}`)
  }

  async bulkDecide(req: BulkDecisionRequest): Promise<BulkDecisionResponse> {
    return this.request<BulkDecisionResponse>('POST', '/actions/bulk-decision', req)
  }

  async getAction(id: string): Promise<Action> {
    return this.request<Action>('GET', `/actions/${id}`)
  }

  async decide(id: string, req: DecisionRequest): Promise<DecisionResponse> {
    return this.request<DecisionResponse>('POST', `/actions/${id}/decision`, req)
  }

  // Create an approval request. Normally agents call POST /v1/actions directly,
  // but the UI uses this for the "send a test approval" onboarding action.
  async createAction(body: {
    kind: string
    title: string
    preview: { format?: 'markdown' | 'plain' | 'diff'; body: string }
    target_url?: string
  }): Promise<Action> {
    return this.request<Action>('POST', '/actions', body)
  }

  async submitFeedback(body: {
    message: string
    rating?: number
    contact?: string
    context?: string
  }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('POST', '/feedback', body)
  }

  async listKeys(): Promise<{ items: ApiKey[] }> {
    return this.request<{ items: ApiKey[] }>('GET', '/keys')
  }

  async revokeKey(keyId: string): Promise<void> {
    return this.request<void>('DELETE', `/keys/${keyId}`)
  }

  async listWatchers(params: {
    status?: WatcherStatus
    kind?: WatcherKind
    limit?: number
    cursor?: string
  } = {}): Promise<ListWatchersResponse> {
    const query = new URLSearchParams()
    if (params.status) query.set('status', params.status)
    if (params.kind) query.set('kind', params.kind)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.cursor) query.set('cursor', params.cursor)
    const qs = query.toString()
    return this.request<ListWatchersResponse>('GET', `/watchers${qs ? `?${qs}` : ''}`)
  }

  async createWatcher(req: CreateWatcherRequest): Promise<Watcher> {
    return this.request<Watcher>('POST', '/watchers', req)
  }

  async listWatcherPresets(): Promise<ListWatcherPresetsResponse> {
    return this.request<ListWatcherPresetsResponse>('GET', '/watcher-presets')
  }

  async createWatcherFromPreset(req: CreateWatcherFromPresetRequest): Promise<Watcher> {
    return this.request<Watcher>('POST', '/watchers/from-preset', req)
  }

  async updateWatcher(id: string, req: UpdateWatcherRequest): Promise<Watcher> {
    return this.request<Watcher>('PATCH', `/watchers/${id}`, req)
  }

  async deleteWatcher(id: string): Promise<void> {
    return this.request<void>('DELETE', `/watchers/${id}`)
  }

  async getBilling(): Promise<Billing> {
    return this.request<Billing>('GET', '/billing')
  }

  async getUsage(): Promise<UsageResponse> {
    return this.request<UsageResponse>('GET', '/usage')
  }

  // Push notification endpoints — public_key fetch has no auth requirement on the server
  async getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
    const response = await fetch(`${this.baseUrl}/push/vapid-public-key`)
    if (!response.ok) {
      const json = await response.json() as ApiError
      throw new ApiClientError(response.status, json)
    }
    return response.json() as Promise<VapidPublicKeyResponse>
  }

  async pushSubscribe(subscription: PushSubscriptionBody): Promise<void> {
    return this.request<void>('POST', '/push/subscribe', subscription)
  }

  async pushUnsubscribe(endpoint: string): Promise<void> {
    return this.request<void>('DELETE', '/push/subscribe', { endpoint })
  }

  async createCheckout(plan: 'indie' | 'team', period: 'monthly' | 'yearly'): Promise<{ url: string }> {
    return this.request<{ url: string }>('POST', '/billing/checkout', { plan, period })
  }

  async openPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>('POST', '/billing/portal')
  }

  // --- Notification channels (admin scope required) ---

  async listChannels(): Promise<ListChannelsResponse> {
    return this.request<ListChannelsResponse>('GET', '/notification-channels')
  }

  async createChannel(req: CreateChannelRequest): Promise<NotificationChannel> {
    return this.request<NotificationChannel>('POST', '/notification-channels', req)
  }

  async getChannel(id: string): Promise<NotificationChannel> {
    return this.request<NotificationChannel>('GET', `/notification-channels/${id}`)
  }

  async updateChannel(id: string, req: UpdateChannelRequest): Promise<NotificationChannel> {
    return this.request<NotificationChannel>('PATCH', `/notification-channels/${id}`, req)
  }

  async deleteChannel(id: string): Promise<void> {
    return this.request<void>('DELETE', `/notification-channels/${id}`)
  }

  async testChannel(id: string): Promise<TestChannelResponse> {
    return this.request<TestChannelResponse>('POST', `/notification-channels/${id}/test`)
  }

  // --- Audit log (admin scope required) ---

  async listAudit(params: {
    type?: string
    actor?: string
    entity_id?: string
    since?: number
    until?: number
    limit?: number
    cursor?: string
  } = {}): Promise<ListAuditResponse> {
    const query = new URLSearchParams()
    if (params.type) query.set('type', params.type)
    if (params.actor) query.set('actor', params.actor)
    if (params.entity_id) query.set('entity_id', params.entity_id)
    if (params.since !== undefined) query.set('since', String(params.since))
    if (params.until !== undefined) query.set('until', String(params.until))
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.cursor) query.set('cursor', params.cursor)
    const qs = query.toString()
    return this.request<ListAuditResponse>('GET', `/audit${qs ? `?${qs}` : ''}`)
  }

  // --- Account recovery ---

  /** Rotate the recovery code for the current project (admin scope). Returns plaintext once. */
  async generateRecoveryCode(): Promise<RecoveryCodeResponse> {
    return this.request<RecoveryCodeResponse>('POST', '/recovery-code')
  }

  /**
   * Exchange a recovery code for a new admin key (public — no Bearer token needed).
   * Mints a new admin key and rotates the recovery code atomically.
   */
  async recover(projectId: string, recoveryCode: string): Promise<RecoverResponse> {
    const baseUrl = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1'
    const response = await fetch(`${baseUrl}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, recovery_code: recoveryCode }),
    })
    const json = await response.json() as RecoverResponse | ApiError
    if (!response.ok) {
      throw new ApiClientError(response.status, json as ApiError)
    }
    return json as RecoverResponse
  }

  async exportAudit(params: {
    type?: string
    actor?: string
    entity_id?: string
    since?: number
    until?: number
    format?: 'json' | 'csv'
  } = {}): Promise<{ blob: Blob; filename: string }> {
    const query = new URLSearchParams()
    if (params.type) query.set('type', params.type)
    if (params.actor) query.set('actor', params.actor)
    if (params.entity_id) query.set('entity_id', params.entity_id)
    if (params.since !== undefined) query.set('since', String(params.since))
    if (params.until !== undefined) query.set('until', String(params.until))
    if (params.format) query.set('format', params.format)
    const qs = query.toString()

    const response = await fetch(`${this.baseUrl}/audit/export${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    })

    if (!response.ok) {
      const json = await response.json() as ApiError
      throw new ApiClientError(response.status, json)
    }

    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const filenameMatch = /filename="([^"]+)"/.exec(disposition)
    const ext = params.format === 'csv' ? 'csv' : 'json'
    const filename = filenameMatch ? filenameMatch[1] : `audit-export.${ext}`
    return { blob, filename }
  }

}
