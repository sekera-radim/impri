// Shared browser-side Sentry wiring, used by main.ts (uncaught Vue/window
// errors) and by api/client.ts (unexpected — 5xx/network — API failures).
// Split into its own module so the beforeSend scrubber below is unit
// testable without booting Sentry or mounting the Vue app — see
// tests/sentryReporting.test.ts.
//
// Mirrors the design used in briefgate/portal/utils/sentryReporting.ts, with
// one addition: Impri's API carries approval action payloads and API keys
// (briefgate's context does not), so `extra` context is scrubbed by KEY NAME
// as well as by content — see SENSITIVE_KEY_PATTERN.

import type { BrowserOptions, ErrorEvent as SentryEvent, EventHint } from '@sentry/browser';

// Matches an email address anywhere in a string. Error text can echo one back
// (a watcher keyword, a feedback message, an API error wrapping a server
// response) even though the request itself carried no PII we asked for.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[email]';

// Keys whose value is dropped outright, wherever they appear in `extra`
// context — approval action payloads, watcher configs, and API keys must
// never reach Sentry. Call sites are expected to pass small, deliberate
// context (status codes, method, pathname); this is the backstop.
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|apikey|authoriz|cookie|password|secret|token|payload|body|preview|recovery_code)/i;

function scrubEmails(value: string): string {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

const MAX_SCRUB_DEPTH = 8;

function scrubExtraDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;
  if (typeof value === 'string') return scrubEmails(value);
  if (Array.isArray(value)) return value.map(item => scrubExtraDeep(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : scrubExtraDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** Full or relative URL -> pathname only. Recovery links carry their code as
 *  a query string (`?t=...`), and that code is effectively a password —
 *  Sentry never needs more than which page/endpoint errored. */
export function pathnameOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Most calls in this app pass a relative path ('/v1/actions'), which
    // `new URL()` cannot parse without a base. Strip the query string by hand
    // instead of dropping the value entirely.
    return url.split('?')[0] ?? url;
  }
}

/**
 * Sentry's beforeSend hook: strips everything that could identify a person or
 * leak a credential before an event leaves the browser.
 *  - request.url and the Referer header: pathname only, no query string.
 *  - request.query_string / request.data: dropped outright.
 *  - message / exception text: email-looking substrings redacted.
 *  - extra: email-scrubbed, AND sensitive-looking keys redacted entirely.
 *  - breadcrumbs: dropped entirely — they can capture clicks and input, and
 *    this app has no need for them (tracesSampleRate is 0; this is error
 *    capture only).
 * Exported standalone, not as a closure passed straight to init(), so it is
 * unit testable on plain objects shaped like a Sentry event.
 */
export function scrubEvent(event: SentryEvent, _hint: EventHint): SentryEvent {
  if (event.request) {
    if (event.request.url) event.request.url = pathnameOnly(event.request.url);
    if (event.request.headers?.['Referer']) {
      event.request.headers['Referer'] = pathnameOnly(event.request.headers['Referer']);
    }
    delete event.request.query_string;
    delete (event.request as { data?: unknown }).data;
  }

  if (event.message) event.message = scrubEmails(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubEmails(exception.value);
  }

  if (event.extra) {
    event.extra = scrubExtraDeep(event.extra) as SentryEvent['extra'];
  }

  event.breadcrumbs = undefined;

  return event;
}

/**
 * Browser-side noise that is not a bug in this app, matched by Sentry's
 * `ignoreErrors` (the eventFilters integration, see buildSentryOptions()
 * below) against the message / exception value, so a match is dropped in the
 * browser and never sent:
 *  - "Object Not Found Matching Id:N, MethodName:update, ParamCount:4" is
 *    thrown by Microsoft's link scanner (Outlook SafeLinks / Edge) opening a
 *    link from an email in a headless page.
 *  - "Script error." is the browser's cross-origin stand-in for an uncaught
 *    error in a script it will not describe (a browser extension, an
 *    injected third-party script) — no stack, no message, nothing actionable.
 * Exported so tests can pin what does and does not match, since a pattern
 * that is too broad would silently hide real bugs.
 */
export const IGNORED_ERROR_PATTERNS: RegExp[] = [
  /^Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+$/,
  /^Script error\.?$/,
];

interface SentryReportingConfig {
  dsn: string;
  environment: string;
  release?: string;
}

let config: SentryReportingConfig | null = null;
let sentryPromise: Promise<typeof import('@sentry/browser')> | null = null;

/** Called once, from main.ts at app boot. A blank dsn leaves `config` null,
 *  which is what keeps reportError() below a no-op and @sentry/browser out of
 *  the bundle for any deploy that has not set VITE_SENTRY_DSN. */
export function configureSentryReporting(next: SentryReportingConfig): void {
  config = next.dsn ? next : null;
}

/** Test-only escape hatch — vitest module state persists across it() blocks
 *  within a file since ES modules are singletons. */
export function resetSentryReportingForTests(): void {
  config = null;
  sentryPromise = null;
}

/**
 * The options Sentry.init() runs with. Split out of ensureSentryInitialized()
 * so tests/sentryReporting.test.ts can boot the real SDK with exactly these
 * and assert what does and does not get sent — a pattern list that matches on
 * its own says nothing about whether the SDK ever applies it.
 */
export function buildSentryOptions(
  Sentry: typeof import('@sentry/browser'),
  { dsn, environment, release }: SentryReportingConfig,
): BrowserOptions {
  return {
    dsn,
    environment,
    release,
    // A short, hand-picked integration list rather than Sentry's browser
    // defaults: no session tracking, no automatic breadcrumbs (dropped in
    // scrubEvent above anyway — this keeps them from being collected at
    // all), no built-in global error/rejection handlers (main.ts wires
    // those itself so every capture path funnels through reportError()).
    // Two default integrations are kept:
    //  - httpContext, purely so beforeSend has a request.url to scrub down
    //    to a pathname.
    //  - eventFilters, because it is what implements `ignoreErrors` below.
    //    The option is read by that integration, not by the client, so
    //    without it the patterns are accepted and silently never applied.
    //    disableErrorDefaults keeps the ignored set to exactly
    //    IGNORED_ERROR_PATTERNS instead of adding Sentry's built-in list on
    //    top of it.
    defaultIntegrations: false,
    integrations: [
      Sentry.httpContextIntegration(),
      Sentry.eventFiltersIntegration({ disableErrorDefaults: true }),
    ],
    tracesSampleRate: 0,
    sendDefaultPii: false,
    ignoreErrors: IGNORED_ERROR_PATTERNS,
    beforeSend: scrubEvent,
  };
}

async function ensureSentryInitialized(): Promise<typeof import('@sentry/browser') | null> {
  if (!config) return null;
  const reportingConfig = config;
  if (!sentryPromise) {
    sentryPromise = import('@sentry/browser').then((Sentry) => {
      Sentry.init(buildSentryOptions(Sentry, reportingConfig));
      return Sentry;
    });
  }
  return sentryPromise;
}

/**
 * Reports an error to Sentry. No-ops, and never imports @sentry/browser, when
 * no DSN has been configured — structurally, not via an `if` a future edit
 * could drop: ensureSentryInitialized() returns null before the dynamic
 * import ever runs.
 */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  if (!config) return;
  void ensureSentryInitialized().then((Sentry) => {
    Sentry?.captureException(error, extra ? { extra: scrubExtraDeep(extra) as Record<string, unknown> } : undefined);
  });
}

