import './types.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createDb } from './db.js';
import { verifyApiKey, bootstrapAdminKey } from './auth.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerWatcherRoutes } from './routes/watchers.js';
import { registerProjectRoutes } from './routes/project.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSignupRoutes } from './routes/signup.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerWatcherPresetRoutes } from './routes/watcherPresets.js';
import { registerNotificationChannelRoutes } from './routes/notification-channels.js';
import { registerTelegramWebhookRoutes } from './routes/telegram-webhook.js';
import { registerSlackOAuthRoutes } from './routes/slack-oauth.js';
import { registerSlackInteractionRoutes } from './routes/slack-interactions.js';
import { registerDiscordInteractionRoutes } from './routes/discord-interactions.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerRecoveryRoutes } from './routes/recovery.js';
import { billingActive } from './billing.js';
import { pushEnabled } from './push.js';
import { runExpiryTick } from './webhooks.js';
import { runChannelDigestTick } from './notify.js';
import { runWatcherTick, startWatcherScheduler } from './scheduler.js';
import { buildOpenApiDocument } from './openapi.js';
import { initMetrics, renderMetrics, incCounter, obsHistogram } from './metrics.js';
import { safeEqual } from './notify.js';
import type { Db } from './db.js';

// Read package version once at startup (no dynamic import needed — we embed it).
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require('../package.json') as { version: string }).version;

const DB_PATH = process.env.DB_PATH ?? 'impri.db';
const PORT = Number(process.env.PORT ?? 8484);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'change-me-in-production';

// Initialize metrics definitions once at module load — idempotent.
initMetrics();

