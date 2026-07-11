/**
 * coverage-expiry-idempotency.test.ts
 *
 * Covers the highest-priority gaps related to:
 *  - minWatcherIntervalSec tier limit (never enforced — high priority bug)
 *  - watcherLimitReached bypass via PATCH status=active (high priority bug)
 *  - expires_in schema boundary validation
 *  - Payload > 256KB returns 400
 *  - Soft dedup disabled when idempotency_key is present
 *
 * Run: cd server && npm test -- coverage-expiry-idempotency
 *
 * KNOWN FAILING TESTS (document bugs that need fixing in server/src):
 *
 *  1. "free-tier user setting 1m interval should be blocked" — FAILS
 *     Bug: server/src/routes/watchers.ts POST /v1/watchers does not check
 *     TIER_LIMITS[tier].minWatcherIntervalSec. A free-tier user (min=900s) can
 *     set schedule: { every: '1m' } (60s) and it passes because only the
 *     absolute Zod minimum (60s) is enforced, not the per-tier minimum.
 *
 *  2. "PATCH status=active when at limit should return 402" — FAILS
 *     Bug: server/src/routes/watchers.ts PATCH /v1/watchers/:id reactivates
 *     a paused watcher without checking watcherLimitReached. A user who has 3
 *     active watchers (free-tier limit), pauses one, creates a replacement, and
 *     then PATCHes the original back to active ends up with 4 active watchers,
 *     bypassing the limit.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const rssWatcher = (name: string, every: string) => ({
  name,
  kind: 'rss',
  config: { url: 'https://example.com/feed.xml' },
  schedule: { every },
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
// minWatcherIntervalSec tier limit
// ─────────────────────────────────────────────────────────────────────────────

describe('minWatcherIntervalSec tier limit — never enforced [BUG]', () => {
  /**
   * TIER_LIMITS (server/src/billing.ts):
   *   free:  minWatcherIntervalSec = 900  (15 min)
   *   indie: minWatcherIntervalSec = 300  (5 min)
   *   team:  minWatcherIntervalSec = 60   (1 min)
   *
   * Neither POST /v1/watchers nor PATCH /v1/watchers/:id validates the
   * schedule.every value against the project tier's minimum. The Zod schema
   * only enforces an absolute 60s floor.
   *
   * Tests below express the CORRECT expected behaviour (402 when under tier
   * minimum) and will FAIL until the enforcement is added.
   */

  it('[BUG] free-tier user setting 1m interval should be blocked with 402', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();
    // free tier min is 900s; '1m' = 60s < 900s — must be rejected
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('too-fast-free', '1m'),
    });
    // CURRENTLY returns 201 — minWatcherIntervalSec is never checked
    expect(res.statusCode).toBe(402);
  });

  it('[BUG] free-tier user setting 10m interval should be blocked with 402 (10m < 15m min)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();
    // 10m = 600s < 900s free minimum
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('too-fast-free-10m', '10m'),
    });
    expect(res.statusCode).toBe(402);
  });

  it('free-tier user setting 15m interval is allowed (equals free minimum)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();
    // 15m = 900s = exact free minimum — must be allowed
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('ok-free-15m', '15m'),
    });
    // NOTE: This will pass because currently no tier check is done at all.
    // Once the check is added, '15m' should still pass for the free tier.
    expect(res.statusCode).toBe(201);
  });

  it('[BUG] indie-tier user setting 1m interval should be blocked with 402', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();
    // Elevate project to indie tier
    db.prepare("UPDATE projects SET tier = 'indie' WHERE id = ?").run(projectId);
    // indie min is 300s; '1m' = 60s < 300s — must be rejected
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('too-fast-indie', '1m'),
    });
    expect(res.statusCode).toBe(402);
  });

  it('team-tier user setting 1m interval is allowed (1m = 60s = team minimum)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { db, app, adminKey, projectId } = await setup();
    db.prepare("UPDATE projects SET tier = 'team' WHERE id = ?").run(projectId);
    // team min is 60s; '1m' = 60s — must be allowed
    const res = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('ok-team-1m', '1m'),
    });
    // NOTE: Will pass today because no tier check exists; must remain passing after fix.
    expect(res.statusCode).toBe(201);
  });

  it('[BUG] PATCH changing schedule to sub-tier minimum should be blocked with 402', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    // Create a compliant watcher (30m is fine for free tier)
    const created = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('patched-watcher', '30m'),
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // PATCH to change schedule to 1m — free tier allows minimum 15m; must 402
    const patched = await app.inject({
      method: 'PATCH', url: `/v1/watchers/${id}`, headers: auth(adminKey),
      payload: { schedule: { every: '1m' } },
    });
    // CURRENTLY returns 200 — PATCH does not enforce minWatcherIntervalSec
    expect(patched.statusCode).toBe(402);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// watcherLimitReached bypass via PATCH status=active
// ─────────────────────────────────────────────────────────────────────────────

describe('Watcher limit — paused-watcher bypass [BUG]', () => {
  it('paused watchers are excluded from the active count (by design)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    // Create 3 watchers (free tier limit = 3)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
        payload: rssWatcher(`w${i}`, '30m'),
      });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id as string);
    }

    // A 4th watcher must be refused (at limit)
    const blocked = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('w-extra', '30m'),
    });
    expect(blocked.statusCode).toBe(402);

    // Pause one watcher — active count drops to 2 (under limit)
    await app.inject({
      method: 'PATCH', url: `/v1/watchers/${ids[0]}`, headers: auth(adminKey),
      payload: { status: 'paused' },
    });

    // Now a new watcher fits (active = 2 + 1 = 3, at limit)
    const r4 = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('w-after-pause', '30m'),
    });
    expect(r4.statusCode).toBe(201);
  });

  it('[BUG] PATCH status=active when project is at-limit should return 402', async () => {
    /**
     * Bug: server/src/routes/watchers.ts PATCH handler never calls
     * watcherLimitReached. A user at their free-tier limit (3 active) who has
     * 1 paused watcher can PATCH that paused watcher back to active, pushing
     * the active count to 4 (above the limit of 3), with no 402 response.
     */
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();

    // Create 3 active watchers (at limit)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
        payload: rssWatcher(`w${i}`, '30m'),
      });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id as string);
    }

    // Pause one → active count = 2
    await app.inject({
      method: 'PATCH', url: `/v1/watchers/${ids[0]}`, headers: auth(adminKey),
      payload: { status: 'paused' },
    });

    // Create one more → active = 3 (at limit again)
    const extra = await app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: rssWatcher('extra', '30m'),
    });
    expect(extra.statusCode).toBe(201);

    // Now reactivating the paused watcher would push active to 4 — must 402.
    // CURRENTLY: returns 200 — no limit check on PATCH (bug).
    const reactivate = await app.inject({
      method: 'PATCH', url: `/v1/watchers/${ids[0]}`, headers: auth(adminKey),
      payload: { status: 'active' },
    });
    expect(reactivate.statusCode).toBe(402);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expires_in boundary validation
