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

import type { ErrorEvent as SentryEvent, EventHint } from '@sentry/browser';

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
 * `ignoreErrors` against the message / exception value before an event is
 * even built (so it costs no quota, unlike dropping it in beforeSend):
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

async function ensureSentryInitialized(): Promise<typeof import('@sentry/browser') | null> {
  if (!config) return null;
  const { dsn, environment, release } = config;
  if (!sentryPromise) {
    sentryPromise = import('@sentry/browser').then((Sentry) => {
      Sentry.init({
        dsn,
        environment,
        release,
        // A short, hand-picked integration list rather than Sentry's browser
        // defaults: no session tracking, no automatic breadcrumbs (dropped in
        // scrubEvent above anyway — this keeps them from being collected at
        // all), no built-in global error/rejection handlers (main.ts wires
        // those itself so every capture path funnels through reportError()).
        // httpContext is the one default integration kept, purely so
        // beforeSend has a request.url to scrub down to a pathname.
        defaultIntegrations: false,
        integrations: [Sentry.httpContextIntegration()],
        tracesSampleRate: 0,
        sendDefaultPii: false,
        ignoreErrors: IGNORED_ERROR_PATTERNS,
        beforeSend: scrubEvent,
      });
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

/**
 * Reports the API failures that are actually a bug — a 5xx, or no response at
 * all (network/CORS/offline) — with just `{status, method, pathname}`: no
 * body, no query string (a recovery-code redeem call carries its code as
 * `?t=...`, and pathnameOnly() strips that the same way it does for uncaught
 * errors — see scrubEvent() above). A 4xx is the person's or agent's own
 * mistake (bad API key, validation failure, not found), not a bug, and is
 * deliberately left out so Sentry volume tracks real breakage.
 */
export function reportUnexpectedApiFailure(
  error: unknown,
  info: { status?: number; method: string; path: string },
  // Injectable for tests (see tests/sentryReporting.test.ts) — defaults to
  // the real reportError. A plain function param rather than spying on the
  // module's own export, since an intra-module call bypasses a spy set on
  // the exported binding.
  report: (error: unknown, extra?: Record<string, unknown>) => void = reportError,
): void {
  if (info.status !== undefined && info.status < 500) return;
  report(error, {
    status: info.status ?? 'network_error',
    method: info.method,
    pathname: pathnameOnly(info.path),
  });
}
