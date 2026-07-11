/**
 * Discord interactive approval — server-side tests.
 *
 * Covers:
 *  - DiscordConfig schema: new approval fields validated, superRefine errors
 *    when approval_mode=true and required fields missing
 *  - hmac_secret auto-generated when omitted for discord approval-mode channel
 *  - maskConfig: new discord fields handled correctly; bot_token/public_key
 *    never leaked; non-approval-mode returns plain { url: masked }
 *  - buildDiscordApprovalSig: deterministic 8-char base64url output
 *  - POST /v1/integrations/discord/interactions/:channelId:
 *    - BAD Ed25519 signature → 401 "invalid request signature"
 *    - Missing signature headers → 401
 *    - PING (type 1) + valid signature → 200 {"type":1} (PONG)
 *    - Non-MESSAGE_COMPONENT → 200 {"type":1}
 *    - Malformed custom_id → 200 ephemeral "Invalid or expired"
 *    - Forged button HMAC → 200 ephemeral "Invalid or expired"
 *    - UNAUTHORIZED user → 200 ephemeral "Not authorized"
 *    - HAPPY PATH approve → action approved, UPDATE_MESSAGE response
 *    - HAPPY PATH reject → action rejected
 *    - CROSS-PROJECT action → 200 ephemeral "Action not found"
 *    - ALREADY-DECIDED → 200 ephemeral "Already decided" (idempotent)
 *    - Secrets never in API responses (bot_token, public_key masked)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createHmac } from 'node:crypto';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import {
  maskConfig,
  buildDiscordApprovalSig,
} from '../src/notify.js';

// Prevent watcher scheduler from spawning background timers in tests.
process.env.DISABLE_WATCHER_SCHEDULER = '1';

// ---------------------------------------------------------------------------
// Ed25519 key pair — generated once for the entire test module.
// ---------------------------------------------------------------------------

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY_OBJ } = generateKeyPairSync('ed25519');

// Get the 64-char hex public key (raw 32-byte Ed25519 key)
const TEST_PUBLIC_KEY_HEX = (() => {
  const jwk = TEST_PUBLIC_KEY_OBJ.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('hex');
})();

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_TOKEN       = 'MTESTestBotToken.Example';
const APP_ID         = '123456789012345678';
const CHANNEL_ID_DC  = '987654321098765432';
const HMAC_SECRET_DC = 'b'.repeat(32); // 32 deterministic chars
const APPROVER_USER  = '111222333444555666';

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

/**
 * Sign a Discord interaction request with the test Ed25519 private key.
 * Returns the signature headers required by the Discord endpoint.
 */
function signDiscord(
  rawBody: string,
  tsOverride?: string,
): { 'x-signature-ed25519': string; 'x-signature-timestamp': string } {
  const ts = tsOverride ?? String(Math.floor(Date.now() / 1000));
  const msg = Buffer.concat([Buffer.from(ts, 'utf-8'), Buffer.from(rawBody, 'utf-8')]);
  const sig = nodeSign(null, msg, TEST_PRIVATE_KEY);
  return {
    'x-signature-ed25519': sig.toString('hex'),
    'x-signature-timestamp': ts,
  };
}

