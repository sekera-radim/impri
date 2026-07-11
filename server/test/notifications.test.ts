/**
 * Notification channels tests.
 *
 * Covers:
 * - CRUD for /v1/notification-channels (all 6 types)
 * - Secret masking in all API responses
 * - SSRF rejection of private-IP webhook/slack/discord/ntfy URLs at create time
 * - Trigger fires on new pending action (mocked sender via global fetch stub)
 * - POST /v1/notification-channels/:id/test endpoint
 * - Admin-scope enforcement (actions-scope key must be denied)
 * - digest window logic (items queued within window, sent on next fire)
 * - auto-disable after IMPRI_CHANNEL_MAX_FAILS consecutive failures
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { maskConfig } from '../src/notify.js';

// Prevent the watcher scheduler from spawning background timers in tests.
process.env.DISABLE_WATCHER_SCHEDULER = '1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

/** Create an actions-scope key via the admin key. */
async function createActionsKey(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/keys',
    headers: auth(adminKey),
    payload: { name: 'Agent', scopes: ['actions'] },
  });
  return (res.json() as { key: string }).key;
}

const VALID_SLACK_URL = 'https://hooks.slack.com/services/T00/B00/abcdefghijklmno';
const VALID_DISCORD_URL = 'https://discord.com/api/webhooks/123456/abcdefghijklmno';
const VALID_NTFY_URL = 'https://ntfy.sh';
const VALID_WEBHOOK_URL = 'https://example.com/webhook/receiver';

// Minimal valid payload for creating a pending action.
const ACTION_PAYLOAD = {
  kind: 'test.kind',
  title: 'Test Action Title',
  preview: { format: 'plain', body: 'preview body' },
};

// ---------------------------------------------------------------------------
// maskConfig() unit tests (no HTTP needed)
// ---------------------------------------------------------------------------

describe('maskConfig()', () => {
  it('masks slack url, keeps structure', () => {
    const masked = maskConfig('slack', { url: 'https://hooks.slack.com/services/TOKEN' });
    expect(masked.url).toBe('****OKEN');
  });

  it('masks discord url', () => {
    const masked = maskConfig('discord', { url: 'https://discord.com/api/webhooks/123/secrettoken' });
    expect(masked.url).toBe('****oken');
  });

  it('masks telegram bot_token, returns chat_id as-is', () => {
    const masked = maskConfig('telegram', { bot_token: '1234567890:ABCDEFabcdef', chat_id: '-1001234567' });
    expect(masked.bot_token).toBe('****cdef');
    expect(masked.chat_id).toBe('-1001234567');
  });

  it('masks ntfy url, returns topic as-is', () => {
    const masked = maskConfig('ntfy', { url: 'https://ntfy.example.com', topic: 'my-alerts' });
    expect(masked.url).toBe('****.com'); // last 4 chars of 'https://ntfy.example.com'
    expect(masked.topic).toBe('my-alerts');
  });

  it('returns email address as-is (not a secret)', () => {
    const masked = maskConfig('email', { address: 'admin@example.com' });
    expect(masked.address).toBe('admin@example.com');
  });

  it('masks webhook url and hmac_secret when present', () => {
    const masked = maskConfig('webhook', { url: 'https://example.com/webhook', hmac_secret: 'supersecretvalue12345' });
    expect(masked.url).toMatch(/^\*\*\*\*/);
    expect(masked.hmac_secret).toMatch(/^\*\*\*\*/);
  });

  it('omits hmac_secret from masked output when not set', () => {
    const masked = maskConfig('webhook', { url: 'https://example.com/webhook' });
    expect(masked.hmac_secret).toBeUndefined();
  });

  it('fully masks values shorter than 5 chars', () => {
    const masked = maskConfig('slack', { url: 'hi' });
    expect(masked.url).toBe('****');
  });
});

// ---------------------------------------------------------------------------
// Admin scope enforcement
// ---------------------------------------------------------------------------

