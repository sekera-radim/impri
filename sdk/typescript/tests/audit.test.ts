import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ImpriClient,
  ImpriRateLimited,
  ImpriUnauthorized,
  type AuditEvent,
  type ListAuditParams,
} from '../src/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_KEY = 'im_test_audit_abc'
const TEST_BASE = 'http://localhost:29999'

function client() {
  return new ImpriClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE })
}

/** Build a JSON-response mock. */
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
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/** Build a text/ndjson/csv response mock. */
function textResp(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => { throw new Error('Not JSON') },
    text: () => Promise.resolve(text),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── Audit event fixture ──────────────────────────────────────────────────────

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1001,
    event: 'action.approved',
    action_id: 'act_abc',
    actor: 'key_admin',
    channel: 'web',
    data: { rule_id: 'rul_x' },
    created_at: 1720001000,
    ...overrides,
  }
}

const NDJSON_BODY =
  '{"id":1001,"event":"action.approved","action_id":"act_abc","actor":"key_admin","channel":"web","data":{"rule_id":"rul_x"},"created_at":1720001000}\n' +
  '{"id":1002,"event":"rule.created","action_id":null,"actor":"key_admin","channel":null,"data":null,"created_at":1720002000}\n'

const CSV_BODY =
  'id,event,action_id,actor,channel,data,created_at\r\n' +
  '1001,action.approved,act_abc,key_admin,web,"{""rule_id"":""rul_x""}",1720001000\r\n' +
  '1002,rule.created,,key_admin,,,1720002000\r\n'

// ─── listAudit ────────────────────────────────────────────────────────────────

describe('listAudit', () => {
  it('GETs /v1/audit', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit()

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toBe(`${TEST_BASE}/v1/audit`)
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('GET')
  })

  it('sends Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('forwards type filter in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ type: 'action.' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('type=action.')
  })

  it('forwards actor filter in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ actor: 'key_admin' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('actor=key_admin')
  })

  it('forwards entity_id filter in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ entity_id: 'act_abc' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('entity_id=act_abc')
  })

  it('forwards since and until in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ since: 1720000000, until: 1720009999 })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('since=1720000000')
    expect(url).toContain('until=1720009999')
  })

  it('forwards limit in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ limit: 20 })

    expect(mockFetch.mock.calls[0][0] as string).toContain('limit=20')
  })

  it('forwards cursor in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ cursor: 'cursor_xyz' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('cursor=cursor_xyz')
  })

  it('omits undefined params from query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({})

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).not.toContain('?')
  })

  it('returns a paged result with items, has_more, and next_cursor', async () => {
    const page = {
      items: [auditEvent()],
      has_more: true,
      next_cursor: 'cursor_abc',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, page)))

    const result = await client().listAudit()

    expect(result.items).toHaveLength(1)
    expect(result.has_more).toBe(true)
    expect(result.next_cursor).toBe('cursor_abc')
    expect(result.items[0].event).toBe('action.approved')
    expect(result.items[0].data).toEqual({ rule_id: 'rul_x' })
  })

  it('returns correct AuditEvent shape', async () => {
    const event = auditEvent({
      id: 2001,
      event: 'rule.deleted',
      action_id: null,
      actor: 'key_x',
      channel: null,
      data: { rule_id: 'rul_del' },
      created_at: 1720005000,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { items: [event], has_more: false })))

    const result = await client().listAudit()
    const item = result.items[0]
    expect(item.id).toBe(2001)
    expect(item.event).toBe('rule.deleted')
    expect(item.action_id).toBeNull()
    expect(item.actor).toBe('key_x')
    expect(item.channel).toBeNull()
    expect(item.data).toEqual({ rule_id: 'rul_del' })
    expect(item.created_at).toBe(1720005000)
  })

  it('auto-paginates across two pages when autoPaginate=true', async () => {
    const page1 = {
      items: [auditEvent({ id: 1001 })],
      has_more: true,
      next_cursor: 'cur1',
    }
    const page2 = {
      items: [auditEvent({ id: 1002, event: 'rule.created' })],
      has_more: false,
    }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(200, page1))
      .mockResolvedValueOnce(resp(200, page2))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().listAudit({ autoPaginate: true })

    expect(result.items).toHaveLength(2)
    expect(result.has_more).toBe(false)
    expect(result.items[0].id).toBe(1001)
    expect(result.items[1].id).toBe(1002)
    expect(mockFetch).toHaveBeenCalledTimes(2)

    const secondUrl = mockFetch.mock.calls[1][0] as string
    expect(secondUrl).toContain('cursor=cur1')
  })

  it('autoPaginate carries filters through all pages', async () => {
    const page1 = { items: [auditEvent()], has_more: true, next_cursor: 'c1' }
    const page2 = { items: [], has_more: false }
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(resp(200, page1))
      .mockResolvedValueOnce(resp(200, page2))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({ type: 'action.', actor: 'key_admin', autoPaginate: true })

    for (const call of mockFetch.mock.calls) {
      const url = call[0] as string
      expect(url).toContain('type=action.')
      expect(url).toContain('actor=key_admin')
    }
  })

  it('propagates 403 as ImpriUnauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { message: "Scope 'admin' required" })))
    await expect(client().listAudit()).rejects.toBeInstanceOf(ImpriUnauthorized)
  })

  it('propagates 429 as ImpriRateLimited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(429, { message: 'Rate limit' })))
    await expect(client().listAudit()).rejects.toBeInstanceOf(ImpriRateLimited)
  })

  it('returns an empty items array on an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false })))

    const result = await client().listAudit()
    expect(result.items).toEqual([])
    expect(result.has_more).toBe(false)
  })

  it('combines multiple filters in a single query', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { items: [], has_more: false }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listAudit({
      type: 'key.',
      actor: 'key_admin',
      entity_id: 'act_xyz',
      since: 1720000000,
      until: 1720099999,
      limit: 100,
    })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('type=key.')
    expect(url).toContain('actor=key_admin')
    expect(url).toContain('entity_id=act_xyz')
    expect(url).toContain('since=1720000000')
    expect(url).toContain('until=1720099999')
    expect(url).toContain('limit=100')
  })
})

