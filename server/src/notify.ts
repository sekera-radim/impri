import nodemailer from 'nodemailer';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { fetchGuarded } from './net-guard.js';
import { signWebhookBody } from './webhooks.js';

export interface NotifyPayload {
  actionId: string;
  title: string;
  kind: string;
  inboxUrl: string;
  verdict?: string;
  /** Optional override for the ntfy topic (used by escalate rules). */
  escalateChannel?: string;
}

// Strip CR/LF before values reach HTTP headers (header-injection guard).
// Applied to title in ntfy headers and email subject lines.
export const headerSafe = (s: string) => s.replace(/[\r\n]+/g, ' ');

// HTML-escape for Telegram — prevents markup injection when values are
// interpolated into the HTML parse_mode body.
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ntfy adapter: POST to topic URL (global / escalate path)
export async function notifyNtfy(payload: NotifyPayload): Promise<void> {
  const ntfyUrl = process.env.NTFY_URL;
  // escalateChannel overrides the default topic when an escalate rule fired.
  const ntfyTopic = payload.escalateChannel ?? process.env.NTFY_TOPIC;
  if (!ntfyUrl || !ntfyTopic) return;

  const url = `${ntfyUrl.replace(/\/$/, '')}/${ntfyTopic}`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Title': headerSafe(payload.title),
        'Priority': 'default',
        'Tags': `impri,${headerSafe(payload.kind)}`,
        'Click': payload.inboxUrl,
        'Content-Type': 'text/plain',
      },
      body: payload.verdict
        ? `Decision needed: ${payload.title}`
        : `New action pending: ${payload.title}`,
    });
  } catch (err) {
    console.error('[notify] ntfy delivery failed', err instanceof Error ? err.message : String(err));
  }
}

// Email adapter: nodemailer SMTP (global path)
export async function notifyEmail(payload: NotifyPayload): Promise<void> {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    console.log(`[notify] email (no SMTP): "${payload.title}" → ${payload.inboxUrl}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });

  const to = process.env.NOTIFY_EMAIL;
  if (!to) return;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'impri@localhost',
      to,
      subject: `[Impri] ${payload.title}`,
      text: `A new action requires your decision.\n\nTitle: ${payload.title}\nKind: ${payload.kind}\n\nReview: ${payload.inboxUrl}`,
    });
  } catch (err) {
    console.error('[notify] email delivery failed', err instanceof Error ? err.message : String(err));
  }
}

export async function notifyAll(payload: NotifyPayload): Promise<void> {
  await Promise.allSettled([notifyNtfy(payload), notifyEmail(payload)]);
}

// ---------------------------------------------------------------------------
// Per-channel (project-scoped) notification infrastructure
// ---------------------------------------------------------------------------

export interface ChannelPayload {
  actionId: string;
  title: string;
  kind: string;
  inboxUrl: string;
  escalate?: boolean;
}

// Channel row shape returned by better-sqlite3
interface ChannelRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  enabled: number;
  config: string;    // JSON
  digest_window_sec: number;
  last_fired_at: number | null;
  digest_queue: string;  // JSON [{actionId, title, kind}]
  fail_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface QueueItem {
  actionId: string;
  title: string;
  kind: string;
}

interface DigestMessage {
  title: string;
  kind: string;
  inboxUrl: string;
  primaryActionId: string;
}

// After how many consecutive failures a channel is auto-disabled.
// Read from env on each call so tests can override IMPRI_CHANNEL_MAX_FAILS.
function channelMaxFails(): number {
  return Number(process.env.IMPRI_CHANNEL_MAX_FAILS ?? 5);
}

function baseUrl(): string {
  return process.env.BASE_URL ?? 'http://localhost:8484';
}

// ---------------------------------------------------------------------------
// maskConfig() — applied to every channel response leaving the API layer.
// Fields that carry secrets are replaced with '****{last4}'.
// Any raw value shorter than 5 chars is fully masked to '****'.
// ---------------------------------------------------------------------------

export function maskConfig(type: string, rawConfig: Record<string, unknown>): Record<string, unknown> {
  const mask = (val: unknown): string => {
    const s = String(val ?? '');
    return s.length < 5 ? '****' : `****${s.slice(-4)}`;
  };

  switch (type) {
    case 'slack':
      return { url: mask(rawConfig.url) };
    case 'discord':
      return { url: mask(rawConfig.url) };
    case 'telegram':
      return { bot_token: mask(rawConfig.bot_token), chat_id: rawConfig.chat_id };
    case 'ntfy':
      return { url: mask(rawConfig.url), topic: rawConfig.topic };
    case 'email':
      return { address: rawConfig.address };
    case 'webhook': {
      const masked: Record<string, unknown> = { url: mask(rawConfig.url) };
      if (rawConfig.hmac_secret !== undefined) {
        masked.hmac_secret = mask(rawConfig.hmac_secret);
      }
      return masked;
    }
    default:
      return rawConfig;
  }
}

// ---------------------------------------------------------------------------
// sanitizeError() — strips secret config values from error messages before
// they are returned to callers (e.g. the test endpoint). Best-effort.
// ---------------------------------------------------------------------------

function sanitizeError(msg: string, config: Record<string, unknown>): string {
  let result = msg;
  for (const val of Object.values(config)) {
    if (typeof val === 'string' && val.length >= 8) {
      result = result.split(val).join('[redacted]');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-type adapter functions — each makes one outbound HTTP call and throws
// on non-2xx. Every URL goes through fetchGuarded (SSRF guard). Secrets are
// never logged; only channelId + type reach the error log.
// ---------------------------------------------------------------------------

async function sendSlack(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
): Promise<void> {
  const url = String(config.url);
  // Values go into the JSON body via JSON.stringify — no header injection risk.
  const body = JSON.stringify({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:bell: *${title}*\nKind: \`${kind}\`\n<${inboxUrl}|Review in Impri>`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Review' },
            url: inboxUrl,
            style: 'primary',
          },
        ],
      },
    ],
  });
  const res = await fetchGuarded(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
}

