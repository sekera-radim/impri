import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ApiClient, ApiClientError } from '../src/api/client'
import { isUntrustedPayload } from '../src/utils/untrusted'

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
  setActivePinia(createPinia())
})

// ─── Watcher API client ───────────────────────────────────────────────────────

const minimalWatcher = {
  id: 'wat_1',
  name: 'Test feed',
  kind: 'rss',
  config: { url: 'https://example.com/feed.xml' },
  keywords: [],
  keywords_none: [],
  min_score: 1,
  schedule: { every: '1h' },
  status: 'active',
  fail_count: 0,
  first_run_done: false,
  next_run_at: 1000000,
  created_at: 999000,
  updated_at: 999000,
}

describe('ApiClient.createWatcher', () => {
  it('sends POST to /watchers with the correct body', async () => {
    mockFetch(201, minimalWatcher)
    const client = new ApiClient('im_key')
    await client.createWatcher({
      name: 'Test feed',
      kind: 'rss',
      config: { url: 'https://example.com/feed.xml' },
      schedule: { every: '1h' },
    })
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/watchers')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as {
      name: string
      kind: string
      config: { url: string }
      schedule: { every: string }
    }
    expect(body.name).toBe('Test feed')
    expect(body.kind).toBe('rss')
    expect(body.config.url).toBe('https://example.com/feed.xml')
    expect(body.schedule.every).toBe('1h')
  })

  it('sends keywords and min_score when provided', async () => {
    mockFetch(201, minimalWatcher)
    const client = new ApiClient('im_key')
    await client.createWatcher({
      name: 'Scored',
      kind: 'rss',
      config: { url: 'https://example.com/feed.xml' },
      schedule: { every: '30m' },
      keywords: [{ pattern: 'AI', points: 5 }],
      min_score: 3,
    })
    const [, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as {
      keywords: Array<{ pattern: string; points: number }>
      min_score: number
    }
    expect(body.keywords).toEqual([{ pattern: 'AI', points: 5 }])
    expect(body.min_score).toBe(3)
  })

  it('throws ApiClientError on 400 validation error', async () => {
    mockFetch(400, { error: 'Bad Request', issues: [{ message: '"url" is required', path: ['config', 'url'] }] })
    const client = new ApiClient('im_key')
    await expect(
      client.createWatcher({
        name: 'Bad',
        kind: 'rss',
        config: {},
        schedule: { every: '1h' },
      }),
    ).rejects.toThrow(ApiClientError)
  })
})

describe('ApiClient.updateWatcher', () => {
  it('sends PATCH /watchers/:id with status=paused', async () => {
    mockFetch(200, { ...minimalWatcher, status: 'paused' })
    const client = new ApiClient('im_key')
    await client.updateWatcher('wat_1', { status: 'paused' })
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/watchers/wat_1')
    expect(opts.method).toBe('PATCH')
    const body = JSON.parse(opts.body as string) as { status: string }
    expect(body.status).toBe('paused')
  })

  it('sends PATCH /watchers/:id with status=active', async () => {
    mockFetch(200, minimalWatcher)
    const client = new ApiClient('im_key')
    await client.updateWatcher('wat_1', { status: 'active' })
    const [, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as { status: string }
    expect(body.status).toBe('active')
  })

  it('throws ApiClientError on 404', async () => {
    mockFetch(404, { error: 'Not Found' })
    const client = new ApiClient('im_key')
    await expect(client.updateWatcher('wat_missing', { status: 'paused' })).rejects.toThrow(ApiClientError)
  })
})

describe('ApiClient.deleteWatcher', () => {
  it('sends DELETE /watchers/:id', async () => {
    mockFetch(204, undefined)
    const client = new ApiClient('im_key')
    await client.deleteWatcher('wat_1')
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/watchers/wat_1')
    expect(opts.method).toBe('DELETE')
  })

  it('resolves to undefined on 204', async () => {
    mockFetch(204, undefined)
    const client = new ApiClient('im_key')
    const result = await client.deleteWatcher('wat_1')
    expect(result).toBeUndefined()
  })

  it('throws ApiClientError on 404', async () => {
    mockFetch(404, { error: 'Not Found' })
    const client = new ApiClient('im_key')
    await expect(client.deleteWatcher('wat_missing')).rejects.toThrow(ApiClientError)
  })
})

describe('ApiClient.listWatchers', () => {
  it('returns items on success', async () => {
    mockFetch(200, { items: [minimalWatcher], has_more: false })
    const client = new ApiClient('im_key')
    const res = await client.listWatchers()
    expect(res.items).toHaveLength(1)
    expect(res.items[0].id).toBe('wat_1')
  })

  it('appends status query param when provided', async () => {
    mockFetch(200, { items: [], has_more: false })
    const client = new ApiClient('im_key')
    await client.listWatchers({ status: 'paused' })
    const [url] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('status=paused')
  })
})

// ─── Untrusted payload detection ─────────────────────────────────────────────

describe('isUntrustedPayload', () => {
  it('returns true when payload.untrusted is true', () => {
    expect(isUntrustedPayload({ untrusted: true })).toBe(true)
  })

  it('returns false when payload is undefined', () => {
    expect(isUntrustedPayload(undefined)).toBe(false)
  })

  it('returns false when payload is null', () => {
    expect(isUntrustedPayload(null)).toBe(false)
  })

  it('returns false when payload.untrusted is false', () => {
    expect(isUntrustedPayload({ untrusted: false })).toBe(false)
  })

  it('returns false when payload has no untrusted key', () => {
    expect(isUntrustedPayload({ kind: 'watcher.triage', score: 42 })).toBe(false)
  })

  it('returns false when payload.untrusted is a truthy non-boolean', () => {
    // Only strict true counts — other truthy values are not enough
    expect(isUntrustedPayload({ untrusted: 1 })).toBe(false)
    expect(isUntrustedPayload({ untrusted: 'yes' })).toBe(false)
  })

  it('returns false for primitive payload values', () => {
    expect(isUntrustedPayload('untrusted')).toBe(false)
    expect(isUntrustedPayload(42)).toBe(false)
  })
})
