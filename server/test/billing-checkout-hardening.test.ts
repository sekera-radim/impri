/**
 * POST /v1/billing/checkout — Stripe error hardening.
 *
 * Covers:
 * - Happy path with an already-stored customer id
 * - A stale stored customer id (Stripe 'resource_missing' on param 'customer' —
 *   e.g. a test-mode id left over after switching to live keys) is cleared, a
 *   fresh customer is created, and the checkout is retried exactly once
 * - Any OTHER Stripe failure returns a generic 502 without leaking Stripe's
 *   message, error code or ids to the client
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

const customersCreate = vi.fn();
const checkoutSessionsCreate = vi.fn();

// Stand in for the real `stripe` package: only the surface billing.ts touches.
// vi.mock is hoisted above these imports by vitest's transform, so billing.ts
// (imported transitively via index.ts) sees the fake from its very first import.
vi.mock('stripe', () => {
  class FakeStripe {
    customers = { create: customersCreate };
    checkout = { sessions: { create: checkoutSessionsCreate } };
    billingPortal = { sessions: { create: vi.fn() } };
    webhooks = { constructEvent: vi.fn() };
  }
  return { default: FakeStripe };
});

class FakeStripeError extends Error {
  code?: string;
  param?: string;
  constructor(message: string, code?: string, param?: string) {
    super(message);
    this.code = code;
    this.param = param;
  }
}

async function setup() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_PRICE_INDIE = 'price_indie_m';
  process.env.APP_URL = 'https://app.impri.dev';
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const checkout = (app: Awaited<ReturnType<typeof setup>>['app'], key: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/billing/checkout',
    headers: { Authorization: `Bearer ${key}` },
    payload: { plan: 'indie', period: 'monthly' },
  });

beforeEach(() => {
  customersCreate.mockReset();
  checkoutSessionsCreate.mockReset();
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_INDIE;
  delete process.env.APP_URL;
  vi.restoreAllMocks();
});

describe('POST /v1/billing/checkout — stripe hardening', () => {
  it('happy path: existing customer id, checkout session created', async () => {
    const { app, adminKey, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_existing', projectId);
    checkoutSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session-1' });

    const res = await checkout(app, adminKey);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://checkout.stripe.com/session-1' });
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing' }));
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it('stale stored customer id (resource_missing) is replaced and retried once', async () => {
    const { app, adminKey, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_stale_test_mode', projectId);

    checkoutSessionsCreate
      .mockRejectedValueOnce(new FakeStripeError('No such customer: cus_stale_test_mode', 'resource_missing', 'customer'))
      .mockResolvedValueOnce({ url: 'https://checkout.stripe.com/session-2' });
    customersCreate.mockResolvedValue({ id: 'cus_fresh' });

    const res = await checkout(app, adminKey);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://checkout.stripe.com/session-2' });

    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(2);
    expect(checkoutSessionsCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ customer: 'cus_fresh' }));

    // The fresh customer id must be persisted so the next call doesn't retry again.
    const row = db.prepare('SELECT stripe_customer_id FROM projects WHERE id = ?').get(projectId) as {
      stripe_customer_id: string;
    };
    expect(row.stripe_customer_id).toBe('cus_fresh');
  });

  it('a second resource_missing (retry also stale) is NOT retried again — generic 502', async () => {
    const { app, adminKey, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_stale', projectId);
    checkoutSessionsCreate.mockRejectedValue(
      new FakeStripeError('No such customer', 'resource_missing', 'customer'),
    );
    customersCreate.mockResolvedValue({ id: 'cus_fresh_2' });

    const res = await checkout(app, adminKey);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'billing_unavailable' });
    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it('any other Stripe error returns a generic 502 without leaking Stripe details', async () => {
    const { app, adminKey, db, projectId } = await setup();
    db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run('cus_ok', projectId);
    checkoutSessionsCreate.mockRejectedValue(
      new FakeStripeError('Your card was declined: sk_live_abc123secret', 'card_declined'),
    );

    const res = await checkout(app, adminKey);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'billing_unavailable' });
    expect(res.payload).not.toContain('card was declined');
    expect(res.payload).not.toContain('sk_live_abc123secret');
  });

  it('customer creation failure (no stored id yet) also returns a generic 502', async () => {
    const { app, adminKey } = await setup();
    customersCreate.mockRejectedValue(new FakeStripeError('internal stripe error, ref req_abc', 'api_error'));

    const res = await checkout(app, adminKey);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'billing_unavailable' });
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });
});
