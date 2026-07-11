/**
 * Shared interactive-decision helper — used by Telegram, Slack, and Discord
 * approval webhook handlers.
 *
 * Callers are responsible for:
 *   - Verifying the platform signature before calling this.
 *   - Checking authorized user IDs before calling this.
 *   - Loading the action with WHERE project_id = channel.project_id before
 *     calling this.
 *   - Calling scheduleWebhookDelivery(db, actionId, callbackUrl) on 'ok'.
 */

import type { Db } from './db.js';
import { genId, nowSec } from './db.js';

export interface ActionRow {
  id: string;
  project_id: string;
  status: string;
  preview: string;  // JSON
  callback_url: string | null;
}

export type DecisionOutcome =
  | { kind: 'ok'; newStatus: 'approved' | 'rejected' }
  | { kind: 'already_decided'; currentStatus: string }
  | { kind: 'concurrent' };

/**
 * Project-scoped, idempotent decision commit shared by Telegram, Slack, and
 * Discord interactive approval handlers.
 *
 * Returns:
 *   'ok'              — decision committed; newStatus is 'approved' or 'rejected'.
 *   'already_decided' — action.status was not 'pending'; currentStatus is the
 *                       existing state.
 *   'concurrent'      — UNIQUE(action_id) violation; another request won the
 *                       race. Callers treat this as "already decided".
 */
export function commitInteractiveDecision(
  db: Db,
  action: ActionRow,
  verdict: 'a' | 'r',
  decidedBy: string,   // "tg:{userId}" | "sl:{slackUserId}" | "dc:{discordUserId}"
  channel: string,     // 'telegram' | 'slack' | 'discord'
  projectId: string,
  requestIp: string | null,
): DecisionOutcome {
  if (action.status !== 'pending') {
    return { kind: 'already_decided', currentStatus: action.status };
  }

  const now = nowSec();
  const decisionId = genId('dec_');
  const newStatus = verdict === 'a' ? 'approved' : 'rejected';
  const dbVerdict = verdict === 'a' ? 'approve' : 'reject';
  const eventName = verdict === 'a' ? 'action.approved' : 'action.rejected';
  const finalPreview = JSON.parse(action.preview) as object;

  const commit = db.transaction(() => {
    db.prepare(`
      INSERT INTO decisions (id, action_id, verdict, decided_by, decided_at, channel, final_preview, diff)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(decisionId, action.id, dbVerdict, decidedBy, now, channel, JSON.stringify(finalPreview));
    db.prepare(
      'UPDATE actions SET status = ?, updated_at = ? WHERE id = ?',
    ).run(newStatus, now, action.id);
    db.prepare(
      'INSERT INTO audit_log (project_id, action_id, event, actor, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(projectId, action.id, eventName, decidedBy, channel, now);
    // IP is PII — separate erasable table (PLAYBOOK F), not the immutable audit trail.
    db.prepare(
      'INSERT INTO pii_log (project_id, action_id, event, ip, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectId, action.id, eventName, requestIp, now);
  });

  try {
    commit();
    return { kind: 'ok', newStatus: newStatus as 'approved' | 'rejected' };
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return { kind: 'concurrent' };
    }
    throw err;
  }
}
