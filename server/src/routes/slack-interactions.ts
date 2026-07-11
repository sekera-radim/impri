/**
 * POST /v1/integrations/slack/interactions/:channelId
 *
 * Public endpoint (no Bearer auth). Authentication is entirely via the
 * Slack v0 HMAC-SHA256 request signature scheme.
 *
 * Five independent security layers (all must pass):
 *   1. X-Slack-Signature header — v0 HMAC-SHA256 over rawBody + timestamp,
 *      compared with timingSafeEqual. Timestamp window ≤ 5 minutes (replay).
 *   2. Button value HMAC — 6-byte (48-bit) truncated HMAC covering (v, actionId)
 *      with "sl:" prefix, preventing forged button clicks.
 *   3. allowed_approver_slack_user_ids check — Slack-enforced user identity.
 *   4. project_id binding — action lookup uses channel.project_id.
 *   5. UNIQUE(action_id) constraint on decisions — first writer wins.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { checkRateLimit } from '../auth.js';
import { fetchGuarded } from '../net-guard.js';
import {
  buildSlackApprovalSig,
  verifySlackSignature,
  safeEqual,
} from '../notify.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { commitInteractiveDecision } from '../interactive-decision.js';
import type { ActionRow } from '../interactive-decision.js';

// Shape of a stored slack channel row
interface SlackChannelRow {
  id: string;
  project_id: string;
  type: string;
  enabled: number;
  config: string; // JSON
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSlackInteractionRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { channelId: string } }>(
    '/v1/integrations/slack/interactions/:channelId',
    async (request, reply) => {
      const { channelId } = request.params;

      // 1. Rate limit: 100 req/min per channelId (stops scanner enumeration).
      if (!(await checkRateLimit(db, `sl_interactions:${channelId}`, 'sl_interactions', 100))) {
        return reply.status(429).send('');
      }

      // 2. Load channel — must be slack, enabled, approval_mode.
      const channel = db.prepare(
        "SELECT id, project_id, type, enabled, config FROM notification_channels WHERE id = ? AND type = 'slack' AND enabled = 1",
      ).get(channelId) as SlackChannelRow | undefined;

      if (!channel) {
        return reply.status(404).send('');
      }

      const config = JSON.parse(channel.config) as Record<string, unknown>;

      if (config.approval_mode !== true) {
        return reply.status(404).send('');
      }

      // 3. Verify Slack request signature (Layer 1).
      // rawSlackBody is set by the global application/x-www-form-urlencoded parser.
      const rawBody = request.rawSlackBody ?? '';
      const receivedSig = String(request.headers['x-slack-signature'] ?? '');
      const receivedTs  = String(request.headers['x-slack-request-timestamp'] ?? '');

      if (!verifySlackSignature(rawBody, String(config.signing_secret), receivedSig, receivedTs)) {
        return reply.status(403).send('');
      }

      // 4. Parse the JSON payload from the URL-encoded form body.
      const payloadStr = new URLSearchParams(rawBody).get('payload');
      if (!payloadStr) {
        return reply.status(200).send('');
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>;
      } catch {
        return reply.status(200).send('');
      }

      // 5. Only handle block_actions; return 200 '' for all other event types.
      if (payload.type !== 'block_actions') {
        return reply.status(200).send('');
      }

      // 6. Extract first action value: "{v}:{actionId}:{sig}".
      const actions = payload.actions as Array<{ value?: string }> | undefined;
      const actionValue = actions?.[0]?.value ?? '';
      const parts = actionValue.split(':');
      const actionIdRegex = /^act_[A-Za-z0-9_-]{22}$/;

      if (
        parts.length !== 3 ||
        !['a', 'r'].includes(parts[0]) ||
        !actionIdRegex.test(parts[1]) ||
        parts[2].length !== 8
      ) {
        // Malformed — silently ignore (Slack expects 200).
        return reply.status(200).send('');
      }

      const [verdict, actionId, receivedButtonSig] = parts;

      // 7. Verify button HMAC (Layer 2).
      const expectedButtonSig = buildSlackApprovalSig(String(config.signing_secret), verdict, actionId);
      if (!safeEqual(receivedButtonSig, expectedButtonSig)) {
        return reply.status(200).send('');
      }

      // Capture response_url for sending ephemeral replies and the final update.
      const responseUrl = String(payload.response_url ?? '');
      // Validate response_url before use — SSRF defense-in-depth (the payload is
      // already Slack-signed, so this is a secondary guard).
      const responseUrlValid = /^https:\/\/hooks\.slack\.com\//.test(responseUrl);

      async function postToResponseUrl(body: unknown): Promise<void> {
        if (!responseUrlValid) return;
        await fetchGuarded(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
      }

      // 8. Authorize user (Layer 3).
      // payload.user.id is set by Slack's servers from the authenticated session
      // of whoever clicked; non-spoofable after Layer 1 passes.
      const slackUser = payload.user as { id?: string } | undefined;
      const slackUserId = String(slackUser?.id ?? '');
      const allowedIds = (config.allowed_approver_slack_user_ids as string[] | undefined) ?? [];

      if (!slackUserId || !allowedIds.includes(slackUserId)) {
        await postToResponseUrl({
          response_type: 'ephemeral',
          text: '⛔ Not authorized to approve in this project',
        });
        return reply.status(200).send('');
      }

      // 9. Load action — scoped to channel's project (Layer 4).
      const action = db.prepare(
        'SELECT id, project_id, status, preview, callback_url FROM actions WHERE id = ? AND project_id = ?',
      ).get(actionId, channel.project_id) as ActionRow | undefined;

      if (!action) {
        await postToResponseUrl({
          response_type: 'ephemeral',
          text: 'Action not found',
        });
        return reply.status(200).send('');
      }

      // 10–12. Commit decision via shared helper (idempotent, project-scoped).
      const outcome = commitInteractiveDecision(
        db,
        action,
        verdict as 'a' | 'r',
        `sl:${slackUserId}`,
        'slack',
        channel.project_id,
        request.ip ?? null,
      );

      if (outcome.kind === 'already_decided' || outcome.kind === 'concurrent') {
        const status = outcome.kind === 'already_decided' ? outcome.currentStatus : 'unknown';
        await postToResponseUrl({
          response_type: 'ephemeral',
          text: `Already decided: ${status}`,
        });
        return reply.status(200).send('');
      }

      // 13. Schedule webhook delivery.
      if (action.callback_url) {
        scheduleWebhookDelivery(db, actionId, action.callback_url);
      }

      // 14. Update the original message to show outcome and remove buttons.
      const newStatus = outcome.newStatus;
      const outcomeIcon = newStatus === 'approved' ? '✅' : '❌';
      const outcomeLabel = newStatus === 'approved' ? 'Approved' : 'Rejected';

      await postToResponseUrl({
        replace_original: true,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${outcomeIcon} *${outcomeLabel}* by <@${slackUserId}>`,
            },
          },
        ],
      });

      return reply.status(200).send('');
    },
  );
}
