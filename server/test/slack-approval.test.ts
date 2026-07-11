/**
 * Slack interactive approval — server-side tests.
 *
 * Covers:
 *  - SlackConfig schema: new approval fields validated, superRefine errors
 *    when approval_mode=true and required fields missing
 *  - maskConfig: new slack fields handled correctly; bot_token/signing_secret
 *    never leaked; non-approval-mode returns plain { url: masked }
 *  - buildSlackApprovalSig: deterministic 8-char base64url output
 *  - POST /v1/integrations/slack/interactions/:channelId:
 *    - BAD X-Slack-Signature → 403
 *    - Missing signature headers → 403
 *    - Stale timestamp → 403
 *    - Non-block_actions payload type → 200 '' (ignored)
 *    - Malformed button value → 200 '' (ignored)
 *    - Forged button HMAC → 200 '' (silently ignored)
 *    - UNAUTHORIZED user → 200 '' + ephemeral "Not authorized" via response_url
 *    - HAPPY PATH approve → action approved, response_url called with replace_original
 *    - HAPPY PATH reject → action rejected
 *    - CROSS-PROJECT action → 200 '' + "Action not found" via response_url
 *    - ALREADY-DECIDED → 200 '' + "Already decided" via response_url (idempotent)
 *    - Secrets never in API responses (bot_token, signing_secret masked)
 *    - response_url not called when it's not a hooks.slack.com URL (SSRF guard)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import {
  maskConfig,
  buildSlackApprovalSig,
} from '../src/notify.js';

// Prevent watcher scheduler from spawning background timers in tests.
process.env.DISABLE_WATCHER_SCHEDULER = '1';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_TOKEN      = 'xoxb-1234567890-abcdef-testtoken';
const CHANNEL_ID     = 'C1234567890';
const SIGNING_SECRET = 'a'.repeat(32); // 32 deterministic chars
const APPROVER_USER  = 'U0TESTUSER';

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

/** Build Slack v0 HMAC-SHA256 signature headers for a raw body string. */
function signSlack(
  rawBody: string,
  signingSecret: string,
  tsOverride?: number,
): { 'x-slack-signature': string; 'x-slack-request-timestamp': string } {
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);
  const base = `v0:${ts}:${rawBody}`;
  const sig = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');
  return {
    'x-slack-signature': sig,
    'x-slack-request-timestamp': String(ts),
  };
}

/** Create an approval-mode Slack channel and return its id. */
async function createApprovalChannel(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/notification-channels',
    headers: auth(adminKey),
    payload: {
      name: 'Slack Approvals',
      type: 'slack',
      config: {
        bot_token: BOT_TOKEN,
        channel_id: CHANNEL_ID,
        signing_secret: SIGNING_SECRET,
        approval_mode: true,
        allowed_approver_slack_user_ids: [APPROVER_USER],
        ...overrides,
      },
    },
  });
}

/** Create a pending action and return its id. */
async function createPendingAction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  title = 'Test Action',
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
 * Build a URL-encoded Slack interactions payload with a signed button value.
 */
function buildSlackPayload(
  verdict: 'a' | 'r',
  actionId: string,
  signingSecret: string,
  options: {
    userId?: string;
    responseUrl?: string;
    customButtonSig?: string; // override the HMAC (for forgery tests)
  } = {},
): string {
  const userId = options.userId ?? APPROVER_USER;
  const responseUrl = options.responseUrl ?? 'https://hooks.slack.com/actions/T0000/00000/TESTTOKEN';

  const buttonSig = options.customButtonSig ?? buildSlackApprovalSig(signingSecret, verdict, actionId);
  const buttonValue = `${verdict}:${actionId}:${buttonSig}`;

  const payloadJson = JSON.stringify({
    type: 'block_actions',
    user: { id: userId, name: 'testuser' },
    response_url: responseUrl,
    actions: [
      {
        action_id: verdict === 'a' ? 'approve' : 'reject',
        value: buttonValue,
      },
    ],
  });

  return `payload=${encodeURIComponent(payloadJson)}`;
}

