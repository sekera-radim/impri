/**
 * POST /v1/integrations/telegram/webhook/:channelId
 *
 * Public endpoint (no Bearer auth). Authentication is entirely via the
 * X-Telegram-Bot-Api-Secret-Token header, derived from the per-channel
 * hmac_secret.
 *
 * Four independent security layers (all must pass):
 *   1. X-Telegram-Bot-Api-Secret-Token header — derived from hmac_secret
 *      via HMAC-SHA256, compared with timingSafeEqual.
 *   2. callback_data HMAC signature — 6-byte (48-bit) truncated HMAC
 *      covering (v, actionId), preventing forged button clicks.
 *   3. allowed_approver_user_ids check — Telegram-enforced user identity.
 *   4. UNIQUE(action_id) constraint on decisions — first writer wins,
 *      concurrent duplicate taps are idempotent no-ops.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { checkRateLimit } from '../auth.js';
import { fetchGuarded } from '../net-guard.js';
import { deriveWebhookSecret, buildTelegramApprovalSig, safeEqual, htmlEscape } from '../notify.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { commitInteractiveDecision } from '../interactive-decision.js';
import type { ActionRow } from '../interactive-decision.js';

// ---------------------------------------------------------------------------
// Type shapes for Telegram Update JSON
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
}

// Shape of a stored telegram channel row
interface TelegramChannelRow {
  id: string;
  project_id: string;
  type: string;
  enabled: number;
  config: string; // JSON
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers — best-effort, failures only logged
// ---------------------------------------------------------------------------

async function answerCallbackQuery(
  botToken: string,
  cbQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await fetchGuarded(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cbQueryId, text, show_alert: showAlert }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

async function editMessageAfterDecision(
  botToken: string,
  chatId: number,
  messageId: number,
  originalText: string,
  verdict: string,
  firstName: string,
): Promise<void> {
  const suffix = verdict === 'a'
    ? `\n\n— ✅ Approved by ${htmlEscape(firstName)}`
    : `\n\n— ❌ Rejected by ${htmlEscape(firstName)}`;

  await fetchGuarded(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: originalText + suffix,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }, // removes buttons
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTelegramWebhookRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { channelId: string } }>(
    '/v1/integrations/telegram/webhook/:channelId',
    async (request, reply) => {
      const { channelId } = request.params;

      // Rate limit: 100 req/min per channelId (stops scanner enumeration).
      if (!(await checkRateLimit(db, `tg_webhook:${channelId}`, 'tg_webhook', 100))) {
        return reply.status(429).send('');
      }

      // --- Step 1: Load channel ---
      const channel = db.prepare(
        "SELECT id, project_id, type, enabled, config FROM notification_channels WHERE id = ? AND type = 'telegram' AND enabled = 1",
      ).get(channelId) as TelegramChannelRow | undefined;

      // Return 404 for non-existent or non-approval channels to avoid
      // revealing existence of channels that have approval_mode disabled.
      if (!channel) {
        return reply.status(404).send('');
      }

      const config = JSON.parse(channel.config) as Record<string, unknown>;

      // Only approval-mode channels expose this webhook.
      if (config.approval_mode !== true) {
        return reply.status(404).send('');
      }

      // --- Step 2–4: Verify X-Telegram-Bot-Api-Secret-Token ---
      const hmacSecret = String(config.hmac_secret ?? '');
      const expectedToken = deriveWebhookSecret(hmacSecret);
      const receivedToken = String(
        (request.headers as Record<string, string | string[] | undefined>)['x-telegram-bot-api-secret-token'] ?? '',
      );

      if (!receivedToken || !safeEqual(receivedToken, expectedToken)) {
        return reply.status(403).send('');
      }

      // --- Step 5: Parse update body ---
      // Body was already parsed as JSON by the global content-type parser.
      const update = request.body as TelegramUpdate;

      if (!update.callback_query) {
        // Telegram expects 200 for all update types, even those we ignore.
        return reply.status(200).send('');
      }

      const cq = update.callback_query;
      const cbQueryId = cq.id;
      const userId = cq.from.id;
      const cbData = cq.data ?? '';

      // --- Step 7: Parse and shape-validate callback_data ---
      const parts = cbData.split(':');
      const actionIdRegex = /^act_[A-Za-z0-9_-]{22}$/;

      if (
        parts.length !== 3 ||
        !['a', 'r'].includes(parts[0]) ||
        !actionIdRegex.test(parts[1]) ||
        parts[2].length !== 8
      ) {
        await answerCallbackQuery(String(config.bot_token), cbQueryId, 'Invalid request');
        return reply.status(200).send('');
      }

      const [verdict, actionId, receivedSig] = parts;

      // --- Step 8: Verify HMAC signature on callback_data ---
      const expectedSig = buildTelegramApprovalSig(hmacSecret, verdict, actionId);
      if (!safeEqual(receivedSig, expectedSig)) {
        await answerCallbackQuery(
          String(config.bot_token), cbQueryId,
          'Invalid or expired approval link', true,
        );
        return reply.status(200).send('');
      }

      // --- Step 9: Check authorized user ---
      const allowedIds = (config.allowed_approver_user_ids as number[] | undefined) ?? [];
      if (!allowedIds.includes(userId)) {
        await answerCallbackQuery(
          String(config.bot_token), cbQueryId,
          '⛔ Not authorized to approve in this project', true,
        );
        return reply.status(200).send('');
      }

      // --- Step 10: Load action — scoped to channel's project ---
      const action = db.prepare(
        'SELECT id, project_id, status, preview, callback_url FROM actions WHERE id = ? AND project_id = ?',
      ).get(actionId, channel.project_id) as ActionRow | undefined;

      if (!action) {
        await answerCallbackQuery(String(config.bot_token), cbQueryId, 'Action not found');
        return reply.status(200).send('');
      }

      // --- Steps 11–13: Idempotent decision commit via shared helper ---
      const tgName = cq.from.username ? `@${cq.from.username}` : cq.from.first_name;
      const outcome = commitInteractiveDecision(
        db,
        action,
        verdict as 'a' | 'r',
        `tg:${userId}`,
        'telegram',
        channel.project_id,
        request.ip ?? null,
        tgName ? `${tgName} (Telegram)` : `tg:${userId}`,
      );

      switch (outcome.kind) {
        case 'already_decided':
          await answerCallbackQuery(
            String(config.bot_token), cbQueryId,
            `Already decided: ${outcome.currentStatus}`,
          );
          return reply.status(200).send('');
        case 'concurrent':
          await answerCallbackQuery(String(config.bot_token), cbQueryId, 'Already decided');
          return reply.status(200).send('');
        default:
          // 'ok' — fall through
      }

      // --- Step 14: Schedule webhook delivery ---
      if (action.callback_url) {
        scheduleWebhookDelivery(db, actionId, action.callback_url);
      }

      // --- Step 15: Answer the callback query ---
      const newStatus = outcome.newStatus;
      const answerText = newStatus === 'approved' ? 'Approved ✅' : 'Rejected ❌';
      await answerCallbackQuery(String(config.bot_token), cbQueryId, answerText, false);

      // --- Step 16: Edit original message to show outcome (best-effort) ---
      const firstName = cq.from.first_name;
      const msg = cq.message;
      if (msg) {
        await editMessageAfterDecision(
          String(config.bot_token),
          msg.chat.id,
          msg.message_id,
          msg.text ?? '',
          newStatus === 'approved' ? 'a' : 'r',
          firstName,
        );
      }

      return reply.status(200).send('');
    },
  );
}