export async function createApp(db: Db) {
  const app = Fastify({
    logger: {
      // Never log the Authorization header — it carries the raw API key.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // CORS only when a hosted web inbox on another origin needs to reach this API
  // (e.g. app.impri.dev → api.impri.dev). Restricted to the configured origins;
  // unset = same-origin only. Bearer auth, no cookies.
  const corsOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (corsOrigins.length > 0) {
    await app.register(cors, {
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });
  }

  // Keep the raw body on every JSON request (Stripe webhook signature needs
  // the exact bytes) while still exposing the parsed object to routes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Slack interaction events arrive as application/x-www-form-urlencoded.
  // Store the raw string before any parsing so the v0 HMAC signature
  // verification in the interactions route can cover the exact bytes received.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawSlackBody = body as string;
    // Return empty object — the route handler parses the payload field itself.
    done(null, {});
  });

  // ---------------------------------------------------------------------------
  // /metrics — Prometheus text exposition format.
  // Opt-in: only registered when METRICS_ENABLED=1.
  // Auth: optional METRICS_TOKEN bearer (timing-safe comparison).
  // Registered BEFORE the global auth preHandler so it handles auth itself.
  // ---------------------------------------------------------------------------
  if (process.env.METRICS_ENABLED === '1') {
    app.get('/metrics', async (request, reply) => {
      const token = process.env.METRICS_TOKEN;
      if (token) {
        const auth = (request.headers.authorization ?? '') as string;
        const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        if (!safeEqual(bearer, token)) {
          return reply.status(401).header('Content-Type', 'text/plain').send('Unauthorized\n');
        }
      }
      const body = renderMetrics(db, PKG_VERSION, DB_PATH);
      return reply
        .status(200)
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(body);
    });
  }

  // ---------------------------------------------------------------------------
  // /readyz — readiness probe (distinct from /healthz liveness probe).
  // Public: no auth. Returns pass/fail per named check; no query content or
  // secrets in any field.
  // ---------------------------------------------------------------------------
  app.get('/readyz', async (_, reply) => {
    const checks: Record<string, string> = {};
    let hasError = false;
    let errorMsg: string | undefined;

    // 1. DB reachable — verifies the file is open and WAL is not corrupted.
    try {
      db.prepare('SELECT 1').get();
      checks.db_reachable = 'ok';
    } catch {
      checks.db_reachable = 'error';
      hasError = true;
      errorMsg = 'db_reachable: SELECT 1 failed';
    }

    // 2. Schema applied — confirms migrations ran and the DB file is correct.
    if (!hasError) {
      try {
        const row = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_keys'",
        ).get();
        if (row) {
          checks.schema_applied = 'ok';
        } else {
          checks.schema_applied = 'error';
          hasError = true;
          errorMsg = 'schema_applied: expected table api_keys not found';
        }
      } catch {
        checks.schema_applied = 'error';
        hasError = true;
        errorMsg = 'schema_applied: check failed';
      }
    } else {
      checks.schema_applied = 'skipped';
    }

    // 3. Write canary — confirms writes are not blocked (disk full, WAL lock,
    //    read-only mount). Uses rate_limits (no schema change needed); sentinel
    //    key is inserted and deleted inside the same transaction.
    if (!hasError) {
      try {
        db.transaction(() => {
          db.prepare(
            'INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, ?)',
          ).run('__readyz__', '__readyz__', 0, 0);
          db.prepare("DELETE FROM rate_limits WHERE key_id = '__readyz__'").run();
        })();
        checks.db_writable = 'ok';
      } catch {
        checks.db_writable = 'error';
        hasError = true;
        errorMsg = 'db_writable: write canary failed';
      }
    } else {
      checks.db_writable = 'skipped';
    }

    const ts = Math.floor(Date.now() / 1000);

    if (hasError) {
      return reply.status(503).send({ status: 'error', checks, error: errorMsg, ts });
    }
    return { status: 'ok', checks, ts };
  });

  // ---------------------------------------------------------------------------
  // Request-ID correlation — assign/propagate X-Request-Id on every response.
  // Lets agents and operators match a 429/403 in their logs to a server log line.
  // ---------------------------------------------------------------------------
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', String(request.id));
  });

  // ---------------------------------------------------------------------------
  // HTTP metrics — onResponse hook populates impri_http_requests_total and
  // impri_http_request_duration_seconds. Excludes /metrics itself to avoid noise.
  // ---------------------------------------------------------------------------
  app.addHook('onResponse', (request, reply, done) => {
    // req.routeOptions.url is the pattern (/v1/actions/:id), never the real URL.
    const route = (request.routeOptions as { url?: string }).url ?? 'unknown';
    if (route === '/metrics') { done(); return; }

    const method = request.method;
    const statusCode = reply.statusCode;
    const statusClass = statusCode >= 500 ? '5xx' : statusCode >= 400 ? '4xx' : '2xx';
    const durationSec = reply.elapsedTime / 1000;

    incCounter('impri_http_requests_total', { route, method, status_class: statusClass });
    obsHistogram('impri_http_request_duration_seconds', { route, method }, durationSec);
    done();
  });

  // Auth preHandler: extract and verify Bearer key
  app.addHook('preHandler', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer im_')) {
      // Public endpoints don't need auth
      return;
    }
    const rawKey = auth.slice('Bearer '.length);
    const keyRecord = await verifyApiKey(db, rawKey);
    if (!keyRecord) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or revoked API key' });
    }
    request.apiKey = {
      keyId: keyRecord.id,
      projectId: keyRecord.project_id,
      scopes: keyRecord.scopes,
    };
  });

  // Health check — public
  app.get('/healthz', async () => ({ status: 'ok', ts: Math.floor(Date.now() / 1000) }));

  // OpenAPI spec — public
  app.get('/v1/openapi.json', async () => buildOpenApiDocument(process.env.BASE_URL ?? `http://localhost:${PORT}`));

  // Action routes
  registerActionRoutes(app, db);

  // Key management routes
  registerKeyRoutes(app, db);

  // Watcher CRUD routes
  registerWatcherRoutes(app, db);

  // Project settings + GDPR export/erase routes
  registerProjectRoutes(app, db);

  // Billing routes (no-op checkout/portal when Stripe keys are unset)
  registerBillingRoutes(app, db);

  // Web-push subscription routes (no-op when VAPID keys are unset)
  registerPushRoutes(app, db);

  // Public self-serve signup — creates a project + admin key (gated on ALLOW_SIGNUP)
  registerSignupRoutes(app, db);

  // Operator-only platform stats (gated on OPERATOR_PROJECT_ID)
  registerAdminRoutes(app, db);

  // Rules engine CRUD (admin scope)
  registerRuleRoutes(app, db);

  // Watcher preset catalog + from-preset creation
  registerWatcherPresetRoutes(app, db);

  // Per-project notification channels (Slack, Discord, Telegram, ntfy, email, webhook)
  registerNotificationChannelRoutes(app, db);

  // Telegram interactive approval bot webhook (public, authenticated via secret_token header)
  registerTelegramWebhookRoutes(app, db);

  // Slack shared app OAuth (install-url, callback, shared interactions endpoint).
  // Registered BEFORE registerSlackInteractionRoutes so the exact path
  // POST /v1/integrations/slack/interactions is matched before the parameterised
  // POST /v1/integrations/slack/interactions/:channelId route.
  registerSlackOAuthRoutes(app, db);

  // Slack interactive approval webhook (public, authenticated via v0 HMAC signature)
  registerSlackInteractionRoutes(app, db);

  // Discord interactive approval webhook (public, authenticated via Ed25519 signature)
  registerDiscordInteractionRoutes(app, db);

  // Audit log query + export (admin scope)
  registerAuditRoutes(app, db);

  // Usage snapshot — current period actions/approvals, watchers, tier limits
  registerUsageRoutes(app, db);

  // Recovery code rotation + project recovery (public /v1/recover, authed /v1/recovery-code)
  registerRecoveryRoutes(app, db);

  return app;
}

