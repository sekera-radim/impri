import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ApiClient } from '../src/api/client'
import { useBillingStore } from '../src/stores/billing'
import { useAuthStore } from '../src/stores/auth'
import { usagePercent, usageColor } from '../src/utils/billing'
import type { Billing } from '../src/types'

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

// ─── usagePercent utility ─────────────────────────────────────────────────────

describe('usagePercent', () => {
  it('returns correct percentage for normal usage', () => {
    expect(usagePercent(50, 100)).toBe(50)
  })

  it('returns 0 when limit is null (unlimited)', () => {
    expect(usagePercent(500, null)).toBe(0)
  })

  it('caps at 100 when used exceeds limit', () => {
    expect(usagePercent(150, 100)).toBe(100)
  })

  it('returns 0 when used is 0', () => {
    expect(usagePercent(0, 100)).toBe(0)
  })

  it('returns 0 when limit is 0 (avoid division by zero)', () => {
    expect(usagePercent(5, 0)).toBe(0)
  })

  it('rounds to nearest integer', () => {
    expect(usagePercent(1, 3)).toBe(33)
  })
})

// ─── usageColor utility ───────────────────────────────────────────────────────

describe('usageColor', () => {
  it('returns primary color below 70%', () => {
    expect(usageColor(50)).toBe('primary')
  })

  it('returns warning color at 70–89%', () => {
    expect(usageColor(70)).toBe('warning')
    expect(usageColor(89)).toBe('warning')
  })

  it('returns error color at 90% and above', () => {
    expect(usageColor(90)).toBe('error')
    expect(usageColor(100)).toBe('error')
  })
})

// ─── ApiClient billing methods ────────────────────────────────────────────────

describe('ApiClient.getBilling', () => {
  it('sends GET /billing', async () => {
    const billingData: Billing = {
      tier: 'free',
      status: 'active',
      usage: { watchers: { used: 2, limit: 3 }, approvals: { used: 40, limit: 100 } },
      billing_enabled: true,
    }
    mockFetch(200, billingData)
    const client = new ApiClient('im_key')
    const result = await client.getBilling()
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/billing')
    expect(opts.method).toBe('GET')
    expect(result.tier).toBe('free')
    expect(result.billing_enabled).toBe(true)
  })

  it('returns billing_enabled=false for self-hosted', async () => {
    const billingData: Billing = {
      tier: 'free',
      status: 'none',
      usage: { watchers: { used: 0, limit: null }, approvals: { used: 0, limit: null } },
      billing_enabled: false,
    }
    mockFetch(200, billingData)
    const client = new ApiClient('im_key')
    const result = await client.getBilling()
    expect(result.billing_enabled).toBe(false)
    expect(result.usage.watchers.limit).toBeNull()
    expect(result.usage.approvals.limit).toBeNull()
  })
})

