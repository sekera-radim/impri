/**
 * Slack shared-app OAuth install + interactive approval — server-side tests.
 *
 * Covers:
 *  - GET  /v1/integrations/slack/app-info  — available flag driven by SLACK_CLIENT_ID env
 *  - POST /v1/integrations/slack/install-url — auth-gated, returns Slack OAuth authorize URL
 *  - GET  /v1/integrations/slack/oauth/callback — state verification, nonce replay, happy path
 *  - POST /v1/integrations/slack/interactions (shared app, no :channelId) — full approval flow:
 *    wrong signature, stale timestamp, unknown team, unknown channel, unauthorized user,
 *    forged button HMAC, approve, reject, double-decision idempotency
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createDb } from '../src/db.js';
import { genId, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { buildSlackApprovalSig } from '../src/notify.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

// ---------------------------------------------------------------------------
// Test constants — all obviously fake / dummy values, no real secrets
// ---------------------------------------------------------------------------

const SLACK_CLIENT_ID     = 'test-client-id';
const SLACK_CLIENT_SECRET = 'test-client-secret';
const APP_SIGNING_SECRET  = 'z'.repeat(32);
const BOT_TOKEN           = 'xoxb-shared-app-testtoken-1234567890';
const TEAM_ID             = 'TSHAREDTEAM';
const TEAM_NAME           = 'Test Workspace';
const SLACK_CHANNEL_ID    = 'C9876543210';
const SLACK_CHANNEL_NAME  = '#approvals';
const APPROVER_USER       = 'U0TESTUSER';
const APP_URL             = 'http://localhost:5173';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup() {
  process.env.SLACK_CLIENT_ID        = SLACK_CLIENT_ID;
  process.env.SLACK_CLIENT_SECRET    = SLACK_CLIENT_SECRET;
  process.env.SLACK_APP_SIGNING_SECRET = APP_SIGNING_SECRET;
  process.env.BASE_URL               = 'http://localhost:8484';
  process.env.APP_URL                = APP_URL;
  const db        = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app       = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

/**
 * Setup variant without any Slack credentials — routes capture env at
 * registration time, so SLACK_CLIENT_ID must be absent before createApp.
 */
async function setupNoSlack() {
  // Only BASE_URL / APP_URL — no Slack credentials.
  process.env.BASE_URL = 'http://localhost:8484';
  process.env.APP_URL  = APP_URL;
  const db        = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app       = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

afterEach(() => {
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
  delete process.env.SLACK_APP_SIGNING_SECRET;
  delete process.env.BASE_URL;
  delete process.env.APP_URL;
  vi.unstubAllGlobals();
});

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

/** Build Slack v0 HMAC-SHA256 signature headers for a raw body string. */
function signSlack(rawBody: string, secret: string, tsOverride?: number) {
  const ts  = tsOverride ?? Math.floor(Date.now() / 1000);
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  return {
    'x-slack-signature': sig,
    'x-slack-request-timestamp': String(ts),
  };
}

/**
 * Insert a shared-app channel directly into the DB to avoid going through the
 * full OAuth callback flow in every test.
 */
function insertSharedChannel(
  db: ReturnType<typeof createDb>,
  projectId: string,
  buttonSecret = 'shared-button-secret-12345678901234567890',
) {
  const id  = genId('nchan_');
  const now = nowSec();
  const config = JSON.stringify({
    shared_app: true,
    team_id:    TEAM_ID,
    team_name:  TEAM_NAME,
    slack_channel_id:   SLACK_CHANNEL_ID,
    slack_channel_name: SLACK_CHANNEL_NAME,
    button_secret: buttonSecret,
    bot_token: BOT_TOKEN,
    allowed_approver_slack_user_ids: [APPROVER_USER],
  });
  db.prepare(
    `INSERT INTO notification_channels (id, project_id, name, type, enabled, config, digest_window_sec, digest_queue, fail_count, created_at, updated_at)
     VALUES (?, ?, ?, 'slack', 1, ?, 60, '[]', 0, ?, ?)`,
  ).run(id, projectId, 'Shared Slack #approvals', config, now, now);
  return { id, buttonSecret };
}

/** Create a pending action and return its id. */
async function createPendingAction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  title = 'Shared App Test Action',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: auth(adminKey),
    payload: {
      kind: 'test.kind',
      title,
      preview: { format: 'plain', body: 'preview body' },
    },
  });
  return (res.json() as { id: string }).id;
}

/**
 * Build a URL-encoded Slack interactions payload for the shared app.
 * The payload includes `team` and `channel` fields so the server can
 * look up the right notification channel by (team_id, channel_id).
 */
