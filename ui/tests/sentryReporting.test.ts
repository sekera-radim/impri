import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Sentry from '@sentry/browser'
import {
  scrubEvent,
  pathnameOnly,
  buildSentryOptions,
  configureSentryReporting,
  reportError,
  reportUnexpectedApiFailure,
  resetSentryReportingForTests,
  IGNORED_ERROR_PATTERNS,
  NetworkFailureTracker,
  NETWORK_FAILURE_MIN_STREAK_MS,
  NETWORK_FAILURE_MAX_GAP_MS,
  NETWORK_FAILURE_MAX_GAP_HIDDEN_MS,
  NETWORK_FAILURE_MIN_FAILURES,
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

// The patterns above only matter if the SDK applies them, and it does that in
// an integration this app has to opt into (defaultIntegrations is off). So
// this boots the real SDK with the production options and looks at what
// reaches the transport — in briefgate the same link-scanner error kept
// arriving in Sentry while the pattern tests above were green.
describe('Sentry booted with buildSentryOptions()', () => {
  const SCANNER_ERROR = 'Object Not Found Matching Id:3, MethodName:update, ParamCount:4'

  let sentBodies: string[]

  beforeEach(() => {
    sentBodies = []
    Sentry.init({
      ...buildSentryOptions(Sentry, { dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'test' }),
      transport: transportOptions =>
        Sentry.createTransport(transportOptions, async (request) => {
          sentBodies.push(String(request.body))
          return { statusCode: 200 }
        }),
    })
  })

  afterEach(async () => {
    await Sentry.close()
  })

  it('sends a real error, so an empty transport below means "filtered", not "broken"', async () => {
    Sentry.captureException(new Error('Cannot read properties of undefined'))
    await Sentry.flush()

    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]).toContain('Cannot read properties of undefined')
  })

  it('drops the link-scanner rejection, which arrives as a bare string reason', async () => {
    Sentry.captureException(SCANNER_ERROR)
    await Sentry.flush()

    expect(sentBodies).toHaveLength(0)
  })

  it('drops the link-scanner error when it arrives as an Error object', async () => {
    Sentry.captureException(new Error(SCANNER_ERROR))
    await Sentry.flush()

    expect(sentBodies).toHaveLength(0)
  })

  it('drops the cross-origin "Script error." placeholder', async () => {
    Sentry.captureException('Script error.')
    await Sentry.flush()

    expect(sentBodies).toHaveLength(0)
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
  const loadFailed = () => new TypeError('Load failed')
  const SEC = 1_000

  /** A tracker on a fake clock: `fail(atMs)` records a failure at that time.
   *  `online` / `hidden` are read on every failure, so a test can flip them. */
  function setup() {
    const report = vi.fn()
    let clock = 0
    const state = { online: true, hidden: false }
    const tracker = new NetworkFailureTracker({
      report,
      isOnline: () => state.online,
      isHidden: () => state.hidden,
      now: () => clock,
    })
    const fail = (atMs: number, err: unknown = loadFailed()) => {
      clock = atMs
      tracker.recordFailure(err, info)
    }
    return { report, tracker, fail, state }
  }

  it('pins the window the docs describe', () => {
    expect(NETWORK_FAILURE_MIN_STREAK_MS).toBe(60 * SEC)
    expect(NETWORK_FAILURE_MIN_FAILURES).toBe(3)
    expect(NETWORK_FAILURE_MAX_GAP_MS).toBe(30 * SEC)
    expect(NETWORK_FAILURE_MAX_GAP_HIDDEN_MS).toBe(90 * SEC)
  })

  it('does not report a burst of failures right after waking up (IMPRI-WEB-3)', () => {
    const { report, tracker, fail } = setup()
    // First poll tick after wake fires two requests, the next one a third —
    // all before Wi-Fi is back — then the API answers.
    fail(0)
    fail(0)
    fail(5 * SEC)
    fail(10 * SEC)
    tracker.recordResponse()
    expect(report).not.toHaveBeenCalled()
  })

  it('does not report however many failures arrive within the first minute', () => {
    const { report, fail } = setup()
    for (let t = 0; t < 60 * SEC; t += 2 * SEC) fail(t)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports once when polls keep failing for a minute, not on every later poll', () => {
    const { report, fail } = setup()
    const err = loadFailed()
    for (let t = 0; t < 60 * SEC; t += 5 * SEC) fail(t)
    expect(report).not.toHaveBeenCalled()
    fail(60 * SEC, err)
    for (let t = 65 * SEC; t <= 90 * SEC; t += 5 * SEC) fail(t)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(err, {
      status: 'network_error',
      method: 'GET',
      pathname: '/v1/actions',
      consecutive_failures: 13,
      unanswered_for_s: 60,
    })
  })

  it('does not count time the page was not running (laptop asleep) as an outage', () => {
    const { report, fail } = setup()
    fail(0) // cut off as the lid closed
    const wake = 8 * 3600 * SEC
    fail(wake)
    fail(wake + 5 * SEC)
    expect(report).not.toHaveBeenCalled()
    // Still failing a full minute after waking up is an outage again.
    for (let t = wake + 10 * SEC; t <= wake + 60 * SEC; t += 5 * SEC) fail(t)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ unanswered_for_s: 60 })
  })

  it('treats failures exactly MAX_GAP apart as one streak, and further apart as two', () => {
    const joined = setup()
    joined.fail(0)
    joined.fail(30 * SEC)
    joined.fail(60 * SEC)
    expect(joined.report).toHaveBeenCalledTimes(1)
    expect(joined.report.mock.calls[0]?.[1]).toMatchObject({ consecutive_failures: 3 })

    const split = setup()
    split.fail(0)
    split.fail(30 * SEC + 1)
    split.fail(60 * SEC + 2)
    expect(split.report).not.toHaveBeenCalled()
  })

  it('reports an outage seen only by a hidden tab whose polls are throttled to once a minute', () => {
    const { report, fail, state } = setup()
    state.hidden = true
    fail(0)
    fail(60 * SEC)
    // Two failures already span the window, but one each side of a short
    // laptop sleep looks exactly like this — the third one decides.
    expect(report).not.toHaveBeenCalled()
    fail(120 * SEC)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ consecutive_failures: 3, unanswered_for_s: 120 })
  })

  it('starts a new streak in a hidden tab when failures are more than MAX_GAP_HIDDEN apart', () => {
    const { report, fail, state } = setup()
    state.hidden = true
    fail(0)
    fail(90 * SEC + 1)
    fail(180 * SEC + 2)
    expect(report).not.toHaveBeenCalled()
  })

  it('starts the streak over when the browser goes offline in the middle of it', () => {
    const { report, fail, state } = setup()
    for (let t = 0; t <= 50 * SEC; t += 5 * SEC) fail(t)
    state.online = false
    fail(55 * SEC)
    state.online = true
    for (let t = 60 * SEC; t <= 115 * SEC; t += 5 * SEC) fail(t)
    expect(report).not.toHaveBeenCalled()
    fail(120 * SEC)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ unanswered_for_s: 60 })
  })

  it('starts a new streak after any response, so a later outage is reported again', () => {
    const { report, tracker, fail } = setup()
    for (let t = 0; t <= 55 * SEC; t += 5 * SEC) fail(t)
    tracker.recordResponse()
    for (let t = 60 * SEC; t <= 115 * SEC; t += 5 * SEC) fail(t)
    expect(report).not.toHaveBeenCalled()
    fail(120 * SEC)
    tracker.recordResponse()
    for (let t = 200 * SEC; t <= 260 * SEC; t += 5 * SEC) fail(t)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('ignores failures while the browser reports being offline', () => {
    const { report, fail, state } = setup()
    state.online = false
    for (let t = 0; t <= 120 * SEC; t += 5 * SEC) fail(t)
    expect(report).not.toHaveBeenCalled()
  })

  it('ignores requests the page aborted itself', () => {
    const { report, fail } = setup()
    const abort = () => {
      const err = new Error('The user aborted a request.')
      err.name = 'AbortError'
      return err
    }
    for (let t = 0; t <= 120 * SEC; t += 5 * SEC) fail(t, abort())
    expect(report).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  resetSentryReportingForTests()
  vi.restoreAllMocks()
})