describe('ApiClient.createCheckout', () => {
  it('sends POST /billing/checkout with correct plan and period', async () => {
    mockFetch(200, { url: 'https://checkout.stripe.com/pay/cs_test_123' })
    const client = new ApiClient('im_key')
    const result = await client.createCheckout('indie', 'monthly')
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/billing/checkout')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as { plan: string; period: string }
    expect(body.plan).toBe('indie')
    expect(body.period).toBe('monthly')
    expect(result.url).toBe('https://checkout.stripe.com/pay/cs_test_123')
  })

  it('sends yearly period when specified', async () => {
    mockFetch(200, { url: 'https://checkout.stripe.com/pay/cs_year_456' })
    const client = new ApiClient('im_key')
    await client.createCheckout('team', 'yearly')
    const [, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as { plan: string; period: string }
    expect(body.plan).toBe('team')
    expect(body.period).toBe('yearly')
  })
})

describe('ApiClient.openPortal', () => {
  it('sends POST /billing/portal and returns url', async () => {
    mockFetch(200, { url: 'https://billing.stripe.com/session/bps_test_789' })
    const client = new ApiClient('im_key')
    const result = await client.openPortal()
    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/billing/portal')
    expect(opts.method).toBe('POST')
    expect(result.url).toBe('https://billing.stripe.com/session/bps_test_789')
  })
})

// ─── Billing store ────────────────────────────────────────────────────────────

describe('useBillingStore.fetchBilling', () => {
  it('sets billing data from API response', async () => {
    const billingData: Billing = {
      tier: 'indie',
      status: 'active',
      current_period_end: 1800000000,
      usage: { watchers: { used: 5, limit: 20 }, approvals: { used: 300, limit: 2000 } },
      billing_enabled: true,
    }
    mockFetch(200, billingData)

    const auth = useAuthStore()
    auth.apiKey = 'im_testkey'

    const store = useBillingStore()
    await store.fetchBilling()

    expect(store.billing).not.toBeNull()
    expect(store.billing?.tier).toBe('indie')
    expect(store.billing?.usage.watchers.used).toBe(5)
    expect(store.billing?.usage.watchers.limit).toBe(20)
    expect(store.billing?.billing_enabled).toBe(true)
    expect(store.error).toBeNull()
  })

  it('sets billing with billing_enabled=false for self-hosted setup', async () => {
    const billingData: Billing = {
      tier: 'free',
      status: 'none',
      usage: { watchers: { used: 1, limit: null }, approvals: { used: 10, limit: null } },
      billing_enabled: false,
    }
    mockFetch(200, billingData)

    const auth = useAuthStore()
    auth.apiKey = 'im_selfhost'

    const store = useBillingStore()
    await store.fetchBilling()

    expect(store.billing?.billing_enabled).toBe(false)
    expect(store.billing?.usage.watchers.limit).toBeNull()
  })

  it('sets error message on API failure', async () => {
    mockFetch(500, { error: 'Internal Server Error', message: 'Something went wrong' })

    const auth = useAuthStore()
    auth.apiKey = 'im_testkey'

    const store = useBillingStore()
    await store.fetchBilling()

    expect(store.billing).toBeNull()
    expect(store.error).toBe('Something went wrong')
  })

  it('does nothing when not authenticated', async () => {
    const store = useBillingStore()
    await store.fetchBilling()
    expect(store.billing).toBeNull()
    expect(store.loading).toBe(false)
  })
})

describe('useBillingStore.checkout', () => {
  it('calls createCheckout with correct plan and period and redirects', async () => {
    const checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_abc'
    mockFetch(200, { url: checkoutUrl })

    const auth = useAuthStore()
    auth.apiKey = 'im_testkey'

    // Mock window.location.href assignment
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    })
    let redirectedTo = ''
    Object.defineProperty(window, 'location', {
      value: { ...window.location, set href(url: string) { redirectedTo = url } },
      writable: true,
    })

    const store = useBillingStore()
    await store.checkout('indie', 'monthly')

    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/billing/checkout')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body as string) as { plan: string; period: string }
    expect(body.plan).toBe('indie')
    expect(body.period).toBe('monthly')
    expect(redirectedTo).toBe(checkoutUrl)

    locationSpy.mockRestore()
  })

  it('throws when not authenticated', async () => {
    const store = useBillingStore()
    await expect(store.checkout('indie', 'monthly')).rejects.toThrow('Not authenticated')
  })
})

describe('useBillingStore.portal', () => {
  it('calls openPortal and redirects to returned url', async () => {
    const portalUrl = 'https://billing.stripe.com/session/bps_test_xyz'
    mockFetch(200, { url: portalUrl })

    const auth = useAuthStore()
    auth.apiKey = 'im_testkey'

    let redirectedTo = ''
    Object.defineProperty(window, 'location', {
      value: { ...window.location, set href(url: string) { redirectedTo = url } },
      writable: true,
    })

    const store = useBillingStore()
    await store.portal()

    const [url, opts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/billing/portal')
    expect(opts.method).toBe('POST')
    expect(redirectedTo).toBe(portalUrl)
  })

  it('throws when not authenticated', async () => {
    const store = useBillingStore()
    await expect(store.portal()).rejects.toThrow('Not authenticated')
  })
})
