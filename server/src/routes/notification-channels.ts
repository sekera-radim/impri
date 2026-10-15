import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import {
  maskConfig,
  dispatchChannelType,
  deriveWebhookSecret,
  isPublicBaseUrl,
  emailDeliveryConfigured,
  htmlEscape,
  EMAIL_NOT_CONFIGURED_MESSAGE,
} from '../notify.js';
import { fetchGuarded } from '../net-guard.js';
import { deleteEmailSend, normalizeEmailAddress, reserveNotifyEmail } from '../email-sends.js';
import {
  sendChannelVerification,
  queueChannelVerification,
  resetChannelVerification,
  verificationFailureMessage,
  inspectVerifyToken,
  confirmVerifyToken,
  type QueuedVerification,
  type TokenState,
} from '../email-verification.js';
import {
  SlackConfig,
  DiscordConfig,
  TelegramConfig,
  NtfyConfig,
  EmailConfig,
  WebhookConfig,
  CreateChannelBody,
  UpdateChannelBody,
} from '../schemas.js';

// Map channel type → Zod schema for type-specific config validation.
const CONFIG_SCHEMA: Record<string, ZodTypeAny> = {
  slack:    SlackConfig,
  discord:  DiscordConfig,
  telegram: TelegramConfig,
  ntfy:     NtfyConfig,
  email:    EmailConfig,
  webhook:  WebhookConfig,
};

function validateConfig(type: string, raw: Record<string, unknown>) {
  const schema = CONFIG_SCHEMA[type];
  if (!schema) return { success: false as const, error: { issues: [{ message: `Unknown channel type: ${type}` }] } };
  return schema.safeParse(raw);
}

interface ChannelRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  enabled: number;
  config: string;
  digest_window_sec: number;
  last_fired_at: number | null;
  digest_queue: string;
  fail_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  verified_at: number | null;
  verify_token_hash: string | null;
  verify_sent_at: number | null;
}

// Serialize a DB row to the API response shape: masked config, boolean enabled,
// no digest_queue or verify_token_hash (internal implementation details).
// `verified` is always true for non-email types: only email addresses need
// confirming before delivery.
function serializeChannel(channel: ChannelRow) {
  const rawConfig = JSON.parse(channel.config) as Record<string, unknown>;
  const isEmail = channel.type === 'email';
  return {
    id: channel.id,
    project_id: channel.project_id,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled === 1,
    verified: !isEmail || channel.verified_at !== null,
    verified_at: isEmail ? channel.verified_at ?? undefined : undefined,
    verification_sent_at: isEmail ? channel.verify_sent_at ?? undefined : undefined,
    digest_window_sec: channel.digest_window_sec,
    config: maskConfig(channel.type, rawConfig),
    last_fired_at: channel.last_fired_at ?? undefined,
    fail_count: channel.fail_count,
    last_error: channel.last_error ?? undefined,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  };
}

// Extra response fields after a create/update that triggered a confirmation
// email. "Queued" is all the response can promise: the SMTP call runs after it.
function verificationFields(result: QueuedVerification) {
  return result.queued
    ? { verification_queued: true }
    : { verification_queued: false, verification_error: verificationFailureMessage(result.reason) };
}

function loadChannel(db: Db, id: string): ChannelRow {
  return db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as ChannelRow;
}

// ---------------------------------------------------------------------------
// Public confirmation page (GET shows a button, POST confirms)
// ---------------------------------------------------------------------------

