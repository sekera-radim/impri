import './types.js';
import Fastify from 'fastify';
import { createDb } from './db.js';
import { verifyApiKey, bootstrapAdminKey } from './auth.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerKeyRoutes } from './routes/keys.js';
import { runExpiryTick } from './webhooks.js';
import { buildOpenApiDocument } from './openapi.js';
import type { Db } from './db.js';

const DB_PATH = process.env.DB_PATH ?? 'impri.db';
const PORT = Number(process.env.PORT ?? 8484);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'change-me-in-production';

export async function createApp(db: Db) {
  const app = Fastify({ logger: true });

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

  return app;
}

async function main() {
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

  await app.listen({ port: PORT, host: HOST });
  console.log(`Impri server running on http://${HOST}:${PORT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
