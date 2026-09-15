import * as Sentry from '@sentry/node';

// ---------------------------------------------------------------------------
// Error reporting boundary.
//
// Routes, the global error handler, and background schedulers (watcher tick,
// expiry tick, channel digest tick) report through this narrow ErrorReporter
// interface rather than importing `@sentry/node` directly, for two reasons:
//   1. `@sentry/node`'s ESM exports cannot be spied on (the module namespace
//      is not configurable), so tests inject a plain fake SentryClient
//      instead of mocking the SDK module.
//   2. Without SENTRY_DSN, initSentry never calls client.init() at all —
//      structurally, not via an `if` a future edit could drop. A deployment
//      with no DSN configured (self-host default, and any cloud deploy that
//      hasn't opted in) makes zero calls into the Sentry SDK.
//
// Mirrors the design used in briefgate/server/src/sentry.ts.
// ---------------------------------------------------------------------------

export interface ErrorReporter {
  captureError(error: unknown, context?: Record<string, unknown>): void;
}

export const noopReporter: ErrorReporter = {
  captureError: () => {
    // No DSN configured: reporting is a deliberate no-op, not a dropped call.
  },
};

/**
 * The slice of the Sentry SDK initSentry actually calls. Real @sentry/node is
 * the default; tests pass a fake that records calls instead.
 */
export interface SentryClient {
  init(options: {
    dsn: string;
    environment: string;
    release: string;
    tracesSampleRate: number;
    beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null;
  }): void;
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): void;
}

export interface SentryConfig {
  dsn: string | undefined;
  environment: string;
  release: string;
}

/**
 * Builds the Sentry config from environment variables.
 *  - SENTRY_DSN: optional. Unset in development, CI, and self-host by default.
 *  - SENTRY_ENVIRONMENT: defaults to "development" (Fly deploy sets it to
 *    "production" via fly.toml; self-hosters set it in their .env).
 *  - SENTRY_RELEASE: optional override; falls back to the package.json version
 *    already loaded at startup (index.ts) since this project has no separate
 *    build-time commit SHA env var.
 */
export function sentryConfigFromEnv(pkgVersion: string): SentryConfig {
  return {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
    release: process.env.SENTRY_RELEASE ?? pkgVersion,
  };
}

/**
 * config.dsn is optional: unset in development, CI, and self-host by default,
 * so none of those ever call out to Sentry. Only a configured DSN turns this
 * into a real reporter.
 */
export function initSentry(config: SentryConfig, client: SentryClient = Sentry): ErrorReporter {
  if (!config.dsn) return noopReporter;

  client.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    // No request tracing: that would mean sampling and shipping request spans
    // we haven't audited for tenant data (approval payloads, watcher configs,
    // API keys). Error capture only.
    tracesSampleRate: 0,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });

  return {
    captureError: (error, context) => {
      client.captureException(error, context ? { extra: scrubExtraDeep(context) as Record<string, unknown> } : undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Scrubbing
//
// Runs inside beforeSend (every event, regardless of capture path) AND on the
// `extra` context passed by call sites (captureError above), so a call site
// that forgets to scrub its own context can never leak a credential or an
// approval payload — the boundary does it, here, twice over.
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[email]';

// Header names carrying bearer credentials or session state. Compared
// lowercase since HTTP header casing is not meaningful. `x-api-key` covers
// the notification-channel test-webhook path; the project's own API keys
// travel as `Authorization: Bearer im_...`.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key']);

// Object keys whose VALUE is dropped outright (not just email-scrubbed),
// wherever they appear in captured `extra` context — this is the backstop for
// "request bodies and token-bearing fields must never reach Sentry": approval
// action payloads, watcher configs, and API keys all travel through this app,
// and none of them belong in an error report. Call sites are expected to pass
// small, deliberate context (ids, kinds, status codes) — this catches the
// mistake if one doesn't.
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|apikey|authoriz|cookie|password|secret|token|payload|body|preview|webhook_secret|recovery_code)/i;

// RFC 5322 is far more permissive than this, but this project only needs to
// catch the shapes people actually type into free-text fields (watcher
// keywords, feedback messages, error messages quoting a client's address) —
// not validate email syntax.
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function redactEmails(value: string): string {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

// Recursion depth guard: an event's `extra` is arbitrary data assembled by
// whichever call site captured the error, so nothing here bounds how deeply
// nested it could be short of this.
const MAX_SCRUB_DEPTH = 8;

function scrubEmailsDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;
  if (typeof value === 'string') return redactEmails(value);
  if (Array.isArray(value)) return value.map(item => scrubEmailsDeep(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubEmailsDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Like scrubEmailsDeep, but additionally redacts the entire value (whatever
 * its type) when the key name looks sensitive — see SENSITIVE_KEY_PATTERN.
 * Used for `extra` context passed by call sites (captureError), which is
 * free-form data assembled ad hoc rather than a fixed Sentry event shape.
 */
function scrubExtraDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;
  if (typeof value === 'string') return redactEmails(value);
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

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

// Drops everything after `?` — magic-link/recovery tokens, invite tokens, and
// signed webhook query params (none currently exist, but the next one this
// app grows would otherwise leak by default) all travel as query params.
// Stripping entirely rather than allow-listing individual param names.
function stripQueryString(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function pathnameOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Fastify request URLs are path-relative ("/v1/actions/abc?since=…"), which
    // the WHATWG URL constructor refuses without a base — strip by hand.
    return stripQueryString(url);
  }
}

/**
 * The beforeSend scrub. Exported (not just used internally) so it can be
 * unit-tested directly against representative event shapes, rather than only
 * indirectly through a client.init spy.
 */
export function scrubSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const scrubbed: Sentry.ErrorEvent = { ...event };

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = redactEmails(scrubbed.message);
  }

  if (scrubbed.extra) {
    scrubbed.extra = scrubEmailsDeep(scrubbed.extra) as Sentry.ErrorEvent['extra'];
  }

  if (scrubbed.request) {
    const request = { ...scrubbed.request };
    if (request.headers) {
      request.headers = scrubHeaders(request.headers);
    }
    // Query strings carry the sensitive part; delete rather than scrub field
    // by field for the same reason as stripQueryString above.
    delete request.query_string;
    // Request bodies (approval action payloads, watcher configs, API-key
    // creation bodies) must never reach Sentry — this app doesn't wire up
    // automatic request-body capture, but drop it defensively if a future
    // integration ever populates it.
    delete request.data;
    if (typeof request.url === 'string') {
      request.url = stripQueryString(request.url);
    }
    scrubbed.request = request;
  }

  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(crumb => {
      if (crumb.category !== 'http') return crumb;
      const data = crumb.data as Record<string, unknown> | undefined;
      const url = typeof data?.url === 'string' ? data.url : undefined;
      // Everything else on an http breadcrumb (full URL incl. query, request
      // body excerpts some SDK integrations attach, response size) is dropped
      // — only the pathname is worth keeping for reconstructing a timeline.
      return { ...crumb, data: url ? { url: pathnameOnly(url) } : undefined };
    });
  }

  return scrubbed;
}