// 32 random bytes, base64url without padding.
const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// The page carries the token, so: no caching, no referrer, no framing, no
// script; the form may only post back to this origin.
const VERIFY_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function sendVerifyPage(reply: FastifyReply, status: number, heading: string, bodyHtml: string) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${htmlEscape(heading)} · Impri</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e8e8ea;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:440px;margin:24px 16px;padding:32px;background:#181b22;border-radius:12px}
h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 16px;color:#b8bcc6}
button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:8px;background:#7c5cff;color:#fff;cursor:pointer}
a{color:#a996ff}
</style>
</head>
<body><main><h1>${htmlEscape(heading)}</h1>${bodyHtml}</main></body>
</html>`;
  return reply
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Security-Policy', VERIFY_PAGE_CSP)
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .send(html);
}

const RESEND_HINT =
  '<p>You can request a new confirmation email in Impri under Settings &gt; Notifications.</p>';

function sendTokenProblemPage(reply: FastifyReply, state: Exclude<TokenState, 'valid'>) {
  if (state === 'expired') {
    return sendVerifyPage(reply, 410, 'This link has expired', `<p>Confirmation links are valid for 7 days.</p>${RESEND_HINT}`);
  }
  return sendVerifyPage(
    reply,
    404,
    'This link is not valid',
    `<p>It may have been used already — if you confirmed this address before, you're all set.</p>${RESEND_HINT}`,
  );
}

function clientIp(request: FastifyRequest): string {
  // Same order as signup/recovery: Fly sets fly-client-ip, clients cannot override it.
  return (
    (request.headers['fly-client-ip'] as string | undefined) ??
    (request.headers['cf-connecting-ip'] as string | undefined) ??
    request.ip ??
    'unknown'
  );
}

// The form posts application/x-www-form-urlencoded; its parser in index.ts
// keeps the raw string (Slack signature needs it) and leaves body empty.
function tokenFromBody(request: FastifyRequest): string {
  if (typeof request.rawSlackBody === 'string') {
    return new URLSearchParams(request.rawSlackBody).get('token') ?? '';
  }
  const body = request.body as { token?: unknown } | undefined;
  return typeof body?.token === 'string' ? body.token : '';
}

