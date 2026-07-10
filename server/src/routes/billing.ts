import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type Stripe from 'stripe';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope } from '../auth.js';
import {
  billingActive, getStripe, webhookSecret,
  priceIdFor, priceToTier, getProjectBilling, getUsage,
  type Tier,
} from '../billing.js';

const CheckoutBody = z.object({
  plan: z.enum(['indie', 'team']),
  period: z.enum(['monthly', 'yearly']).default('monthly'),
});

// Mirror a Stripe subscription onto the local project row (tier is derived from
// the price; Stripe stays the source of truth for status/period).
function applySubscription(db: Db, customerId: string, sub: Stripe.Subscription): void {
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? '';
  const tier: Tier = priceToTier(priceId) ?? 'free';
  const active = sub.status === 'active' || sub.status === 'trialing';
  // Newer Stripe API versions (2025+) moved current_period_end onto the
  // subscription item; older ones keep it on the subscription. Read both.
  const periodEnd =
    (item as { current_period_end?: number } | undefined)?.current_period_end ??
    (sub as { current_period_end?: number }).current_period_end ??
    null;
  db.prepare(
    `UPDATE projects
        SET tier = ?, stripe_subscription_id = ?, subscription_status = ?, current_period_end = ?
      WHERE stripe_customer_id = ?`,
  ).run(active ? tier : 'free', sub.id, sub.status, periodEnd, customerId);
}

export function registerBillingRoutes(app: FastifyInstance, db: Db): void {
  // GET /v1/billing — current tier + usage (admin scope)
  app.get('/v1/billing', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const b = getProjectBilling(db, key.projectId);
    return {
      tier: b.tier,
      status: b.subscription_status ?? (billingActive() ? 'none' : 'self_host'),
      current_period_end: b.current_period_end ?? undefined,
      usage: getUsage(db, key.projectId),
      billing_enabled: billingActive(),
    };
  });

  // POST /v1/billing/checkout — Stripe Checkout session (admin scope)
  app.post('/v1/billing/checkout', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const stripe = getStripe();
    if (!billingActive() || !stripe) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Billing is not enabled on this instance' });
    }
    const parsed = CheckoutBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });

    const priceId = priceIdFor(parsed.data.plan, parsed.data.period);
    if (!priceId) {
      return reply.status(400).send({ error: 'Bad Request', message: `No price configured for ${parsed.data.plan}/${parsed.data.period}` });
    }

    // Reuse or create the project's Stripe customer.
    let customerId = getProjectBilling(db, key.projectId).stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { project_id: key.projectId } });
      customerId = customer.id;
      db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run(customerId, key.projectId);
    }

    // Redirect back to the web UI, which may live on a different origin than
    // the API (e.g. app.impri.dev vs api.impri.dev). Falls back to BASE_URL
    // for same-origin self-hosting.
    const appUrl = process.env.APP_URL ?? process.env.BASE_URL ?? 'http://localhost:8484';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: key.projectId,
      success_url: `${appUrl}/?checkout=success`,
      cancel_url: `${appUrl}/?checkout=canceled`,
    });
    return { url: session.url };
  });

  // POST /v1/billing/portal — Stripe customer portal (admin scope)
  app.post('/v1/billing/portal', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }
    const stripe = getStripe();
    if (!billingActive() || !stripe) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Billing is not enabled on this instance' });
    }
    const customerId = getProjectBilling(db, key.projectId).stripe_customer_id;
    if (!customerId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'No billing customer yet — start a subscription first' });
    }
    const appUrl = process.env.APP_URL ?? process.env.BASE_URL ?? 'http://localhost:8484';
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${appUrl}/?checkout=success` });
    return { url: session.url };
  });

  // POST /v1/billing/webhook — Stripe events (public; verified by signature)
  app.post('/v1/billing/webhook', async (request, reply) => {
    const stripe = getStripe();
    if (!billingActive() || !stripe) return reply.status(400).send({ error: 'Billing not enabled' });

    const sig = request.headers['stripe-signature'];
    const raw = (request as { rawBody?: Buffer }).rawBody;
    if (!sig || typeof sig !== 'string' || !raw) {
      return reply.status(400).send({ error: 'Missing signature or body' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, webhookSecret());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: `Webhook signature verification failed: ${msg}` });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const projectId = session.client_reference_id;
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          if (projectId && customerId) {
            db.prepare('UPDATE projects SET stripe_customer_id = ? WHERE id = ?').run(customerId, projectId);
            if (session.subscription) {
              const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
              const sub = await stripe.subscriptions.retrieve(subId);
              applySubscription(db, customerId, sub);
            }
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
          applySubscription(db, customerId, sub);
          break;
        }
        default:
          break; // ignore other events
      }
    } catch (err) {
      request.log.error({ err }, 'billing webhook handler failed');
      return reply.status(500).send({ error: 'Webhook handler error' });
    }

    return { received: true, ts: nowSec() };
  });
}