describe('admin scope enforcement', () => {
  it('GET /v1/notification-channels returns 403 for actions-scope key', async () => {
    const { app, adminKey } = await setup();
    const agentKey = await createActionsKey(app, adminKey);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels',
      headers: auth(agentKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/notification-channels returns 403 for actions-scope key', async () => {
    const { app, adminKey } = await setup();
    const agentKey = await createActionsKey(app, adminKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(agentKey),
      payload: { name: 'x', type: 'email', config: { address: 'a@b.com' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /v1/notification-channels/:id returns 403 for actions-scope key', async () => {
    const { app, adminKey } = await setup();
    const agentKey = await createActionsKey(app, adminKey);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/notification-channels/nchan_fake',
      headers: auth(agentKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it('test endpoint returns 403 for actions-scope key', async () => {
    const { app, adminKey } = await setup();
    const agentKey = await createActionsKey(app, adminKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels/nchan_fake/test',
      headers: auth(agentKey),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// SSRF rejection (at Zod validation layer — no network call needed)
// ---------------------------------------------------------------------------

describe('SSRF rejection at create time', () => {
  it('rejects private IPv4 literal in slack url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'bad', type: 'slack', config: { url: 'http://192.168.1.1/webhook' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects loopback in discord url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'bad', type: 'discord', config: { url: 'http://127.0.0.1/api/webhooks/1/x' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects cloud-metadata IP in ntfy url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'bad', type: 'ntfy', config: { url: 'http://169.254.169.254', topic: 'alerts' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-http scheme in webhook url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'bad', type: 'webhook', config: { url: 'ftp://example.com/hook' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid telegram bot_token format', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'bad', type: 'telegram',
        config: { bot_token: '../../etc/passwd', chat_id: '-100123' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects ntfy topic with path-traversal characters', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'bad', type: 'ntfy',
        config: { url: VALID_NTFY_URL, topic: '../../../etc' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid public HTTPS slack url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'ok', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// CRUD operations + secret masking in responses
// ---------------------------------------------------------------------------

describe('CRUD — email channel (simplest, no secrets)', () => {
  it('creates a channel and returns 201 with masked config', async () => {
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Email Alerts', type: 'email', config: { address: 'ops@example.com' } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^nchan_/);
    expect(body.type).toBe('email');
    expect(body.enabled).toBe(true);
    expect(body.config.address).toBe('ops@example.com'); // not a secret — returned as-is
    expect(body.digest_window_sec).toBe(60);
    expect(body.fail_count).toBe(0);
  });

  it('GET /v1/notification-channels lists created channel', async () => {
    const { app, adminKey } = await setup();

    await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'A', type: 'email', config: { address: 'a@b.com' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: unknown[] };
    expect(items).toHaveLength(1);
  });

  it('GET /v1/notification-channels/:id returns 404 for missing channel', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels/nchan_doesnotexist',
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH updates name and enabled, returns masked config', async () => {
    const { app, adminKey } = await setup();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Old Name', type: 'email', config: { address: 'x@y.com' } },
    });
    const { id } = create.json() as { id: string };

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${id}`,
      headers: auth(adminKey),
      payload: { name: 'New Name', enabled: false },
    });

    expect(patch.statusCode).toBe(200);
    const body = patch.json();
    expect(body.name).toBe('New Name');
    expect(body.enabled).toBe(false);
    expect(body.config.address).toBe('x@y.com'); // unchanged
  });

  it('DELETE returns 204 and channel is gone', async () => {
    const { app, adminKey } = await setup();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Bye', type: 'email', config: { address: 'bye@example.com' } },
    });
    const { id } = create.json() as { id: string };

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/notification-channels/${id}`,
      headers: auth(adminKey),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${id}`,
      headers: auth(adminKey),
    });
    expect(get.statusCode).toBe(404);
  });
});

describe('CRUD — webhook channel (secrets masked)', () => {
  it('masks url and hmac_secret in all API responses', async () => {
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Webhook',
        type: 'webhook',
        config: {
          url: VALID_WEBHOOK_URL,
          hmac_secret: 'supersecrethmackey12345',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // URL should be masked — must not start with 'http'
    expect(body.config.url).toMatch(/^\*\*\*\*/);
    expect(body.config.url).not.toContain('http');
    // hmac_secret masked
    expect(body.config.hmac_secret).toMatch(/^\*\*\*\*/);
    expect(body.config.hmac_secret).not.toContain('supersecret');
  });

  it('GET single channel also returns masked config', async () => {
    const { app, adminKey } = await setup();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'WH',
        type: 'webhook',
        config: { url: VALID_WEBHOOK_URL },
      },
    });
    const { id } = create.json() as { id: string };

    const get = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${id}`,
      headers: auth(adminKey),
    });
    expect(get.json().config.url).toMatch(/^\*\*\*\*/);
  });

  it('PATCH config resets fail_count to 0', async () => {
    const { app, adminKey, db } = await setup();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'WH',
        type: 'webhook',
        config: { url: VALID_WEBHOOK_URL },
      },
    });
    const { id } = create.json() as { id: string };

    // Manually set fail_count to simulate failures.
    db.prepare('UPDATE notification_channels SET fail_count = 3 WHERE id = ?').run(id);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${id}`,
      headers: auth(adminKey),
      payload: { config: { url: 'https://example.com/webhook/v2' } },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().fail_count).toBe(0);
  });
});

describe('CRUD — telegram channel', () => {
  it('creates telegram channel, bot_token masked, chat_id as-is', async () => {
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'TG',
        type: 'telegram',
        config: { bot_token: '1234567890:ABCDEFabcdef', chat_id: '-1001234567890' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.config.bot_token).toMatch(/^\*\*\*\*/);
    expect(body.config.bot_token).not.toContain('ABCDEF');
    expect(body.config.chat_id).toBe('-1001234567890'); // not a secret
  });
});

describe('CRUD — slack channel', () => {
  it('masks slack url in response, digest_queue NOT exposed', async () => {
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack', type: 'slack', config: { url: VALID_SLACK_URL } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.config.url).toMatch(/^\*\*\*\*/);
    expect(body.digest_queue).toBeUndefined(); // internal field — never exposed
  });
});

// ---------------------------------------------------------------------------
// Trigger: fires on new pending action (mocked fetch)
// ---------------------------------------------------------------------------

describe('trigger on pending action creation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires a slack channel when a pending action is created', async () => {
    const { app, adminKey, db } = await setup();

    // Create the channel
    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack', type: 'slack', config: { url: VALID_SLACK_URL }, digest_window_sec: 10 },
    });
    expect(ch.statusCode).toBe(201);
    const channelId = (ch.json() as { id: string }).id;

    // Create a pending action (triggers notifyChannels fire-and-forget)
    const act = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      headers: auth(adminKey),
      payload: ACTION_PAYLOAD,
    });
    expect(act.statusCode).toBe(201);

    // Wait for the async notification to execute.
    await new Promise(r => setTimeout(r, 50));

    // Channel should have fired: last_fired_at set, fail_count still 0
    const row = db.prepare(
      'SELECT last_fired_at, fail_count, digest_queue FROM notification_channels WHERE id = ?',
    ).get(channelId) as { last_fired_at: number | null; fail_count: number; digest_queue: string };

    expect(row.last_fired_at).not.toBeNull();
    expect(row.fail_count).toBe(0);
    expect(row.digest_queue).toBe('[]');
  });

  it('queues a second action within the digest window instead of sending', async () => {
    const { app, adminKey, db } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Slack Digest', type: 'slack',
        config: { url: VALID_SLACK_URL },
        digest_window_sec: 3600, // large window so the second action is always queued
      },
    });
    const channelId = (ch.json() as { id: string }).id;

    // First action — fires immediately (last_fired_at was NULL)
    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...ACTION_PAYLOAD, title: 'First Action' },
    });
    await new Promise(r => setTimeout(r, 50));

    const rowAfterFirst = db.prepare(
      'SELECT last_fired_at, digest_queue FROM notification_channels WHERE id = ?',
    ).get(channelId) as { last_fired_at: number | null; digest_queue: string };
    expect(rowAfterFirst.last_fired_at).not.toBeNull();
    expect(JSON.parse(rowAfterFirst.digest_queue)).toHaveLength(0); // queue flushed

    // Second action — within the 3600 s window → should be queued, not sent
    const callsBefore = fetchMock.mock.calls.length;
    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...ACTION_PAYLOAD, title: 'Second Action', preview: { format: 'plain', body: 'different body' } },
    });
    await new Promise(r => setTimeout(r, 50));

    // No additional fetch call should have been made for the channel
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    const rowAfterSecond = db.prepare(
      'SELECT digest_queue FROM notification_channels WHERE id = ?',
    ).get(channelId) as { digest_queue: string };
    const queue = JSON.parse(rowAfterSecond.digest_queue) as { actionId: string }[];
    expect(queue).toHaveLength(1); // second action queued
  });

  it('does NOT fire disabled channels', async () => {
    const { app, adminKey, db } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Disabled', type: 'slack', config: { url: VALID_SLACK_URL }, enabled: false },
    });
    const channelId = (ch.json() as { id: string }).id;

    const callsBefore = fetchMock.mock.calls.length;
    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: ACTION_PAYLOAD,
    });
    await new Promise(r => setTimeout(r, 50));

    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    const row = db.prepare(
      'SELECT last_fired_at FROM notification_channels WHERE id = ?',
    ).get(channelId) as { last_fired_at: number | null };
    expect(row.last_fired_at).toBeNull();
  });

  it('auto-approves action does NOT trigger channels (only pending does)', async () => {
    const { app, adminKey, db } = await setup();

    // Create a rule that auto-approves all actions
    await app.inject({
      method: 'POST', url: '/v1/rules', headers: auth(adminKey),
      payload: { name: 'Auto-approve all', rule_action: 'auto_approve', kind_pattern: '*' },
    });

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const channelId = (ch.json() as { id: string }).id;

    const callsBefore = fetchMock.mock.calls.length;
    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: ACTION_PAYLOAD,
    });
    await new Promise(r => setTimeout(r, 50));

    // No channel fire — auto-approved actions are not pending
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    const row = db.prepare(
      'SELECT last_fired_at FROM notification_channels WHERE id = ?',
    ).get(channelId) as { last_fired_at: number | null };
    expect(row.last_fired_at).toBeNull();
  });

  it('increments fail_count when adapter fails', async () => {
    const { app, adminKey, db } = await setup();

    // Stub fetch to return a 500 error
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' }));

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Failing Slack', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const channelId = (ch.json() as { id: string }).id;

    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: ACTION_PAYLOAD,
    });
    await new Promise(r => setTimeout(r, 50));

    const row = db.prepare(
      'SELECT fail_count, last_error FROM notification_channels WHERE id = ?',
    ).get(channelId) as { fail_count: number; last_error: string | null };
    expect(row.fail_count).toBe(1);
    expect(row.last_error).toContain('500');
  });

  it('sanitizes secrets from error message logged on channel delivery failure', async () => {
    // Simulate a network error whose message contains the webhook secret token
    // (e.g. a DNS/TLS error that echoes back the full request URL).
    const secretToken = 'abcdefghijklmno'; // last segment of VALID_SLACK_URL
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error(`connect ECONNREFUSED https://hooks.slack.com/services/T00/B00/${secretToken}`),
    ));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { app, adminKey, db } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack Secret Leak', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const channelId = (ch.json() as { id: string }).id;

    await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: ACTION_PAYLOAD,
    });
    await new Promise(r => setTimeout(r, 50));

    // The token must not appear in any logged string.
    const allLoggedArgs = errorSpy.mock.calls.flatMap(call =>
      call.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))),
    );
    for (const logged of allLoggedArgs) {
      expect(logged).not.toContain(secretToken);
    }

    // The DB-stored last_error must also be sanitized.
    const row = db.prepare(
      'SELECT last_error FROM notification_channels WHERE id = ?',
    ).get(channelId) as { last_error: string | null };
    expect(row.last_error).not.toBeNull();
    expect(row.last_error).not.toContain(secretToken);
    expect(row.last_error).toContain('[redacted]');

    errorSpy.mockRestore();
  });

  it('auto-disables channel after IMPRI_CHANNEL_MAX_FAILS consecutive failures', async () => {
    const prevMaxFails = process.env.IMPRI_CHANNEL_MAX_FAILS;
    process.env.IMPRI_CHANNEL_MAX_FAILS = '2';

    const { app, adminKey, db } = await setup();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' }));

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Auto-disable', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const channelId = (ch.json() as { id: string }).id;

    // Fire twice — each creates a different action so dedup doesn't kick in
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST', url: '/v1/actions', headers: auth(adminKey),
        payload: { ...ACTION_PAYLOAD, title: `Action ${i}`, preview: { format: 'plain', body: `body ${i}` } },
      });
      await new Promise(r => setTimeout(r, 50));
      // Reset last_fired_at so the next action doesn't get queued within window
      db.prepare('UPDATE notification_channels SET last_fired_at = NULL WHERE id = ?').run(channelId);
    }

    const row = db.prepare(
      'SELECT enabled, fail_count FROM notification_channels WHERE id = ?',
    ).get(channelId) as { enabled: number; fail_count: number };
    expect(row.enabled).toBe(0); // auto-disabled
    expect(row.fail_count).toBe(2);

    if (prevMaxFails !== undefined) {
      process.env.IMPRI_CHANNEL_MAX_FAILS = prevMaxFails;
    } else {
      delete process.env.IMPRI_CHANNEL_MAX_FAILS;
    }
  });
});