// Strip secret config values from an error message before returning to callers.
// Mirrors the sanitizeError helper in notify.ts but applied at the route layer.
function sanitizeErrorMsg(msg: string, config: Record<string, unknown>): string {
  let result = msg;
  for (const val of Object.values(config)) {
    if (typeof val === 'string' && val.length >= 8) {
      result = result.split(val).join('[redacted]');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Telegram webhook registration helpers
// ---------------------------------------------------------------------------

/**
 * Register (or update) the Telegram webhook for an approval-mode channel.
 * Skipped when BASE_URL is absent, localhost, or an RFC1918 address — in
 * those cases the operator must call setup-webhook after configuring a tunnel.
 * Errors are logged as warnings; the channel CRUD operation is not affected.
 */
async function callSetWebhook(
  botToken: string,
  channelId: string,
  hmacSecret: string,
): Promise<void> {
  const bUrl = process.env.BASE_URL;
  if (!isPublicBaseUrl(bUrl)) return;

  const webhookUrl = `${bUrl!}/v1/integrations/telegram/webhook/${channelId}`;
  const secretToken = deriveWebhookSecret(hmacSecret);

  try {
    const res = await fetchGuarded(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['callback_query'],
        drop_pending_updates: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json() as { ok?: boolean };
    console.log('[telegram-approval] setWebhook', { channelId, url: webhookUrl, ok: json.ok ?? false });
  } catch (err) {
    // Warn but do not rethrow — channel creation/update must succeed regardless.
    console.warn('[telegram-approval] setWebhook failed (register manually via setup-webhook)', {
      channelId,
      error: err instanceof Error ? err.message.replace(botToken, '[redacted]') : String(err),
    });
  }
}

/**
 * Deregister the Telegram webhook for the given bot token.
 * Best-effort — errors only logged.
 */
async function callDeleteWebhook(botToken: string, channelId: string): Promise<void> {
  try {
    await fetchGuarded(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    console.log('[telegram-approval] deleteWebhook', { channelId });
  } catch (err) {
    console.warn('[telegram-approval] deleteWebhook failed', {
      channelId,
      error: err instanceof Error ? err.message.replace(botToken, '[redacted]') : String(err),
    });
  }
}

export function registerNotificationChannelRoutes(app: FastifyInstance, db: Db): void {
  // GET /v1/notification-channels
  // List all channels for the calling project. Config masked.
  app.get('/v1/notification-channels', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:read', 120))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 120 requests/min per key' });
    }

    const rows = db.prepare(
      'SELECT * FROM notification_channels WHERE project_id = ? ORDER BY created_at ASC',
    ).all(key.projectId) as ChannelRow[];

    return { items: rows.map(serializeChannel) };
  });

  // POST /v1/notification-channels
  // Create a channel. Config validated by type-specific Zod schema. 201 on success.
  app.post('/v1/notification-channels', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:write', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    const parsed = CreateChannelBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    if (body.type === 'email' && !emailDeliveryConfigured()) {
      return reply.status(400).send({ error: 'Bad Request', message: EMAIL_NOT_CONFIGURED_MESSAGE });
    }

    // For telegram and discord approval-mode channels, auto-generate hmac_secret
    // when the operator omits it. Inject BEFORE Zod validation so the schema's
    // min(16) constraint is satisfied and the generated secret is stored.
    let channelConfig = body.config as Record<string, unknown>;
    if (
      (body.type === 'telegram' || body.type === 'discord') &&
      channelConfig.approval_mode === true &&
      !channelConfig.hmac_secret
    ) {
      channelConfig = { ...channelConfig, hmac_secret: randomBytes(32).toString('hex') };
    }

    const configValidation = validateConfig(body.type, channelConfig);
    if (!configValidation.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid config for channel type',
        issues: configValidation.error.issues,
      });
    }
    // Use the Zod-parsed (and defaulted) config so defaults (approval_mode: false etc.) are persisted.
    channelConfig = configValidation.data as Record<string, unknown>;

    const id = genId('nchan_');
    const now = nowSec();

    db.prepare(`
      INSERT INTO notification_channels
        (id, project_id, name, type, enabled, config, digest_window_sec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key.projectId,
      body.name,
      body.type,
      body.enabled ? 1 : 0,
      JSON.stringify(channelConfig),
      body.digest_window_sec,
      now,
      now,
    );

    // Audit log records channel identity only — no config content (no secrets).
    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.created', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ channel_id: id, type: body.type }), now);

    // Email: the address must be confirmed before anything else is sent to it.
    // A failed or rate-limited confirmation does not fail the create — the
    // channel exists, the response says why no email went out, and the owner
    // can retry with resend-verification.
    const verification = body.type === 'email'
      ? queueChannelVerification(db, id, key.keyId, request.log)
      : null;

    const created = loadChannel(db, id);

    // Register Telegram webhook when approval_mode is enabled and the channel
    // is enabled. Fire-and-forget — failure is logged but does not fail the
    // request. Operator can re-trigger via POST /v1/notification-channels/:id/setup-webhook.
    if (body.type === 'telegram' && channelConfig.approval_mode === true && body.enabled) {
      callSetWebhook(
        String(channelConfig.bot_token),
        id,
        String(channelConfig.hmac_secret),
      ).catch(() => {});
    }

    reply.status(201);
    return verification
      ? { ...serializeChannel(created), ...verificationFields(verification) }
      : serializeChannel(created);
  });

  // GET /v1/notification-channels/:id
  // Single channel, project-scoped. 404 if not found or wrong project.
  app.get<{ Params: { id: string } }>('/v1/notification-channels/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:read', 120))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 120 requests/min per key' });
    }

    const channel = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as ChannelRow | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });

    return serializeChannel(channel);
  });

  // PATCH /v1/notification-channels/:id
  // Partial update. Config fields are shallowly merged; merged config is re-validated.
  // Resetting fail_count to 0 when config changes gives a freshly-edited channel
  // a clean slate.
  app.patch<{ Params: { id: string } }>('/v1/notification-channels/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:write', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    const parsed = UpdateChannelBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const channel = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as ChannelRow | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });

    // Shallow merge: provided config fields override existing ones; omitted
    // fields are preserved. Use a new channel creation to fully replace config.
    const previousConfig = JSON.parse(channel.config) as Record<string, unknown>;
    let mergedConfig = previousConfig;
    let configChanged = false;
    if (body.config !== undefined) {
      mergedConfig = { ...mergedConfig, ...(body.config as Record<string, unknown>) };
      const cv = validateConfig(channel.type, mergedConfig);
      if (!cv.success) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid config', issues: cv.error.issues });
      }
      configChanged = true;
    }

    // A different email address is a new, unconfirmed recipient.
    const addressChanged =
      channel.type === 'email' &&
      normalizeEmailAddress(String(mergedConfig.address ?? '')) !==
        normalizeEmailAddress(String(previousConfig.address ?? ''));
    if (addressChanged && !emailDeliveryConfigured()) {
      return reply.status(400).send({ error: 'Bad Request', message: EMAIL_NOT_CONFIGURED_MESSAGE });
    }

    const newName = body.name ?? channel.name;
    const newEnabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : channel.enabled;
    const newWindow = body.digest_window_sec ?? channel.digest_window_sec;
    const now = nowSec();

    // Reset fail state when config changes so the channel gets a clean slate.
    if (configChanged) {
      db.prepare(`
        UPDATE notification_channels
        SET name = ?, enabled = ?, config = ?, digest_window_sec = ?,
            fail_count = 0, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(newName, newEnabled, JSON.stringify(mergedConfig), newWindow, now, channel.id);
    } else {
      db.prepare(`
        UPDATE notification_channels
        SET name = ?, enabled = ?, config = ?, digest_window_sec = ?, updated_at = ?
        WHERE id = ?
      `).run(newName, newEnabled, JSON.stringify(mergedConfig), newWindow, now, channel.id);
    }

    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.updated', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ channel_id: channel.id, type: channel.type }), now);

    let verification: QueuedVerification | null = null;
    if (addressChanged) {
      resetChannelVerification(db, channel.id);
      verification = queueChannelVerification(db, channel.id, key.keyId, request.log);
    }

    const updated = loadChannel(db, channel.id);

    // Manage Telegram webhook when approval_mode or enabled state changes.
    if (channel.type === 'telegram' && (body.config !== undefined || body.enabled !== undefined)) {
      const nowApproval = mergedConfig.approval_mode === true;
      const nowEnabled = newEnabled === 1;
      if (nowApproval && nowEnabled) {
        callSetWebhook(
          String(mergedConfig.bot_token),
          channel.id,
          String(mergedConfig.hmac_secret),
        ).catch(() => {});
      } else {
        // approval_mode turned off or channel disabled — deregister webhook.
        callDeleteWebhook(String(mergedConfig.bot_token), channel.id).catch(() => {});
      }
    }

    return verification
      ? { ...serializeChannel(updated), ...verificationFields(verification) }
      : serializeChannel(updated);
  });

  // DELETE /v1/notification-channels/:id
  // Hard-delete. 204 on success, 404 if not found or wrong project.
  app.delete<{ Params: { id: string } }>('/v1/notification-channels/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:write', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    const channel = db.prepare(
      'SELECT id, type, config FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as { id: string; type: string; config: string } | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });

    // Deregister Telegram webhook before deleting the channel (best-effort).
    if (channel.type === 'telegram') {
      const cfg = JSON.parse(channel.config) as Record<string, unknown>;
      if (cfg.approval_mode === true) {
        callDeleteWebhook(String(cfg.bot_token), channel.id).catch(() => {});
      }
    }

    const now = nowSec();
    db.prepare('DELETE FROM notification_channels WHERE id = ?').run(channel.id);

    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.deleted', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ channel_id: channel.id }), now);

    reply.status(204);
    return '';
  });

  // POST /v1/notification-channels/:id/test
  // Send a test message immediately, bypassing the digest window. Rate-limited
  // to 5/min per key. Does NOT update last_fired_at/digest_queue/fail_count —
  // test sends are fully independent from live delivery state.
  app.post<{ Params: { id: string } }>('/v1/notification-channels/:id/test', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:test', 5))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 5 requests/min per key' });
    }

    const channel = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as ChannelRow | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });

    if (channel.type === 'email' && channel.verified_at === null) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Confirm the email address first: open the confirmation link we sent to it. ' +
          'You can resend the confirmation email from the channel settings.',
      });
    }

    // Load raw (unmasked) config for the actual send.
    const rawConfig = JSON.parse(channel.config) as Record<string, unknown>;
    const inboxUrl = `${process.env.BASE_URL ?? 'http://localhost:8484'}/inbox`;

    // Test emails count toward the project's daily email cap like any other.
    let emailSendId: number | null = null;
    if (channel.type === 'email' && emailDeliveryConfigured()) {
      emailSendId = reserveNotifyEmail(db, channel.project_id, channel.id, String(rawConfig.address), nowSec());
      if (emailSendId === null) {
        return { ok: false, error: 'Daily email limit for this project reached. Try again later.' };
      }
    }

    let ok = false;
    let errorMsg: string | undefined;
    try {
      await dispatchChannelType(
        channel.type,
        rawConfig,
        'Test notification from Impri',
        'test',
        inboxUrl,
        'test_action_id',
      );
      ok = true;
    } catch (err) {
      if (emailSendId !== null) deleteEmailSend(db, emailSendId);
      // Sanitize error message — must not echo secrets (URL, token, etc.).
      const raw = err instanceof Error ? err.message : String(err);
      errorMsg = sanitizeErrorMsg(raw, rawConfig);
    }

    // Audit: channel.tested — ok boolean only; no config, token, or URL in data.
    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.tested', ?, ?, ?)",
    ).run(key.projectId, key.keyId, JSON.stringify({ channel_id: channel.id, type: channel.type, ok }), nowSec());

    if (ok) return { ok: true };
    return { ok: false, error: errorMsg };
  });

  // POST /v1/notification-channels/:id/resend-verification
  // Send a new confirmation email for an unconfirmed email channel. Each send
  // issues a new link (the previous one stops working). Limited per channel
  // (10 min cooldown), per address and per project (rolling 24 h) → 429.
  app.post<{ Params: { id: string } }>('/v1/notification-channels/:id/resend-verification', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:write', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    const channel = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as ChannelRow | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });
    if (channel.type !== 'email') {
      return reply.status(400).send({ error: 'Bad Request', message: 'Only email channels need address confirmation' });
    }
    if (channel.verified_at !== null) {
      return reply.status(409).send({ error: 'Conflict', message: 'This email address is already confirmed' });
    }

    // Unlike create/update, this waits for the SMTP server: it is how the owner
    // finds out that a queued confirmation email did not go out.
    const result = await sendChannelVerification(db, channel.id, key.keyId, request.log);
    if (result.sent) {
      return { ok: true, channel: serializeChannel(loadChannel(db, channel.id)) };
    }
    const message = verificationFailureMessage(result.reason);
    switch (result.reason) {
      case 'email_not_configured':
        return reply.status(400).send({ error: 'Bad Request', message });
      case 'cooldown':
      case 'address_limit':
      case 'project_limit':
        return reply.status(429).send({ error: 'Too Many Requests', message });
      case 'send_failed':
        return reply.status(502).send({ error: 'Bad Gateway', message });
    }
  });

  // GET /v1/notification-channels/verify?token=… — public, no API key.
  // Shows a confirmation button only. Mail scanners and link previews fetch
  // links in incoming email, so a GET must never confirm the address.
  app.get<{ Querystring: { token?: string } }>('/v1/notification-channels/verify', async (request, reply) => {
    if (!(await checkRateLimit(db, `ip:${clientIp(request)}`, 'channel-verify', 30))) {
      return sendVerifyPage(reply, 429, 'Too many attempts', '<p>Please wait a minute and try again.</p>');
    }

    const token = typeof request.query.token === 'string' ? request.query.token : '';
    if (!VERIFY_TOKEN_RE.test(token)) return sendTokenProblemPage(reply, 'invalid');

    const state = inspectVerifyToken(db, token);
    if (state !== 'valid') return sendTokenProblemPage(reply, state);

    return sendVerifyPage(
      reply,
      200,
      'Confirm your email address',
      '<p>Confirm that this address should receive Impri notifications when an AI agent is waiting for your approval.</p>' +
        '<form method="post" action="/v1/notification-channels/verify">' +
        `<input type="hidden" name="token" value="${htmlEscape(token)}">` +
        '<p><button type="submit">Confirm email address</button></p>' +
        '</form>' +
        "<p>If you didn't set this up, close this page — nothing will be sent to this address.</p>",
    );
  });

  // POST /v1/notification-channels/verify — public, no API key. The token is
  // the credential: single use, 7-day lifetime, stored only as a sha256 hash.
  app.post('/v1/notification-channels/verify', async (request, reply) => {
    if (!(await checkRateLimit(db, `ip:${clientIp(request)}`, 'channel-verify', 30))) {
      return sendVerifyPage(reply, 429, 'Too many attempts', '<p>Please wait a minute and try again.</p>');
    }

    const token = tokenFromBody(request);
    if (!VERIFY_TOKEN_RE.test(token)) return sendTokenProblemPage(reply, 'invalid');

    const state = confirmVerifyToken(db, token);
    if (state !== 'valid') return sendTokenProblemPage(reply, state);

    const appUrl = process.env.APP_URL;
    return sendVerifyPage(
      reply,
      200,
      'Email confirmed',
      '<p>Impri notifications will now be delivered to this address. You can close this page.</p>' +
        (appUrl ? `<p><a href="${htmlEscape(appUrl)}">Open Impri</a></p>` : ''),
    );
  });

  // POST /v1/notification-channels/:id/setup-webhook
  // Re-register the Telegram webhook for an approval-mode channel.
  // Useful when BASE_URL was missing at channel-create time (local dev tunnel).
  // Admin scope required.
  app.post<{ Params: { id: string } }>('/v1/notification-channels/:id/setup-webhook', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'channels:write', 30))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 30 requests/min per key' });
    }

    const channel = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as ChannelRow | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });
    if (channel.type !== 'telegram') {
      return reply.status(400).send({ error: 'Bad Request', message: 'setup-webhook is only supported for telegram channels' });
    }

    const cfg = JSON.parse(channel.config) as Record<string, unknown>;
    if (cfg.approval_mode !== true) {
      return reply.status(400).send({ error: 'Bad Request', message: 'approval_mode must be true to register a webhook' });
    }

    const bUrl = process.env.BASE_URL;
    if (!isPublicBaseUrl(bUrl)) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'BASE_URL is not configured to a public URL. Set BASE_URL (e.g. https://your-domain.com) and retry.',
      });
    }

    const webhookUrl = `${bUrl!}/v1/integrations/telegram/webhook/${channel.id}`;
    const secretToken = deriveWebhookSecret(String(cfg.hmac_secret));

    try {
      const res = await fetchGuarded(`https://api.telegram.org/bot${cfg.bot_token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secretToken,
          allowed_updates: ['callback_query'],
          drop_pending_updates: false,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json() as { ok?: boolean; description?: string };
      if (!json.ok) {
        return reply.status(502).send({ error: 'Bad Gateway', message: `Telegram setWebhook returned ok=false: ${json.description ?? 'unknown'}` });
      }
      return { ok: true, url: webhookUrl };
    } catch (err) {
      const sanitized = (err instanceof Error ? err.message : String(err))
        .replace(String(cfg.bot_token), '[redacted]');
      return reply.status(502).send({ error: 'Bad Gateway', message: sanitized });
    }
  });
}
