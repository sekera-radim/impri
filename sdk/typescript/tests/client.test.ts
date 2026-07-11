import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ImpriClient,
  ImpriApiError,
  ImpriConfigError,
  ImpriConflict,
  ImpriExpired,
  ImpriNotFound,
  ImpriQuotaExceeded,
  ImpriRateLimited,
  ImpriRejected,
  ImpriTimeout,
  ImpriUnauthorized,
  ImpriValidationError,
  type WatcherPreset,
} from '../src/index.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_KEY = 'im_test_abc123'
const TEST_BASE = 'http://localhost:19999'
const ACT_ID = 'act_test001'

function client() {
  return new ImpriClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE })
}

/** Build a mock Response-like object. */
function resp(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function noContentResp(): Response {
  return resp(204, null)
}

/** Minimal pending action fixture. */
function pendingAction(id = ACT_ID) {
  return {
    id,
    kind: 'test.action',
    title: 'Test action',
    status: 'pending',
    preview: { format: 'plain', body: 'hello' },
    payload: null,
    editable: [],
    created_at: 1720000000,
    updated_at: 1720000000,
    expires_at: 1720086400,
  }
}

function approvedAction(id = ACT_ID) {
  return {
    ...pendingAction(id),
    status: 'approved',
    decision: { verdict: 'approve', decided_at: 1720003600 },
  }
}

function rejectedAction(id = ACT_ID) {
  return {
    ...pendingAction(id),
    status: 'rejected',
    decision: { verdict: 'reject', decided_at: 1720003600 },
  }
}

function expiredAction(id = ACT_ID) {
  return { ...pendingAction(id), status: 'expired' }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('ImpriClient constructor', () => {
  it('throws ImpriConfigError when no API key is provided', () => {
    const saved = process.env.IMPRI_API_KEY
    delete process.env.IMPRI_API_KEY
    try {
      expect(() => new ImpriClient({ baseUrl: TEST_BASE })).toThrow(ImpriConfigError)
    } finally {
      if (saved !== undefined) process.env.IMPRI_API_KEY = saved
    }
  })

  it('reads API key from IMPRI_API_KEY env var', () => {
    const saved = process.env.IMPRI_API_KEY
    process.env.IMPRI_API_KEY = 'im_from_env'
    try {
      expect(() => new ImpriClient({ baseUrl: TEST_BASE })).not.toThrow()
    } finally {
      if (saved !== undefined) process.env.IMPRI_API_KEY = saved
      else delete process.env.IMPRI_API_KEY
    }
  })

  it('throws ImpriConfigError for a non-URL baseUrl', () => {
    expect(() => new ImpriClient({ apiKey: TEST_KEY, baseUrl: 'not-a-url' })).toThrow(
      ImpriConfigError,
    )
  })

  it('strips trailing slash from baseUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    const c = new ImpriClient({ apiKey: TEST_KEY, baseUrl: 'http://localhost:19999/' })
    await c.listActions()

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toMatch(/^http:\/\/localhost:19999\/v1\//)
    expect(url).not.toMatch(/\/\/v1/)
  })

  it('includes Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listActions()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })
})

// ─── createAction ─────────────────────────────────────────────────────────────

describe('createAction', () => {
  it('POSTs to /v1/actions with the correct body', async () => {
    const created = {
      id: ACT_ID,
      status: 'pending',
      inbox_url: 'http://localhost:8080/inbox/act_test001',
      expires_at: 1720086400,
      created_at: 1720000000,
    }
    const mockFetch = vi.fn().mockResolvedValue(resp(201, created))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().createAction({
      kind: 'email.send',
      title: 'Send newsletter',
      preview: { format: 'plain', body: 'Hello!' },
      idempotency_key: 'idem-1',
    })

    expect(result.id).toBe(ACT_ID)
    expect(result.status).toBe('pending')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/actions`)
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string)
    expect(body.kind).toBe('email.send')
    expect(body.idempotency_key).toBe('idem-1')
  })

  it('auto-generates idempotency_key when omitted', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        resp(201, { id: 'act_1', status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }),
      )
    vi.stubGlobal('fetch', mockFetch)

    await client().createAction({
      kind: 'test',
      title: 'T',
      preview: { format: 'plain', body: 'B' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.idempotency_key).toMatch(/^sdk-\d+-\d+-[0-9a-f]+$/)
  })

  it('returns duplicate_of on a 200 idempotent response', async () => {
    const dup = {
      id: ACT_ID,
      status: 'pending',
      inbox_url: 'u',
      expires_at: 0,
      created_at: 0,
      duplicate_of: 'act_original',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, dup)))

    const result = await client().createAction({
      kind: 'k',
      title: 't',
      preview: { format: 'plain', body: 'b' },
      idempotency_key: 'dup',
    })
    expect(result.duplicate_of).toBe('act_original')
  })
})

// ─── getAction ────────────────────────────────────────────────────────────────

describe('getAction', () => {
  it('GETs /v1/actions/:id and normalizes is_untrusted=false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, pendingAction())))

    const action = await client().getAction(ACT_ID)

    expect(action.id).toBe(ACT_ID)
    expect(action.is_untrusted).toBe(false)
    expect((vi.mocked(fetch).mock.calls[0][0] as string)).toBe(
      `${TEST_BASE}/v1/actions/${ACT_ID}`,
    )
  })

  it('sets is_untrusted=true when payload.untrusted is true', async () => {
    const raw = { ...pendingAction(), payload: { untrusted: true, url: 'https://example.com' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, raw)))

    const action = await client().getAction(ACT_ID)
    expect(action.is_untrusted).toBe(true)
  })

  it('defaults editable to [] when missing from response', async () => {
    const raw = { ...pendingAction() }
    ;(raw as Record<string, unknown>).editable = undefined
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, raw)))

    const action = await client().getAction(ACT_ID)
    expect(action.editable).toEqual([])
  })
})

// ─── listActions ──────────────────────────────────────────────────────────────

describe('listActions', () => {
  it('GETs /v1/actions with query params', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listActions({ status: 'pending', kind: 'email.send', limit: 10 })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('status=pending')
    expect(url).toContain('kind=email.send')
    expect(url).toContain('limit=10')
  })

  it('does not include undefined params in the query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listActions({})

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).not.toContain('?')
  })

  it('auto-paginates across two pages when autoPaginate=true', async () => {
    const page1 = { items: [pendingAction('act_1')], has_more: true, next_cursor: 'cur1' }
    const page2 = { items: [pendingAction('act_2')], has_more: false }

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(200, page1))
      .mockResolvedValueOnce(resp(200, page2))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().listActions({ autoPaginate: true })

    expect(result.items).toHaveLength(2)
    expect(result.has_more).toBe(false)
    expect(result.items[0].id).toBe('act_1')
    expect(result.items[1].id).toBe('act_2')

    const secondUrl = mockFetch.mock.calls[1][0] as string
    expect(secondUrl).toContain('cursor=cur1')
  })

  it('returns paged result with next_cursor on single page', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { items: [pendingAction()], has_more: true, next_cursor: 'nc1' }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().listActions({ limit: 1 })
    expect(result.has_more).toBe(true)
    expect(result.next_cursor).toBe('nc1')
  })
})

// ─── decide ───────────────────────────────────────────────────────────────────

describe('decide', () => {
  it('POSTs verdict to /v1/actions/:id/decision', async () => {
    const decisionResult = {
      id: ACT_ID,
      status: 'approved',
      verdict: 'approve',
      decided_at: 1720003600,
      final_preview: { format: 'plain', body: 'hello' },
    }
    const mockFetch = vi.fn().mockResolvedValue(resp(200, decisionResult))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().decide(ACT_ID, 'approve')
    expect(result.verdict).toBe('approve')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/actions/${ACT_ID}/decision`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string).verdict).toBe('approve')
  })

  it('includes edited fields and channel in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      resp(200, {
        id: ACT_ID,
        status: 'approved',
        verdict: 'approve',
        decided_at: 0,
        final_preview: { format: 'plain', body: 'edited' },
      }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await client().decide(ACT_ID, 'approve', {
      edited: { 'preview.body': 'edited' },
      channel: 'web',
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edited).toEqual({ 'preview.body': 'edited' })
    expect(body.channel).toBe('web')
  })
})

