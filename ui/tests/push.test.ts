import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiClient, ApiClientError } from '../src/api/client'
import { urlBase64ToUint8Array, isPushSupported, subscribeToPush, unsubscribeFromPush } from '../src/utils/push'

// ─── Helper ───────────────────────────────────────────────────────────────────

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

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── urlBase64ToUint8Array ────────────────────────────────────────────────────

describe('urlBase64ToUint8Array', () => {
  it('converts a standard base64url string to Uint8Array', () => {
    // "hello" in base64url is "aGVsbG8"
    const result = urlBase64ToUint8Array('aGVsbG8')
    expect(result).toBeInstanceOf(Uint8Array)
    // "hello" → [104, 101, 108, 108, 111]
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111])
  })

  it('handles URL-safe characters: - becomes + and _ becomes /', () => {
    // base64url for bytes [0xfb, 0xff] is "-_8" (standard: "+/8=")
    const result = urlBase64ToUint8Array('-_8')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result[0]).toBe(0xfb)
    expect(result[1]).toBe(0xff)
  })

  it('handles strings that already have padding', () => {
    const result = urlBase64ToUint8Array('aGVsbG8=')
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111])
  })

  it('handles an empty string', () => {
    const result = urlBase64ToUint8Array('')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(0)
  })

  it('round-trips a realistic VAPID key length (65 bytes)', () => {
    // Build 65 random-ish bytes
    const bytes = new Uint8Array(65)
    for (let i = 0; i < 65; i++) bytes[i] = i * 3 + 7
    // Encode to base64url
    const base64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    const result = urlBase64ToUint8Array(base64url)
    expect(Array.from(result)).toEqual(Array.from(bytes))
  })
})

// ─── isPushSupported ──────────────────────────────────────────────────────────

describe('isPushSupported', () => {
  it('returns true when serviceWorker, PushManager and Notification are available', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', class {})
    expect(isPushSupported()).toBe(true)
  })

  it('returns false when serviceWorker is missing', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', class {})
    expect(isPushSupported()).toBe(false)
  })

  it('returns false when PushManager is missing', () => {
    vi.stubGlobal('navigator', { serviceWorker: {} })
    // Remove PushManager from window
    const win = globalThis as Record<string, unknown>
    const orig = win['PushManager']
    delete win['PushManager']
    expect(isPushSupported()).toBe(false)
    if (orig !== undefined) win['PushManager'] = orig
  })
})

// ─── ApiClient push methods ───────────────────────────────────────────────────

describe('ApiClient.getVapidPublicKey', () => {
  it('fetches /v1/push/vapid-public-key without Authorization header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ enabled: true, public_key: 'abc123' }),
    }))
    const client = new ApiClient('im_key')
    const res = await client.getVapidPublicKey()
    expect(res.enabled).toBe(true)
    expect(res.public_key).toBe('abc123')
    const [url] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit?]
    expect(url).toContain('/push/vapid-public-key')
  })

  it('returns enabled=false with null public_key when push is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ enabled: false, public_key: null }),
    }))
    const client = new ApiClient('im_key')
    const res = await client.getVapidPublicKey()
    expect(res.enabled).toBe(false)
    expect(res.public_key).toBeNull()
  })

  it('throws ApiClientError on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal Server Error' }),
    }))
    const client = new ApiClient('im_key')
    await expect(client.getVapidPublicKey()).rejects.toThrow(ApiClientError)
  })
})

describe('ApiClient.pushSubscribe', () => {
  it('sends POST /push/subscribe with subscription body', async () => {
    mockFetch(201, {})
    const client = new ApiClient('im_key')
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'key123', auth: 'auth456' },
    }
    await client.pushSubscribe(sub)
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/push/subscribe')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as typeof sub
    expect(body.endpoint).toBe(sub.endpoint)
    expect(body.keys.p256dh).toBe('key123')
    expect(body.keys.auth).toBe('auth456')
  })

  it('sends Authorization header with Bearer token', async () => {
    mockFetch(201, {})
    const client = new ApiClient('im_mykey')
    await client.pushSubscribe({ endpoint: 'https://example.com', keys: { p256dh: 'a', auth: 'b' } })
    const [, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer im_mykey')
  })

  it('throws ApiClientError on 400 (push disabled)', async () => {
    mockFetch(400, { error: 'Push notifications disabled' })
    const client = new ApiClient('im_key')
    await expect(
      client.pushSubscribe({ endpoint: 'https://example.com', keys: { p256dh: 'a', auth: 'b' } }),
    ).rejects.toThrow(ApiClientError)
  })
})

