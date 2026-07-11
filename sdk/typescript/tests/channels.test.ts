import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ImpriClient,
  ImpriNotFound,
  ImpriUnauthorized,
  ImpriValidationError,
  type NotificationChannel,
  type ChannelTestResult,
} from '../src/index.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_KEY = 'im_test_abc123'
const TEST_BASE = 'http://localhost:19999'

function client() {
  return new ImpriClient({ apiKey: TEST_KEY, baseUrl: TEST_BASE })
}

/** Build a mock Response-like object. */
function resp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function slackChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch_slack1',
    project_id: 'proj_1',
    name: 'Slack ops',
    type: 'slack',
    enabled: true,
    config: { url: '****cdef' },
    digest_window_sec: 60,
    last_fired_at: null,
    fail_count: 0,
    last_error: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function telegramChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch_tg1',
    project_id: 'proj_1',
    name: 'Telegram alerts',
    type: 'telegram',
    enabled: true,
    config: { bot_token: '****:abc', chat_id: '-1001234567890' },
    digest_window_sec: 120,
    last_fired_at: 1700001000,
    fail_count: 0,
    last_error: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function emailChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch_email1',
    project_id: 'proj_1',
    name: 'Email ops',
    type: 'email',
    enabled: true,
    config: { address: 'ops@example.com' },
    digest_window_sec: 300,
    last_fired_at: null,
    fail_count: 0,
    last_error: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function webhookChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch_wh1',
    project_id: 'proj_1',
    name: 'Generic webhook',
    type: 'webhook',
    enabled: true,
    config: { url: '****cdef', hmac_secret: '****7890' },
    digest_window_sec: 60,
    last_fired_at: null,
    fail_count: 0,
    last_error: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function ntfyChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch_ntfy1',
    project_id: 'proj_1',
    name: 'ntfy self-hosted',
    type: 'ntfy',
    enabled: true,
    config: { url: '****8765', topic: 'my-alerts' },
    digest_window_sec: 60,
    last_fired_at: null,
    fail_count: 0,
    last_error: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── listNotificationChannels ─────────────────────────────────────────────────