// ─── reportResult ─────────────────────────────────────────────────────────────

describe('reportResult', () => {
  it('POSTs status to /v1/actions/:id/result', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { id: ACT_ID, status: 'executed', updated_at: 1720003600 }))
    vi.stubGlobal('fetch', mockFetch)

    const ack = await client().reportResult(ACT_ID, 'executed')
    expect(ack.status).toBe('executed')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/actions/${ACT_ID}/result`)
    expect(JSON.parse(init.body as string).status).toBe('executed')
  })

  it('sends detail when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { id: ACT_ID, status: 'execute_failed', updated_at: 0 }))
    vi.stubGlobal('fetch', mockFetch)

    await client().reportResult(ACT_ID, 'execute_failed', { detail: 'HTTP 500 from mailer' })
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.detail).toBe('HTTP 500 from mailer')
  })

  it('omits detail key when not provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { id: ACT_ID, status: 'executed', updated_at: 0 }))
    vi.stubGlobal('fetch', mockFetch)

    await client().reportResult(ACT_ID, 'executed')
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect('detail' in body).toBe(false)
  })
})

// ─── awaitDecision ────────────────────────────────────────────────────────────

describe('awaitDecision', () => {
  it('returns the action immediately when already approved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, approvedAction())))

    const action = await client().awaitDecision(ACT_ID)
    expect(action.status).toBe('approved')
    expect(action.decision?.verdict).toBe('approve')
  })

  it('polls until approved on the second attempt', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(200, pendingAction()))
      .mockResolvedValueOnce(resp(200, approvedAction()))
    vi.stubGlobal('fetch', mockFetch)

    const action = await client().awaitDecision(ACT_ID, { pollIntervalS: 0 })
    expect(action.status).toBe('approved')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws ImpriRejected when action is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, rejectedAction())))

    await expect(client().awaitDecision(ACT_ID)).rejects.toBeInstanceOf(ImpriRejected)
  })

  it('ImpriRejected carries actionId and decision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, rejectedAction())))

    try {
      await client().awaitDecision(ACT_ID)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ImpriRejected)
      const e = err as ImpriRejected
      expect(e.actionId).toBe(ACT_ID)
      expect(e.decision.verdict).toBe('reject')
    }
  })

  it('throws ImpriExpired when action is expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, expiredAction())))

    await expect(client().awaitDecision(ACT_ID)).rejects.toBeInstanceOf(ImpriExpired)
  })

  it('throws ImpriTimeout when deadline elapses while action is still pending', async () => {
    // Always return pending — timeout=0 means deadline is immediately past.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, pendingAction())))

    await expect(
      client().awaitDecision(ACT_ID, { timeoutS: 0, pollIntervalS: 0 }),
    ).rejects.toBeInstanceOf(ImpriTimeout)
  })

  it('ImpriTimeout carries the actionId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, pendingAction())))

    try {
      await client().awaitDecision(ACT_ID, { timeoutS: 0, pollIntervalS: 0 })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ImpriTimeout)
      expect((err as ImpriTimeout).actionId).toBe(ACT_ID)
    }
  })
})

// ─── Error mapping ────────────────────────────────────────────────────────────

describe('HTTP error mapping', () => {
  const cases = [
    [401, ImpriUnauthorized],
    [403, ImpriUnauthorized],
    [404, ImpriNotFound],
    [409, ImpriConflict],
    [410, ImpriExpired],
    [429, ImpriRateLimited],
    [402, ImpriQuotaExceeded],
    [422, ImpriValidationError],
    [400, ImpriValidationError],
    [500, ImpriApiError],
    [503, ImpriApiError],
  ] as const

  for (const [status, ErrorClass] of cases) {
    it(`maps HTTP ${status} to ${ErrorClass.name}`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(status, { message: 'test error' })))
      await expect(client().getAction(ACT_ID)).rejects.toBeInstanceOf(ErrorClass)
    })
  }

  it('ImpriUnauthorized carries statusCode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { message: 'Unauthorized' })))
    try {
      await client().getAction(ACT_ID)
    } catch (err) {
      expect((err as ImpriUnauthorized).statusCode).toBe(401)
    }
  })

  it('ImpriRateLimited carries retryAfter from Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(429, { message: 'Too many requests' }, { 'retry-after': '42' })),
    )
    try {
      await client().getAction(ACT_ID)
    } catch (err) {
      expect(err).toBeInstanceOf(ImpriRateLimited)
      expect((err as ImpriRateLimited).retryAfter).toBe(42)
    }
  })

  it('ImpriQuotaExceeded carries limit and tier', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(402, { message: 'Quota exceeded', limit: 100, tier: 'free' })),
    )
    try {
      await client().getAction(ACT_ID)
    } catch (err) {
      expect(err).toBeInstanceOf(ImpriQuotaExceeded)
      const e = err as ImpriQuotaExceeded
      expect(e.limit).toBe(100)
      expect(e.tier).toBe('free')
    }
  })

  it('ImpriValidationError carries issues array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resp(422, { message: 'Invalid', issues: [{ path: ['kind'], message: 'Required' }] }),
      ),
    )
    try {
      await client().getAction(ACT_ID)
    } catch (err) {
      expect(err).toBeInstanceOf(ImpriValidationError)
      expect((err as ImpriValidationError).issues).toHaveLength(1)
    }
  })
})

// ─── requiresApproval ─────────────────────────────────────────────────────────

describe('requiresApproval', () => {
  it('calls the wrapped function after approval', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))   // createAction
      .mockResolvedValueOnce(resp(200, approvedAction()))  // awaitDecision
    vi.stubGlobal('fetch', mockFetch)

    const fn = vi.fn().mockResolvedValue('result')
    const wrapped = client().requiresApproval(fn, {
      kind: 'test',
      title: 'Test',
      preview: { format: 'plain', body: 'body' },
    })

    const result = await wrapped()
    expect(result).toBe('result')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('throws ImpriRejected and does NOT call fn when rejected', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, rejectedAction()))
    vi.stubGlobal('fetch', mockFetch)

    const fn = vi.fn().mockResolvedValue('result')
    const wrapped = client().requiresApproval(fn, { kind: 'test', title: 'Test' })

    await expect(wrapped()).rejects.toBeInstanceOf(ImpriRejected)
    expect(fn).not.toHaveBeenCalled()
  })

  it('resolves title and preview from function arguments', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, approvedAction()))
    vi.stubGlobal('fetch', mockFetch)

    type Fn = (to: string, body: string) => Promise<string>
    const fn: Fn = vi.fn().mockResolvedValue('sent')
    const wrapped = client().requiresApproval(fn, {
      kind: 'email.send',
      title: (to: string) => `Send to ${to}`,
      preview: (_to: string, body: string) => ({ format: 'plain' as const, body }),
    })

    await wrapped('alice@example.com', 'Hello!')

    const createBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(createBody.title).toBe('Send to alice@example.com')
    expect(createBody.preview.body).toBe('Hello!')
  })

  it('passes payload factory result to createAction', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, approvedAction()))
    vi.stubGlobal('fetch', mockFetch)

    type Fn = (id: number) => Promise<void>
    const fn: Fn = vi.fn().mockResolvedValue(undefined)
    const wrapped = client().requiresApproval(fn, {
      kind: 'record.delete',
      title: (id: number) => `Delete record ${id}`,
      payload: (id: number) => ({ record_id: id }),
    })

    await wrapped(42)

    const createBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(createBody.payload).toEqual({ record_id: 42 })
  })
})

// ─── approvalGate ─────────────────────────────────────────────────────────────

describe('approvalGate', () => {
  it('returns ApprovedAction with finalPreview from decision', async () => {
    const editedApproved = {
      ...approvedAction(),
      decision: {
        verdict: 'approve',
        decided_at: 1720003600,
        final_preview: { format: 'plain', body: 'edited body' },
        diff: '...',
      },
    }
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, editedApproved))
    vi.stubGlobal('fetch', mockFetch)

    const gate = await client().approvalGate({
      kind: 'db.exec',
      title: 'DROP TABLE users',
      preview: { format: 'plain', body: 'original sql' },
      editable: ['preview.body'],
    })

    expect(gate.actionId).toBe(ACT_ID)
    expect(gate.finalPreview.body).toBe('edited body')
    expect(gate.decision.verdict).toBe('approve')
  })

  it('falls back to action preview when decision has no final_preview', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, approvedAction()))
    vi.stubGlobal('fetch', mockFetch)

    const gate = await client().approvalGate({
      kind: 'test',
      title: 'T',
      preview: { format: 'plain', body: 'original' },
    })

    expect(gate.finalPreview.body).toBe('hello') // from pendingAction fixture
  })

  it('throws ImpriRejected on rejection', async () => {
    const created = { id: ACT_ID, status: 'pending', inbox_url: 'u', expires_at: 0, created_at: 0 }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(201, created))
      .mockResolvedValueOnce(resp(200, rejectedAction()))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      client().approvalGate({ kind: 'k', title: 't', preview: { format: 'plain', body: 'b' } }),
    ).rejects.toBeInstanceOf(ImpriRejected)
  })
})

// ─── Watchers ─────────────────────────────────────────────────────────────────

describe('watchers', () => {
  const watcher = {
    id: 'w_1',
    name: 'AI News',
    kind: 'rss',
    config: { url: 'https://example.com/feed.rss' },
    keywords: [{ pattern: 'gpt', points: 5 }],
    keywords_none: [],
    min_score: 1,
    schedule: { every: '8h' },
    status: 'active',
    fail_count: 0,
    first_run_done: false,
    next_run_at: 1720010000,
    created_at: 1720000000,
    updated_at: 1720000000,
  }

  it('createWatcher POSTs to /v1/watchers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, watcher))
    vi.stubGlobal('fetch', mockFetch)

    const w = await client().createWatcher({
      name: 'AI News',
      kind: 'rss',
      config: { url: 'https://example.com/feed.rss' },
      schedule: { every: '8h' },
    })
    expect(w.id).toBe('w_1')
    expect(w.kind).toBe('rss')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/watchers`)
    expect(init.method).toBe('POST')
  })

  it('listWatchers GETs /v1/watchers with status filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [watcher], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listWatchers({ status: 'active' })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('status=active')
  })

  it('getWatcher GETs /v1/watchers/:id and returns item_count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(200, { ...watcher, item_count: 42 })),
    )
    const w = await client().getWatcher('w_1')
    expect(w.item_count).toBe(42)
    expect((vi.mocked(fetch).mock.calls[0][0] as string)).toBe(
      `${TEST_BASE}/v1/watchers/w_1`,
    )
  })

  it('updateWatcher PATCHes /v1/watchers/:id', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { ...watcher, status: 'paused' }))
    vi.stubGlobal('fetch', mockFetch)

    const w = await client().updateWatcher('w_1', { status: 'paused' })
    expect(w.status).toBe('paused')
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH')
  })

  it('deleteWatcher DELETEs /v1/watchers/:id (204)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noContentResp()))
    await expect(client().deleteWatcher('w_1')).resolves.toBeUndefined()
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })
})

