import type {
  Action,
  ActionStatus,
  ApiError,
  ApiKey,
  DecisionRequest,
  DecisionResponse,
  ListActionsResponse,
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
    baseUrl = '/v1',
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
}
