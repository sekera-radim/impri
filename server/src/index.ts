import './types.js';
import Fastify from 'fastify';
import { createDb } from './db.js';
import { verifyApiKey, bootstrapAdminKey } from './auth.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerWatcherRoutes } from './routes/watchers.js';
import { registerProjectRoutes } from './routes/project.js';
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

  return app;
}

async function main() {
  if (WEBHOOK_SECRET === 'change-me-in-production') {
    console.warn(
      '[impri] WARNING: WEBHOOK_SECRET is the default value. Webhook signatures ' +
      'are forgeable. Set WEBHOOK_SECRET to a strong random value in production.',
    );
  }

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
