# Billing

Impri is **open-core**: the self-hosted version has no billing, no limits, and no Stripe dependency. Limits only apply to the hosted cloud (`api.impri.dev`), where billing is enforced per project tier.

---

## Tiers

| | Free | Indie | Team |
|---|---|---|---|
| Approvals per month | 100 | 2 000 | Unlimited |
| Active watchers | 3 | 20 | Unlimited |
| Minimum watcher interval | 15 min | 5 min | 1 min |
| Billing | — | Stripe subscription | Stripe subscription |

**Approvals** are counted as decisions made (approved or rejected) in the current UTC calendar month, not actions created. Expired actions do not count.

**Active watchers** are watchers with `status != "paused"`.

---

## Self-hosting

When `STRIPE_SECRET_KEY` is not set in the server environment, billing is fully disabled:

- All tier limits are bypassed — unlimited approvals and watchers.
- `GET /v1/billing` returns `{ "billing_enabled": false, "status": "self_host" }`.
- `POST /v1/billing/checkout` and `POST /v1/billing/portal` return `400 Bad Request`.
- There is no Stripe dependency at runtime.

This is the default for anyone running `docker compose up` from the repository.

---

## API reference

All billing endpoints require the **`admin`** scope.

### `GET /v1/billing` — current tier and usage

```http
GET /v1/billing HTTP/1.1
Authorization: Bearer im_...
```

Response:

```json
{
  "tier": "free",
  "status": "none",
  "current_period_end": null,
  "billing_enabled": true,
  "usage": {
    "approvals": { "used": 12, "limit": 100 },
    "watchers":  { "used": 1,  "limit": 3 }
  }
}
```

`status` values:
- `"none"` — no active subscription (free tier)
- `"active"` — subscription is active
- `"trialing"` — subscription is in a trial period
- `"past_due"` / `"canceled"` / `"unpaid"` — Stripe subscription states
- `"self_host"` — billing is disabled (self-hosted, no `STRIPE_SECRET_KEY`)

`current_period_end` is a Unix timestamp for when the current billing period ends, or `null` for free/self-host.

`limit: null` means unlimited (team tier, or self-hosted).

**Error responses:**

| Status | Meaning |
|--------|---------|
| `402` | Usage limit reached — the 402 body contains `limit` and `tier` fields |
| `403` | Key lacks `admin` scope |

---

### `POST /v1/billing/checkout` — start a subscription

Creates a Stripe Checkout session for the `indie` or `team` plan.

```http
POST /v1/billing/checkout HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{
  "plan": "indie",
  "period": "monthly"
}
```

`plan`: `"indie"` or `"team"`
`period`: `"monthly"` (default) or `"yearly"`

Response:

```json
{ "url": "https://checkout.stripe.com/c/pay/..." }
```

Redirect the user to `url`. On success, Stripe redirects back to `APP_URL/?checkout=success`. On cancel, back to `APP_URL/?checkout=canceled`.

Returns `400 Bad Request` when billing is disabled (self-hosted with no `STRIPE_SECRET_KEY`).

---

### `POST /v1/billing/portal` — manage subscription

Creates a Stripe Customer Portal session so the user can change plan, update payment method, or cancel.

```http
POST /v1/billing/portal HTTP/1.1
Authorization: Bearer im_...
```

Response:

```json
{ "url": "https://billing.stripe.com/p/session/..." }
```

Returns `400 Bad Request` if the project has no Stripe customer yet (never subscribed).

---

### `POST /v1/billing/webhook` — Stripe event receiver

Public endpoint (no auth header). Stripe calls this when a subscription event occurs. The server verifies the `Stripe-Signature` header before processing.

Handled events:

| Event | Effect |
|-------|--------|
| `checkout.session.completed` | Links Stripe customer to project; activates subscription |
| `customer.subscription.created` | Updates project tier to match the subscribed price |
| `customer.subscription.updated` | Updates tier / status / period_end |
| `customer.subscription.deleted` | Downgrades project to `free` |

Configure in the Stripe Dashboard as `POST https://api.impri.dev/v1/billing/webhook` (or your self-hosted URL). Required env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

---

## Limit enforcement

When a project hits a limit, the relevant endpoint returns `402 Payment Required`:

- `POST /v1/actions` — when `approvals_per_month` limit is reached
- `POST /v1/watchers` and `POST /v1/watchers/from-preset` — when `watchers` limit is reached or the requested schedule is more frequent than the tier's `min_interval`

`402` response body:

```json
{
  "error": "Payment Required",
  "message": "Monthly approval quota reached (100/100). Upgrade to indie for 2 000/month.",
  "limit": 100,
  "tier": "free"
}
```

---

## Self-hosting configuration

| Env var | Purpose |
|---------|---------|
| `STRIPE_SECRET_KEY` | Activates billing (required for paid plans) |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhook events |
| `STRIPE_PRICE_INDIE` | Stripe Price ID for indie monthly |
| `STRIPE_PRICE_INDIE_YEARLY` | Stripe Price ID for indie yearly |
| `STRIPE_PRICE_TEAM` | Stripe Price ID for team monthly |
| `STRIPE_PRICE_TEAM_YEARLY` | Stripe Price ID for team yearly |
| `APP_URL` | Redirect base after Stripe Checkout (defaults to `BASE_URL`) |

When none of the `STRIPE_PRICE_*` vars are set, checkout calls for that plan/period return `400 Bad Request`.