type Reporter = (error: unknown, extra?: Record<string, unknown>) => void;

/**
 * Reports the HTTP failures that are actually a bug — a 5xx — with just
 * `{status, method, pathname}`: no body, no query string (a recovery-code
 * redeem call carries its code as `?t=...`, and pathnameOnly() strips that the
 * same way it does for uncaught errors — see scrubEvent() above). A 4xx is the
 * person's or agent's own mistake (bad API key, validation failure, not
 * found), not a bug, and is deliberately left out so Sentry volume tracks real
 * breakage. No response at all goes through NetworkFailureTracker instead.
 */
export function reportUnexpectedApiFailure(
  error: unknown,
  info: { status: number; method: string; path: string },
  // Injectable for tests (see tests/sentryReporting.test.ts) — defaults to
  // the real reportError. A plain function param rather than spying on the
  // module's own export, since an intra-module call bypasses a spy set on
  // the exported binding.
  report: Reporter = reportError,
): void {
  if (info.status < 500) return;
  report(error, {
    status: info.status,
    method: info.method,
    pathname: pathnameOnly(info.path),
  });
}

/**
 * How long requests must go unanswered before it counts as an outage. Waking
 * a laptop or switching Wi-Fi leaves the browser "online" with no network for
 * several seconds, and the inbox polls every 5 s with up to two requests per
 * tick — so a failure count alone fills up within seconds of a Mac waking
 * (IMPRI-WEB-3: Safari "Load failed" x3 while the API was healthy).
 */