async function main() {
  if (WEBHOOK_SECRET === 'change-me-in-production') {
    console.warn(
      '[impri] WARNING: WEBHOOK_SECRET is the default value. Webhook signatures ' +
      'are forgeable. Set WEBHOOK_SECRET to a strong random value in production.',
    );
  }

  console.log(
    billingActive()
      ? '[impri] billing: ENABLED (Stripe) — tier limits enforced'
      : '[impri] billing: disabled (self-host — all features free, no limits)',
  );
  console.log(`[impri] web push: ${pushEnabled() ? 'ENABLED (VAPID)' : 'disabled'}`);

  const db = createDb(DB_PATH);

  // Bootstrap admin key on first run
  const bootstrap = await bootstrapAdminKey(db);
  if (bootstrap) {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║            IMPRI — FIRST RUN BOOTSTRAP               ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Admin API Key: ${bootstrap.key}`);
    console.log(`║  Project ID:    ${bootstrap.projectId}`);
    console.log('║  Store this key securely — it will not be shown again.║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
  }

  const app = await createApp(db);
  const log = app.log;

  // Expiry + webhook + channel digest tick every 60 s.
  setInterval(() => {
    runExpiryTick(db, WEBHOOK_SECRET, log).catch(err =>
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'expiry/webhook tick failed'),
    );
    runChannelDigestTick(db, log).catch(err =>
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'channel digest tick failed'),
    );
  }, 60_000);

  // Watcher scheduler tick every 60s (no-op when DISABLE_WATCHER_SCHEDULER=1)
  startWatcherScheduler(db, log);

  // Also run one watcher tick immediately on startup (handles missed runs — PLAYBOOK B3)
  runWatcherTick(db, log).catch(err =>
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'initial watcher tick failed'),
  );

  await app.listen({ port: PORT, host: HOST });
  console.log(`Impri server running on http://${HOST}:${PORT}`);
}

// Don't run in vitest worker threads — each thread imports index.ts and would
// try to bind port 8484, causing EADDRINUSE in the second worker.
if (!process.env.VITEST) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
