import { createHash } from 'node:crypto';
import type { Db } from './db.js';

// Log of emails sent to project-supplied addresses (email notification
// channels). It exists for the limits only — rolling 24 h counts per address
// and per project — so it stores a hash of the address, never the address.
//
// Deliberately NOT wiped by the GDPR project erase: the per-address limit
// protects people who never signed up, and letting a project reset it by
// erasing its own data would reopen the hole. Rows are pruned after 2 days.

export type EmailSendKind = 'verify' | 'notify';

export const DAY_SEC = 86_400;
const RETENTION_SEC = 2 * DAY_SEC;

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function hashEmailAddress(address: string): string {
  return createHash('sha256').update(normalizeEmailAddress(address)).digest('hex');
}

export function countSendsToAddress(db: Db, addressHash: string, kind: EmailSendKind, since: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM email_sends WHERE address_hash = ? AND kind = ? AND sent_at > ?',
  ).get(addressHash, kind, since) as { c: number };
  return row.c;
}

export function countSendsByProject(db: Db, projectId: string, kind: EmailSendKind, since: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM email_sends WHERE project_id = ? AND kind = ? AND sent_at > ?',
  ).get(projectId, kind, since) as { c: number };
  return row.c;
}

export function recordEmailSend(
  db: Db,
  projectId: string,
  channelId: string,
  kind: EmailSendKind,
  addressHash: string,
  sentAt: number,
): number {
  const res = db.prepare(
    'INSERT INTO email_sends (project_id, channel_id, kind, address_hash, sent_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, channelId, kind, addressHash, sentAt);
  return Number(res.lastInsertRowid);
}

// A reservation is recorded before the SMTP call (so two concurrent requests
// cannot both pass the limit) and removed again when the send fails — a
// failed send reached nobody and must not eat into the limit.
export function deleteEmailSend(db: Db, id: number): void {
  db.prepare('DELETE FROM email_sends WHERE id = ?').run(id);
}

export function pruneEmailSends(db: Db, now: number): number {
  return db.prepare('DELETE FROM email_sends WHERE sent_at < ?').run(now - RETENTION_SEC).changes;
}

// Notification emails a project may send per rolling 24 h. Read on each call
// so tests (and operators) can change IMPRI_EMAIL_DAILY_CAP without a restart.
export function emailDailyCap(): number {
  const raw = Number(process.env.IMPRI_EMAIL_DAILY_CAP ?? 100);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100;
}

/**
 * Reserve one notification email against the project's daily cap.
 * Returns the reservation id, or null when the cap is reached.
 * Synchronous transaction: better-sqlite3 runs it without yielding, so the
 * count and the insert cannot interleave with another reservation.
 */
export function reserveNotifyEmail(
  db: Db,
  projectId: string,
  channelId: string,
  address: string,
  now: number,
): number | null {
  const reserve = db.transaction((): number | null => {
    if (countSendsByProject(db, projectId, 'notify', now - DAY_SEC) >= emailDailyCap()) return null;
    return recordEmailSend(db, projectId, channelId, 'notify', hashEmailAddress(address), now);
  });
  return reserve();
}