// ─────────────────────────────────────────────────────────────────────────────

describe('expires_in boundary validation', () => {
  const post = (app: Awaited<ReturnType<typeof setup>>['app'], adminKey: string, expires_in: number) =>
    app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'exp.bound', title: 'Boundary', preview: { format: 'plain', body: 'b' }, expires_in },
    });

  it('expires_in=299 (below 300s minimum) returns 400', async () => {
    const { app, adminKey } = await setup();
    expect((await post(app, adminKey, 299)).statusCode).toBe(400);
  });

  it('expires_in=300 (minimum) returns 201', async () => {
    const { app, adminKey } = await setup();
    expect((await post(app, adminKey, 300)).statusCode).toBe(201);
  });

  it('expires_in=2592001 (above 30-day maximum) returns 400', async () => {
    const { app, adminKey } = await setup();
    // 30 * 24 * 3600 = 2592000; one over = 2592001
    expect((await post(app, adminKey, 2592001)).statusCode).toBe(400);
  });

  it('expires_in=2592000 (maximum = 30 days) returns 201', async () => {
    const { app, adminKey } = await setup();
    expect((await post(app, adminKey, 2592000)).statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payload > 256KB
// ─────────────────────────────────────────────────────────────────────────────

describe('Payload > 256KB size guard', () => {
  it('POST /v1/actions with a >256KB payload field returns 400', async () => {
    const { app, adminKey } = await setup();

    // Build a payload whose JSON serialization exceeds 256 * 1024 bytes.
    // The guard checks JSON.stringify(body.payload).length > 256 * 1024.
    // 'x'.repeat(257 * 1024) is well above that ceiling.
    const oversizePayload = { data: 'x'.repeat(257 * 1024) };

    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'big.payload',
        title: 'Big payload',
        preview: { format: 'plain', body: 'b' },
        payload: oversizePayload,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('256');
  });

  it('POST /v1/actions with a payload just under 256KB returns 201', async () => {
    const { app, adminKey } = await setup();

    // '{"data":"' is 9 chars, closing '"}}' is 3 chars; fill the rest.
    // We need JSON.stringify(payload).length <= 256 * 1024.
    const targetSize = 256 * 1024 - 20; // leave headroom for JSON overhead
    const safePayload = { data: 'x'.repeat(targetSize) };

    const res = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: {
        kind: 'ok.payload',
        title: 'Ok payload',
        preview: { format: 'plain', body: 'b' },
        payload: safePayload,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Soft dedup disabled when idempotency_key is present
// ─────────────────────────────────────────────────────────────────────────────

describe('Soft dedup is skipped when idempotency_key is present', () => {
  /**
   * routes/actions.ts:106 — soft dedup only runs when !body.idempotency_key.
   * Two requests with different idempotency_keys but identical content must each
   * create a separate action (201 both), even though the content hash matches.
   */
  it('two requests with different idempotency_keys and identical content create separate actions', async () => {
    const { app, adminKey } = await setup();

    const base = {
      kind: 'soft.idem',
      title: 'Same content',
      preview: { format: 'plain', body: 'identical body' },
    };

    const r1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...base, idempotency_key: 'idem-A' },
    });
    const r2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { ...base, idempotency_key: 'idem-B' },
    });

    // Both must be 201 (new actions), not 200 (dedup)
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);

    // The IDs must differ — they are genuinely separate actions
    expect(r1.json().id).not.toBe(r2.json().id);
  });

  it('repeated POST with the same idempotency_key returns the same action regardless of content', async () => {
    const { app, adminKey } = await setup();

    // First request
    const r1 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'idem.same', title: 'First', preview: { format: 'plain', body: 'v1' }, idempotency_key: 'key-X' },
    });
    expect(r1.statusCode).toBe(201);

    // Repeat with same key but different content — idempotency wins
    const r2 = await app.inject({
      method: 'POST', url: '/v1/actions', headers: auth(adminKey),
      payload: { kind: 'idem.same', title: 'Second', preview: { format: 'plain', body: 'v2' }, idempotency_key: 'key-X' },
    });
    expect(r2.statusCode).toBe(200); // returns existing action
    expect(r2.json().id).toBe(r1.json().id);
  });

  it('without an idempotency_key, identical content triggers soft dedup (returning duplicate_of)', async () => {
    const { app, adminKey } = await setup();

    const payload = { kind: 'no.idem', title: 'Dup check', preview: { format: 'plain', body: 'same' } };

    const r1 = await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload });
    const r2 = await app.inject({ method: 'POST', url: '/v1/actions', headers: auth(adminKey), payload });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate_of).toBe(r1.json().id);
  });
});
