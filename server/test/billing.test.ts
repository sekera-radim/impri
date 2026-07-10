import { describe, it, expect, afterEach } from 'vitest';
import { createDb, genId, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import {
  TIER_LIMITS, priceToTier, priceIdFor, monthStartSec,
  getUsage, watcherLimitReached, approvalsLimitReached, billingActive,
} from '../src/billing.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}
const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

function seedDecisions(db: ReturnType<typeof createDb>, projectId: string, n: number) {
  const now = nowSec();
  for (let i = 0; i < n; i++) {
    const aid = genId('act_');
    db.prepare(`INSERT INTO actions (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
      VALUES (?, ?, 'test', 't', '{}', '[]', 'approved', 'h', ?, ?)`).run(aid, projectId, now, now);
    db.prepare(`INSERT INTO decisions (id, action_id, verdict, decided_at) VALUES (?, ?, 'approve', ?)`)
      .run(genId('dec_'), aid, now);
  }
}

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_INDIE;
  delete process.env.STRIPE_PRICE_TEAM;
});

describe('billing pure logic', () => {
  it('tier limits are shaped as expected', () => {
    expect(TIER_LIMITS.free.watchers).toBe(3);
    expect(TIER_LIMITS.indie.approvalsPerMonth).toBe(2000);
    expect(TIER_LIMITS.team.watchers).toBeNull();
  });

  it('maps stripe price ids to tiers (both periods → same tier)', () => {
    process.env.STRIPE_PRICE_INDIE = 'price_indie_m';
    process.env.STRIPE_PRICE_TEAM = 'price_team_m';
    expect(priceToTier('price_indie_m')).toBe('indie');
    expect(priceToTier('price_team_m')).toBe('team');
    expect(priceToTier('price_unknown')).toBeNull();
  });

  it('resolves plan+period to the configured price id', () => {
    process.env.STRIPE_PRICE_INDIE = 'price_indie_m';
    expect(priceIdFor('indie', 'monthly')).toBe('price_indie_m');
    expect(priceIdFor('team', 'yearly')).toBeNull(); // not configured
  });

  it('monthStartSec is the 1st of the month 00:00 UTC', () => {
    const ms = monthStartSec(Date.UTC(2026, 6, 10, 13, 0, 0) / 1000);
    expect(ms).toBe(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000);
  });

  it('billingActive reflects STRIPE_SECRET_KEY', () => {
    expect(billingActive()).toBe(false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(billingActive()).toBe(true);
  });
});

describe('usage counting', () => {
  it('counts active watchers and this-month approvals', async () => {
    const { db, projectId } = await setup();
    db.prepare(`INSERT INTO watchers (id, project_id, name, kind, config, schedule, status, next_run_at, created_at, updated_at)
      VALUES (?, ?, 'w', 'rss', '{}', '{}', 'active', 0, ?, ?)`).run(genId('wat_'), projectId, nowSec(), nowSec());
    seedDecisions(db, projectId, 5);
    const u = getUsage(db, projectId);
    expect(u.watchers.used).toBe(1);
    expect(u.approvals.used).toBe(5);
    expect(u.approvals.limit).toBe(100); // free
  });
});

describe('limit enforcement is a no-op without billing', () => {
  it('never blocks when self-host (no STRIPE key)', async () => {
    const { db, projectId } = await setup();
    seedDecisions(db, projectId, 500); // way over free limit
    expect(approvalsLimitReached(db, projectId)).toBe(false);
    expect(watcherLimitReached(db, projectId)).toBe(false);
  });

  it('blocks over-limit when billing is enabled', async () => {
    const { db, projectId } = await setup();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(approvalsLimitReached(db, projectId)).toBe(false);
    seedDecisions(db, projectId, 100);
    expect(approvalsLimitReached(db, projectId)).toBe(true);
  });
});

describe('billing endpoints', () => {
  it('GET /v1/billing reports self-host mode when no Stripe key', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/billing', headers: auth(adminKey) });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.billing_enabled).toBe(false);
    expect(b.tier).toBe('free');
    expect(b.status).toBe('self_host');
    expect(b.usage.watchers.limit).toBe(3);
  });

  it('checkout is rejected when billing is disabled', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/billing/checkout', headers: auth(adminKey),
      payload: { plan: 'indie', period: 'monthly' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the free watcher limit (402) when billing is enabled', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const { app, adminKey } = await setup();
    const mk = (n: number) => app.inject({
      method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
      payload: { name: `w${n}`, kind: 'rss', config: { url: 'https://example.com/f.xml' }, schedule: { every: '30m' } },
    });
    expect((await mk(1)).statusCode).toBe(201);
    expect((await mk(2)).statusCode).toBe(201);
    expect((await mk(3)).statusCode).toBe(201);
    const fourth = await mk(4);
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json().tier).toBe('free');
  });
});