describe('listNotificationChannels', () => {
  it('GETs /v1/notification-channels', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { channels: [] }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listNotificationChannels()

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels`)
    expect((init.method as string).toUpperCase()).toBe('GET')
  })

  it('sends Bearer Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { channels: [] }))
    vi.stubGlobal('fetch', mockFetch)

    await client().listNotificationChannels()

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('returns the channels array', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { channels: [slackChannel(), telegramChannel()] }))
    vi.stubGlobal('fetch', mockFetch)

    const channels = await client().listNotificationChannels()

    expect(channels).toHaveLength(2)
    expect(channels[0].id).toBe('ch_slack1')
    expect(channels[1].id).toBe('ch_tg1')
  })

  it('returns empty array when no channels exist', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { channels: [] }))
    vi.stubGlobal('fetch', mockFetch)

    const channels = await client().listNotificationChannels()

    expect(channels).toEqual([])
  })

  it('throws ImpriUnauthorized on 403', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(403, { error: 'Forbidden' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(client().listNotificationChannels()).rejects.toBeInstanceOf(ImpriUnauthorized)
  })
})

// ─── createNotificationChannel ────────────────────────────────────────────────

describe('createNotificationChannel', () => {
  it('POSTs to /v1/notification-channels', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Slack ops',
      type: 'slack',
      config: { url: 'https://hooks.slack.com/services/T00/B00/abcdef' },
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels`)
    expect((init.method as string).toUpperCase()).toBe('POST')
  })

  it('sends the correct body fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Slack ops',
      type: 'slack',
      config: { url: 'https://hooks.slack.com/services/T00/B00/abcdef' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.name).toBe('Slack ops')
    expect(body.type).toBe('slack')
    expect(body.config.url).toBe('https://hooks.slack.com/services/T00/B00/abcdef')
  })

  it('returns the created channel with masked config', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    const ch = await client().createNotificationChannel({
      name: 'Slack ops',
      type: 'slack',
      config: { url: 'https://hooks.slack.com/services/T00/B00/abcdef' },
    })

    expect(ch.id).toBe('ch_slack1')
    // SDK passes the server response through; server masks the URL
    const cfg = ch.config as Record<string, string>
    expect(cfg.url).toMatch(/^\*\*\*\*/)
  })

  it('passes enabled=false and digest_window_sec when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, slackChannel({ enabled: false })))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Slack ops',
      type: 'slack',
      config: { url: 'https://hooks.slack.com/services/T00/B00/abcdef' },
      enabled: false,
      digest_window_sec: 300,
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.enabled).toBe(false)
    expect(body.digest_window_sec).toBe(300)
  })

  it('creates a telegram channel with bot_token and chat_id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, telegramChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Telegram alerts',
      type: 'telegram',
      config: {
        bot_token: '123456789:AAFxxxxxxxxxxxxxxxx',
        chat_id: '-1001234567890',
      },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.type).toBe('telegram')
    expect(body.config.bot_token).toBe('123456789:AAFxxxxxxxxxxxxxxxx')
    expect(body.config.chat_id).toBe('-1001234567890')
  })

  it('creates an email channel', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, emailChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Email ops',
      type: 'email',
      config: { address: 'ops@example.com' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.type).toBe('email')
    expect(body.config.address).toBe('ops@example.com')
  })

  it('creates a webhook channel with optional hmac_secret', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, webhookChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'Generic webhook',
      type: 'webhook',
      config: {
        url: 'https://myapp.example.com/impri-hook',
        hmac_secret: 'my-secret-1234567890',
      },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.type).toBe('webhook')
    expect(body.config.hmac_secret).toBe('my-secret-1234567890')
  })

  it('creates an ntfy channel', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(201, ntfyChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().createNotificationChannel({
      name: 'ntfy self-hosted',
      type: 'ntfy',
      config: { url: 'https://ntfy.sh', topic: 'my-alerts' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.type).toBe('ntfy')
    expect(body.config.topic).toBe('my-alerts')
  })

  it('throws ImpriValidationError on 400', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      resp(400, { error: 'Validation error', message: 'config.url is required' }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      client().createNotificationChannel({ name: 'Bad', type: 'slack', config: {} }),
    ).rejects.toBeInstanceOf(ImpriValidationError)
  })
})

// ─── getNotificationChannel ───────────────────────────────────────────────────

describe('getNotificationChannel', () => {
  it('GETs /v1/notification-channels/:id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().getNotificationChannel('ch_slack1')

    const [url] = mockFetch.mock.calls[0] as [string]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels/ch_slack1`)
  })

  it('returns the channel with masked config', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    const ch = await client().getNotificationChannel('ch_slack1')

    expect(ch.id).toBe('ch_slack1')
    expect(ch.type).toBe('slack')
    const cfg = ch.config as Record<string, string>
    expect(cfg.url).toMatch(/^\*\*\*\*/)
  })

  it('telegram: bot_token masked, chat_id returned as-is', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, telegramChannel()))
    vi.stubGlobal('fetch', mockFetch)

    const ch = await client().getNotificationChannel('ch_tg1')

    const cfg = ch.config as Record<string, string>
    // bot_token is masked by the server
    expect(cfg.bot_token).toMatch(/^\*\*\*\*/)
    // chat_id is not a secret — returned as-is by the server
    expect(cfg.chat_id).toBe('-1001234567890')
  })

  it('email: address not masked', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, emailChannel()))
    vi.stubGlobal('fetch', mockFetch)

    const ch = await client().getNotificationChannel('ch_email1')

    const cfg = ch.config as Record<string, string>
    expect(cfg.address).toBe('ops@example.com')
  })

  it('throws ImpriNotFound on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(404, { error: 'Not Found' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(client().getNotificationChannel('ch_missing')).rejects.toBeInstanceOf(
      ImpriNotFound,
    )
  })
})

// ─── updateNotificationChannel ────────────────────────────────────────────────

describe('updateNotificationChannel', () => {
  it('PATCHes /v1/notification-channels/:id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().updateNotificationChannel('ch_slack1', { name: 'Renamed' })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels/ch_slack1`)
    expect((init.method as string).toUpperCase()).toBe('PATCH')
  })

  it('sends only the supplied fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().updateNotificationChannel('ch_slack1', { name: 'New name' })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.name).toBe('New name')
    expect(body.config).toBeUndefined()
    expect(body.enabled).toBeUndefined()
    expect(body.digest_window_sec).toBeUndefined()
  })

  it('can disable a channel', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel({ enabled: false })))
    vi.stubGlobal('fetch', mockFetch)

    const ch = await client().updateNotificationChannel('ch_slack1', { enabled: false })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.enabled).toBe(false)
    expect(ch.enabled).toBe(false)
  })

  it('can update digest_window_sec', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, slackChannel({ digest_window_sec: 300 })))
    vi.stubGlobal('fetch', mockFetch)

    await client().updateNotificationChannel('ch_slack1', { digest_window_sec: 300 })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.digest_window_sec).toBe(300)
  })

  it('can update config', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().updateNotificationChannel('ch_slack1', {
      config: { url: 'https://hooks.slack.com/services/T00/B00/newurl' },
    })

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.config).toBeDefined()
    expect(body.config.url).toBe('https://hooks.slack.com/services/T00/B00/newurl')
  })

  it('sends empty body when no fields supplied', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, slackChannel()))
    vi.stubGlobal('fetch', mockFetch)

    await client().updateNotificationChannel('ch_slack1', {})

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({})
  })

  it('throws ImpriNotFound on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(404, { error: 'Not Found' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      client().updateNotificationChannel('ch_missing', { name: 'X' }),
    ).rejects.toBeInstanceOf(ImpriNotFound)
  })
})

