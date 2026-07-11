import type { FastifyInstance } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import {
  maskConfig,
  dispatchChannelType,
  deriveWebhookSecret,
  isPublicBaseUrl,
} from '../notify.js';
import { fetchGuarded, isPrivateIp } from '../net-guard.js';
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
}

// Serialize a DB row to the API response shape: masked config, boolean enabled,
// no digest_queue (internal implementation detail).
function serializeChannel(channel: ChannelRow) {
  const rawConfig = JSON.parse(channel.config) as Record<string, unknown>;
  return {
    id: channel.id,
    project_id: channel.project_id,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled === 1,
    digest_window_sec: channel.digest_window_sec,
    config: maskConfig(channel.type, rawConfig),
    last_fired_at: channel.last_fired_at ?? undefined,
    fail_count: channel.fail_count,
    last_error: channel.last_error ?? undefined,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  };
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

    // For telegram approval-mode channels, auto-generate hmac_secret when
    // the operator omits it. Inject BEFORE Zod validation so the schema's
    // min(16) constraint is satisfied and the generated secret is stored.
    let channelConfig = body.config as Record<string, unknown>;
    if (body.type === 'telegram' && channelConfig.approval_mode === true && !channelConfig.hmac_secret) {
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

    const created = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ?',
    ).get(id) as ChannelRow;

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
    return serializeChannel(created);
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
    let mergedConfig = JSON.parse(channel.config) as Record<string, unknown>;
    let configChanged = false;
    if (body.config !== undefined) {
      mergedConfig = { ...mergedConfig, ...(body.config as Record<string, unknown>) };
      const cv = validateConfig(channel.type, mergedConfig);
      if (!cv.success) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid config', issues: cv.error.issues });
      }
      configChanged = true;
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

    const updated = db.prepare(
      'SELECT * FROM notification_channels WHERE id = ?',
    ).get(channel.id) as ChannelRow;

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

    return serializeChannel(updated);
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

    // Load raw (unmasked) config for the actual send.
    const rawConfig = JSON.parse(channel.config) as Record<string, unknown>;
    const inboxUrl = `${process.env.BASE_URL ?? 'http://localhost:8484'}/inbox`;

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
