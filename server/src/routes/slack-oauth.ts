/**
 * Slack shared-app OAuth installation and interaction endpoints.
 *
 * Env-gated: SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_APP_SIGNING_SECRET
 * must all be set for install-url and callback to function; SLACK_APP_SIGNING_SECRET
 * alone is required for the shared interactions handler.
 *
 * Route registration order matters: this file's POST /v1/integrations/slack/interactions
 * (no param) MUST be registered BEFORE the per-channel route
 * POST /v1/integrations/slack/interactions/:channelId — enforced by calling
 * registerSlackOAuthRoutes before registerSlackInteractionRoutes in index.ts.
 */

import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import {
  buildSlackApprovalSig,
  verifySlackSignature,
  safeEqual,
} from '../notify.js';
import { fetchGuarded } from '../net-guard.js';
import { checkRateLimit, hasScope } from '../auth.js';
import { genId, nowSec } from '../db.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { commitInteractiveDecision } from '../interactive-decision.js';
import type { ActionRow } from '../interactive-decision.js';

// ---------------------------------------------------------------------------
// In-memory nonce store for OAuth state tokens.
// Nonces expire together with the state (15 min TTL); we prune on each mint.
// ---------------------------------------------------------------------------

const usedNonces = new Map<string, number>(); // nonce → expiry unix sec

function pruneNonces(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, exp] of usedNonces) {
    if (exp < now) usedNonces.delete(nonce);
  }
}

function mintStateToken(projectId: string, signingSecret: string): string {
  const exp = Math.floor(Date.now() / 1000) + 900; // 15 min
  const nonce = randomBytes(16).toString('hex');
  pruneNonces();
  usedNonces.set(nonce, exp);
  const payload = Buffer.from(JSON.stringify({ projectId, exp, nonce })).toString('base64url');
  const sig = createHmac('sha256', signingSecret).update(payload).digest().toString('base64url');
  return `${payload}.${sig}`;
}

function verifyStateToken(state: string, signingSecret: string): { projectId: string } | null {
  const dot = state.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  // Timing-safe signature check
  const expectedSig = createHmac('sha256', signingSecret).update(payload).digest().toString('base64url');
  if (!safeEqual(sig, expectedSig)) return null;
  let parsed: { projectId?: string; exp?: number; nonce?: string };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof parsed;
  } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!parsed.exp || parsed.exp < now) return null;
  if (!parsed.nonce || !usedNonces.has(parsed.nonce)) return null;
  // Consume nonce — replay protection
  usedNonces.delete(parsed.nonce);
  if (!parsed.projectId) return null;
  return { projectId: parsed.projectId };
}

// ---------------------------------------------------------------------------
// Stored shape of a shared-app Slack channel config
// ---------------------------------------------------------------------------

interface SharedSlackConfig {
  shared_app: true;
  approval_mode: true;
  bot_token: string;
  team_id: string;
  team_name: string;
  slack_channel_id: string;
  slack_channel_name: string;
  allowed_approver_slack_user_ids: string[];
  button_secret: string;
}

