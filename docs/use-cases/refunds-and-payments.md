<!-- title: Approve refunds and charges an AI support agent wants to issue -->
<!-- description: Require human sign-off before an AI support or billing agent issues a refund or charge, with the amount and reason visible in the approval card. -->
<!-- screenshot: inbox.png | The Impri inbox showing a pending refund action alongside other queued approvals -->
# Approve refunds and charges an AI support agent wants to issue

An AI support agent that can look up an order, understand the complaint, and decide a refund is warranted is genuinely useful — most refund requests are routine and the reasoning is easy to check. The part worth gating isn't the judgment call, it's the money actually moving.

## Problem

A support agent that's right 98% of the time about refund amounts is still wrong roughly once in fifty. At volume, "wrong" here means real charge-backs, real disputes, real reconciliation work, and a customer who got refunded twice or not at all. Refunds also invite a specific failure mode agents are bad at resisting: a customer arguing forcefully for a bigger refund than policy allows, phrased as if it were already agreed.

## Workflow

1. The agent decides a refund is warranted, computes the amount, and calls `impri_push_action` with the order ID, amount, and reason as the preview — not the refund API call itself.
2. Impri can route by amount: small refunds under a threshold auto-approve via a [rule](/docs/rules), while anything above it — or anything the agent flags as a policy exception — reaches a human.
3. A human reviewer sees the order, the customer's message, and the proposed amount side by side, and approves, reduces the amount by editing the field, or rejects with a note.
4. `impri_await_decision` returns the (possibly edited) amount; the agent calls the payment processor's actual refund endpoint only with that approved figure.
5. `impri_report_result` closes the loop with the processor's transaction ID, so the audit log ties every refund back to the decision that authorized it.

## MCP example

```
impri_push_action({
  kind: "payment.refund",
  title: "Refund $84.00 to order #10432 — damaged item, customer provided photos",
  preview: {
    format: "plain",
    body: "Order #10432, $84.00 full refund. Customer: item arrived cracked, photo attached to ticket #6021."
  },
  payload: { order_id: "10432", amount_cents: 8400, currency: "USD" },
  target_url: "https://support.acme.com/tickets/6021",
  editable: ["payload.amount_cents"]
})
// -> { action_id: "act_5jf8...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_5jf8..." }

impri_await_decision({ action_id: "act_5jf8...", timeout_s: 1800 })
// -> { action_id: "act_5jf8...", status: "approved", decision_at: 1757830200, preview: { format: "diff", body: "..." }, edited_by_human: false }

impri_report_result({
  action_id: "act_5jf8...",
  status: "executed",
  detail: "Refunded via Stripe, txn re_1P..."
})
```

## Result

Routine, in-policy refunds still flow at the speed a support agent promises. Every refund that's large, unusual, or contested gets a human looking at the actual amount and reason before money moves — and a paper trail that shows exactly who authorized it.

## CTA

Related: [Approve refunds issued by an AI support agent](/docs/approve-refunds-issued-by-an-ai-support-agent) and [Human approval for fintech AI agents](/docs/human-approval-for-fintech-ai-agents). [Try Impri free](https://app.impri.dev).
