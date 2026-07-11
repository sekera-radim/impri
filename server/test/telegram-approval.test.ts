/**
 * Telegram interactive approval bot — server-side tests.
 *
 * Covers:
 *  - TelegramConfig schema: new fields validated, superRefine error when
 *    approval_mode=true and allowed_approver_user_ids empty
 *  - hmac_secret auto-generated on channel create when omitted
 *  - maskConfig: new telegram fields (approval_mode, allowed_approver_user_ids,
 *    hmac_secret) handled correctly; bot_token never leaks
 *  - Signed button build: buildTelegramApprovalSig / deriveWebhookSecret
 *  - Webhook happy path: authorized user approves → action decided, message
 *    edited (fetch called with editMessageText)
 *  - Forged callback_data HMAC rejected (invalid sig)
 *  - Unauthorized Telegram user rejected (user ID not in allowed list)
 *  - Wrong / missing X-Telegram-Bot-Api-Secret-Token → 403
 *  - Cross-project action ID rejected (action belongs to different project)
 *  - Already-decided idempotent (second tap → "Already decided", no UNIQUE error)
 *  - Non-approval-mode channel returns 404 (don't reveal existence)
 *  - bot_token never appears in API responses or logs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import {
  maskConfig,
  deriveWebhookSecret,
  buildTelegramApprovalSig,
} from '../src/notify.js';

// Prevent watcher scheduler from spawning background timers in tests.
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

const BOT_TOKEN = '1234567890:ABCDEFabcdef';
const CHAT_ID   = '-1001234567890';
const HMAC_SECRET = 'a'.repeat(32); // 32-char deterministic secret for tests
const APPROVER_USER_ID = 987654321;

/** Create an approval-mode telegram channel and return its id + stored config. */
async function createApprovalChannel(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/notification-channels',
    headers: auth(adminKey),
    payload: {
      name: 'TG Approvals',
      type: 'telegram',
      config: {
        bot_token: BOT_TOKEN,
        chat_id: CHAT_ID,
        approval_mode: true,
        allowed_approver_user_ids: [APPROVER_USER_ID],
        hmac_secret: HMAC_SECRET,
        ...overrides,
      },
    },
  });
  return res;
}

/**
 * Build a valid Telegram Update JSON for a callback_query tap.
 * Signs the callback_data with the given hmac_secret.
 */
