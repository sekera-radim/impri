/**
 * In-app feedback.
 *
 * POST /v1/feedback       (Bearer)   — a signed-in user submits feedback
 * GET  /v1/admin/feedback (operator) — the operator reads recent feedback
 *
 * Kept deliberately small: a message, an optional 1–5 rating, an optional way to
 * reach back, and the page it came from. No PII is required.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';

const FeedbackBody = z.object({
  message: z.string().trim().min(1).max(4000),
  rating: z.number().int().min(1).max(5).optional(),
  contact: z.string().trim().max(200).optional(),
  context: z.string().trim().max(200).optional(),
});

export function registerFeedbackRoutes(app: FastifyInstance, db: Db): void {
  app.post('/v1/feedback', async (request, reply) => {
    const key = request.apiKey;
    if (!key) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Light rate limit — feedback is infrequent; this only stops accidental spam.
    if (!(await checkRateLimit(db, key.keyId, 'feedback', 10))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 10 submissions/min per key' });
    }

    const parsed = FeedbackBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    db.prepare(
      'INSERT INTO feedback (id, project_id, message, rating, contact, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      genId('fb_'),
      key.projectId,
      body.message,
      body.rating ?? null,
      body.contact ?? null,
      body.context ?? null,
      nowSec(),
    );

    reply.status(201);
    return { ok: true };
  });

  // Operator-only: read recent feedback across all projects. 404 for anyone else
  // so the endpoint isn't discoverable (same posture as /v1/admin/stats).
  app.get('/v1/admin/feedback', async (request, reply) => {
    const key = request.apiKey;
    const operator = process.env.OPERATOR_PROJECT_ID;
    if (!key || !hasScope(key.scopes, 'admin') || !operator || key.projectId !== operator) {
      return reply.status(404).send({ error: 'Not Found' });
    }

    const rows = db.prepare(
      'SELECT id, project_id, message, rating, contact, context, created_at FROM feedback ORDER BY created_at DESC LIMIT 200',
    ).all();

    return { items: rows };
  });
}
