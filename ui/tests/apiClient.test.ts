import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiClient, ApiClientError } from '../src/api/client'

// Helper to mock fetch with a given status + body
function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient.listActions', () => {
  it('returns items on success', async () => {
    mockFetch(200, { items: [{ id: 'act_1', status: 'pending' }], has_more: false })
    const client = new ApiClient('im_testkey')
    const res = await client.listActions()
    expect(res.items).toHaveLength(1)
    expect(res.items[0].id).toBe('act_1')
  })

  it('sends Authorization header with Bearer prefix', async () => {
    mockFetch(200, { items: [], has_more: false })
    const client = new ApiClient('im_mykey')
    await client.listActions()
    const [, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer im_mykey')
  })

  it('appends status query param when provided', async () => {
    mockFetch(200, { items: [], has_more: false })
    const client = new ApiClient('im_k')
    await client.listActions({ status: 'approved' })
    const [url] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('status=approved')
  })

  it('throws ApiClientError on 401', async () => {
    mockFetch(401, { error: 'Unauthorized', message: 'Invalid or revoked API key' })
    const client = new ApiClient('im_bad')
    await expect(client.listActions()).rejects.toThrow(ApiClientError)
  })

  it('ApiClientError carries status code', async () => {
    mockFetch(401, { error: 'Unauthorized', message: 'Invalid key' })
    const client = new ApiClient('im_bad')
    try {
      await client.listActions()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError)
      expect((err as ApiClientError).status).toBe(401)
    }
  })
})

describe('ApiClient.decide', () => {
  it('sends POST with correct body', async () => {
    mockFetch(200, { id: 'act_1', status: 'approved', verdict: 'approve', decided_at: 1000, final_preview: { format: 'plain', body: 'x' } })
    const client = new ApiClient('im_key')
    await client.decide('act_1', { decision: 'approve' })
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/actions/act_1/decision')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as { decision: string }
    expect(body.decision).toBe('approve')
  })

  it('throws ApiClientError with 422 status on unprocessable entity', async () => {
    mockFetch(422, {
      error: 'Unprocessable Entity',
      message: "Field(s) not in editable whitelist: payload.x",
      invalid_keys: ['payload.x'],
      editable: ['preview.body'],
    })
    const client = new ApiClient('im_key')
    await expect(
      client.decide('act_1', { decision: 'approve', edited: { 'payload.x': 'y' } }),
    ).rejects.toThrow(ApiClientError)
  })

  it('throws ApiClientError on 409 conflict', async () => {
    mockFetch(409, { error: 'Conflict', message: 'Action is already in state "approved"', current_status: 'approved' })
    const client = new ApiClient('im_key')
    try {
      await client.decide('act_1', { decision: 'approve' })
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError)
      expect((err as ApiClientError).status).toBe(409)
      expect((err as ApiClientError).body.current_status).toBe('approved')
    }
  })
})
