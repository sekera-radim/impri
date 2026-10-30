/**
 * billing-webhook.test.ts
 *
 * POST /v1/billing/webhook had zero test coverage before this QA pass
 * (2026-10-30) despite being the only place a project's tier actually
 * changes in production — a bug here silently mis-bills every real
 * customer. Covers:
 *  - Signature verification (bad signature -> 400, no DB mutation)
 *  - checkout.session.completed stores the Stripe customer id
 *  - customer.subscription.updated with an active sub flips tier to the
 *    price's mapped tier
 *  - customer.subscription.deleted (or any inactive status) resets tier
 *    to 'free' even though the row keeps its stripe_customer_id
 *  - An event for a customer id the DB doesn't know about is a no-op,
 *    not a 500 (UPDATE ... WHERE stripe_customer_id = ? matches 0 rows)
 *
 * Builds real Stripe-signed payloads with the 'stripe' package's own
 * Webhook.generateTestHeaderString — this exercises the exact HMAC
 * construction stripe.webhooks.constructEvent() verifies, not a stand-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Stripe from 'stripe';
import { createDb, nowSec } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

const WEBHOOK_SECRET = 'whsec_test_fixture_only';

async function setup() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_INDIE = 'price_indie_m';
  process.env.STRIPE_PRICE_TEAM = 'price_team_m';
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, projectId: bootstrap!.projectId };
}

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_INDIE;
  delete process.env.STRIPE_PRICE_TEAM;
});

function sign(payload: object): { body: string; header: string } {
  const body = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });
  return { body, header };
}

function stripeEvent(type: string, data: object) {
  return { id: 'evt_test', object: 'event', type, data: { object: data } };
}

async function postWebhook(app: Awaited<ReturnType<typeof setup>>['app'], body: string, header: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    payload: body,
  });
}

describe('POST /v1/billing/webhook — signature verification', () => {
  it('rejects a bad signature with 400 and makes no DB change', async () => {
    const { app, db, projectId } = await setup();
    const { body } = sign(stripeEvent('customer.subscription.updated', {
      id: 'sub_x', status: 'active', customer: 'cus_x',
      items: { data: [{ price: { id: 'price_indie_m' } }] },
    }));

    const res = await app.inject({
      method: 'POST', url: '/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: body,
    });
    expect(res.statusCode).toBe(400);

    const row = db.prepare('SELECT tier FROM projects WHERE id = ?').get(projectId) as { tier: string };
    expect(row.tier).toBe('free'); // untouched
  });

  it('rejects when the stripe-signature header is missing entirely', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(stripeEvent('customer.subscription.updated', {})),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/billing/webhook — checkout.session.completed', () => {
  it('stores the Stripe customer id on the project named by client_reference_id', async () => {
    const { app, db, projectId } = await setup();
    const { body, header } = sign(stripeEvent('checkout.session.completed', {
      id: 'cs_test', client_reference_id: projectId, customer: 'cus_abc123',
      // No `subscription` field — avoids the route's stripe.subscriptions.retrieve()
      // call, which would need a real Stripe API round-trip. The subsequent
      // customer.subscription.updated event (sent by real Stripe moments later)
      // is what actually flips the tier; covered separately below.
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);

    const row = db.prepare('SELECT stripe_customer_id FROM projects WHERE id = ?').get(projectId) as
      { stripe_customer_id: string | null };
    expect(row.stripe_customer_id).toBe('cus_abc123');
  });

  it('ignores an event with no client_reference_id instead of throwing', async () => {
    const { app } = await setup();
    const { body, header } = sign(stripeEvent('checkout.session.completed', {
      id: 'cs_test', client_reference_id: null, customer: 'cus_orphan',
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /v1/billing/webhook — subscription lifecycle flips tier', () => {
  it('customer.subscription.updated with an active indie price sets tier=indie', async () => {
    const { app, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_abc123', projectId);

    const { body, header } = sign(stripeEvent('customer.subscription.updated', {
      id: 'sub_1', status: 'active', customer: 'cus_abc123',
      items: { data: [{ price: { id: 'price_indie_m' }, current_period_end: nowSec() + 2592000 }] },
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);

    const row = db.prepare(
      'SELECT tier, subscription_status, stripe_subscription_id FROM projects WHERE id = ?',
    ).get(projectId) as { tier: string; subscription_status: string; stripe_subscription_id: string };
    expect(row.tier).toBe('indie');
    expect(row.subscription_status).toBe('active');
    expect(row.stripe_subscription_id).toBe('sub_1');
  });

  it('customer.subscription.updated with an active team price sets tier=team', async () => {
    // Regression guard (review round 2, 2026-10-30): the indie test above
    // doesn't catch a priceToTier() mix-up between the two paid tiers — a
    // mutation swapping STRIPE_PRICE_TEAM for STRIPE_PRICE_INDIE in
    // priceToTier()'s map would still pass every other assertion in this
    // file. This test pins price_team_m -> 'team' specifically, not just
    // "some paid tier". Verified via mutation (see commit message) that it
    // actually fails when that mapping is wrong.
    const { app, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_team1', projectId);

    const { body, header } = sign(stripeEvent('customer.subscription.updated', {
      id: 'sub_team', status: 'active', customer: 'cus_team1',
      items: { data: [{ price: { id: 'price_team_m' }, current_period_end: nowSec() + 2592000 }] },
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);

    const row = db.prepare(
      'SELECT tier, subscription_status, stripe_subscription_id FROM projects WHERE id = ?',
    ).get(projectId) as { tier: string; subscription_status: string; stripe_subscription_id: string };
    expect(row.tier).toBe('team');
    expect(row.subscription_status).toBe('active');
    expect(row.stripe_subscription_id).toBe('sub_team');
  });

  it('customer.subscription.deleted resets tier to free but keeps the customer id', async () => {
    const { app, db, projectId } = await setup();
    db.prepare(
      "UPDATE projects SET stripe_customer_id = 'cus_abc123', tier = 'indie' WHERE id = ?",
    ).run(projectId);

    const { body, header } = sign(stripeEvent('customer.subscription.deleted', {
      id: 'sub_1', status: 'canceled', customer: 'cus_abc123',
      items: { data: [{ price: { id: 'price_indie_m' } }] },
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);

    const row = db.prepare(
      'SELECT tier, stripe_customer_id FROM projects WHERE id = ?',
    ).get(projectId) as { tier: string; stripe_customer_id: string };
    expect(row.tier).toBe('free'); // downgraded
    expect(row.stripe_customer_id).toBe('cus_abc123'); // not erased — re-subscribing reuses it
  });

  it('a past_due subscription (not active/trialing) also resets tier to free', async () => {
    const { app, db, projectId } = await setup();
    db.prepare(
      "UPDATE projects SET stripe_customer_id = 'cus_abc123', tier = 'team' WHERE id = ?",
    ).run(projectId);

    const { body, header } = sign(stripeEvent('customer.subscription.updated', {
      id: 'sub_1', status: 'past_due', customer: 'cus_abc123',
      items: { data: [{ price: { id: 'price_team_m' } }] },
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200);

    const row = db.prepare('SELECT tier FROM projects WHERE id = ?').get(projectId) as { tier: string };
    expect(row.tier).toBe('free'); // failed payment -> no paid features until it recovers
  });

  it('an event for an unknown Stripe customer id is a no-op, not a 500', async () => {
    const { app } = await setup();
    const { body, header } = sign(stripeEvent('customer.subscription.updated', {
      id: 'sub_orphan', status: 'active', customer: 'cus_never_seen',
      items: { data: [{ price: { id: 'price_indie_m' } }] },
    }));
    const res = await postWebhook(app, body, header);
    expect(res.statusCode).toBe(200); // UPDATE ... WHERE stripe_customer_id = ? matches 0 rows, not an error
  });
});