// ─── API Keys ─────────────────────────────────────────────────────────────────

describe('api keys', () => {
  it('createKey POSTs to /v1/keys and returns raw key', async () => {
    const keyResp = {
      id: 'key_1',
      name: 'CI Key',
      key: 'im_rawvalue',
      prefix: 'im_rawvalue000',
      scopes: ['actions'],
      project_id: 'proj_1',
      created_at: 1720000000,
      note: 'Store immediately.',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(201, keyResp)))

    const k = await client().createKey('CI Key', ['actions'])
    expect(k.key).toBe('im_rawvalue')
    expect(k.scopes).toContain('actions')
  })

  it('listKeys GETs /v1/keys', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, [])))
    const keys = await client().listKeys()
    expect(Array.isArray(keys)).toBe(true)
  })

  it('revokeKey DELETEs /v1/keys/:id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noContentResp()))
    await expect(client().revokeKey('key_1')).resolves.toBeUndefined()
  })
})

// ─── Project ──────────────────────────────────────────────────────────────────

describe('project', () => {
  const project = { id: 'proj_1', name: 'Test Project', timezone: 'UTC', created_at: 1720000000 }

  it('getProject GETs /v1/project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, project)))
    const p = await client().getProject()
    expect(p.id).toBe('proj_1')
    expect(p.timezone).toBe('UTC')
  })

  it('updateProject PATCHes /v1/project', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { ...project, name: 'New Name' }))
    vi.stubGlobal('fetch', mockFetch)

    const p = await client().updateProject({ name: 'New Name' })
    expect(p.name).toBe('New Name')
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('PATCH')
  })

  it('rotateWebhookSecret POSTs to /v1/project/rotate-webhook-secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(200, { webhook_secret: 'whsec_new', note: 'Update handler.' })),
    )
    const r = await client().rotateWebhookSecret()
    expect(r.webhook_secret).toBe('whsec_new')
    expect((vi.mocked(fetch).mock.calls[0][0] as string)).toContain(
      'rotate-webhook-secret',
    )
  })

  it('exportProject GETs /v1/project/export', async () => {
    const exportData = {
      exported_at: 1720000000,
      project: {},
      actions: [],
      decisions: [],
      watchers: [],
      audit_log: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, exportData)))
    const e = await client().exportProject()
    expect(e.exported_at).toBe(1720000000)
  })

  it('eraseProjectData DELETEs /v1/project/data and returns counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(200, { erased: true, actions: 5, watchers: 2 })),
    )
    const r = await client().eraseProjectData()
    expect(r.erased).toBe(true)
    expect(r.actions).toBe(5)
    expect(r.watchers).toBe(2)
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).method).toBe('DELETE')
  })
})