// ─── deleteNotificationChannel ────────────────────────────────────────────────

describe('deleteNotificationChannel', () => {
  it('DELETEs /v1/notification-channels/:id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noContentResp())
    vi.stubGlobal('fetch', mockFetch)

    await client().deleteNotificationChannel('ch_slack1')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels/ch_slack1`)
    expect((init.method as string).toUpperCase()).toBe('DELETE')
  })

  it('returns void on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue(noContentResp())
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().deleteNotificationChannel('ch_slack1')

    expect(result).toBeUndefined()
  })

  it('throws ImpriNotFound on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(404, { error: 'Not Found' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(client().deleteNotificationChannel('ch_missing')).rejects.toBeInstanceOf(
      ImpriNotFound,
    )
  })
})

// ─── testNotificationChannel ──────────────────────────────────────────────────

describe('testNotificationChannel', () => {
  it('POSTs to /v1/notification-channels/:id/test', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { ok: true }))
    vi.stubGlobal('fetch', mockFetch)

    await client().testNotificationChannel('ch_slack1')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TEST_BASE}/v1/notification-channels/ch_slack1/test`)
    expect((init.method as string).toUpperCase()).toBe('POST')
  })

  it('returns { ok: true } on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(200, { ok: true }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().testNotificationChannel('ch_slack1')

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns { ok: false, error } on delivery failure', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { ok: false, error: 'connection refused' }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().testNotificationChannel('ch_slack1')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('connection refused')
  })

  it('error message does not contain raw secrets (server guarantee, SDK passes through)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(resp(200, { ok: false, error: 'delivery failed' }))
    vi.stubGlobal('fetch', mockFetch)

    const result = await client().testNotificationChannel('ch_tg1')

    // SDK does not inject secrets into the error
    expect(result.error).not.toContain('bot_token')
  })

  it('throws ImpriNotFound on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(404, { error: 'Not Found' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(client().testNotificationChannel('ch_missing')).rejects.toBeInstanceOf(
      ImpriNotFound,
    )
  })

  it('throws ImpriUnauthorized on 403', async () => {
    const mockFetch = vi.fn().mockResolvedValue(resp(403, { error: 'Forbidden' }))
    vi.stubGlobal('fetch', mockFetch)

    await expect(client().testNotificationChannel('ch_slack1')).rejects.toBeInstanceOf(
      ImpriUnauthorized,
    )
  })
})
