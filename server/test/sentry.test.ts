import { describe, it, expect, vi } from 'vitest';
import {
  initSentry,
  noopReporter,
  scrubSentryEvent,
  sentryConfigFromEnv,
  type SentryClient,
} from '../src/sentry.js';
import type * as Sentry from '@sentry/node';

function fakeClient(): SentryClient & { init: ReturnType<typeof vi.fn>; captureException: ReturnType<typeof vi.fn> } {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
  };
}

describe('sentryConfigFromEnv', () => {
  it('reads SENTRY_DSN / SENTRY_ENVIRONMENT / SENTRY_RELEASE from the environment', () => {
    const prev = { ...process.env };
    process.env.SENTRY_DSN = 'https://key@example.ingest.sentry.io/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    process.env.SENTRY_RELEASE = '9.9.9';
    try {
      expect(sentryConfigFromEnv('0.1.0')).toEqual({
        dsn: 'https://key@example.ingest.sentry.io/1',
        environment: 'staging',
        release: '9.9.9',
      });
    } finally {
      process.env = prev;
    }
  });

  it('falls back to development environment and the given package version', () => {
    const prev = { ...process.env };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
    try {
      expect(sentryConfigFromEnv('0.1.0')).toEqual({
        dsn: undefined,
        environment: 'development',
        release: '0.1.0',
      });
    } finally {
      process.env = prev;
    }
  });
});

describe('initSentry — no DSN = no init (structural no-op)', () => {
  it('never calls client.init or client.captureException when dsn is unset', () => {
    const client = fakeClient();
    const reporter = initSentry({ dsn: undefined, environment: 'development', release: '0.1.0' }, client);

    expect(client.init).not.toHaveBeenCalled();

    reporter.captureError(new Error('boom'), { foo: 'bar' });
    expect(client.captureException).not.toHaveBeenCalled();
  });

  it('returns the shared noopReporter instance', () => {
    const client = fakeClient();
    const reporter = initSentry({ dsn: undefined, environment: 'development', release: '0.1.0' }, client);
    expect(reporter).toBe(noopReporter);
  });
});

describe('initSentry — DSN set', () => {
  it('calls client.init once with the configured dsn/environment/release and tracesSampleRate 0', () => {
    const client = fakeClient();
    initSentry({ dsn: 'https://key@example.ingest.sentry.io/1', environment: 'production', release: '1.2.3' }, client);

    expect(client.init).toHaveBeenCalledTimes(1);
    const opts = client.init.mock.calls[0][0];
    expect(opts.dsn).toBe('https://key@example.ingest.sentry.io/1');
    expect(opts.environment).toBe('production');
    expect(opts.release).toBe('1.2.3');
    expect(opts.tracesSampleRate).toBe(0);
    expect(typeof opts.beforeSend).toBe('function');
  });

  it('captureError forwards to client.captureException with extra context', () => {
    const client = fakeClient();
    const reporter = initSentry({ dsn: 'https://key@example.ingest.sentry.io/1', environment: 'production', release: '1.2.3' }, client);

    const err = new Error('db write failed');
    reporter.captureError(err, { route: '/v1/actions/:id', statusCode: 500 });

    expect(client.captureException).toHaveBeenCalledTimes(1);
    const [capturedErr, hint] = client.captureException.mock.calls[0];
    expect(capturedErr).toBe(err);
    expect(hint?.extra).toEqual({ route: '/v1/actions/:id', statusCode: 500 });
  });

  it('scrubs sensitive keys (api key, token, payload) out of extra context before forwarding', () => {
    const client = fakeClient();
    const reporter = initSentry({ dsn: 'https://key@example.ingest.sentry.io/1', environment: 'production', release: '1.2.3' }, client);

    reporter.captureError(new Error('boom'), {
      watcherId: 'wat_1',
      api_key: 'im_supersecret',
      authorization: 'Bearer im_supersecret',
      payload: { callback_url: 'https://agent.example/cb', secret: 'sh' },
      contact: 'someone@example.com',
    });

    const [, hint] = client.captureException.mock.calls[0];
    expect(hint?.extra).toEqual({
      watcherId: 'wat_1',
      api_key: '[REDACTED]',
      authorization: '[REDACTED]',
      payload: '[REDACTED]',
      contact: '[email]',
    });
  });
});

describe('scrubSentryEvent', () => {
  it('redacts email addresses in the top-level message', () => {
    const event = { message: 'Failed for user someone@example.com during checkout' } as Sentry.ErrorEvent;
    expect(scrubSentryEvent(event).message).toBe('Failed for user [email] during checkout');
  });

  it('redacts email addresses nested inside extra, including arrays and nested objects', () => {
    const event = {
      extra: {
        note: 'contact radim@example.com for details',
        list: ['a@b.com', 'no-email-here'],
        nested: { deeper: { email: 'x@y.io' } },
      },
    } as unknown as Sentry.ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.extra).toEqual({
      note: 'contact [email] for details',
      list: ['[email]', 'no-email-here'],
      nested: { deeper: { email: '[email]' } },
    });
  });

  it('redacts Authorization/Cookie/X-Api-Key headers on request.headers, case-insensitively', () => {
    const event = {
      request: {
        url: 'https://api.impri.dev/v1/actions',
        headers: {
          Authorization: 'Bearer im_abcdef',
          Cookie: 'session=xyz',
          'X-Api-Key': 'im_abcdef',
          'User-Agent': 'impri-agent/1.0',
        },
      },
    } as unknown as Sentry.ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request?.headers).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'User-Agent': 'impri-agent/1.0',
    });
  });

  it('strips the query string from request.url and deletes request.query_string and request.data', () => {
    const event = {
      request: {
        url: 'https://app.impri.dev/recover?project_id=proj_1&t=secret-recovery-code',
        query_string: 'project_id=proj_1&t=secret-recovery-code',
        data: { recovery_code: 'secret-recovery-code' },
      },
    } as unknown as Sentry.ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request?.url).toBe('https://app.impri.dev/recover');
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
  });

  it('strips the query string from a path-relative Fastify request URL with no scheme', () => {
    const event = {
      request: { url: '/v1/recover?t=secret' },
    } as unknown as Sentry.ErrorEvent;
    expect(scrubSentryEvent(event).request?.url).toBe('/v1/recover');
  });

  it('reduces http breadcrumbs to pathname-only and drops everything else on the breadcrumb data', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'http',
          data: { url: 'https://www.reddit.com/r/foo/search.rss?q=secret+query&limit=25', method: 'GET', status_code: 200 },
        },
        { category: 'console', message: 'contact me@example.com', data: {} },
      ],
    } as unknown as Sentry.ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.breadcrumbs?.[0]).toEqual({
      category: 'http',
      data: { url: '/r/foo/search.rss' },
    });
    // Non-http breadcrumbs pass through untouched by this function (message
    // scrubbing on breadcrumbs is out of scope here — beforeSend only scrubs
    // message/extra/request/http-breadcrumbs, matching the reference design).
    expect(scrubbed.breadcrumbs?.[1]).toEqual({ category: 'console', message: 'contact me@example.com', data: {} });
  });

  it('does not mutate the original event object', () => {
    const original = { message: 'foo bar@example.com' } as Sentry.ErrorEvent;
    scrubSentryEvent(original);
    expect(original.message).toBe('foo bar@example.com');
  });
});
