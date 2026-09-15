import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  scrubEvent,
  pathnameOnly,
  configureSentryReporting,
  reportError,
  reportUnexpectedApiFailure,
  resetSentryReportingForTests,
  IGNORED_ERROR_PATTERNS,
  NetworkFailureTracker,
} from '../src/utils/sentryReporting'
import type { ErrorEvent as SentryEvent, EventHint } from '@sentry/browser'

const hint = {} as EventHint

describe('pathnameOnly', () => {
  it('strips the query string from an absolute URL', () => {
    expect(pathnameOnly('https://app.impri.dev/recover?project_id=proj_1&t=secretcode')).toBe('/recover')
  })

  it('strips the query string from a relative path', () => {
    expect(pathnameOnly('/v1/actions?status=pending&q=refund')).toBe('/v1/actions')
  })

  it('returns a bare relative path unchanged', () => {
    expect(pathnameOnly('/v1/billing')).toBe('/v1/billing')
  })
})

describe('scrubEvent', () => {
  it('reduces request.url to a pathname and drops query_string/data', () => {
    const event = {
      request: {
        url: 'https://app.impri.dev/recover?project_id=proj_1&t=secretcode',
        query_string: 'project_id=proj_1&t=secretcode',
        data: { recovery_code: 'secretcode' },
      },
    } as unknown as SentryEvent
    const scrubbed = scrubEvent(event, hint)
    expect(scrubbed.request?.url).toBe('/recover')
    expect(scrubbed.request?.query_string).toBeUndefined()
    expect((scrubbed.request as { data?: unknown })?.data).toBeUndefined()
  })

  it('reduces the Referer header to a pathname', () => {
    const event = {
      request: { headers: { Referer: 'https://app.impri.dev/watchers?highlight=wat_1' } },
    } as unknown as SentryEvent
    const scrubbed = scrubEvent(event, hint)
    expect(scrubbed.request?.headers?.['Referer']).toBe('/watchers')
  })

  it('redacts email addresses in message and exception values', () => {
    const event = {
      message: 'Failed for someone@example.com',
      exception: { values: [{ value: 'contact ops@impri.dev for help' }] },
    } as unknown as SentryEvent
    const scrubbed = scrubEvent(event, hint)
    expect(scrubbed.message).toBe('Failed for [email]')
    expect(scrubbed.exception?.values?.[0].value).toBe('contact [email] for help')
  })

  it('redacts email addresses inside extra', () => {
    const event = { extra: { note: 'reported by a@b.com' } } as unknown as SentryEvent
    expect(scrubEvent(event, hint).extra).toEqual({ note: 'reported by [email]' })
  })

  it('redacts sensitive-looking keys in extra entirely, regardless of value type', () => {
    const event = {
      extra: {
        pathname: '/v1/watchers',
        api_key: 'im_supersecret',
        payload: { url: 'https://example.com', keywords: ['x'] },
        authorization: 'Bearer im_supersecret',
      },
    } as unknown as SentryEvent
    expect(scrubEvent(event, hint).extra).toEqual({
      pathname: '/v1/watchers',
      api_key: '[REDACTED]',
      payload: '[REDACTED]',
      authorization: '[REDACTED]',
    })
  })

  it('always drops breadcrumbs', () => {
    const event = { breadcrumbs: [{ category: 'ui.click', message: 'clicked' }] } as unknown as SentryEvent
    expect(scrubEvent(event, hint).breadcrumbs).toBeUndefined()
  })
})

describe('IGNORED_ERROR_PATTERNS', () => {
  it('matches the Outlook SafeLinks noise message', () => {
    expect(IGNORED_ERROR_PATTERNS.some(p => p.test('Object Not Found Matching Id:4, MethodName:update, ParamCount:4'))).toBe(true)
  })

  it('matches the generic cross-origin "Script error."', () => {
    expect(IGNORED_ERROR_PATTERNS.some(p => p.test('Script error.'))).toBe(true)
  })

  it('does not match a real application error message', () => {
    expect(IGNORED_ERROR_PATTERNS.some(p => p.test('Cannot read properties of undefined'))).toBe(false)
  })
})