interface SharedSlackChannelRow {
  id: string;
  project_id: string;
  type: string;
  enabled: number;
  config: string; // JSON
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSlackOAuthRoutes(app: FastifyInstance, db: Db): void {
  const CLIENT_ID     = process.env.SLACK_CLIENT_ID ?? '';
  const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? '';
  const SIGNING_SECRET = process.env.SLACK_APP_SIGNING_SECRET ?? '';
  const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? '8484'}`;
  const APP_URL  = process.env.APP_URL ?? process.env.BASE_URL ?? 'http://localhost:5173';

  // All three secrets must be present for the OAuth-backed endpoints to work.
  const fullyConfigured = (): boolean =>
    Boolean(CLIENT_ID && CLIENT_SECRET && SIGNING_SECRET);

  // -------------------------------------------------------------------------
  // GET /v1/integrations/slack/app-info — public, no auth
  // Reports whether a shared Slack app is configured so the UI can show/hide
  // the Connect to Slack button without requiring authentication.
  // -------------------------------------------------------------------------
  app.get('/v1/integrations/slack/app-info', async (_request, reply) => {
    return reply.status(200).send({ available: Boolean(CLIENT_ID) });
  });

  // -------------------------------------------------------------------------
  // POST /v1/integrations/slack/install-url — Bearer auth, admin scope
  // Generates a Slack OAuth v2 install URL with a signed, replay-safe state token.
  // -------------------------------------------------------------------------
  app.post('/v1/integrations/slack/install-url', async (request, reply) => {
    if (!fullyConfigured()) {
      return reply.status(404).send({ error: 'Not configured' });
    }

    const key = request.apiKey;
    if (!key) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    if (!hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Rate limit: 10 per minute per API key
    if (!(await checkRateLimit(db, `sl_install:${key.keyId}`, 'sl_install', 10))) {
      return reply.status(429).send({ error: 'Rate limit exceeded' });
    }

    const redirectUri = `${BASE_URL}/v1/integrations/slack/oauth/callback`;
    const state = mintStateToken(key.projectId, SIGNING_SECRET);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'chat:write,incoming-webhook',
      redirect_uri: redirectUri,
      state,
    });

    const url = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    return reply.status(200).send({ url });
  });

  // -------------------------------------------------------------------------
  // GET /v1/integrations/slack/oauth/callback — public
  // Slack redirects here after the user authorizes the app.
  // On any error: 302 to APP_URL/?slack=error&reason=<token>.
  // On success:   302 to APP_URL/?slack=connected.
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/integrations/slack/oauth/callback',
    async (request, reply) => {
      if (!fullyConfigured()) {
        return reply.status(404).send({ error: 'Not configured' });
      }

      const errorRedirect = (reason: string) =>
        reply.redirect(`${APP_URL}/?slack=error&reason=${reason}`);

      const { code, state } = request.query;

      // Verify state token (CSRF + replay protection)
      if (!state) {
        return errorRedirect('invalid_state');
      }
      const stateData = verifyStateToken(state, SIGNING_SECRET);
      if (!stateData) {
        return errorRedirect('invalid_state');
      }

      if (!code) {
        return errorRedirect('exchange_failed');
      }

      const redirectUri = `${BASE_URL}/v1/integrations/slack/oauth/callback`;

      // Exchange authorization code for access token
      let exchangeData: Record<string, unknown>;
      try {
        const formBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        });

        const res = await fetchGuarded('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody.toString(),
          signal: AbortSignal.timeout(10_000),
        });

        exchangeData = await res.json() as Record<string, unknown>;
      } catch {
        return errorRedirect('exchange_failed');
      }

      if (exchangeData.ok !== true) {
        return errorRedirect('exchange_failed');
      }

      // Extract and validate required fields from the OAuth response
      const accessToken      = exchangeData.access_token;
      const team             = exchangeData.team as Record<string, unknown> | undefined;
      const incomingWebhook  = exchangeData.incoming_webhook as Record<string, unknown> | undefined;

      if (
        typeof accessToken !== 'string' ||
        typeof team?.id !== 'string' ||
        typeof team?.name !== 'string' ||
        typeof incomingWebhook?.channel_id !== 'string' ||
        typeof incomingWebhook?.channel !== 'string' ||
        typeof incomingWebhook?.url !== 'string'
      ) {
        return errorRedirect('missing_data');
      }

      const buttonSecret = randomBytes(32).toString('base64url');
      const channelId    = genId('ch_');
      const now          = nowSec();

      const channelConfig: SharedSlackConfig = {
        shared_app: true,
        approval_mode: true,
        bot_token: accessToken,
        team_id: team.id,
        team_name: team.name,
        slack_channel_id: incomingWebhook.channel_id,
        slack_channel_name: incomingWebhook.channel,
        allowed_approver_slack_user_ids: [],
        button_secret: buttonSecret,
      };

      try {
        db.prepare(`
          INSERT INTO notification_channels
            (id, project_id, name, type, enabled, config, digest_window_sec, created_at, updated_at)
          VALUES (?, ?, ?, 'slack', 1, ?, 60, ?, ?)
        `).run(
          channelId,
          stateData.projectId,
          `Slack (${team.name})`,
          JSON.stringify(channelConfig),
          now,
          now,
        );

        // Audit log: channel identity only — no secrets in data field.
        db.prepare(
          "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'channel.created', ?, ?, ?)",
        ).run(
          stateData.projectId,
          `oauth:${team.id}`,
          JSON.stringify({ channel_id: channelId, type: 'slack' }),
          now,
        );
      } catch {
        return errorRedirect('exchange_failed');
      }

      return reply.redirect(`${APP_URL}/?slack=connected`);
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/integrations/slack/interactions — public, shared app
  //
  // Handles button clicks from ALL shared-app Slack channels. Registered before
  // the per-channel route (/…/:channelId) so Fastify matches this exact path
  // first (no trailing param). Looks up the channel by team_id + slack_channel_id.
  // -------------------------------------------------------------------------
  app.post('/v1/integrations/slack/interactions', async (request, reply) => {
    // Silently accept when not configured — Slack retries on non-2xx.
    if (!SIGNING_SECRET) {
      return reply.status(200).send('');
    }

    const rawBody    = request.rawSlackBody ?? '';
    const receivedSig = String(request.headers['x-slack-signature'] ?? '');
    const receivedTs  = String(request.headers['x-slack-request-timestamp'] ?? '');

    // Verify Slack v0 HMAC-SHA256 request signature (replay window ≤ 5 min)
    if (!verifySlackSignature(rawBody, SIGNING_SECRET, receivedSig, receivedTs)) {
      return reply.status(403).send('');
    }

    // Parse the JSON payload from URL-encoded form body
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

    // Only handle block_actions; return 200 '' for all other interaction types
    if (payload.type !== 'block_actions') {
      return reply.status(200).send('');
    }

    const teamId = (payload.team as { id?: string } | undefined)?.id ?? '';

    // Rate limit: 100 req/min per team
    if (!(await checkRateLimit(db, `sl_shared:${teamId}`, 'sl_shared', 100))) {
      return reply.status(200).send('');
    }

    const slackChannelId = (payload.channel as { id?: string } | undefined)?.id ?? '';

    // Look up the shared-app channel matching this team + channel
    const channel = db.prepare(`
      SELECT id, project_id, type, enabled, config
      FROM notification_channels
      WHERE type = 'slack'
        AND enabled = 1
        AND json_extract(config, '$.shared_app') = 1
        AND json_extract(config, '$.team_id') = ?
        AND json_extract(config, '$.slack_channel_id') = ?
    `).get(teamId, slackChannelId) as SharedSlackChannelRow | undefined;

    if (!channel) {
      // No matching channel — not our event; acknowledge silently.
      return reply.status(200).send('');
    }

    const config = JSON.parse(channel.config) as SharedSlackConfig;

    // Extract action value: "{v}:{actionId}:{sig}"
    const actions     = payload.actions as Array<{ value?: string }> | undefined;
    const actionValue = actions?.[0]?.value ?? '';
    const parts       = actionValue.split(':');
    const actionIdRegex = /^act_[A-Za-z0-9_-]{22}$/;

    if (
      parts.length !== 3 ||
      !['a', 'r'].includes(parts[0]) ||
      !actionIdRegex.test(parts[1]) ||
      parts[2].length !== 8
    ) {
      // Malformed value — silently ignore (Slack expects 200)
      return reply.status(200).send('');
    }

    const [verdict, actionId, receivedButtonSig] = parts;

    // Verify button HMAC using the channel's dedicated button_secret
    const expectedButtonSig = buildSlackApprovalSig(String(config.button_secret), verdict, actionId);
    if (!safeEqual(receivedButtonSig, expectedButtonSig)) {
      return reply.status(200).send('');
    }

    const responseUrl = String(payload.response_url ?? '');
    // SSRF defense-in-depth: restrict response_url to the expected Slack domain
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

    // Authorize the clicking user against the channel's allowed-approver list
    const slackUser   = payload.user as { id?: string } | undefined;
    const slackUserId = String(slackUser?.id ?? '');
    const allowedIds  = config.allowed_approver_slack_user_ids ?? [];

    if (!slackUserId || !allowedIds.includes(slackUserId)) {
      await postToResponseUrl({
        response_type: 'ephemeral',
        text: '⛔ Not authorized to approve in this project',
      });
      return reply.status(200).send('');
    }

    // Load action — scoped to this channel's project (prevents cross-project decisions)
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

    // Commit decision (idempotent, project-scoped, first-writer-wins)
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

    // Trigger webhook delivery callback
    if (action.callback_url) {
      scheduleWebhookDelivery(db, actionId, action.callback_url);
    }

    // Replace the original message to show the outcome and remove buttons
    const newStatus    = outcome.newStatus;
    const outcomeIcon  = newStatus === 'approved' ? '✅' : '❌';
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
  });
}
