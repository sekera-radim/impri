import type {
  Action,
  ActionStatus,
  ApiError,
  ApiKey,
  Billing,
  DecisionRequest,
  DecisionResponse,
  ListActionsResponse,
  Watcher,
  WatcherStatus,
  WatcherKind,
  ListWatchersResponse,
  CreateWatcherRequest,
  UpdateWatcherRequest,
  VapidPublicKeyResponse,
  PushSubscriptionBody,
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
  } = {}): Promise<ListActionsResponse> {
    const query = new URLSearchParams()
    if (params.status) query.set('status', params.status)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.since !== undefined) query.set('since', String(params.since))
    if (params.kind) query.set('kind', params.kind)
    if (params.cursor) query.set('cursor', params.cursor)
    const qs = query.toString()
    return this.request<ListActionsResponse>('GET', `/actions${qs ? `?${qs}` : ''}`)
  }

  async getAction(id: string): Promise<Action> {
    return this.request<Action>('GET', `/actions/${id}`)
  }

  async decide(id: string, req: DecisionRequest): Promise<DecisionResponse> {
    return this.request<DecisionResponse>('POST', `/actions/${id}/decision`, req)
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

  async updateWatcher(id: string, req: UpdateWatcherRequest): Promise<Watcher> {
    return this.request<Watcher>('PATCH', `/watchers/${id}`, req)
  }

  async deleteWatcher(id: string): Promise<void> {
    return this.request<void>('DELETE', `/watchers/${id}`)
  }

  async getBilling(): Promise<Billing> {
    return this.request<Billing>('GET', '/billing')
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
}