function buildSharedPayload(
  verdict: 'a' | 'r',
  actionId: string,
  buttonSecret: string,
  options: {
    userId?: string;
    teamId?: string;
    channelId?: string;
    responseUrl?: string;
    customButtonSig?: string;
  } = {},
): string {
  const userId      = options.userId    ?? APPROVER_USER;
  const teamId      = options.teamId    ?? TEAM_ID;
  const channelId   = options.channelId ?? SLACK_CHANNEL_ID;
  const responseUrl = options.responseUrl ?? 'https://hooks.slack.com/actions/T0000/00000/TESTTOKEN';
  const buttonSig   = options.customButtonSig ?? buildSlackApprovalSig(buttonSecret, verdict, actionId);

  const payloadJson = JSON.stringify({
    type: 'block_actions',
    team:    { id: teamId },
    channel: { id: channelId },
    user:    { id: userId },
    response_url: responseUrl,
    actions: [
      {
        action_id: verdict === 'a' ? 'approve' : 'reject',
        value: `${verdict}:${actionId}:${buttonSig}`,
      },
    ],
  });

  return `payload=${encodeURIComponent(payloadJson)}`;
}

/** Send a shared-app Slack interaction with proper signature headers. */
async function postSharedInteraction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  rawBody: string,
  sigHeaders?: ReturnType<typeof signSlack>,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    ...(sigHeaders ?? signSlack(rawBody, APP_SIGNING_SECRET)),
  };
  return app.inject({
    method: 'POST',
    url: '/v1/integrations/slack/interactions',
    headers,
    payload: rawBody,
  });
}

/**
 * Call POST /v1/integrations/slack/install-url (requires auth) and extract
 * the `state` query-param from the returned Slack OAuth authorize URL.
 */
async function getValidState(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations/slack/install-url',
    headers: auth(adminKey),
  });
  const { url } = res.json() as { url: string };
  return new URL(url).searchParams.get('state')!;
}

// ---------------------------------------------------------------------------
// GET /v1/integrations/slack/app-info
// ---------------------------------------------------------------------------