describe('ApiClient.pushUnsubscribe', () => {
  it('sends DELETE /push/subscribe with endpoint in body', async () => {
    mockFetch(204, undefined)
    const client = new ApiClient('im_key')
    await client.pushUnsubscribe('https://fcm.googleapis.com/fcm/send/xyz')
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/push/subscribe')
    expect(opts.method).toBe('DELETE')
    const body = JSON.parse(opts.body as string) as { endpoint: string }
    expect(body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/xyz')
  })

  it('resolves to undefined on 204', async () => {
    mockFetch(204, undefined)
    const client = new ApiClient('im_key')
    const result = await client.pushUnsubscribe('https://example.com')
    expect(result).toBeUndefined()
  })
})

// ─── subscribeToPush / unsubscribeFromPush flow ───────────────────────────────

function makeMockSubscription(endpoint = 'https://push.example.com/sub/1') {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'p256key', auth: 'authsecret' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

function setupPushMocks({
  permissionResult = 'granted' as NotificationPermission,
  vapidEnabled = true,
  vapidKey = 'dGVzdGtleQ', // base64url for "testkey"
  existingSubscription = null as ReturnType<typeof makeMockSubscription> | null,
  newSubscription = makeMockSubscription(),
} = {}) {
  vi.stubGlobal('Notification', {
    permission: permissionResult,
    requestPermission: vi.fn().mockResolvedValue(permissionResult),
  })

  const mockPushManager = {
    subscribe: vi.fn().mockResolvedValue(newSubscription),
    getSubscription: vi.fn().mockResolvedValue(existingSubscription),
  }

  const mockRegistration = {
    pushManager: mockPushManager,
  }

  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn().mockResolvedValue(mockRegistration),
      getRegistration: vi.fn().mockResolvedValue(mockRegistration),
    },
  })

  vi.stubGlobal('PushManager', class {})

  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const urlStr = String(url)
    if (urlStr.includes('vapid-public-key')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ enabled: vapidEnabled, public_key: vapidEnabled ? vapidKey : null }),
      })
    }
    // POST subscribe or DELETE subscribe → 201/204
    return Promise.resolve({
      ok: true,
      status: urlStr.includes('DELETE') ? 204 : 201,
      json: () => Promise.resolve({}),
    })
  }))

  return { mockPushManager, mockRegistration }
}

describe('subscribeToPush', () => {
  it('throws when push is not supported in browser', async () => {
    vi.stubGlobal('navigator', {})
    const client = new ApiClient('im_key')
    await expect(subscribeToPush(client)).rejects.toThrow('not supported')
  })

  it('throws when notification permission is denied', async () => {
    setupPushMocks({ permissionResult: 'denied' })
    const client = new ApiClient('im_key')
    await expect(subscribeToPush(client)).rejects.toThrow('permission was denied')
  })

  it('throws when push is disabled on the server', async () => {
    setupPushMocks({ vapidEnabled: false })
    const client = new ApiClient('im_key')
    await expect(subscribeToPush(client)).rejects.toThrow('not enabled on this server')
  })

  it('registers sw, subscribes to pushManager, and POSTs to API', async () => {
    const sub = makeMockSubscription()
    const { mockPushManager, mockRegistration } = setupPushMocks({ newSubscription: sub })

    const client = new ApiClient('im_key')
    await subscribeToPush(client)

    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js')
    expect(mockPushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    })

    // Verify POST /push/subscribe was called with correct shape
    const calls = (vi.mocked(fetch)).mock.calls as Array<[string, RequestInit]>
    const postCall = calls.find(([, opts]) => opts?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall![1].body as string) as {
      endpoint: string
      keys: { p256dh: string; auth: string }
    }
    expect(body.endpoint).toBe(sub.endpoint)
    expect(body.keys.p256dh).toBe('p256key')
    expect(body.keys.auth).toBe('authsecret')

    // mockRegistration used to satisfy TS — check sw was registered
    expect(mockRegistration.pushManager).toBe(mockPushManager)
  })
})

describe('unsubscribeFromPush', () => {
  it('does nothing when push is not supported', async () => {
    vi.stubGlobal('navigator', {})
    const client = new ApiClient('im_key')
    await expect(unsubscribeFromPush(client)).resolves.toBeUndefined()
  })

  it('does nothing when no service worker registration exists', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(undefined),
      },
    })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() })
    const client = new ApiClient('im_key')
    await expect(unsubscribeFromPush(client)).resolves.toBeUndefined()
  })

  it('does nothing when there is no active subscription', async () => {
    setupPushMocks({ existingSubscription: null })
    const client = new ApiClient('im_key')
    await expect(unsubscribeFromPush(client)).resolves.toBeUndefined()
  })

  it('calls unsubscribe on PushSubscription and sends DELETE to API', async () => {
    const sub = makeMockSubscription('https://push.example.com/existing/42')
    setupPushMocks({ existingSubscription: sub })

    const client = new ApiClient('im_key')
    await unsubscribeFromPush(client)

    expect(sub.unsubscribe).toHaveBeenCalled()

    const calls = (vi.mocked(fetch)).mock.calls as Array<[string, RequestInit]>
    const deleteCall = calls.find(([, opts]) => opts?.method === 'DELETE')
    expect(deleteCall).toBeDefined()
    const body = JSON.parse(deleteCall![1].body as string) as { endpoint: string }
    expect(body.endpoint).toBe('https://push.example.com/existing/42')
  })
})
