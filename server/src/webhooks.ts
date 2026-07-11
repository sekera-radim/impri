import { createHmac, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { genId, nowSec } from './db.js';
import { assertPublicUrl, fetchGuarded } from './net-guard.js';

// Retry schedule in seconds after first attempt
const RETRY_DELAYS = [60, 300, 1500, 7200, 43200]; // 1m, 5m, 25m, 2h, 12h

export function signWebhookBody(secret: string, body: string, timestamp: number, nonce: string): string {
  const payload = `${timestamp}.${nonce}.${body}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export interface WebhookEvent {
  event: string;
  action_id: string;
  status: string;
  decided_at?: number;
  verdict?: string;
  final_preview?: unknown;
  diff?: string | null;
}

export async function deliverWebhook(
  db: Db,
  deliveryId: string,
  callbackUrl: string,
  event: WebhookEvent,
  webhookSecret: string,
): Promise<boolean> {
  const body = JSON.stringify(event);
  const timestamp = nowSec();
  const nonce = randomBytes(8).toString('hex');
  const signature = signWebhookBody(webhookSecret, body, timestamp, nonce);

  // SSRF: never POST to a private/link-local address. A blocked target can
  // never become deliverable, so DLQ it immediately rather than retrying.
  try {
    await assertPublicUrl(callbackUrl);
  } catch (guardErr) {
    const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
    db.prepare(
      "UPDATE webhook_deliveries SET status = 'dlq', last_attempt_at = ?, last_error = ? WHERE id = ?",
    ).run(nowSec(), `SSRF blocked: ${msg}`, deliveryId);
    return false;
  }

  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const res = await fetchGuarded(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Impri-Signature': `sha256=${signature}`,
        'X-Impri-Timestamp': String(timestamp),
        'X-Impri-Nonce': nonce,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;

    if (res.status === 410) {
      // Agent deregistered — deactivate callback
      db.prepare(
        "UPDATE webhook_deliveries SET status = 'gone', last_status_code = ?, last_attempt_at = ? WHERE id = ?",
      ).run(410, nowSec(), deliveryId);
      db.prepare(
        "UPDATE actions SET callback_url = NULL WHERE id = (SELECT action_id FROM webhook_deliveries WHERE id = ?)",
      ).run(deliveryId);
      return false;
    }

    if (res.ok) {
      db.prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', last_status_code = ?, last_attempt_at = ? WHERE id = ?",
      ).run(statusCode, nowSec(), deliveryId);
      return true;
    }

    // Non-2xx — schedule retry
    error = `HTTP ${statusCode}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Determine current attempt number
  const delivery = db.prepare('SELECT attempt FROM webhook_deliveries WHERE id = ?').get(deliveryId) as
    | { attempt: number }
    | undefined;
  const attempt = (delivery?.attempt ?? 0) + 1;

  if (attempt >= RETRY_DELAYS.length + 1) {
    // Exhausted all retries → DLQ
    db.prepare(
      "UPDATE webhook_deliveries SET status = 'dlq', attempt = ?, last_attempt_at = ?, last_error = ?, last_status_code = ? WHERE id = ?",
    ).run(attempt, nowSec(), error, statusCode ?? null, deliveryId);
    return false;
  }

  const nextAt = nowSec() + RETRY_DELAYS[attempt - 1];
  db.prepare(
    "UPDATE webhook_deliveries SET status = 'retry', attempt = ?, next_attempt_at = ?, last_attempt_at = ?, last_error = ?, last_status_code = ? WHERE id = ?",
  ).run(attempt, nextAt, nowSec(), error, statusCode ?? null, deliveryId);
  return false;
}

export function scheduleWebhookDelivery(db: Db, actionId: string, callbackUrl: string): void {
  const id = genId('wdel_');
  db.prepare(
    'INSERT INTO webhook_deliveries (id, action_id, callback_url, status, attempt, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, actionId, callbackUrl, 'pending', 0, nowSec(), nowSec());
}

export async function runWebhookTick(db: Db, webhookSecret: string): Promise<void> {
  const now = nowSec();
  const due = db.prepare(
    "SELECT * FROM webhook_deliveries WHERE status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
  ).all(now) as Array<{
    id: string;
    action_id: string;
    callback_url: string;
    attempt: number;
  }>;

  for (const delivery of due) {
    // Build event payload from action + decision
    const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(delivery.action_id) as
      Record<string, unknown> | undefined;
    if (!action) continue;

    // Sign with the project's own secret so a receiver can verify, and so one
    // tenant's leaked secret can't forge another's webhooks. Fall back to the
    // instance secret for rows created before per-project secrets existed.
    const project = db.prepare('SELECT webhook_secret FROM projects WHERE id = ?').get(action.project_id) as
      { webhook_secret: string | null } | undefined;
    const secret = project?.webhook_secret ?? webhookSecret;

    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(delivery.action_id) as
      Record<string, unknown> | undefined;

    const event: WebhookEvent = {
      event: 'action.updated',
      action_id: delivery.action_id,
      status: action.status as string,
      ...(decision && {
        decided_at: decision.decided_at as number,
        verdict: decision.verdict as string,
        final_preview: decision.final_preview ? JSON.parse(decision.final_preview as string) : undefined,
        diff: decision.diff as string | null,
      }),
    };

    await deliverWebhook(db, delivery.id, delivery.callback_url, event, secret);
  }
}

/**
 * Prune old audit_log and pii_log rows.
 *
 * Opt-in: no-op when AUDIT_RETENTION_DAYS is unset (self-host default = unlimited).
 * PII_RETENTION_DAYS independently controls pii_log (defaults to AUDIT_RETENTION_DAYS).
 * Safe to call as often as the expiry tick (60 s) — SQLite DELETE is fast on small
 * result sets and is a no-op when no rows are older than the cutoff.
 */
export function pruneAuditLogs(db: Db): void {
  const auditDays = parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10);
  if (auditDays > 0) {
    const cutoff = nowSec() - auditDays * 86400;
    db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
  }

  const piiDays = parseInt(
    process.env.PII_RETENTION_DAYS ?? (auditDays > 0 ? String(auditDays) : ''),
    10,
  );
  if (piiDays > 0) {
    const piiCutoff = nowSec() - piiDays * 86400;
    db.prepare('DELETE FROM pii_log WHERE created_at < ?').run(piiCutoff);
  }
}

export async function runExpiryTick(db: Db, webhookSecret: string): Promise<void> {
  const now = nowSec();
  const expired = db.prepare(
    "SELECT * FROM actions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
  ).all(now) as Array<{ id: string; callback_url: string | null; project_id: string }>;

  // Expire atomically with a status guard: a concurrent approve/reject that
  // commits between our SELECT and UPDATE must win (TOCTOU) — otherwise we'd
  // overwrite an approved action with 'expired' and desync it from its
  // recorded decision. PLAYBOOK A1/A2.
  const expireOne = db.transaction((a: { id: string; project_id: string }): boolean => {
    const res = db.prepare(
      "UPDATE actions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'",
    ).run(now, a.id);
    if (res.changes === 0) return false; // already decided — leave it alone
    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, created_at) VALUES (?, ?, 'action.expired', ?)",
    ).run(a.project_id, a.id, now);
    return true;
  });

  for (const action of expired) {
    const didExpire = expireOne(action);
    if (didExpire && action.callback_url) {
      scheduleWebhookDelivery(db, action.id, action.callback_url);
    }
  }

  // Also run webhook tick
  await runWebhookTick(db, webhookSecret);

  // Prune old audit/PII rows (opt-in — no-op when retention env vars are unset).
  pruneAuditLogs(db);
}
