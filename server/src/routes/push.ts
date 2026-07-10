import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope } from '../auth.js';
import { pushEnabled, vapidPublicKey } from '../push.js';
import { PushSubscribeBody } from '../schemas.js';

export function registerPushRoutes(app: FastifyInstance, db: Db): void {
  // Public: the browser needs the VAPID public key to create a subscription.
  app.get('/v1/push/vapid-public-key', async () => ({
    enabled: pushEnabled(),
    public_key: pushEnabled() ? vapidPublicKey() : null,
  }));

  // Register a browser push subscription for the caller's project.
  app.post('/v1/push/subscribe', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "actions" required' });
    }
    if (!pushEnabled()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Push is not enabled on this instance' });
    }
    const parsed = PushSubscribeBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });

    const { endpoint, keys } = parsed.data;
    const now = nowSec();
    // Upsert by endpoint (a browser may re-subscribe with the same endpoint).
    db.prepare(`
      INSERT INTO push_subscriptions (id, project_id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET project_id = excluded.project_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(genId('push_'), key.projectId, endpoint, keys.p256dh, keys.auth, now);

    reply.status(201);
    return { subscribed: true };
  });

  // Remove a subscription (on logout / unsubscribe).
  app.delete<{ Body: { endpoint?: string } }>('/v1/push/subscribe', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "actions" required' });
    }
    const endpoint = (request.body as { endpoint?: string } | undefined)?.endpoint;
    if (!endpoint) return reply.status(400).send({ error: 'Bad Request', message: 'endpoint required' });

    db.prepare('DELETE FROM push_subscriptions WHERE project_id = ? AND endpoint = ?').run(key.projectId, endpoint);
    reply.status(204);
    return;
  });
}