async function sendDiscord(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
): Promise<void> {
  // wait=true makes Discord return the created message so non-2xx is surfaced.
  const url = `${String(config.url)}?wait=true`;
  const body = JSON.stringify({
    embeds: [
      {
        title: `Action Pending: ${title}`,
        description: `Kind: \`${kind}\`\n[Review in Impri](${inboxUrl})`,
        color: 15899902,
      },
    ],
  });
  const res = await fetchGuarded(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
}

async function sendTelegram(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
): Promise<void> {
  const botToken = String(config.bot_token);
  const chatId = String(config.chat_id);
  // Base URL is hardcoded — not user-supplied — so SSRF via config injection is
  // impossible. fetchGuarded is still used for defense in depth.
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    // HTML-escape title/kind/inboxUrl to prevent markup injection.
    text: `🔔 <b>Action Pending</b>: ${htmlEscape(title)}\nKind: <code>${htmlEscape(kind)}</code>\n<a href="${htmlEscape(inboxUrl)}">Review in Impri</a>`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  const res = await fetchGuarded(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

async function sendNtfyChannel(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
): Promise<void> {
  const url = `${String(config.url).replace(/\/$/, '')}/${String(config.topic)}`;
  const res = await fetchGuarded(url, {
    method: 'POST',
    headers: {
      // headerSafe strips CR/LF — header-injection guard (same as global notifyNtfy).
      'Title': headerSafe(title),
      'Priority': 'default',
      'Tags': `impri,${headerSafe(kind)}`,
      'Click': inboxUrl,
      'Content-Type': 'text/plain',
    },
    body: `New action pending: ${title}`,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

async function sendEmailChannel(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
): Promise<void> {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    // Same no-op behaviour as the global adapter when SMTP_HOST is absent.
    console.warn('[notify-channel] email: SMTP_HOST not configured, skipping delivery');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? 'impri@localhost',
    to: String(config.address),
    // headerSafe strips CR/LF from subject line (email header injection guard).
    subject: `[Impri] ${headerSafe(title)}`,
    text: `A new action requires your decision.\n\nTitle: ${title}\nKind: ${kind}\n\nReview: ${inboxUrl}`,
  });
}

async function sendWebhookChannel(
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
  actionId: string,
  escalate?: boolean,
): Promise<void> {
  const url = String(config.url);
  const hmacSecret = config.hmac_secret != null ? String(config.hmac_secret) : undefined;
  const now = nowSec();
  const nonce = randomBytes(8).toString('hex');

  const body = JSON.stringify({
    event: 'action.pending',
    action_id: actionId,
    title,
    kind,
    inbox_url: inboxUrl,
    triggered_at: now,
    ...(escalate ? { escalate: true } : {}),
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (hmacSecret) {
    // Identical signing pattern to the existing callback webhook — receivers can
    // share the same verification logic (signWebhookBody from webhooks.ts).
    const sig = signWebhookBody(hmacSecret, body, now, nonce);
    headers['X-Impri-Signature'] = `sha256=${sig}`;
    headers['X-Impri-Timestamp'] = String(now);
    headers['X-Impri-Nonce'] = nonce;
  }

  const res = await fetchGuarded(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Dispatch — routes to the correct per-type adapter.
// Exported so the test endpoint can call adapters directly (bypassing digest).
// ---------------------------------------------------------------------------

export async function dispatchChannelType(
  type: string,
  config: Record<string, unknown>,
  title: string,
  kind: string,
  inboxUrl: string,
  actionId = '',
  escalate?: boolean,
): Promise<void> {
  switch (type) {
    case 'slack':    return sendSlack(config, title, kind, inboxUrl);
    case 'discord':  return sendDiscord(config, title, kind, inboxUrl);
    case 'telegram': return sendTelegram(config, title, kind, inboxUrl);
    case 'ntfy':     return sendNtfyChannel(config, title, kind, inboxUrl);
    case 'email':    return sendEmailChannel(config, title, kind, inboxUrl);
    case 'webhook':  return sendWebhookChannel(config, title, kind, inboxUrl, actionId, escalate);
    default:         throw new Error(`Unknown channel type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Digest message builder — single item sends immediately; N items are batched.
// ---------------------------------------------------------------------------

function buildDigestMessage(queue: QueueItem[]): DigestMessage {
  if (queue.length === 1) {
    const item = queue[0];
    return {
      title: item.title,
      kind: item.kind,
      inboxUrl: `${baseUrl()}/inbox/${item.actionId}`,
      primaryActionId: item.actionId,
    };
  }
  // Truncate title list at 3 with "+ N more" suffix.
  const top = queue.slice(0, 3);
  const extra = queue.length - top.length;
  const titleList = top.map(q => q.title).join(', ');
  const title = extra > 0
    ? `${queue.length} actions pending your approval: ${titleList} +${extra} more`
    : `${queue.length} actions pending your approval: ${titleList}`;
  return {
    title,
    kind: 'action.pending',
    inboxUrl: `${baseUrl()}/inbox`,
    primaryActionId: queue[0].actionId,
  };
}

// ---------------------------------------------------------------------------
// DB helpers for channel state
// ---------------------------------------------------------------------------

function onChannelSuccess(db: Db, channelId: string, now: number): void {
  db.prepare(
    'UPDATE notification_channels SET last_fired_at = ?, digest_queue = ?, fail_count = 0, last_error = NULL, updated_at = ? WHERE id = ?',
  ).run(now, '[]', now, channelId);
}

function onChannelFailure(db: Db, channel: ChannelRow, msg: string, now: number): void {
  const newFailCount = channel.fail_count + 1;
  if (newFailCount >= channelMaxFails()) {
    db.prepare(
      'UPDATE notification_channels SET fail_count = ?, last_error = ?, enabled = 0, updated_at = ? WHERE id = ?',
    ).run(newFailCount, msg, now, channel.id);
    // Structured warning — no secrets in this log line.
    console.warn('[notify-channel] auto-disabled after repeated failures', {
      channelId: channel.id,
      type: channel.type,
      projectId: channel.project_id,
      failCount: newFailCount,
    });
  } else {
    db.prepare(
      'UPDATE notification_channels SET fail_count = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ).run(newFailCount, msg, now, channel.id);
  }
}

// ---------------------------------------------------------------------------
// fireChannel — applies digest window, queues or sends, updates DB state.
// Called once per channel on every notifyChannels() invocation.
// ---------------------------------------------------------------------------

async function fireChannel(db: Db, channel: ChannelRow, payload: ChannelPayload): Promise<void> {
  const now = nowSec();
  const config = JSON.parse(channel.config) as Record<string, unknown>;
  let queue = JSON.parse(channel.digest_queue) as QueueItem[];

  // Layer 2 digest window check (Layer 1 = action-level soft-dedup in POST /v1/actions).
  if (channel.last_fired_at !== null && (now - channel.last_fired_at) < channel.digest_window_sec) {
    // Window still open — queue the item without sending.
    if (!queue.some(q => q.actionId === payload.actionId)) {
      queue.push({ actionId: payload.actionId, title: payload.title, kind: payload.kind });
    }
    db.prepare(
      'UPDATE notification_channels SET digest_queue = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(queue), now, channel.id);
    return;
  }

  // Window expired or channel has never fired — flush queue + current item.
  if (!queue.some(q => q.actionId === payload.actionId)) {
    queue.push({ actionId: payload.actionId, title: payload.title, kind: payload.kind });
  }

  // Persist the merged queue BEFORE attempting the send so items are not lost
  // on failure (the queue is kept intact for the next flush attempt).
  db.prepare(
    'UPDATE notification_channels SET digest_queue = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(queue), now, channel.id);

  const { title, kind, inboxUrl, primaryActionId } = buildDigestMessage(queue);

  try {
    await dispatchChannelType(channel.type, config, title, kind, inboxUrl, primaryActionId, payload.escalate);
    onChannelSuccess(db, channel.id, now);
  } catch (err) {
    // Sanitize before storing AND before re-throwing so no secret can reach
    // the notifyChannels log site via err.message (tokens appear in URLs for
    // Telegram/Slack/Discord/webhook network errors).
    const raw = err instanceof Error ? err.message : String(err);
    const msg = sanitizeError(raw, config);
    onChannelFailure(db, channel, msg, now);
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// flushChannelQueue — background tick path: send queued items and clear queue.
// Called when the digest window has expired and items are waiting.
// ---------------------------------------------------------------------------

async function flushChannelQueue(db: Db, channel: ChannelRow): Promise<void> {
  const now = nowSec();
  const config = JSON.parse(channel.config) as Record<string, unknown>;
  const queue = JSON.parse(channel.digest_queue) as QueueItem[];
  if (queue.length === 0) return;

  const { title, kind, inboxUrl, primaryActionId } = buildDigestMessage(queue);

  try {
    await dispatchChannelType(channel.type, config, title, kind, inboxUrl, primaryActionId);
    onChannelSuccess(db, channel.id, now);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = sanitizeError(raw, config);
    onChannelFailure(db, channel, msg, now);
    // Log but don't re-throw: one channel failure must not stop the tick.
    console.error('[notify-channel] digest flush failed', {
      channelId: channel.id,
      type: channel.type,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire all enabled notification channels for a project when a new action
 * becomes pending. Fire-and-forget from the caller (.catch(() => {})).
 * One channel failing never blocks the others (Promise.allSettled pattern).
 */
export async function notifyChannels(db: Db, projectId: string, payload: ChannelPayload): Promise<void> {
  const channels = db.prepare(
    'SELECT * FROM notification_channels WHERE project_id = ? AND enabled = 1',
  ).all(projectId) as ChannelRow[];

  await Promise.allSettled(
    channels.map(channel =>
      fireChannel(db, channel, payload).catch(err => {
        // Error already logged inside fireChannel/onChannelFailure.
        // Log channelId and type only — no secrets.
        console.error('[notify-channel] delivery failed', {
          channelId: channel.id,
          type: channel.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
}

/**
 * Background digest flush tick — call every ~30–60 s alongside runWebhookTick.
 * Selects channels whose digest window has expired with queued items and
 * flushes them. Items with last_fired_at IS NULL are handled by fireChannel()
 * on the next action creation (explicit retry path).
 */
export async function runChannelDigestTick(db: Db): Promise<void> {
  const now = nowSec();
  const due = db.prepare(`
    SELECT * FROM notification_channels
    WHERE enabled = 1
      AND digest_queue != '[]'
      AND last_fired_at IS NOT NULL
      AND (last_fired_at + digest_window_sec) <= ?
  `).all(now) as ChannelRow[];

  for (const channel of due) {
    await flushChannelQueue(db, channel);
  }
}
