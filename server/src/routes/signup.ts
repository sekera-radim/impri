import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
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

    // Global cap: per-IP alone can't stop a botnet / proxy pool. Cap total
    // signups/hour so abuse can't exhaust CPU (argon2) or bloat the DB.
    const recent = (db.prepare(
      'SELECT COUNT(*) AS c FROM projects WHERE created_at > ?',
    ).get(nowSec() - 3600) as { c: number }).c;
    if (recent >= 50) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Signups are temporarily rate-limited. Please try again shortly.' });
    }

    // Unauthenticated + creates resources — rate-limit by REAL client IP.
    // request.ip is the Fly proxy behind our deploy; Fly sets fly-client-ip,
    // which clients cannot override. Fall back for other proxies / local.
    const ip =
      (request.headers['fly-client-ip'] as string | undefined) ??
      (request.headers['cf-connecting-ip'] as string | undefined) ??
      request.ip ??
      'unknown';
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
      recovery_code: result.recoveryCode,
      note: 'Store this key and recovery code securely — they will not be shown again.',
    };
  });
}
