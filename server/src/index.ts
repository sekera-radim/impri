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
import { billingActive } from './billing.js';
import { pushEnabled } from './push.js';
import { runExpiryTick } from './webhooks.js';
import { runWatcherTick, startWatcherScheduler } from './scheduler.js';
import { buildOpenApiDocument } from './openapi.js';
import type { Db } from './db.js';

const DB_PATH = process.env.DB_PATH ?? 'impri.db';
const PORT = Number(process.env.PORT ?? 8484);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'change-me-in-production';

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
    (req as { rawBody?: Buffer }).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
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

  // Expiry + webhook tick every 60s
  setInterval(() => {
    runExpiryTick(db, WEBHOOK_SECRET).catch(err =>
      console.error('[tick] expiry/webhook tick failed', err),
    );
  }, 60_000);

  // Watcher scheduler tick every 60s (no-op when DISABLE_WATCHER_SCHEDULER=1)
  startWatcherScheduler(db);

  // Also run one watcher tick immediately on startup (handles missed runs — PLAYBOOK B3)
  runWatcherTick(db).catch(err =>
    console.error('[tick] initial watcher tick failed', err),
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