/** Create an approval-mode Discord channel and return its id. */
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
      name: 'Discord Approvals',
      type: 'discord',
      config: {
        bot_token: BOT_TOKEN,
        application_id: APP_ID,
        public_key: TEST_PUBLIC_KEY_HEX,
        channel_id: CHANNEL_ID_DC,
        hmac_secret: HMAC_SECRET_DC,
        approval_mode: true,
        allowed_approver_discord_user_ids: [APPROVER_USER],
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

/** Build a Discord interaction JSON body. */
function buildDiscordInteraction(options: {
  type: number;
  customId?: string;
  userId?: string;
  guildMember?: boolean; // true → member.user.id, false → user.id
}): string {
  const { type, customId, userId = APPROVER_USER, guildMember = true } = options;

  const userObj = { id: userId, username: 'testuser' };
  const data = customId !== undefined ? { custom_id: customId, component_type: 2 } : undefined;
  const member = guildMember ? { user: userObj } : undefined;
  const user = guildMember ? undefined : userObj;

  return JSON.stringify({
    type,
    ...(data ? { data } : {}),
    ...(member ? { member } : {}),
    ...(user ? { user } : {}),
  });
}

/** POST an interaction to the Discord endpoint. */
async function postInteraction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  channelId: string,
  rawBody: string,
  sigOverride?: { 'x-signature-ed25519': string; 'x-signature-timestamp': string },
) {
  return app.inject({
    method: 'POST',
    url: `/v1/integrations/discord/interactions/${channelId}`,
    headers: {
      'content-type': 'application/json',
      ...(sigOverride ?? signDiscord(rawBody)),
    },
    payload: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Unit: DiscordConfig schema
// ---------------------------------------------------------------------------

describe('DiscordConfig schema', () => {
  it('accepts plain (non-approval) discord channel with just url', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Plain Discord',
        type: 'discord',
        config: { url: 'https://discord.com/api/webhooks/123456/xxxxxxxxxxxxxxxxxxx' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().config.url).toMatch(/^\*\*\*\*/);
  });

  it('accepts full approval-mode config', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const cfg = res.json().config as Record<string, unknown>;
    expect(cfg.approval_mode).toBe(true);
    expect(cfg.bot_token).toMatch(/^\*\*\*\*/);
    expect(cfg.public_key).toMatch(/^\*\*\*\*/);
    expect(cfg.hmac_secret).toMatch(/^\*\*\*\*/);
    expect(cfg.allowed_approver_discord_user_ids).toEqual([APPROVER_USER]);
  });

  it('rejects approval_mode=true with missing bot_token', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, { bot_token: undefined });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('bot_token');
  });

  it('rejects approval_mode=true with missing public_key', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, { public_key: undefined });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('public_key');
  });

  it('rejects approval_mode=true with missing channel_id', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, { channel_id: undefined });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('channel_id');
  });

  it('rejects approval_mode=true with empty allowed_approver_discord_user_ids', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      allowed_approver_discord_user_ids: [],
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
        name: 'Bad Discord',
        type: 'discord',
        config: { approval_mode: false },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid public_key format (not 64 hex chars)', async () => {
    const { app, adminKey } = await setup();
    const res = await createApprovalChannel(app, adminKey, {
      public_key: 'notahexkey',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('public_key');
  });

  it('rejects more than 50 allowed_approver_discord_user_ids', async () => {
    const { app, adminKey } = await setup();
    const tooMany = Array.from({ length: 51 }, (_, i) => String(i + 1000000000));
    const res = await createApprovalChannel(app, adminKey, {
      allowed_approver_discord_user_ids: tooMany,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit: hmac_secret auto-generation for discord
// ---------------------------------------------------------------------------

describe('hmac_secret auto-generation for discord', () => {
  it('auto-generates hmac_secret when omitted and approval_mode=true', async () => {
    const { app, adminKey, db } = await setup();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/notification-channels',
      headers: auth(adminKey),
      payload: {
        name: 'Auto-secret Discord',
        type: 'discord',
        config: {
          bot_token: BOT_TOKEN,
          application_id: APP_ID,
          public_key: TEST_PUBLIC_KEY_HEX,
          channel_id: CHANNEL_ID_DC,
          approval_mode: true,
          allowed_approver_discord_user_ids: [APPROVER_USER],
          // hmac_secret intentionally omitted
        },
      },
    });
    expect(res.statusCode).toBe(201);
    // Response shows masked secret
    expect(res.json().config.hmac_secret).toMatch(/^\*\*\*\*/);

    // DB stores the actual generated secret (64 hex chars = 32 random bytes)
    const row = db.prepare('SELECT config FROM notification_channels WHERE id = ?').get(
      res.json().id,
    ) as { config: string };
    const stored = JSON.parse(row.config) as Record<string, unknown>;
    expect(typeof stored.hmac_secret).toBe('string');
    expect((stored.hmac_secret as string).length).toBe(64);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Unit: maskConfig — discord approval mode
// ---------------------------------------------------------------------------

describe('maskConfig — discord approval fields', () => {
  it('masks bot_token and public_key and hmac_secret, returns others as-is', () => {
    const masked = maskConfig('discord', {
      bot_token: BOT_TOKEN,
      application_id: APP_ID,
      public_key: TEST_PUBLIC_KEY_HEX,
      channel_id: CHANNEL_ID_DC,
      hmac_secret: HMAC_SECRET_DC,
      approval_mode: true,
      allowed_approver_discord_user_ids: [APPROVER_USER],
    });
    expect(masked.bot_token).toMatch(/^\*\*\*\*/);
    expect(String(masked.bot_token)).not.toContain(BOT_TOKEN);
    expect(masked.public_key).toMatch(/^\*\*\*\*/);
    expect(String(masked.public_key)).not.toContain(TEST_PUBLIC_KEY_HEX);
    expect(masked.hmac_secret).toMatch(/^\*\*\*\*/);
    expect(masked.application_id).toBe(APP_ID);
    expect(masked.channel_id).toBe(CHANNEL_ID_DC);
    expect(masked.approval_mode).toBe(true);
    expect(masked.allowed_approver_discord_user_ids).toEqual([APPROVER_USER]);
  });

  it('omits hmac_secret from masked output when not present', () => {
    const masked = maskConfig('discord', {
      bot_token: BOT_TOKEN,
      approval_mode: true,
      allowed_approver_discord_user_ids: [],
    });
    expect(masked.hmac_secret).toBeUndefined();
  });

  it('returns plain { url: masked } when approval_mode is false/absent', () => {
    const masked = maskConfig('discord', { url: 'https://discord.com/api/webhooks/123/secret' });
    expect(masked.url).toMatch(/^\*\*\*\*/);
    expect(masked.bot_token).toBeUndefined();
    expect(masked.approval_mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: buildDiscordApprovalSig
// ---------------------------------------------------------------------------

describe('buildDiscordApprovalSig', () => {
  it('produces deterministic 8-char base64url output', () => {
    const s1 = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', 'act_abc123');
    const s2 = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', 'act_abc123');
    expect(s1).toBe(s2);
    expect(s1).toHaveLength(8);
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('approve and reject produce different signatures', () => {
    const sigA = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', 'act_abc123');
    const sigR = buildDiscordApprovalSig(HMAC_SECRET_DC, 'r', 'act_abc123');
    expect(sigA).not.toBe(sigR);
  });

  it('dc: prefix prevents cross-platform reuse', () => {
    // Verify the prefix is in the HMAC input by building the same input without prefix.
    // A signature over "a:act_abc123" (no prefix) must differ from "dc:a:act_abc123".
    const sigDc = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', 'act_abc123');
    const noPrefix = createHmac('sha256', HMAC_SECRET_DC)
      .update('a:act_abc123').digest().subarray(0, 6).toString('base64url');
    expect(sigDc).not.toBe(noPrefix);
  });
});

// ---------------------------------------------------------------------------
// Integration: /v1/integrations/discord/interactions/:channelId
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/discord/interactions/:channelId', () => {
  beforeEach(() => {
    const fetchMock = vi.fn().mockResolvedValue({
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

  it('returns 401 "invalid request signature" when Ed25519 signature headers are missing', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({ type: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/discord/interactions/${channelId}`,
      headers: { 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('invalid request signature');
  });

  it('returns 401 when Ed25519 signature is incorrect', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({ type: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/discord/interactions/${channelId}`,
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': 'a'.repeat(128), // 64 bytes but wrong
        'x-signature-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('invalid request signature');
  });

  it('PING (type 1) + valid signature → 200 {"type":1} (PONG)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({ type: 1 });
    const res = await postInteraction(app, channelId, rawBody);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { type: number }).type).toBe(1);
  });

  it('returns 401 when signature timestamp is stale (>5 min old)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({ type: 1 });
    // 6 minutes in the past — outside the 5-min replay window
    const staleTs = String(Math.floor(Date.now() / 1000) - 360);
    const res = await postInteraction(app, channelId, rawBody, signDiscord(rawBody, staleTs));

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('invalid request signature');
  });

  it('returns 401 for PING with wrong signature (Ed25519 check MUST run on PING)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({ type: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integrations/discord/interactions/${channelId}`,
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': 'b'.repeat(128),
        'x-signature-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('non-MESSAGE_COMPONENT interaction type → 200 (ignored)', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    // type 2 = APPLICATION_COMMAND (not handled)
    const rawBody = buildDiscordInteraction({ type: 2 });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
  });

  it('Malformed custom_id → 200 ephemeral "Invalid or expired"', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: 'bad-format',
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(body.data.flags).toBe(64); // ephemeral
    expect(body.data.content).toContain('Invalid');
  });

  it('FORGED button HMAC (wrong sig) → 200 ephemeral "Invalid or expired"', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${actionId}:aaaaaaaa`, // wrong 8-char sig
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('Invalid');
  });

  it('UNAUTHORIZED user → 200 ephemeral "Not authorized"', async () => {
    const { app, adminKey } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey);

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', actionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${actionId}:${sig}`,
      userId: '999999999999999999', // not in allowed list
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('Not authorized');
  });

  it('HAPPY PATH: authorized user approves (guild member) → action approved, UPDATE_MESSAGE', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Discord Approve Test');

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', actionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${actionId}:${sig}`,
      userId: APPROVER_USER,
      guildMember: true,
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    // Response should be UPDATE_MESSAGE (type 7) with no buttons
    const body = res.json() as {
      type: number;
      data: { embeds: Array<{ title: string; color: number }>; components: unknown[] };
    };
    expect(body.type).toBe(7);
    expect(body.data.components).toEqual([]);
    expect(body.data.embeds[0].title).toContain('Approved');

    // Action should now be approved
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('approved');

    // Decision row should exist with decided_by = "dc:{userId}"
    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision).toBeTruthy();
    expect(decision.verdict).toBe('approve');
    expect(decision.decided_by).toBe(`dc:${APPROVER_USER}`);
    expect(decision.channel).toBe('discord');

    // audit_log entry should exist
    const audit = db.prepare(
      "SELECT * FROM audit_log WHERE action_id = ? AND event = 'action.approved'",
    ).get(actionId) as Record<string, unknown> | undefined;
    expect(audit).toBeTruthy();
    expect(audit!.channel).toBe('discord');
  });

  it('HAPPY PATH: authorized user rejects → action rejected, UPDATE_MESSAGE', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Discord Reject Test');

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'r', actionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `r:${actionId}:${sig}`,
      userId: APPROVER_USER,
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      type: number;
      data: { embeds: Array<{ title: string }>; components: unknown[] };
    };
    expect(body.type).toBe(7);
    expect(body.data.embeds[0].title).toContain('Rejected');
    expect(body.data.components).toEqual([]);

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('rejected');

    const decision = db.prepare('SELECT verdict, decided_by FROM decisions WHERE action_id = ?').get(actionId) as Record<string, unknown>;
    expect(decision.verdict).toBe('reject');
    expect(decision.decided_by).toBe(`dc:${APPROVER_USER}`);
  });

  it('HAPPY PATH: user.id used when member.user.id not present (DM interaction)', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Discord DM Test');

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', actionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${actionId}:${sig}`,
      userId: APPROVER_USER,
      guildMember: false, // DM-style: uses user.id, not member.user.id
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string };
    expect(action.status).toBe('approved');
  });

  it('CROSS-PROJECT: action from a different project is not found', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    // Create a second project and action within it
    const signupB = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { project_name: 'Discord Project B' },
      headers: { 'x-impri-signup-token': process.env.SIGNUP_SECRET ?? '' },
    });
    if (signupB.statusCode !== 201) {
      // Signup disabled — skip cross-project test
      return;
    }
    const keyB = (signupB.json() as { key: string }).key;
    const projectBActionId = await createPendingAction(app, keyB, 'Cross-project discord action');

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', projectBActionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${projectBActionId}:${sig}`,
      userId: APPROVER_USER,
    });
    const res = await postInteraction(app, channelId, rawBody);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { type: number; data: { content: string } };
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('not found');

    // The action in project B must remain pending
    const action = db.prepare('SELECT status FROM actions WHERE id = ?').get(projectBActionId) as { status: string };
    expect(action.status).toBe('pending');
  });

  it('ALREADY-DECIDED: second interaction returns "Already decided" (idempotent)', async () => {
    const { app, adminKey, db } = await setup();
    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;
    const actionId = await createPendingAction(app, adminKey, 'Discord Idempotent Test');

    const sig = buildDiscordApprovalSig(HMAC_SECRET_DC, 'a', actionId);
    const rawBody = buildDiscordInteraction({
      type: 3,
      customId: `a:${actionId}:${sig}`,
      userId: APPROVER_USER,
    });

    // First interaction — approves
    await postInteraction(app, channelId, rawBody);

    // Second interaction — should be idempotent
    const res2 = await postInteraction(app, channelId, rawBody);
    expect(res2.statusCode).toBe(200);

    const body2 = res2.json() as { type: number; data: { content: string; flags: number } };
    expect(body2.data.content).toContain('Already decided');
    expect(body2.data.flags).toBe(64); // ephemeral

    // Still exactly one decision row
    const decisions = db.prepare('SELECT COUNT(*) as cnt FROM decisions WHERE action_id = ?').get(actionId) as { cnt: number };
    expect(decisions.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Security: secrets never in API responses
// ---------------------------------------------------------------------------

describe('Discord secrets never leak', () => {
  it('bot_token and public_key and hmac_secret are masked in CREATE response', async () => {
    const { app, adminKey } = await setup();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await createApprovalChannel(app, adminKey);
    expect(res.statusCode).toBe(201);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(TEST_PUBLIC_KEY_HEX);
    expect(body).not.toContain(HMAC_SECRET_DC);
    expect(res.json().config.bot_token).toMatch(/^\*\*\*\*/);
    expect(res.json().config.public_key).toMatch(/^\*\*\*\*/);
    expect(res.json().config.hmac_secret).toMatch(/^\*\*\*\*/);

    vi.unstubAllGlobals();
  });

  it('secrets are masked in GET response', async () => {
    const { app, adminKey } = await setup();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const ch = await createApprovalChannel(app, adminKey);
    const channelId = (ch.json() as { id: string }).id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/notification-channels/${channelId}`,
      headers: auth(adminKey),
    });
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(BOT_TOKEN);
    expect(body).not.toContain(TEST_PUBLIC_KEY_HEX);
    expect(body).not.toContain(HMAC_SECRET_DC);

    vi.unstubAllGlobals();
  });
});
