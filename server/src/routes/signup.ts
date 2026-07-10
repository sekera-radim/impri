import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { createProjectWithAdminKey, checkRateLimit } from '../auth.js';

const SignupBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

// Public self-serve signup: creates a project + admin key and returns it once.
// Off by default so self-hosted single-tenant instances aren't open to the
// public; the hosted cloud sets ALLOW_SIGNUP=1.
export function registerSignupRoutes(app: FastifyInstance, db: Db): void {
  app.post('/v1/signup', async (request, reply) => {
    if (process.env.ALLOW_SIGNUP !== '1') {
      return reply.status(404).send({ error: 'Not Found', message: 'Signup is not enabled on this instance.' });
    }

    // Unauthenticated + creates resources — rate-limit hard by client IP.
    const ip = request.ip || 'unknown';
    const allowed = await checkRateLimit(db, `ip:${ip}`, 'signup', 3);
    if (!allowed) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Please wait a minute and try again.' });
    }

    const parsed = SignupBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }

    const projectName = parsed.data.name?.trim() || 'My Project';
    const result = await createProjectWithAdminKey(db, projectName);
    request.log.info({ projectId: result.projectId }, 'signup: created project');

    reply.status(201);
    return {
      key: result.key,
      project_id: result.projectId,
      note: 'Store this key securely — it will not be shown again.',
    };
  });
}
