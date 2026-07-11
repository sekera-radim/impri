import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { genId, nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import { billingActive, watcherLimitReached, getProjectBilling, TIER_LIMITS } from '../billing.js';
import { CreateWatcherBody, durationToSec } from '../schemas.js';
import { PRESET_CATALOG, PRESET_MAP, buildConfig } from '../watcherPresets.js';

// ─── Request schema ───────────────────────────────────────────────────────────

const FromPresetBody = z.object({
  preset_id: z.string().min(1).max(100),
  params: z.record(z.string()).default({}),
  name: z.string().min(1).max(200).optional(),
  schedule: z.object({
    every: z.string().regex(/^\d+[mhd]$/, 'Invalid duration'),
    jitter: z.string().regex(/^\d+[mhd]$/).optional(),
    window: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/).optional(),
  }).optional(),
});
type FromPresetBody = z.infer<typeof FromPresetBody>;

// ─── Route serializer (shared with watcher routes) ────────────────────────────

function serializeWatcher(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: JSON.parse(row.config as string),
    keywords: JSON.parse(row.keywords as string),
    keywords_none: JSON.parse(row.keywords_none as string),
    min_score: row.min_score,
    schedule: JSON.parse(row.schedule as string),
    status: row.status,
    fail_count: row.fail_count,
    last_error: row.last_error ?? undefined,
    degraded_since: row.degraded_since ?? undefined,
    first_run_done: Boolean(row.first_run_done),
    last_run_at: row.last_run_at ?? undefined,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerWatcherPresetRoutes(app: FastifyInstance, db: Db): void {
  // GET /v1/watcher-presets
  // Returns the static preset catalog. No DB read. Aggressively cacheable.
  // Auth: Bearer token with "watch" scope.
  app.get('/v1/watcher-presets', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    reply.header('Cache-Control', 'max-age=3600');
    return { presets: PRESET_CATALOG };
  });

  // POST /v1/watchers/from-preset
  // Validates preset params, builds a watcher config, then runs through the
  // exact same guards as POST /v1/watchers (rate limit, watcher cap, tier
  // interval, SSRF/schema validation) before inserting.
  app.post('/v1/watchers/from-preset', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'watch')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "watch" required' });
    }

    // ── Step 2: Rate limit (shared bucket with POST /v1/watchers) ────────────
    if (!(await checkRateLimit(db, key.keyId, 'watchers:create', 30))) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit: 30 requests/min per key',
      });
    }

    // ── Step 3: Tier watcher-count limit ─────────────────────────────────────
    if (watcherLimitReached(db, key.projectId)) {
      const tier = getProjectBilling(db, key.projectId).tier;
      return reply.status(402).send({
        error: 'Payment Required',
        message: `Watcher limit reached for the ${tier} plan (${TIER_LIMITS[tier].watchers}). Upgrade to add more.`,
        limit: TIER_LIMITS[tier].watchers,
        tier,
      });
    }

    // ── Parse request body ────────────────────────────────────────────────────
    const parsedBody = FromPresetBody.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsedBody.error.issues });
    }
    const { preset_id, params, name: customName, schedule: customSchedule } = parsedBody.data;

    // ── Step 4: Look up preset ────────────────────────────────────────────────
    const preset = PRESET_MAP.get(preset_id);
    if (!preset) {
      return reply.status(404).send({ error: 'preset_not_found', message: `Unknown preset_id: "${preset_id}"` });
    }

    // ── Step 5: Validate params and build config ──────────────────────────────
    const buildResult = buildConfig(preset_id, params);
    if (!buildResult.ok) {
      return reply.status(400).send({ error: 'Bad Request', issues: buildResult.issues });
    }

    // ── Step 6: Assemble the full CreateWatcherBody ───────────────────────────
    const schedule = customSchedule ?? { every: preset.defaultScheduleEvery };

    // Default name: "Preset Title: primaryParamValue" or just "Preset Title".
    // Slice to 200 chars so a max-length param value never exceeds the
    // CreateWatcherBody name limit when no explicit name was provided.
    const defaultName = (buildResult.primaryParam
      ? `${preset.title}: ${buildResult.primaryParam}`
      : preset.title).slice(0, 200);

    const candidateBody = {
      name: customName ?? defaultName,
      kind: buildResult.body.kind,
      config: buildResult.body.config,
      keywords: buildResult.body.keywords,
      keywords_none: buildResult.body.keywords_none,
      min_score: buildResult.body.min_score,
      schedule,
    };

    // ── Step 7: Re-run the full CreateWatcherBody schema (SSRF guard + schedule
    //           minimum-60s check + kind-config cross-checks) ─────────────────
    const parsed = CreateWatcherBody.safeParse(candidateBody);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // ── Step 8: Tier minimum interval check ───────────────────────────────────
    if (billingActive()) {
      const { tier } = getProjectBilling(db, key.projectId);
      const intervalSec = durationToSec(body.schedule.every);
      if (intervalSec < TIER_LIMITS[tier].minWatcherIntervalSec) {
        return reply.code(402).send({
          error: 'schedule_too_frequent',
          tier,
          min_interval_sec: TIER_LIMITS[tier].minWatcherIntervalSec,
        });
      }
    }

    // ── Step 9: Insert (identical to POST /v1/watchers) ───────────────────────
    const now = nowSec();
    const id = genId('wat_');
    const nextRunAt = now; // first run immediately

    db.prepare(`
      INSERT INTO watchers
        (id, project_id, name, kind, config, keywords, keywords_none, min_score,
         schedule, status, fail_count, first_run_done, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)
    `).run(
      id,
      key.projectId,
      body.name,
      body.kind,
      JSON.stringify(body.config),
      JSON.stringify(body.keywords),
      JSON.stringify(body.keywords_none),
      body.min_score,
      JSON.stringify(body.schedule),
      nextRunAt,
      now,
      now,
    );

    reply.status(201);
    const row = db.prepare('SELECT * FROM watchers WHERE id = ?').get(id) as Record<string, unknown>;
    return serializeWatcher(row);
  });
}