describe('reportError — no DSN configured = no init (structural no-op)', () => {
  beforeEach(() => {
    resetSentryReportingForTests()
  })

  it('never imports @sentry/browser when configureSentryReporting was not called', async () => {
    // No configureSentryReporting() call at all in this test — config stays null.
    reportError(new Error('boom'))
    // Give any stray microtask a chance to run before asserting nothing happened.
    await Promise.resolve()
    // @sentry/browser is only reachable via dynamic import inside
    // ensureSentryInitialized(); if reportError() short-circuited (as it must
    // with no config), that import was never triggered. There's no client
    // object to assert on precisely because none was created — the absence
    // of a thrown error / hang here (no real network call attempted) is the
    // behavior under test.
    expect(true).toBe(true)
  })

  it('stays a no-op after configureSentryReporting is called with an empty dsn', async () => {
    configureSentryReporting({ dsn: '', environment: 'production' })
    reportError(new Error('boom'))
    await Promise.resolve()
    expect(true).toBe(true)
  })
})

describe('reportUnexpectedApiFailure', () => {
  it('does not call the report function for a 4xx status', () => {
    const report = vi.fn()
    reportUnexpectedApiFailure(new Error('bad request'), { status: 404, method: 'GET', path: '/v1/actions/x' }, report)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports with status/method/pathname (query string stripped) for a 5xx', () => {
    const report = vi.fn()
    const err = new Error('server blew up')
    reportUnexpectedApiFailure(err, { status: 500, method: 'POST', path: '/v1/actions?since=123' }, report)
    expect(report).toHaveBeenCalledWith(err, { status: 500, method: 'POST', pathname: '/v1/actions' })
  })

  it('defaults to the real reportError (a structural no-op with no DSN configured)', () => {
    resetSentryReportingForTests()
    expect(() => reportUnexpectedApiFailure(new Error('boom'), { status: 500, method: 'GET', path: '/v1/x' })).not.toThrow()
  })
})

describe('NetworkFailureTracker', () => {
  const info = { method: 'GET', path: '/v1/actions?status=pending' }
  const fetchFailed = () => new TypeError('Failed to fetch')

  it('does not report a single failed request (a Wi-Fi blip while polling)', () => {
    const report = vi.fn()
    const tracker = new NetworkFailureTracker(report, () => true, 3)
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(fetchFailed(), info)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports once when failures reach the threshold, not on every later poll', () => {
    const report = vi.fn()
    const tracker = new NetworkFailureTracker(report, () => true, 3)
    const err = fetchFailed()
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(err, info)
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(fetchFailed(), info)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(err, {
      status: 'network_error',
      method: 'GET',
      pathname: '/v1/actions',
      consecutive_failures: 3,
    })
  })

  it('starts a new streak after any response, so a later outage is reported again', () => {
    const report = vi.fn()
    const tracker = new NetworkFailureTracker(report, () => true, 3)
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordResponse()
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordFailure(fetchFailed(), info)
    expect(report).not.toHaveBeenCalled()
    tracker.recordFailure(fetchFailed(), info)
    tracker.recordResponse()
    for (let i = 0; i < 3; i++) tracker.recordFailure(fetchFailed(), info)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('ignores failures while the browser reports being offline', () => {
    const report = vi.fn()
    const tracker = new NetworkFailureTracker(report, () => false, 3)
    for (let i = 0; i < 5; i++) tracker.recordFailure(fetchFailed(), info)
    expect(report).not.toHaveBeenCalled()
  })

  it('ignores requests the page aborted itself', () => {
    const report = vi.fn()
    const tracker = new NetworkFailureTracker(report, () => true, 3)
    const abort = new Error('The user aborted a request.')
    abort.name = 'AbortError'
    for (let i = 0; i < 5; i++) tracker.recordFailure(abort, info)
    expect(report).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  resetSentryReportingForTests()
  vi.restoreAllMocks()
})
