# Recipe 4 — Payment Approval Gate

A finance agent gates payments above a configurable dollar threshold on human
approval. Low-value payments auto-execute; high-value ones land in the inbox.

## Why this matters

Autonomous payment agents can drain accounts on hallucinated or fraudulent
invoices. A threshold-based gate requires explicit human sign-off above a
certain amount — a standard internal control — without adding friction to
routine small transactions.

## How it works

```
agent receives a payment request (invoice, expense, refund)
    if amount < APPROVAL_THRESHOLD:
        execute immediately — no gate
    else:
        POST /v1/actions  (kind: payment.initiate, target_url = invoice URL)
        human sees amount + description + link to invoice
        agent polls GET /v1/actions/:id
        if approved: initiate transfer via payment processor
        POST /v1/actions/:id/result
```

## Requirements

- Python 3.8+ (stdlib only — no pip install)
- Impri API key with `actions` scope
- Running Impri instance

## Quick start

```bash
# Default threshold: $100
IMPRI_API_KEY=im_your_key python3 agent.py

# Custom threshold
IMPRI_API_KEY=im_your_key APPROVAL_THRESHOLD=250 python3 agent.py

# Cloud
IMPRI_API_KEY=im_your_key IMPRI_BASE_URL=https://api.impri.dev python3 agent.py
```

## Connecting to a real payment processor

Replace the `execute_payment()` stub with your processor's SDK:

**Stripe:**
```python
import stripe
stripe.api_key = os.environ["STRIPE_SECRET_KEY"]

def execute_payment(p):
    intent = stripe.PaymentIntent.create(
        amount=int(p["amount_usd"] * 100),
        currency="usd",
        description=p["description"],
    )
    stripe.PaymentIntent.confirm(intent.id)
    return intent.id
```

**ACH / bank transfer:** similar pattern — replace with your bank API client.

## Idempotency

`idempotency_key: "payment-INV-2026-07-001"` means re-running the agent for
the same invoice (after a crash, a retry, or an accidental double-trigger)
returns the existing action instead of creating a second inbox card and
potentially a double payment.

## Audit trail

Every payment approved through Impri has a timestamped record:
- Who approved it (channel, timestamp)
- The original amount and description
- The execution result and transaction ID

`GET /v1/actions?kind=payment.initiate` retrieves the full history.