export const NETWORK_FAILURE_MIN_STREAK_MS = 60_000;

/**
 * Failures further apart than this start a new streak: the page was not
 * running in between (the laptop slept, the tab was frozen), so the gap says
 * nothing about the API. Without it, a request cut off as the lid closed plus
 * two more after waking hours later would look like an hours-long outage.
 */
export const NETWORK_FAILURE_MAX_GAP_MS = 30_000;

/**
 * The same limit for a hidden tab. Browsers slow timers there to about once a
 * minute (Chrome's intensive throttling), so a hidden inbox polling a dead
 * API fails ~60 s apart — with the 30 s limit every failure would start over
 * and the outage would never be reported.
 */
export const NETWORK_FAILURE_MAX_GAP_HIDDEN_MS = 90_000;

/**
 * Also required before reporting. A visible tab cannot span the window with
 * fewer anyway (0 s, 30 s, 60 s); this matters for a hidden tab, where two
 * throttled polls a minute apart — one just before a laptop sleeps briefly,
 * one right after it wakes — would otherwise already count.
 */
export const NETWORK_FAILURE_MIN_FAILURES = 3;

interface NetworkFailureTrackerDeps {
  report?: Reporter;
  isOnline?: () => boolean;
  isHidden?: () => boolean;
  now?: () => number;
}

/**
 * Requests that got no response at all. The inbox polls every few seconds, so
 * a Wi-Fi drop, a laptop waking up or a reload mid-request each produced a
 * "Failed to fetch" / "Load failed" event (IMPRI-WEB-2, IMPRI-WEB-3) while the
 * API itself was fine. Only a streak that keeps failing for a minute while the
 * browser believes it is online is an outage worth knowing about (API down,
 * DNS, CORS), and it is reported once per streak rather than on every poll
 * that follows.
 */
export class NetworkFailureTracker {
  private readonly report: Reporter;
  private readonly isOnline: () => boolean;
  private readonly isHidden: () => boolean;
  private readonly now: () => number;

  private streakStartedAt: number | null = null;
  private lastFailureAt = 0;
  private failures = 0;
  private reported = false;

  // Every dependency is injectable for tests (see tests/sentryReporting.test.ts);
  // the defaults read the real browser state.
  constructor({
    report = reportError,
    isOnline = () => typeof navigator === 'undefined' || navigator.onLine,
    isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    now = () => Date.now(),
  }: NetworkFailureTrackerDeps = {}) {
    this.report = report;
    this.isOnline = isOnline;
    this.isHidden = isHidden;
    this.now = now;
  }

  recordResponse(): void {
    this.streakStartedAt = null;
  }

  recordFailure(error: unknown, info: { method: string; path: string }): void {
    // A request the page cancelled itself is not an outage of ours.
    if (error instanceof Error && error.name === 'AbortError') return;
    // Neither is anything around a moment the browser knows it is offline:
    // that is the person's own network, so the streak starts over.
    if (!this.isOnline()) {
      this.streakStartedAt = null;
      return;
    }

    const now = this.now();
    const maxGap = this.isHidden() ? NETWORK_FAILURE_MAX_GAP_HIDDEN_MS : NETWORK_FAILURE_MAX_GAP_MS;
    if (this.streakStartedAt === null || now - this.lastFailureAt > maxGap) {
      this.streakStartedAt = now;
      this.failures = 0;
      this.reported = false;
    }
    this.lastFailureAt = now;
    this.failures += 1;

    const unansweredMs = now - this.streakStartedAt;
    if (this.reported) return;
    if (this.failures < NETWORK_FAILURE_MIN_FAILURES || unansweredMs < NETWORK_FAILURE_MIN_STREAK_MS) return;
    this.reported = true;
    this.report(error, {
      status: 'network_error',
      method: info.method,
      pathname: pathnameOnly(info.path),
      consecutive_failures: this.failures,
      unanswered_for_s: Math.round(unansweredMs / 1000),
    });
  }
}