// ---------------------------------------------------------------------------
// Test endpoint
// ---------------------------------------------------------------------------

describe('POST /v1/notification-channels/:id/test', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns { ok: true } when delivery succeeds', async () => {
    const { app, adminKey } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack Test', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const { id } = ch.json() as { id: string };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/notification-channels/${id}/test`,
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns { ok: false, error } when delivery fails (secret stripped from error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' }));

    const { app, adminKey } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack Fail', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const { id } = ch.json() as { id: string };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/notification-channels/${id}/test`,
      headers: auth(adminKey),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
    // Error must NOT contain the webhook URL or any secret value
    expect(body.error).not.toContain(VALID_SLACK_URL);
  });

  it('does NOT update last_fired_at or fail_count on test send', async () => {
    const { app, adminKey, db } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Slack', type: 'slack', config: { url: VALID_SLACK_URL } },
    });
    const { id } = ch.json() as { id: string };

    await app.inject({
      method: 'POST',
      url: `/v1/notification-channels/${id}/test`,
      headers: auth(adminKey),
    });

    const row = db.prepare(
      'SELECT last_fired_at, fail_count FROM notification_channels WHERE id = ?',
    ).get(id) as { last_fired_at: number | null; fail_count: number };
    expect(row.last_fired_at).toBeNull();
    expect(row.fail_count).toBe(0);
  });

  it('returns 404 for unknown channel id', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels/nchan_doesnotexist/test',
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it('email channel test succeeds without SMTP (skip + ok:true)', async () => {
    delete process.env.SMTP_HOST;
    const { app, adminKey } = await setup();

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Email', type: 'email', config: { address: 'test@example.com' } },
    });
    const { id } = ch.json() as { id: string };

    // No SMTP_HOST → sendEmailChannel returns early without throwing
    const res = await app.inject({
      method: 'POST',
      url: `/v1/notification-channels/${id}/test`,
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple channel types validation
// ---------------------------------------------------------------------------

describe('channel type validation', () => {
  it('accepts valid ntfy config', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'ntfy', type: 'ntfy', config: { url: VALID_NTFY_URL, topic: 'my-alerts' } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts valid discord config', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'Discord', type: 'discord', config: { url: VALID_DISCORD_URL } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts webhook with hmac_secret', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Signed Webhook', type: 'webhook',
        config: { url: VALID_WEBHOOK_URL, hmac_secret: 'a-16-char-secret' },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects webhook hmac_secret shorter than 16 chars', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Bad Webhook', type: 'webhook',
        config: { url: VALID_WEBHOOK_URL, hmac_secret: 'short' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown channel type', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: { name: 'X', type: 'pushover', config: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects digest_window_sec below 10', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Fast', type: 'email',
        config: { address: 'a@b.com' },
        digest_window_sec: 5,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Project isolation: channels from project A are invisible to project B
// ---------------------------------------------------------------------------

describe('project isolation', () => {
  it('cannot GET a channel belonging to another project', async () => {
    const { app, adminKey: keyA } = await setup();

    // Project B
    const signupB = await app.inject({
      method: 'POST', url: '/v1/signup',
      payload: { project_name: 'Project B' },
      headers: { 'x-impri-signup-token': process.env.SIGNUP_SECRET ?? '' },
    });
    // If signup is disabled, skip this test
    if (signupB.statusCode !== 201) return;
    const keyB = (signupB.json() as { key: string }).key;

    // Create channel on project A
    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(keyA),
      payload: { name: 'A Channel', type: 'email', config: { address: 'a@a.com' } },
    });
    const { id } = ch.json() as { id: string };

    // Project B should get 404
    const res = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${id}`,
      headers: auth(keyB),
    });
    expect(res.statusCode).toBe(404);
  });
});