describe('GET /v1/integrations/slack/app-info', () => {
  it('returns available: true when SLACK_CLIENT_ID is set', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/slack/app-info' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { available: boolean }).available).toBe(true);
  });

  it('returns available: false when SLACK_CLIENT_ID is not set', async () => {
    // The route captures CLIENT_ID at registration time, so we need a fresh app
    // created without SLACK_CLIENT_ID in env.
    const { app } = await setupNoSlack();
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/slack/app-info' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { available: boolean }).available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/integrations/slack/install-url
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/slack/install-url', () => {
  it('returns 401 without auth', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/integrations/slack/install-url' });
    // Route checks request.apiKey; missing auth → 401 (preHandler passes public routes
    // through, route handler itself rejects unauthenticated callers with 401).
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when SLACK_CLIENT_ID is not set', async () => {
    // Must use an app created without SLACK_CLIENT_ID so the route captures '' at startup.
    const { app, adminKey } = await setupNoSlack();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/install-url',
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns install URL containing slack.com/oauth/v2/authorize and client_id', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/install-url',
      headers: auth(adminKey),
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json() as { url: string };
    expect(url).toContain('slack.com/oauth/v2/authorize');
    expect(url).toContain(`client_id=${SLACK_CLIENT_ID}`);
    // State param must be present (CSRF token)
    expect(new URL(url).searchParams.get('state')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/integrations/slack/oauth/callback — state verification
// ---------------------------------------------------------------------------

describe('GET /v1/integrations/slack/oauth/callback', () => {
  it('rejects invalid (tampered) state signature → redirects with invalid_state', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/slack/oauth/callback',
      query: { code: 'somecode', state: 'tampered.invalid.state.value' },
    });
    // Should be a 302 redirect (or 400); in any case must signal error
    expect([302, 400]).toContain(res.statusCode);
    if (res.statusCode === 302) {
      expect(res.headers.location).toContain('slack=error');
    }
  });

  it('rejects nonce replay — second use of same state returns error', async () => {
    const { app, adminKey } = await setup();
    const state = await getValidState(app, adminKey);

    // Mock fetch so exchange "succeeds" on first call but nonce is spent
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: BOT_TOKEN,
          team: { id: TEAM_ID, name: TEAM_NAME },
          incoming_webhook: { channel: SLACK_CHANNEL_NAME, channel_id: SLACK_CHANNEL_ID },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_code' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    // First use — should succeed or fail for reasons unrelated to state
    await app.inject({
      method: 'GET',
      url: '/v1/integrations/slack/oauth/callback',
      query: { code: 'valid-code-first', state },
    });

    // Second use of the SAME state token — nonce must be consumed
    const res2 = await app.inject({
      method: 'GET',
      url: '/v1/integrations/slack/oauth/callback',
      query: { code: 'valid-code-second', state },
    });

    expect([302, 400]).toContain(res2.statusCode);
    if (res2.statusCode === 302) {
      expect(res2.headers.location).toContain('slack=error');
    }
  });

  it('happy path: valid state + successful exchange creates channel and redirects', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const state = await getValidState(app, adminKey);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        access_token: BOT_TOKEN,
        team: { id: TEAM_ID, name: TEAM_NAME },
        incoming_webhook: {
          channel:    SLACK_CHANNEL_NAME,
          channel_id: SLACK_CHANNEL_ID,
          // url is required by the implementation (used to validate the response shape)
          url: `https://hooks.slack.com/services/${TEAM_ID}/BTEST/testwebhookurl`,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/slack/oauth/callback',
      query: { code: 'valid-code', state },
    });

    // Expect redirect to APP_URL with ?slack=connected
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`${APP_URL}`);
    expect(res.headers.location).toContain('slack=connected');

    // DB should have a notification_channels row for this workspace
    const channels = db.prepare(
      "SELECT * FROM notification_channels WHERE project_id = ? AND type = 'slack'",
    ).all(projectId) as Array<{ config: string; id: string }>;

    const sharedChannel = channels.find(ch => {
      const cfg = JSON.parse(ch.config) as Record<string, unknown>;
      return cfg.shared_app === true && cfg.team_id === TEAM_ID;
    });

    expect(sharedChannel).toBeTruthy();
    const cfg = JSON.parse(sharedChannel!.config) as Record<string, unknown>;
    expect(cfg.slack_channel_id).toBe(SLACK_CHANNEL_ID);
    expect(cfg.team_id).toBe(TEAM_ID);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/integrations/slack/interactions — shared app
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/slack/interactions — shared app', () => {
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

  it('returns 403 when Slack signature is wrong', async () => {
    const { app } = await setup();
    const rawBody = 'payload=%7B%7D';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/interactions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': 'v0=badhash',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when timestamp is stale (replay defense)', async () => {
    const { app } = await setup();
    const rawBody = 'payload=%7B%7D';
    const staleTs  = Math.floor(Date.now() / 1000) - 301; // 5 min + 1 s ago
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/interactions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...signSlack(rawBody, APP_SIGNING_SECRET, staleTs),
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 empty for non-block_actions payload type', async () => {
    const { app } = await setup();
    const payloadJson = JSON.stringify({ type: 'shortcut', callback_id: 'test' });
    const rawBody = `payload=${encodeURIComponent(payloadJson)}`;
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('FORGED button HMAC is silently rejected', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSharedPayload('a', actionId, buttonSecret, {
      customButtonSig: 'forgeSig', // wrong length → malformed → silent ignore
    });
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');

    // response_url must NOT have been called
    const responseUrlCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseUrlCall).toBeUndefined();
  });

  it('returns 200 for unknown team_id — no matching channel', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSharedPayload('a', actionId, buttonSecret, {
      teamId: 'TUNKNOWN999', // not in DB
    });
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    // No fetch to response_url — we don't even have a URL to call
    expect(fetchMock.mock.calls.find(c => String(c[0]).includes('hooks.slack.com'))).toBeUndefined();
  });

  it('returns 200 for wrong channel_id — no matching channel', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSharedPayload('a', actionId, buttonSecret, {
      channelId: 'C0000WRONGCHAN', // correct team, wrong channel
    });
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('UNAUTHORIZED user → ephemeral "Not authorized" via response_url', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSharedPayload('a', actionId, buttonSecret, {
      userId: 'U9999UNAUTH',
    });
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);

    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const body = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(String(body.text)).toContain('Not authorized');
    expect(body.response_type).toBe('ephemeral');
  });

  it('HAPPY PATH: approve → action approved, response_url updated with replace_original', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey, 'Shared Approve Test');

    const rawBody = buildSharedPayload('a', actionId, buttonSecret);
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);

    // Action status → approved
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('approved');

    // Decision row
    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision).toBeTruthy();
    expect(decision.verdict).toBe('approve');
    expect(decision.decided_by).toBe(`sl:${APPROVER_USER}`);
    expect(decision.channel).toBe('slack');

    // response_url called with replace_original
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(responseBody.replace_original).toBe(true);
    expect(JSON.stringify(responseBody)).toContain('Approved');
  });

  it('HAPPY PATH: reject → action rejected', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey, 'Shared Reject Test');

    const rawBody = buildSharedPayload('r', actionId, buttonSecret);
    const res = await postSharedInteraction(app, rawBody);
    expect(res.statusCode).toBe(200);

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('rejected');

    const decision = db.prepare('SELECT verdict, decided_by FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision.verdict).toBe('reject');
    expect(decision.decided_by).toBe(`sl:${APPROVER_USER}`);

    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(JSON.stringify(responseBody)).toContain('Rejected');
  });

  it('DOUBLE DECISION → Already decided idempotent response', async () => {
    const { app, adminKey, db, projectId } = await setup();
    const { buttonSecret } = insertSharedChannel(db, projectId);
    const actionId = await createPendingAction(app, adminKey, 'Idempotent Shared Test');

    const rawBody = buildSharedPayload('a', actionId, buttonSecret);

    // First tap — approves
    await postSharedInteraction(app, rawBody);
    fetchMock.mockClear();

    // Second tap — should be idempotent
    const res2 = await postSharedInteraction(app, rawBody);
    expect(res2.statusCode).toBe(200);

    // response_url must say "Already decided"
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(String(responseBody.text)).toContain('Already decided');

    // Still exactly one decision row
    const decisions = db.prepare('SELECT COUNT(*) as cnt FROM decisions WHERE action_id = ?').get(actionId) as { cnt: number };
    expect(decisions.cnt).toBe(1);
  });
});