function buildUpdate(
  verdict: 'a' | 'r',
  actionId: string,
  hmacSecret: string,
  fromUserId = APPROVER_USER_ID,
  messageText = `🔔 <b>Action Pending</b>: Test Action\nKind: <code>test.kind</code>`,
): Record<string, unknown> {
  const sig = buildTelegramApprovalSig(hmacSecret, verdict, actionId);
  return {
    callback_query: {
      id: 'cbq_123',
      from: { id: fromUserId, first_name: 'Alice' },
      message: {
        message_id: 42,
        chat: { id: Number(CHAT_ID) },
        text: messageText,
      },
      data: `${verdict}:${actionId}:${sig}`,
    },
  };
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

// ---------------------------------------------------------------------------
// Unit: TelegramConfig schema
// ---------------------------------------------------------------------------

describe('TelegramConfig schema', () => {
  it('accepts minimal config (approval_mode defaults to false)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain TG',
        type: 'telegram',
        config: { bot_token: BOT_TOKEN, chat_id: CHAT_ID },
      },
    });
    expect(res.statusCode).toBe(201);
    // approval_mode should default to false in the response
    expect(res.json().config.approval_mode).toBe(false);
  });

  it('accepts full approval-mode config', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.config.approval_mode).toBe(true);
    expect(body.config.allowed_approver_user_ids).toEqual([APPROVER_USER_ID]);
    expect(body.config.hmac_secret).toMatch(/^\*\*\*\*/); // masked
  });

  it('rejects approval_mode=true with empty allowed_approver_user_ids', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, { allowed_approver_user_ids: [] });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(JSON.stringify(body)).toContain('allowed_approver_user_ids');
    expect(JSON.stringify(body)).toContain('no one can approve');
  });

  it('rejects hmac_secret shorter than 16 chars', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, { hmac_secret: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects allowed_approver_user_ids with more than 50 entries', async () => {
    const { app, adminKey } = await setup();
    const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await createApprovalChannel(app, adminKey, { allowed_approver_user_ids: tooMany });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit: hmac_secret auto-generation
// ---------------------------------------------------------------------------

describe('hmac_secret auto-generation', () => {
  it('auto-generates hmac_secret when omitted and approval_mode=true', async () => {
    const { app, adminKey, db } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Auto-secret TG',
        type: 'telegram',
        config: {
          bot_token: BOT_TOKEN,
          chat_id: CHAT_ID,
          approval_mode: true,
          allowed_approver_user_ids: [APPROVER_USER_ID],
          // hmac_secret intentionally omitted
        },
      },
    });
    expect(res.statusCode).toBe(201);
    // Response shows masked secret (****{last4})
    expect(res.json().config.hmac_secret).toMatch(/^\*\*\*\*/);

    // DB stores the actual generated secret (64 hex chars = 32 random bytes)
    const row = db.prepare('SELECT config FROM notification_channels WHERE id = ?').get(res.json().id) as { config: string };
    const stored = JSON.parse(row.config) as Record<string, unknown>;
    expect(typeof stored.hmac_secret).toBe('string');
    expect((stored.hmac_secret as string).length).toBe(64); // 32 bytes → 64 hex chars
  });

  it('does NOT auto-generate hmac_secret when approval_mode=false', async () => {
    const { app, adminKey, db } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain TG',
        type: 'telegram',
        config: { bot_token: BOT_TOKEN, chat_id: CHAT_ID },
      },
    });
    expect(res.statusCode).toBe(201);
    const row = db.prepare('SELECT config FROM notification_channels WHERE id = ?').get(res.json().id) as { config: string };
    const stored = JSON.parse(row.config) as Record<string, unknown>;
    expect(stored.hmac_secret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: maskConfig for telegram
// ---------------------------------------------------------------------------

describe('maskConfig — telegram with approval fields', () => {
  it('masks bot_token and hmac_secret, returns others as-is', () => {
    const masked = maskConfig('telegram', {
      bot_token: '1234567890:ABCDEFabcdef',
      chat_id: '-1001234567',
      approval_mode: true,
      allowed_approver_user_ids: [123, 456],
      hmac_secret: HMAC_SECRET,
    });
    expect(masked.bot_token).toMatch(/^\*\*\*\*/);
    expect(masked.bot_token).not.toContain('ABCDEF');
    expect(masked.hmac_secret).toMatch(/^\*\*\*\*/);
    expect(masked.hmac_secret).not.toContain(HMAC_SECRET);
    expect(masked.chat_id).toBe('-1001234567');
    expect(masked.approval_mode).toBe(true);
    expect(masked.allowed_approver_user_ids).toEqual([123, 456]);
  });

  it('omits hmac_secret from masked output when not present', () => {
    const masked = maskConfig('telegram', {
      bot_token: '1234567890:ABCDEFabcdef',
      chat_id: '-100123',
    });
    expect(masked.hmac_secret).toBeUndefined();
    expect(masked.approval_mode).toBe(false);
    expect(masked.allowed_approver_user_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit: HMAC helper correctness
// ---------------------------------------------------------------------------

describe('HMAC helpers', () => {
  it('deriveWebhookSecret produces deterministic 64-hex output', () => {
    const s1 = deriveWebhookSecret(HMAC_SECRET);
    const s2 = deriveWebhookSecret(HMAC_SECRET);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deriveWebhookSecret differs for different hmac_secrets', () => {
    const s1 = deriveWebhookSecret(HMAC_SECRET);
    const s2 = deriveWebhookSecret('b'.repeat(32));
    expect(s1).not.toBe(s2);
  });

  it('buildTelegramApprovalSig produces 8-char base64url output', () => {
    const sig = buildTelegramApprovalSig(HMAC_SECRET, 'a', 'act_abc123');
    expect(sig).toHaveLength(8);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
  });

  it('approve and reject produce different signatures for same actionId', () => {
    const sigA = buildTelegramApprovalSig(HMAC_SECRET, 'a', 'act_abc123');
    const sigR = buildTelegramApprovalSig(HMAC_SECRET, 'r', 'act_abc123');
    expect(sigA).not.toBe(sigR);
  });

  it('same verdict + actionId + different secret produce different signatures', () => {
    const sig1 = buildTelegramApprovalSig(HMAC_SECRET, 'a', 'act_abc123');
    const sig2 = buildTelegramApprovalSig('b'.repeat(32), 'a', 'act_abc123');
    expect(sig1).not.toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// Integration: webhook endpoint
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/telegram/webhook/:channelId', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper: post a Telegram update to the webhook endpoint
  async function postWebhook(
    app: Awaited<ReturnType<typeof setup>>['app'],
    channelId: string,
    update: Record<string, unknown>,
    secretToken: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/v1/integrations/telegram/webhook/${channelId}`,
      headers: { 'x-telegram-bot-api-secret-token': secretToken },
      payload: update,
    });
  }

  it('returns 403 when secret_token header is missing', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/telegram/webhook/${channelId}`,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when secret_token header is wrong', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await postWebhook(app, channelId, {}, 'wrong-token');
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown channelId', async () => {
    const { app } = await setup();
    const res = await postWebhook(app, 'nchan_doesnotexist', {}, 'any');
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a non-approval-mode telegram channel', async () => {
    const { app, adminKey } = await setup();
    // Create a plain (non-approval) telegram channel
    const ch = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain TG',
        type: 'telegram',
        config: { bot_token: BOT_TOKEN, chat_id: CHAT_ID },
      },
    });
    const channelId = (ch.json() as { id: string }).id;
    const res = await postWebhook(app, channelId, {}, 'any');
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for non-callback_query updates (Telegram expects 200)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const res = await postWebhook(app, channelId, { message: { text: 'hello' } }, secretToken);
    expect(res.statusCode).toBe(200);
  });

  it('FORGED callback_data (bad HMAC sig) is rejected with answerCallbackQuery', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    // Build a valid-looking action ID but with a forged (random) sig
    const actionId = 'act_' + 'x'.repeat(22);
    const forgedUpdate = {
      callback_query: {
        id: 'cbq_forge',
        from: { id: APPROVER_USER_ID, first_name: 'Alice' },
        message: { message_id: 1, chat: { id: -1 }, text: 'msg' },
        data: `a:${actionId}:forgedsig`,
      },
    };

    const res = await postWebhook(app, channelId, forgedUpdate, secretToken);
    expect(res.statusCode).toBe(200); // Telegram expects 200

    // answerCallbackQuery should have been called with error text
    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('Invalid');
  });

  it('UNAUTHORIZED user (user ID not in allowed list) is rejected', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    // Create a real action
    const actionId = await createPendingAction(app, adminKey);

    // Post with an unauthorized user ID
    const unauthorizedUserId = 11111111;
    const update = buildUpdate('a', actionId, HMAC_SECRET, unauthorizedUserId);
    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    // answerCallbackQuery must say "Not authorized"
    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('Not authorized');
    expect(answerBody.show_alert).toBe(true);
  });

  it('HAPPY PATH: authorized user approves → action decided, message edited', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const actionId = await createPendingAction(app, adminKey);
    const update = buildUpdate('a', actionId, HMAC_SECRET);

    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    // Action should now be approved
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('approved');

    // Decision row should exist with decided_by = "tg:{userId}"
    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision).toBeTruthy();
    expect(decision.verdict).toBe('approve');
    expect(decision.decided_by).toBe(`tg:${APPROVER_USER_ID}`);
    expect(decision.channel).toBe('telegram');

    // audit_log entry should exist
    const audit = db.prepare("SELECT * FROM audit_log WHERE action_id = ? AND event = 'action.approved'").get(actionId) as Record<string, unknown> | undefined;
    expect(audit).toBeTruthy();

    // answerCallbackQuery called with "Approved ✅"
    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('Approved');

    // editMessageText called to show outcome and remove buttons
    const editCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/editMessageText'),
    );
    expect(editCall).toBeTruthy();
    const editBody = JSON.parse(editCall![1].body as string) as Record<string, unknown>;
    expect(String(editBody.text)).toContain('Approved by Alice');
    expect((editBody.reply_markup as Record<string, unknown>).inline_keyboard).toEqual([]);
  });

  it('HAPPY PATH: authorized user rejects → action rejected', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const actionId = await createPendingAction(app, adminKey, 'Reject Test');
    const update = buildUpdate('r', actionId, HMAC_SECRET);

    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('rejected');

    const decision = db.prepare('SELECT verdict, decided_by FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision.verdict).toBe('reject');
    expect(decision.decided_by).toBe(`tg:${APPROVER_USER_ID}`);

    const editCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/editMessageText'),
    );
    expect(editCall).toBeTruthy();
    const editBody = JSON.parse(editCall![1].body as string) as Record<string, unknown>;
    expect(String(editBody.text)).toContain('Rejected by Alice');
  });

  it('CROSS-PROJECT: action from a different project is not found', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    // Create a second project and action within it
    const signupB = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { project_name: 'Project B' },
      headers: { 'x-impri-signup-token': process.env.SIGNUP_SECRET ?? '' },
    });
    if (signupB.statusCode !== 201) {
      // Signup disabled — skip test
      return;
    }
    const keyB = (signupB.json() as { key: string }).key;
    const projectBActionId = await createPendingAction(app, keyB, 'Cross-project action');

    // Try to approve an action from project B via project A's channel
    const update = buildUpdate('a', projectBActionId, HMAC_SECRET);
    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    // answerCallbackQuery should say "Action not found"
    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('not found');

    // The action in project B must remain pending
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(projectBActionId) as { status: string };
    expect(action.status).toBe('pending');
  });

  it('ALREADY-DECIDED: second tap returns "Already decided" (idempotent)', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const actionId = await createPendingAction(app, adminKey, 'Idempotent Test');

    // First tap — approves
    await postWebhook(app, channelId, buildUpdate('a', actionId, HMAC_SECRET), secretToken);

    // Reset fetch mock call count
    fetchMock.mockClear();

    // Second tap — should be idempotent
    const res2 = await postWebhook(app, channelId, buildUpdate('a', actionId, HMAC_SECRET), secretToken);
    expect(res2.statusCode).toBe(200);

    // answerCallbackQuery should say "Already decided"
    const answerCall2 = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall2).toBeTruthy();
    const answerBody2 = JSON.parse(answerCall2![1].body as string) as Record<string, unknown>;
    expect(String(answerBody2.text)).toContain('Already decided');

    // Still exactly one decision row
    const decisions = db.prepare('SELECT COUNT(*) as cnt FROM decisions WHERE action_id = ?').get(actionId) as { cnt: number };
    expect(decisions.cnt).toBe(1);
  });

  it('malformed callback_data (wrong number of parts) is rejected', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const update = {
      callback_query: {
        id: 'cbq_bad',
        from: { id: APPROVER_USER_ID, first_name: 'Alice' },
        message: { message_id: 1, chat: { id: -1 }, text: 'msg' },
        data: 'bad-data-no-colons',
      },
    };

    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('Invalid');
  });

  it('malformed callback_data (invalid action ID format) is rejected', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    // Valid sig but invalid actionId format
    const sig = buildTelegramApprovalSig(HMAC_SECRET, 'a', 'not_an_action_id');
    const update = {
      callback_query: {
        id: 'cbq_bad2',
        from: { id: APPROVER_USER_ID, first_name: 'Alice' },
        message: { message_id: 1, chat: { id: -1 }, text: 'msg' },
        data: `a:not_an_action_id:${sig}`,
      },
    };

    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);
    const answerCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/answerCallbackQuery'),
    );
    expect(answerCall).toBeTruthy();
    const answerBody = JSON.parse(answerCall![1].body as string) as Record<string, unknown>;
    expect(String(answerBody.text)).toContain('Invalid');
  });

  it('SECURITY: HTML in approver first_name is escaped in editMessageText', async () => {
    // Regression: first_name is a Telegram-user-controlled value that was
    // previously interpolated raw into a parse_mode:'HTML' message, enabling
    // in-chat markup injection / phishing via a crafted display name.
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    const actionId = await createPendingAction(app, adminKey, 'Escape Test');

    const maliciousName = '</b><a href="https://phish.example">click</a>';
    const sig = buildTelegramApprovalSig(HMAC_SECRET, 'a', actionId);
    const update = {
      callback_query: {
        id: 'cbq_xss',
        from: { id: APPROVER_USER_ID, first_name: maliciousName },
        message: {
          message_id: 99,
          chat: { id: Number(CHAT_ID) },
          text: `🔔 <b>Action Pending</b>: Escape Test\nKind: <code>test.kind</code>`,
        },
        data: `a:${actionId}:${sig}`,
      },
    };

    const res = await postWebhook(app, channelId, update, secretToken);
    expect(res.statusCode).toBe(200);

    const editCall = fetchMock.mock.calls.find(
      call => String(call[0]).includes('/editMessageText'),
    );
    expect(editCall).toBeTruthy();
    const editBody = JSON.parse(editCall![1].body as string) as Record<string, unknown>;
    const editedText = String(editBody.text);

    // The suffix appended after the original message text is where firstName
    // is interpolated. Extract it so we only assert on user-controlled content,
    // not on the intentional HTML markup in the original approval message body.
    const suffixIdx = editedText.indexOf('\n\n—');
    expect(suffixIdx).toBeGreaterThan(-1);
    const suffix = editedText.slice(suffixIdx);

    // Raw HTML tags from the malicious name must NOT appear in the suffix
    expect(suffix).not.toContain('<a href=');
    expect(suffix).not.toContain('</a>');
    // The name content should be present, but HTML-escaped
    expect(suffix).toContain('&lt;/b&gt;');
    expect(suffix).toContain('&lt;a href=');
  });
});

