import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { createSmtpTransport, emailDeliveryConfigured, smtpFrom } from './notify.js';
import {
  DAY_SEC,
  countSendsByProject,
  countSendsToAddress,
  deleteEmailSend,
  hashEmailAddress,
  recordEmailSend,
} from './email-sends.js';
import { noopLogger, type Logger } from './metrics.js';

// Email notification channels are created by anonymous self-serve projects,
// so the address in their config is unverified input: without confirmation,
// anyone could make Impri mail arbitrary people. Until the address owner
// clicks the confirmation link, the only email it receives is the
// confirmation itself — fixed text, no project-controlled content, and
// limited per address and per project.

export const VERIFY_TOKEN_TTL_SEC = 7 * DAY_SEC;
export const VERIFY_RESEND_COOLDOWN_SEC = 10 * 60;
export const VERIFY_MAX_PER_ADDRESS_24H = 3;
export const VERIFY_MAX_PER_PROJECT_24H = 5;

// Channels the background tick handles per run; keeps one tick short even if
// a deploy suddenly finds many unconfirmed channels.
const TICK_BATCH = 20;

export type VerificationFailure =
  | 'email_not_configured'
  | 'cooldown'
  | 'address_limit'
  | 'project_limit'
  | 'send_failed';

export type VerificationResult = { sent: true } | { sent: false; reason: VerificationFailure };

const FAILURE_MESSAGES: Record<VerificationFailure, string> = {
  email_not_configured: 'Email delivery is not configured on this server.',
  cooldown: 'A confirmation email was sent less than 10 minutes ago. Check your inbox (and spam folder) or try again later.',
  address_limit: 'Too many confirmation emails were sent to this address in the last 24 hours. Try again later.',
  project_limit: 'This project has sent too many confirmation emails in the last 24 hours. Try again later.',
  send_failed: 'The confirmation email could not be sent. Try again later.',
};

export function verificationFailureMessage(reason: VerificationFailure): string {
  return FAILURE_MESSAGES[reason];
}

export function hashVerifyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface PendingChannel {
  id: string;
  project_id: string;
  config: string;
  verify_token_hash: string | null;
  verify_sent_at: number | null;
}

type Reservation =
  | { ok: true; sendId: number; previousTokenHash: string | null; previousSentAt: number | null }
  | { ok: false; reason: VerificationFailure };

/**
 * Check the limits and claim a send slot in one synchronous transaction, so
 * two concurrent requests cannot both pass. The new token hash is stored
 * before the SMTP call: the link must work the moment the email lands.
 */
function reserveVerificationSend(
  db: Db,
  channelId: string,
  addressHash: string,
  tokenHash: string,
  now: number,
): Reservation {
  const reserve = db.transaction((): Reservation => {
    const channel = db.prepare(
      'SELECT id, project_id, config, verify_token_hash, verify_sent_at FROM notification_channels WHERE id = ?',
    ).get(channelId) as PendingChannel | undefined;
    if (!channel) return { ok: false, reason: 'send_failed' };

    if (channel.verify_sent_at !== null && now - channel.verify_sent_at < VERIFY_RESEND_COOLDOWN_SEC) {
      return { ok: false, reason: 'cooldown' };
    }
    const since = now - DAY_SEC;
    if (countSendsToAddress(db, addressHash, 'verify', since) >= VERIFY_MAX_PER_ADDRESS_24H) {
      return { ok: false, reason: 'address_limit' };
    }
    if (countSendsByProject(db, channel.project_id, 'verify', since) >= VERIFY_MAX_PER_PROJECT_24H) {
      return { ok: false, reason: 'project_limit' };
    }

    const sendId = recordEmailSend(db, channel.project_id, channel.id, 'verify', addressHash, now);
    db.prepare(
      'UPDATE notification_channels SET verify_token_hash = ?, verify_sent_at = ?, updated_at = ? WHERE id = ?',
    ).run(tokenHash, now, now, channel.id);
    return {
      ok: true,
      sendId,
      previousTokenHash: channel.verify_token_hash,
      previousSentAt: channel.verify_sent_at,
    };
  });
  return reserve();
}

function verificationLink(token: string): string {
  const base = process.env.BASE_URL ?? 'http://localhost:8484';
  return `${base}/v1/notification-channels/verify?token=${token}`;
}

// Fixed text only. Channel and project names are chosen by whoever created
// the channel, so none of them may appear in an email to an unconfirmed address.
function verificationEmailText(link: string): string {
  return [
    'Someone set up Impri to send approval notifications to this address.',
    '',
    'Impri tells you when an AI agent is waiting for a human to approve an action.',
    'Before any notification is sent here, please confirm this address:',
    '',
    link,
    '',
    'The link expires in 7 days.',
    '',
    "If you didn't set this up, ignore this email — nothing more will be sent unless you confirm.",
    '',
    '--',
    'Impri · https://impri.dev',
    '',
  ].join('\n');
}

/**
 * Send (or re-send) the confirmation email for an email channel.
 * Never logs the address or the token.
 */
