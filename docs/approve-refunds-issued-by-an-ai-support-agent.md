# Approve Refunds Issued by an AI Support Agent

Give a support agent the power to resolve tickets by issuing refunds and you've also given it the power to drain your Stripe balance on a bad day — gate every refund behind human approval and the agent can still resolve the ticket fast, just not unsupervised.

---

## Why refunds are a different risk class than replies

Most AI support agent mistakes are annoying: a wrong tone, a repeated answer, a missed nuance. A refund mistake is a wire transfer. If the agent misreads a policy ("full refund for any complaint within 30 days"), gets talked into it by a customer who knows the trigger phrases, or simply hallucinates an order total, the money moves. Stripe doesn't ask the agent if it's sure — `refunds.create` executes on the API call, not on the intent behind it.

This is also the failure mode most likely to compound: a support agent processing a queue of 200 tickets doesn't make one mistake, it makes the same mistake 200 times if the bad reasoning is systemic (e.g., a misconfigured refund policy in its prompt). A human checkpoint before the Stripe call catches that on ticket one instead of ticket two hundred.

## Wiring the gate into the refund path

The agent's refund tool should never call Stripe directly — it should call a wrapper that pushes the proposal to Impri and only calls Stripe once approved:

```typescript
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const BASE = "https://api.impri.dev";

interface RefundProposal {
  chargeId: string;
  amountCents: number;
  customerEmail: string;
  reason: string;
}

async function proposeRefund(p: RefundProposal): Promise<string> {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "payment.refund",
      title: `Refund $${(p.amountCents / 100).toFixed(2)} — ${p.customerEmail}`,
      preview: {
        format: "markdown",
        body: `**Charge:** ${p.chargeId}\n**Amount:** $${(p.amountCents / 100).toFixed(2)}\n**Reason given by agent:** ${p.reason}`,
      },
      expires_in: 43200, // 12h — support tickets shouldn't sit longer than that
      idempotent: false,
      undo: "No automatic undo — a reversed refund requires a new manual charge",
    }),
  });
  const { id } = await res.json();
  return id;
}

async function waitForDecision(actionId: string) {
  while (true) {
    const res = await fetch(`${BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function refundWithApproval(p: RefundProposal) {
  const actionId = await proposeRefund(p);
  const decision = await waitForDecision(actionId);

  if (decision.status !== "approved") {
    return { executed: false, status: decision.status };
  }

  const refund = await stripe.refunds.create({ charge: p.chargeId, amount: p.amountCents });

  await fetch(`${BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IMPRI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "executed", payload: { refundId: refund.id } }),
  });

  return { executed: true, refundId: refund.id };
}
```

The `stripe.refunds.create` call sits behind the `decision.status !== "approved"` early return — that's the whole point. The agent's ticket-resolution logic can decide a refund is warranted, draft the reasoning, and call `refundWithApproval`, but the actual money movement is one `if` away from a human decision, not from the agent's own judgment.

## What the reviewer sees, and how it maps to risk

The `preview.body` above deliberately surfaces the charge ID, the dollar amount, and the agent's stated reasoning — a reviewer approving refunds from a phone needs those three facts and nothing else to make a fast, correct call. `undo` is set because refunds genuinely have none through this API; the reviewer should know that before tapping approve, not find out after.

| Refund path | Recommended handling |
|---|---|
| Under a set threshold (e.g. $20), clear policy match | Still gate it — small refunds add up across a queue |
| Above threshold, or ambiguous policy match | Gate it, and consider routing to a senior reviewer via a separate key/inbox |
| Duplicate charge, customer-verified error | Gate it — `idempotent: false` warns the reviewer a retry would double-refund |
| Chargeback already filed | Don't refund via the agent at all — that's a payments-team process, not a support ticket |

## Result payload and audit trail

Reporting `result` with `payload: { refundId: refund.id }` means the Stripe refund ID is attached to the approval record — when finance asks "who approved this and why," the answer is in one place instead of split across Stripe's dashboard and your support tool's logs. See [audit log](audit-log.md) for how these records are retained and queried.

## Boundaries

Impri does not know your refund policy and does not evaluate whether $340 is reasonable for this ticket — it shows the reviewer what the agent proposed and holds the yes/no. The agent still owns the reasoning; the reviewer still owns the judgment call; Impri owns making sure the Stripe call can't happen without both. For the full three-call pattern (REST and MCP) and how to make the wrapper an actual chokepoint rather than a suggestion, see the [main integration guide](how-to-add-human-approval-to-an-ai-agent.md). If your team wants a Slack-based approve/reject flow instead of the web inbox, see [approving agent actions from Slack](approve-ai-agent-actions-from-slack.md).

New to Impri? Start with the [quickstart](quickstart.md).