// ─── Watcher Presets ──────────────────────────────────────────────────────────

/** Minimal preset fixture matching the catalog shape. */
function makePreset(overrides: Partial<WatcherPreset> = {}): WatcherPreset {
  return {
    id: 'hn-front-page',
    title: 'Hacker News Front Page',
    description: 'New posts as they appear on the HN front page',
    category: 'Community',
    kind: 'rss',
    params: [],
    defaultScheduleEvery: '30m',
    buildNotes: 'config.url = "https://news.ycombinator.com/rss".',
    ...overrides,
  }
}

/** Minimal watcher fixture used by createWatcherFromPreset responses. */
function makeWatcher(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w_preset_1',
    name: 'Hacker News Front Page',
    kind: 'rss',
    config: { url: 'https://news.ycombinator.com/rss' },
    keywords: [],
    keywords_none: [],
    min_score: 0,
    schedule: { every: '30m' },
    status: 'active',
    fail_count: 0,
    first_run_done: false,
    next_run_at: 1720010000,
    created_at: 1720000000,
    updated_at: 1720000000,
    ...overrides,
  }
}

describe('listWatcherPresets', () => {
  it('GETs /v1/watcher-presets and returns the presets array', async () => {
    const presets = [makePreset(), makePreset({ id: 'github-releases', title: 'GitHub Releases' })]
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { presets }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().listWatcherPresets()

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('hn-front-page')
    expect(result[1].id).toBe('github-releases')

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toBe(`${TEST_BASE}/v1/watcher-presets`)
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('GET')
  })

  it('sends Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { presets: [makePreset()] }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listWatcherPresets()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('returns an empty array when the catalog has no presets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { presets: [] })))
    const result = await client().listWatcherPresets()
    expect(result).toEqual([])
  })

  it('returns presets with correct shape including params array', async () => {
    const preset = makePreset({
      id: 'reddit-keyword',
      kind: 'reddit_search',
      params: [
        { name: 'query', required: true, description: 'Search query', example: 'self-hosting AI' },
        { name: 'subreddit', required: false, description: 'Subreddit', example: 'selfhosted' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { presets: [preset] })))

    const [p] = await client().listWatcherPresets()
    expect(p.params).toHaveLength(2)
    expect(p.params[0].required).toBe(true)
    expect(p.params[1].required).toBe(false)
  })

  it('propagates 401 as ImpriUnauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { message: 'Unauthorized' })))
    await expect(client().listWatcherPresets()).rejects.toBeInstanceOf(ImpriUnauthorized)
  })
})