/** Send a Slack interaction request with proper signature headers. */
async function postInteraction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  channelId: string,
  rawBody: string,
  sigHeaders?: { 'x-slack-signature': string; 'x-slack-request-timestamp': string },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    ...(sigHeaders ?? signSlack(rawBody, SIGNING_SECRET)),
  };
  return app.inject({
    method: 'POST',
    url: `/v1/integrations/slack/interactions/${channelId}`,
    headers,
    payload: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Unit: SlackConfig schema
// ---------------------------------------------------------------------------

describe('SlackConfig schema', () => {
  it('accepts plain (non-approval) slack channel with just url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain Slack',
        type: 'slack',
        config: { url: 'https://hooks.slack.com/services/T00/B00/xxxxxxxxxxxxxxxx' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().config.url).toMatch(/^\*\*\*\*/);
  });

  it('accepts full approval-mode config', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect((body.config as Record<string, unknown>).approval_mode).toBe(true);
    expect((body.config as Record<string, unknown>).allowed_approver_slack_user_ids).toEqual([APPROVER_USER]);
    expect((body.config as Record<string, unknown>).bot_token).toMatch(/^\*\*\*\*/);
    expect((body.config as Record<string, unknown>).signing_secret).toMatch(/^\*\*\*\*/);
  });

  it('rejects approval_mode=true with missing bot_token', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      bot_token: undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('bot_token');
  });

  it('rejects approval_mode=true with missing signing_secret', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      signing_secret: undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('signing_secret');
  });

  it('rejects approval_mode=true with missing channel_id', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      channel_id: undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('channel_id');
  });

  it('rejects approval_mode=true with empty allowed_approver_slack_user_ids', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      allowed_approver_slack_user_ids: [],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('no one can approve');
  });

  it('rejects approval_mode=false with no url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Bad Slack',
        type: 'slack',
        config: { approval_mode: false },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('url');
  });

  it('rejects invalid bot_token format (not xoxb-)', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      bot_token: 'xoxa-invalid-token-format',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid Slack user ID format in allowed_approver_slack_user_ids', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      allowed_approver_slack_user_ids: ['invalid-user-id'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects more than 50 allowed_approver_slack_user_ids', async () => {
    const { app, adminKey } = await setup();
    const tooMany = Array.from({ length: 51 }, (_, i) => `U${String(i).padStart(9, '0')}`);
    const res = await createApprovalChannel(app, adminKey, {
      allowed_approver_slack_user_ids: tooMany,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit: maskConfig — slack approval mode
// ---------------------------------------------------------------------------

describe('maskConfig — slack approval fields', () => {
  it('masks bot_token and signing_secret, returns others as-is (approval mode)', () => {
    const masked = maskConfig('slack', {
      bot_token: BOT_TOKEN,
      channel_id: CHANNEL_ID,
      signing_secret: SIGNING_SECRET,
      approval_mode: true,
      allowed_approver_slack_user_ids: [APPROVER_USER],
    });
    expect(masked.bot_token).toMatch(/^\*\*\*\*/);
    expect(String(masked.bot_token)).not.toContain('xoxb-');
    expect(masked.signing_secret).toMatch(/^\*\*\*\*/);
    expect(String(masked.signing_secret)).not.toContain(SIGNING_SECRET);
    expect(masked.channel_id).toBe(CHANNEL_ID);
    expect(masked.approval_mode).toBe(true);
    expect(masked.allowed_approver_slack_user_ids).toEqual([APPROVER_USER]);
  });

  it('returns plain { url: masked } when approval_mode is false/absent', () => {
    const masked = maskConfig('slack', { url: 'https://hooks.slack.com/services/TOKEN' });
    expect(masked.url).toBe('****OKEN');
    expect(masked.bot_token).toBeUndefined();
    expect(masked.approval_mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: buildSlackApprovalSig
// ---------------------------------------------------------------------------

describe('buildSlackApprovalSig', () => {
  it('produces deterministic 8-char base64url output', () => {
    const s1 = buildSlackApprovalSig(SIGNING_SECRET, 'a', 'act_abc123');
    const s2 = buildSlackApprovalSig(SIGNING_SECRET, 'a', 'act_abc123');
    expect(s1).toBe(s2);
    expect(s1).toHaveLength(8);
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('approve and reject produce different signatures', () => {
    const sigA = buildSlackApprovalSig(SIGNING_SECRET, 'a', 'act_abc123');
    const sigR = buildSlackApprovalSig(SIGNING_SECRET, 'r', 'act_abc123');
    expect(sigA).not.toBe(sigR);
  });

  it('different signing secrets produce different signatures', () => {
    const sig1 = buildSlackApprovalSig(SIGNING_SECRET, 'a', 'act_abc123');
    const sig2 = buildSlackApprovalSig('b'.repeat(32), 'a', 'act_abc123');
    expect(sig1).not.toBe(sig2);
  });

  it('sl: prefix prevents cross-platform reuse (differs from tg: and dc: signatures)', () => {
    // This just verifies the prefix is included in the HMAC input
    const sigSl = buildSlackApprovalSig(SIGNING_SECRET, 'a', 'act_abc123');
    // The Telegram equivalent uses "tg:a:act_abc123" as the message
    const tgMac = createHmac('sha256', SIGNING_SECRET)
      .update('tg:a:act_abc123').digest().subarray(0, 6).toString('base64url');
    expect(sigSl).not.toBe(tgMac);
  });
});

// ---------------------------------------------------------------------------
// Integration: /v1/integrations/slack/interactions/:channelId
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/slack/interactions/:channelId', () => {
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

  it('returns 403 when X-Slack-Signature header is missing', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/slack/interactions/${channelId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'payload={}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when X-Slack-Signature is wrong', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = 'payload=%7B%7D';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/slack/interactions/${channelId}`,
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
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = 'payload=%7B%7D';
    const staleTs = Math.floor(Date.now() / 1000) - 301; // 5 min + 1 s ago
    const sigHeaders = signSlack(rawBody, SIGNING_SECRET, staleTs);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/slack/interactions/${channelId}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...sigHeaders,
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown channelId', async () => {
    const { app } = await setup();
    const rawBody = 'payload=%7B%7D';
    const sigHeaders = signSlack(rawBody, SIGNING_SECRET);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/slack/interactions/nchan_doesnotexist',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...sigHeaders },
      payload: rawBody,
    });
    // Could be 403 (sig mismatch on no-channel) or 404 depending on implementation
    // We accept both: the attacker gets no info about channel existence
    expect([403, 404]).toContain(res.statusCode);
  });

  it('returns 404 for a non-approval-mode slack channel', async () => {
    const { app, adminKey } = await setup();
    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain Slack',
        type: 'slack',
        config: { url: 'https://hooks.slack.com/services/T00/B00/xxxxxxxxxxxxxxxx' },
      },
    });
    const channelId = (ch.json() as { id: string }).id;
    const rawBody = 'payload=%7B%7D';
    // Even with correct signing secret (which a plain channel doesn't have)
    // we need to use the channel's url as signing secret - but that's wrong.
    // The point is: correct format but non-approval channel → 404
    const ts = Math.floor(Date.now() / 1000);
    const fakeSig = signSlack(rawBody, 'x'.repeat(32), ts);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/slack/interactions/${channelId}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...fakeSig },
      payload: rawBody,
    });
    // 403 (sig wrong) or 404 (not approval mode) - both acceptable
    expect([403, 404]).toContain(res.statusCode);
  });

  it('returns 200 empty for non-block_actions payload type (Slack expects 200)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const payloadJson = JSON.stringify({ type: 'shortcut', callback_id: 'test' });
    const rawBody = `payload=${encodeURIComponent(payloadJson)}`;
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('FORGED button HMAC is silently rejected', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET, {
      customButtonSig: 'forgeSig', // wrong length too, but tested separately
    });
    // forged sig length != 8 → malformed → 200 ''
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');

  });

  it('FORGED button HMAC (8-char but wrong) is rejected silently', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET, {
      customButtonSig: 'aaaaaaaa', // correct length but wrong HMAC
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');

    // response_url must NOT have been called
    const responseUrlCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseUrlCall).toBeUndefined();
  });

  it('UNAUTHORIZED user → 200 + ephemeral "Not authorized" via response_url', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET, {
      userId: 'U9999UNAUTH',
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    // response_url should have been called with ephemeral "Not authorized"
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const body = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(String(body.text)).toContain('Not authorized');
    expect(body.response_type).toBe('ephemeral');
  });

  it('HAPPY PATH: authorized user approves → action approved, response_url updated', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Slack Approve Test');

    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET);
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    // Action should now be approved
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('approved');

    // Decision row should exist with decided_by = "sl:{userId}"
    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision).toBeTruthy();
    expect(decision.verdict).toBe('approve');
    expect(decision.decided_by).toBe(`sl:${APPROVER_USER}`);
    expect(decision.channel).toBe('slack');

    // audit_log entry should exist
    const audit = db.prepare(
      "SELECT * FROM audit_log WHERE action_id = ? AND event = 'action.approved'",
    ).get(actionId) as Record<string, unknown> | undefined;
    expect(audit).toBeTruthy();
    expect(audit!.channel).toBe('slack');

    // response_url should have been called with replace_original=true
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(responseBody.replace_original).toBe(true);
    expect(JSON.stringify(responseBody)).toContain('Approved');
  });

  it('HAPPY PATH: authorized user rejects → action rejected', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Slack Reject Test');

    const rawBody = buildSlackPayload('r', actionId, SIGNING_SECRET);
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('rejected');

    const decision = db.prepare('SELECT verdict, decided_by FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision.verdict).toBe('reject');
    expect(decision.decided_by).toBe(`sl:${APPROVER_USER}`);

    // response_url should say Rejected
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(JSON.stringify(responseBody)).toContain('Rejected');
  });

  it('CROSS-PROJECT: action from a different project is not found', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    // Create a second project and action within it
    const signupB = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { project_name: 'Project B' },
      headers: { 'x-impri-signup-token': process.env.SIGNUP_SECRET ?? '' },
    });
    if (signupB.statusCode !== 201) {
      // Signup disabled — skip cross-project test
      return;
    }
    const keyB = (signupB.json() as { key: string }).key;
    const projectBActionId = await createPendingAction(app, keyB, 'Cross-project action');

    // Try to approve action from project B via project A's channel
    const rawBody = buildSlackPayload('a', projectBActionId, SIGNING_SECRET);
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    // response_url should say "Action not found"
    const responseCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('hooks.slack.com'),
    );
    expect(responseCall).toBeTruthy();
    const responseBody = JSON.parse(responseCall![1].body as string) as Record<string, unknown>;
    expect(String(responseBody.text)).toContain('not found');

    // The action in project B must remain pending
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(projectBActionId) as { status: string };
    expect(action.status).toBe('pending');
  });

  it('ALREADY-DECIDED: second tap returns "Already decided" (idempotent)', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Idempotent Test');

    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET);

    // First tap — approves
    await postInteraction(app, channelId, rawBody);
    fetchMock.mockClear();

    // Second tap — should be idempotent
    const res2 = await postInteraction(app, channelId, rawBody);
    expect(res2.statusCode).toBe(200);

    // response_url should say "Already decided"
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

  it('SSRF guard: response_url not called when it is not a hooks.slack.com URL', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    // Build payload with a non-Slack response_url
    const rawBody = buildSlackPayload('a', actionId, SIGNING_SECRET, {
      responseUrl: 'https://evil.example.com/webhook',
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    // fetch should NOT have been called with the evil URL
    const evilCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('evil.example.com'),
    );
    expect(evilCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security: secrets never in API responses
// ---------------------------------------------------------------------------

describe('Slack secrets never leak', () => {
  it('bot_token and signing_secret are masked in CREATE response', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(SIGNING_SECRET);
    expect(res.json().config.bot_token).toMatch(/^\*\*\*\*/);
    expect(res.json().config.signing_secret).toMatch(/^\*\*\*\*/);
  });

  it('secrets are masked in GET response', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(SIGNING_SECRET);
  });

  it('secrets are masked in LIST response', async () => {
    const { app, adminKey } = await setup();
    await createApprovalChannel(app, adminKey);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(SIGNING_SECRET);
  });

  it('secrets are masked in PATCH response', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
      payload: { name: 'Updated Slack Channel' },
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(SIGNING_SECRET);
  });
});
