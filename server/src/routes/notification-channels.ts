import type { FastifyInstance } from 'fastify';
import type { ZodTypeAny } from 'zod';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import {
  maskConfig,
  dispatchChannelType,
} from '../notify.js';
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

    const configValidation = validateConfig(body.type, body.config as Record<string, unknown>);
    if (!configValidation.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid config for channel type',
        issues: configValidation.error.issues,
      });
    }

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
      JSON.stringify(body.config),
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
      'SELECT id FROM notification_channels WHERE id = ? AND project_id = ?',
    ).get(request.params.id, key.projectId) as { id: string } | undefined;

    if (!channel) return reply.status(404).send({ error: 'Not Found' });

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
}
