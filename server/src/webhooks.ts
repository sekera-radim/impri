import { createHmac, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { genId, nowSec } from './db.js';

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

  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signoff-Signature': `sha256=${signature}`,
        'X-Signoff-Timestamp': String(timestamp),
        'X-Signoff-Nonce': nonce,
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

    await deliverWebhook(db, delivery.id, delivery.callback_url, event, webhookSecret);
  }
}

export async function runExpiryTick(db: Db, webhookSecret: string): Promise<void> {
  const now = nowSec();
  const expired = db.prepare(
    "SELECT * FROM actions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
  ).all(now) as Array<{ id: string; callback_url: string | null; project_id: string }>;

  for (const action of expired) {
    db.prepare(
      "UPDATE actions SET status = 'expired', updated_at = ? WHERE id = ?",
    ).run(now, action.id);

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, created_at) VALUES (?, ?, 'action.expired', ?)",
    ).run(action.project_id, action.id, now);

    if (action.callback_url) {
      scheduleWebhookDelivery(db, action.id, action.callback_url);
    }
  }

  // Also run webhook tick
  await runWebhookTick(db, webhookSecret);
}