// ─── exportAudit ─────────────────────────────────────────────────────────────

describe('exportAudit', () => {
  it('GETs /v1/audit/export', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit()

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toMatch(/^http:\/\/localhost:29999\/v1\/audit\/export/)
    expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('GET')
  })

  it('sends Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('does not include format param by default (server defaults to json)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit()

    const url = mockFetch.mock.calls[0][0] as string
    // format is undefined so buildQuery omits it
    expect(url).not.toContain('format=')
  })

  it('forwards format=json in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ format: 'json' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('format=json')
  })

  it('forwards format=csv in query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, CSV_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ format: 'csv' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('format=csv')
  })

  it('forwards type filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ type: 'action.' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('type=action.')
  })

  it('forwards actor filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ actor: 'key_admin' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('actor=key_admin')
  })

  it('forwards entity_id filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ entity_id: 'act_abc' })

    expect(mockFetch.mock.calls[0][0] as string).toContain('entity_id=act_abc')
  })

  it('forwards since and until', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({ since: 1720000000, until: 1720099999 })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('since=1720000000')
    expect(url).toContain('until=1720099999')
  })

  it('omits undefined filters from query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({})

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).not.toContain('?')
  })

  it('returns the raw ndjson string from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY)))

    const result = await client().exportAudit()

    expect(typeof result).toBe('string')
    expect(result).toBe(NDJSON_BODY)
  })

  it('returns the raw CSV string when format=csv', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResp(200, CSV_BODY)))

    const result = await client().exportAudit({ format: 'csv' })

    expect(result).toBe(CSV_BODY)
    expect(result.startsWith('id,event,')).toBe(true)
  })

  it('ndjson result can be split into parseable JSON lines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResp(200, NDJSON_BODY)))

    const result = await client().exportAudit()
    const lines = result.trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].event).toBe('action.approved')
    expect(lines[1].event).toBe('rule.created')
  })

  it('propagates 403 as ImpriUnauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(403, { message: "Scope 'admin' required" })),
    )
    await expect(client().exportAudit()).rejects.toBeInstanceOf(ImpriUnauthorized)
  })

  it('propagates 429 as ImpriRateLimited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(429, { message: 'Rate limit' }, { 'retry-after': '5' })),
    )
    await expect(client().exportAudit()).rejects.toBeInstanceOf(ImpriRateLimited)
  })

  it('combines all filters in a single query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(textResp(200, CSV_BODY))
    vi.stubGlobal('fetch', mockFetch)

    await client().exportAudit({
      type: 'action.',
      actor: 'key_admin',
      entity_id: 'act_abc',
      since: 1720000000,
      until: 1720099999,
      format: 'csv',
    })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('type=action.')
    expect(url).toContain('actor=key_admin')
    expect(url).toContain('entity_id=act_abc')
    expect(url).toContain('since=1720000000')
    expect(url).toContain('until=1720099999')
    expect(url).toContain('format=csv')
  })
})