describe('createWatcherFromPreset', () => {
  it('POSTs to /v1/watchers/from-preset with preset_id in body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    const w = await client().createWatcherFromPreset('hn-front-page')

    expect(w.id).toBe('w_preset_1')
    expect(w.kind).toBe('rss')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/watchers/from-preset`)
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string)
    expect(body.preset_id).toBe('hn-front-page')
  })

  it('sends params when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(201, makeWatcher({ id: 'w_2', kind: 'reddit_search' })))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('reddit-keyword', {
      query: 'self-hosting AI',
      subreddit: 'selfhosted',
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.params).toEqual({ query: 'self-hosting AI', subreddit: 'selfhosted' })
  })

  it('omits params key when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('hn-front-page')

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect('params' in body).toBe(false)
  })

  it('sends name override when provided via opts', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher({ name: 'My HN Feed' })))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('hn-front-page', undefined, { name: 'My HN Feed' })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.name).toBe('My HN Feed')
  })

  it('sends schedule override when provided via opts', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('hn-front-page', undefined, {
      schedule: { every: '2h', window: '06:00-22:00' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.schedule).toEqual({ every: '2h', window: '06:00-22:00' })
  })

  it('omits name and schedule keys when opts is not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('hn-front-page')

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect('name' in body).toBe(false)
    expect('schedule' in body).toBe(false)
  })

  it('sends params, name, and schedule together', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset(
      'github-releases',
      { owner: 'fastify', repo: 'fastify' },
      { name: 'Fastify Releases', schedule: { every: '6h' } },
    )

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.preset_id).toBe('github-releases')
    expect(body.params).toEqual({ owner: 'fastify', repo: 'fastify' })
    expect(body.name).toBe('Fastify Releases')
    expect(body.schedule).toEqual({ every: '6h' })
  })

  it('throws ImpriNotFound (404) when preset_id is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(404, { error: 'preset_not_found' })),
    )
    await expect(client().createWatcherFromPreset('no-such-preset')).rejects.toBeInstanceOf(
      ImpriNotFound,
    )
  })

  it('throws ImpriValidationError (400) when a required param is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resp(400, {
          error: 'Bad Request',
          issues: [{ path: ['params', 'query'], message: 'Required' }],
        }),
      ),
    )
    // Calling reddit-keyword without the required 'query' param
    await expect(
      client().createWatcherFromPreset('reddit-keyword', {}),
    ).rejects.toBeInstanceOf(ImpriValidationError)
  })

  it('throws ImpriValidationError when a param value fails format validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resp(400, {
          error: 'Bad Request',
          issues: [{ path: ['params', 'channel_id'], message: 'Invalid YouTube channel ID format' }],
        }),
      ),
    )
    await expect(
      client().createWatcherFromPreset('youtube-channel', { channel_id: 'INVALID' }),
    ).rejects.toBeInstanceOf(ImpriValidationError)
  })

  it('throws ImpriQuotaExceeded (402) when watcher limit is reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resp(402, { message: 'Watcher limit reached', limit: 5, tier: 'free' }),
      ),
    )
    await expect(client().createWatcherFromPreset('hn-front-page')).rejects.toBeInstanceOf(
      ImpriQuotaExceeded,
    )
  })

  it('throws ImpriRateLimited (429) when rate limit bucket is exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        resp(429, { message: 'Too many requests' }, { 'retry-after': '10' }),
      ),
    )
    await expect(client().createWatcherFromPreset('hn-front-page')).rejects.toBeInstanceOf(
      ImpriRateLimited,
    )
  })

  it('includes Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, makeWatcher()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createWatcherFromPreset('hn-front-page')

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })
})
