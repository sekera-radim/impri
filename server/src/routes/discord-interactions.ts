/**
 * POST /v1/integrations/discord/interactions/:channelId
 *
 * Public endpoint (no Bearer auth). Authentication is entirely via the
 * Discord Ed25519 request signature scheme.
 *
 * Five independent security layers (all must pass):
 *   1. X-Signature-Ed25519 header — Ed25519 over timestamp + rawBody,
 *      verified with the channel's public_key. Constant-time by algorithm.
 *   2. Button custom_id HMAC — 6-byte (48-bit) truncated HMAC covering
 *      (v, actionId) with "dc:" prefix, preventing forged button clicks.
 *   3. allowed_approver_discord_user_ids check — Discord-enforced user identity.
 *   4. project_id binding — action lookup uses channel.project_id.
 *   5. UNIQUE(action_id) constraint on decisions — first writer wins.
 *
 * Discord sends a PING (type 1) immediately when the endpoint URL is saved in
 * the Developer Portal. The Ed25519 check MUST run on PING too — Discord verifies
 * both that we return {"type":1} AND that the signature response is valid.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { checkRateLimit } from '../auth.js';
import {
  buildDiscordApprovalSig,
  verifyDiscordSignature,
  safeEqual,
} from '../notify.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { commitInteractiveDecision } from '../interactive-decision.js';
import type { ActionRow } from '../interactive-decision.js';

// Discord interaction types we handle
const DISCORD_PING = 1;
const DISCORD_MESSAGE_COMPONENT = 3;

// Discord interaction response types
const DISCORD_PONG = 1;
const DISCORD_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_UPDATE_MESSAGE = 7;

// Discord message flags
const DISCORD_EPHEMERAL = 64;

// Shape of a stored discord channel row
interface DiscordChannelRow {
  id: string;
  project_id: string;
  type: string;
  enabled: number;
  config: string; // JSON
}

// Interaction payload shapes
interface DiscordInteractionUser {
  id?: string;
  username?: string;
}

interface DiscordInteraction {
  type?: number;
  data?: {
    custom_id?: string;
    component_type?: number;
  };
  member?: {
    user?: DiscordInteractionUser;
  };
  user?: DiscordInteractionUser;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDiscordInteractionRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { channelId: string } }>(
    '/v1/integrations/discord/interactions/:channelId',
    async (request, reply) => {
      const { channelId } = request.params;

      // 1. Rate limit: 100 req/min per channelId (stops scanner enumeration).
      if (!(await checkRateLimit(db, `dc_interactions:${channelId}`, 'dc_interactions', 100))) {
        return reply.status(429).send('');
      }

      // 2. Load channel — must be discord, enabled, approval_mode.
      // NOTE: We do this BEFORE signature verification so we can get public_key,
      // but we return 401 on auth failure either way (not 404) to prevent
      // enumeration. Unloaded channels → missing public_key → invalid sig → 401.
      const channel = db.prepare(
        "SELECT id, project_id, type, enabled, config FROM notification_channels WHERE id = ? AND type = 'discord' AND enabled = 1",
      ).get(channelId) as DiscordChannelRow | undefined;

      const config = channel
        ? (JSON.parse(channel.config) as Record<string, unknown>)
        : null;

      // If channel not found or not approval-mode, we still must verify the
      // signature (with a dummy key that will fail) to prevent timing attacks.
      // Discord expects 401 for failed verification, not 404.
      const publicKey = String(config?.public_key ?? '');

      // 3. Verify Ed25519 signature — MUST run on every request, including PING.
      // Discord checks this during endpoint setup (Developer Portal → Save).
      const sigHex = String(request.headers['x-signature-ed25519'] ?? '');
      const sigTs  = String(request.headers['x-signature-timestamp'] ?? '');

      if (!sigHex || !sigTs) {
        return reply.status(401).send('invalid request signature');
      }

      // rawBody is set by the global application/json content-type parser.
      const rawBodyStr = request.rawBody?.toString('utf-8') ?? '';
      const sigValid = await verifyDiscordSignature(publicKey, sigHex, sigTs, rawBodyStr);

      if (!sigValid) {
        return reply.status(401).send('invalid request signature');
      }

      // Signature verified — now we can return meaningful status codes.
      if (!channel || config?.approval_mode !== true) {
        // Signature verified but channel unknown/not in approval mode — always
        // return PONG so Discord endpoint registration succeeds without leaking
        // channel existence (prevents enumeration; same 200+PONG for all types).
        return reply.status(200).send({ type: DISCORD_PONG });
      }

      // 4. Parse the verified body.
      const interaction = request.body as DiscordInteraction;

      // 5. PING → PONG (Discord endpoint verification).
      if (interaction.type === DISCORD_PING) {
        return reply.status(200).send({ type: DISCORD_PONG });
      }

      // 6. Only handle MESSAGE_COMPONENT (type 3).
      if (interaction.type !== DISCORD_MESSAGE_COMPONENT) {
        return reply.status(200).send({ type: DISCORD_PONG });
      }

      // 7. Extract custom_id: "{v}:{actionId}:{sig}".
      const customId = String(interaction.data?.custom_id ?? '');
      const parts = customId.split(':');
      const actionIdRegex = /^act_[A-Za-z0-9_-]{22}$/;

      if (
        parts.length !== 3 ||
        !['a', 'r'].includes(parts[0]) ||
        !actionIdRegex.test(parts[1]) ||
        parts[2].length !== 8
      ) {
        return reply.status(200).send({
          type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '⛔ Invalid or expired approval link',
            flags: DISCORD_EPHEMERAL,
          },
        });
      }

      const [verdict, actionId, receivedButtonSig] = parts;

      // 8. Verify button HMAC (Layer 2).
      const expectedButtonSig = buildDiscordApprovalSig(String(config.hmac_secret), verdict, actionId);
      if (!safeEqual(receivedButtonSig, expectedButtonSig)) {
        return reply.status(200).send({
          type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '⛔ Invalid or expired approval link',
            flags: DISCORD_EPHEMERAL,
          },
        });
      }

      // 9. Authorize user (Layer 3).
      // member.user.id for guild interactions; user.id for DM interactions.
      // Set by Discord's infrastructure — non-spoofable after Layer 1 passes.
      const discordUserId = String(
        interaction.member?.user?.id ?? interaction.user?.id ?? '',
      );
      const allowedIds = (config.allowed_approver_discord_user_ids as string[] | undefined) ?? [];

      if (!discordUserId || !allowedIds.includes(discordUserId)) {
        return reply.status(200).send({
          type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '⛔ Not authorized to approve in this project',
            flags: DISCORD_EPHEMERAL,
          },
        });
      }

      // 10. Load action — scoped to channel's project (Layer 4).
      const action = db.prepare(
        'SELECT id, project_id, status, preview, callback_url FROM actions WHERE id = ? AND project_id = ?',
      ).get(actionId, channel.project_id) as ActionRow | undefined;

      if (!action) {
        return reply.status(200).send({
          type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Action not found',
            flags: DISCORD_EPHEMERAL,
          },
        });
      }

      // 11–13. Commit decision via shared helper (idempotent, project-scoped).
      const outcome = commitInteractiveDecision(
        db,
        action,
        verdict as 'a' | 'r',
        `dc:${discordUserId}`,
        'discord',
        channel.project_id,
        request.ip ?? null,
      );

      if (outcome.kind === 'already_decided' || outcome.kind === 'concurrent') {
        const status = outcome.kind === 'already_decided' ? outcome.currentStatus : 'unknown';
        return reply.status(200).send({
          type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `Already decided: ${status}`,
            flags: DISCORD_EPHEMERAL,
          },
        });
      }

      // 14. Schedule webhook delivery.
      if (action.callback_url) {
        scheduleWebhookDelivery(db, actionId, action.callback_url);
      }

      // 15. Respond with UPDATE_MESSAGE (type 7) to replace the original message.
      // Must return within 3 seconds — SQLite is synchronous so no async latency.
      const newStatus = outcome.newStatus;
      const outcomeTitle = newStatus === 'approved' ? '✅ Approved' : '❌ Rejected';
      const outcomeColor = newStatus === 'approved' ? 3066993 : 15158332;

      return reply.status(200).send({
        type: DISCORD_UPDATE_MESSAGE,
        data: {
          embeds: [
            {
              title: outcomeTitle,
              description: `Decision by <@${discordUserId}>`,
              color: outcomeColor,
            },
          ],
          components: [], // removes the buttons
        },
      });
    },
  );
}