export async function sendChannelVerification(
  db: Db,
  channelId: string,
  actor: string,
  log: Logger = noopLogger,
): Promise<VerificationResult> {
  const channel = db.prepare(
    "SELECT id, project_id, config FROM notification_channels WHERE id = ? AND type = 'email'",
  ).get(channelId) as Pick<PendingChannel, 'id' | 'project_id' | 'config'> | undefined;
  if (!channel) return { sent: false, reason: 'send_failed' };

  const result = await attemptSend(db, channel, log);
  // Only actual sends are audited. Skips and failures are reported to the API
  // caller (or logged), and the background tick retries them every minute —
  // auditing those would flood the project's audit log.
  if (result.sent) {
    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.verification_sent', ?, ?, ?)",
    ).run(channel.project_id, actor, JSON.stringify({ channel_id: channel.id }), nowSec());
  }
  return result;
}

async function attemptSend(
  db: Db,
  channel: Pick<PendingChannel, 'id' | 'project_id' | 'config'>,
  log: Logger,
): Promise<VerificationResult> {
  if (!emailDeliveryConfigured()) return { sent: false, reason: 'email_not_configured' };

  const address = String((JSON.parse(channel.config) as { address?: unknown }).address ?? '');
  const token = randomBytes(32).toString('base64url');
  const now = nowSec();
  const reservation = reserveVerificationSend(db, channel.id, hashEmailAddress(address), hashVerifyToken(token), now);
  if (!reservation.ok) return { sent: false, reason: reservation.reason };

  try {
    await createSmtpTransport().sendMail({
      from: smtpFrom(),
      to: address,
      subject: 'Confirm your email for Impri notifications',
      text: verificationEmailText(verificationLink(token)),
    });
    return { sent: true };
  } catch (err) {
    // Nothing reached the recipient: give the slot back and restore the
    // previous token so an earlier, still-valid link keeps working.
    db.transaction(() => {
      deleteEmailSend(db, reservation.sendId);
      db.prepare(
        'UPDATE notification_channels SET verify_token_hash = ?, verify_sent_at = ? WHERE id = ?',
      ).run(reservation.previousTokenHash, reservation.previousSentAt, channel.id);
    })();
    // SMTP error messages can echo the recipient, so log only the codes.
    const e = err as { code?: unknown; responseCode?: unknown };
    log.warn({
      event: 'channel.verification_send_failed',
      channel_id: channel.id,
      project_id: channel.project_id,
      code: typeof e.code === 'string' ? e.code : undefined,
      response_code: typeof e.responseCode === 'number' ? e.responseCode : undefined,
    });
    return { sent: false, reason: 'send_failed' };
  }
}

/** New address on an existing channel: it must be confirmed again. */
export function resetChannelVerification(db: Db, channelId: string): void {
  db.prepare(
    'UPDATE notification_channels SET verified_at = NULL, verify_token_hash = NULL, verify_sent_at = NULL WHERE id = ?',
  ).run(channelId);
}

export type TokenState = 'valid' | 'invalid' | 'expired';

interface TokenChannel {
  id: string;
  project_id: string;
  verify_sent_at: number | null;
}

function findByToken(db: Db, token: string): TokenChannel | undefined {
  return db.prepare(
    "SELECT id, project_id, verify_sent_at FROM notification_channels WHERE verify_token_hash = ? AND type = 'email'",
  ).get(hashVerifyToken(token)) as TokenChannel | undefined;
}

function tokenState(channel: TokenChannel | undefined, now: number): TokenState {
  if (!channel || channel.verify_sent_at === null) return 'invalid';
  return now - channel.verify_sent_at > VERIFY_TOKEN_TTL_SEC ? 'expired' : 'valid';
}

/** Read-only check used by the GET confirmation page. */
export function inspectVerifyToken(db: Db, token: string): TokenState {
  return tokenState(findByToken(db, token), nowSec());
}

/** Confirm the address. Single use: the token hash is cleared. */
export function confirmVerifyToken(db: Db, token: string): TokenState {
  const now = nowSec();
  const channel = findByToken(db, token);
  const state = tokenState(channel, now);
  if (state !== 'valid' || !channel) return state;

  db.prepare(
    'UPDATE notification_channels SET verified_at = ?, verify_token_hash = NULL, updated_at = ? WHERE id = ?',
  ).run(now, now, channel.id);
  db.prepare(
    "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.verified', 'email-link', ?, ?)",
  ).run(channel.project_id, JSON.stringify({ channel_id: channel.id }), now);
  return 'valid';
}

/**
 * Background tick: send the first confirmation email for enabled email
 * channels that never got one — channels created before verification existed,
 * or whose create-time send hit a limit or failed (a failed send restores
 * verify_sent_at, so the next tick retries).
 */
export async function runEmailVerificationTick(db: Db, log: Logger = noopLogger): Promise<void> {
  if (!emailDeliveryConfigured()) return;

  const pending = db.prepare(`
    SELECT id FROM notification_channels
    WHERE type = 'email' AND enabled = 1 AND verified_at IS NULL AND verify_sent_at IS NULL
    ORDER BY created_at
    LIMIT ?
  `).all(TICK_BATCH) as { id: string }[];

  for (const { id } of pending) {
    await sendChannelVerification(db, id, 'system', log);
  }
}