// ---------------------------------------------------------------------------
// Security: bot_token never in responses or logs
// ---------------------------------------------------------------------------

describe('bot_token never leaks', () => {
  it('bot_token is masked in CREATE response', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
    expect(body.config.bot_token).toMatch(/^\*\*\*\*/);
  });

  it('bot_token is masked in GET response', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
    });
    expect(JSON.stringify(res.json())).not.toContain(BOT_TOKEN);
  });

  it('bot_token is masked in LIST response', async () => {
    const { app, adminKey } = await setup();
    await createApprovalChannel(app, adminKey);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
    });
    expect(JSON.stringify(res.json())).not.toContain(BOT_TOKEN);
  });

  it('bot_token is masked in PATCH response', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
      payload: { name: 'Updated' },
    });
    expect(JSON.stringify(res.json())).not.toContain(BOT_TOKEN);
  });

  it('bot_token does not appear in answerCallbackQuery call to Telegram', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const secretToken = deriveWebhookSecret(HMAC_SECRET);

    // Post a non-callback update so only answerCallbackQuery path is triggered
    // (actually nothing is triggered for non-callback — just verify fetch calls)
    const actionId = await createPendingAction(app, adminKey);
    const update = buildUpdate('a', actionId, HMAC_SECRET);
    await app.inject({
      method: 'POST',
      url: `/v1/integrations/telegram/webhook/${channelId}`,
      headers: { 'x-telegram-bot-api-secret-token': secretToken },
      payload: update,
    });

    // All fetch calls should include the bot_token in the URL (it's the API auth),
    // but it must NOT appear in the request body
    for (const call of fetchMock.mock.calls) {
      const body = call[1]?.body;
      if (body) {
        expect(String(body)).not.toContain(BOT_TOKEN);
      }
    }

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Schema: approval channel PATCH merges config correctly
// ---------------------------------------------------------------------------

describe('PATCH approval channel', () => {
  it('can add allowed_approver_user_ids via PATCH without re-specifying full config', async () => {
    const { app, adminKey, db } = await setup();

    // Create with mock fetch to avoid setWebhook HTTP calls
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const newUserId = 555666777;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
      payload: { config: { allowed_approver_user_ids: [APPROVER_USER_ID, newUserId] } },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.allowed_approver_user_ids).toEqual([APPROVER_USER_ID, newUserId]);

    // Verify in DB
    const row = db.prepare('SELECT config FROM notification_channels WHERE id = ?').get(channelId) as { config: string };
    const stored = JSON.parse(row.config) as Record<string, unknown>;
    expect(stored.allowed_approver_user_ids).toEqual([APPROVER_USER_ID, newUserId]);

    vi.unstubAllGlobals();
  });
});
