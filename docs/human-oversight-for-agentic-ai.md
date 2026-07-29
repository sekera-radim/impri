# Human Oversight for Agentic AI

Human oversight for agentic AI means deciding, per tool call in a multi-step pipeline, whether a person must sign off before a side effect fires — not reviewing every step the agent takes.

---

## "Agentic" changes what oversight has to cover

A single-turn chatbot has one obvious oversight point: the reply. An agentic system doesn't — it plans, calls tools, calls more tools based on what the first ones returned, and can touch several external systems before it produces anything a human sees. A procurement agent might search a vendor catalog, compare prices, draft a purchase order, and submit it to your ERP, all in one run. Oversight applied only at the end ("show me the final summary") arrives after the purchase order is already submitted.

The fix isn't reviewing every intermediate step either — that just recreates the bottleneck agentic pipelines were built to remove. It's identifying which specific calls in the chain cause an external, hard-to-reverse effect, and gating only those.

## Point checks vs. the audit trail

Oversight has two components that do different jobs:

- **Point checks** — a synchronous gate before a specific call executes. This is what stops a bad purchase order from being submitted.
- **Audit trail** — a durable record of what was proposed, who decided, and when. This is what lets you answer "why did this happen" three weeks later, when the point check is long past.

Impri provides both from the same underlying data: every `POST /v1/actions` call is both the point check (the agent blocks on the decision) and an `audit_log` row (`action.created`, later `action.approved` or `action.rejected`, with the deciding key or channel user recorded). You don't instrument these separately.

## Wiring a point check into an agentic pipeline

Here the procurement agent has already searched vendors and drafted a purchase order. Submitting it commits real spend, so it's the point that needs a human — the search and comparison steps before it don't.

```bash
# Step the agent already ran: vendor search + price comparison (no gate needed, read-only)

# Point check before the PO is submitted to the ERP
ACTION=$(curl -s -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "erp.purchase_order.submit",
    "title": "PO-4471: 200x USB-C hub, Vendor: Anker Direct, $3,840.00",
    "preview": {
      "format": "markdown",
      "body": "**Vendor:** Anker Direct\n**Qty:** 200 @ $19.20\n**Total:** $3,840.00\n**Delivery:** 12 business days\n\nChosen over 2 other quotes (see comparison in target_url)."
    },
    "target_url": "https://internal.example.com/procurement/comparisons/4471",
    "editable": ["preview.body"],
    "expires_in": 14400,
    "idempotent": false,
    "undo": "Cancel PO-4471 in the ERP before the vendor confirms receipt (within 24h)"
  }')

ACTION_ID=$(echo $ACTION | jq -r .id)

# Agent blocks here until a human decides — poll or use impri_await_decision over MCP
```

`idempotent: false` and `undo` don't change whether the gate fires — they add context so the reviewer knows a duplicate submission would double the order, and how to unwind it if approved by mistake. That's oversight information, not just a yes/no gate.

## Tiering oversight instead of applying it uniformly

Not every call in an agentic pipeline deserves the same scrutiny, and treating them uniformly either creates approval fatigue (everything needs a human) or false safety (nothing does). The [rules engine](rules.md) lets you tier by risk instead:

| Pipeline step | Oversight tier | Mechanism |
|---|---|---|
| Vendor search, price comparison | None — read-only, no side effect | Not wrapped at all |
| PO under $500, known vendor | Auto-approve, logged | `payload_conditions` rule: `amount lt 500` + `vendor in [allowlist]` |
| PO $500–$5,000 | Human gate, normal expiry | Default — no matching rule, falls through to `pending` |
| PO over $5,000, or new vendor | Human gate, escalated to on-call channel | Rule with `rule_action: "escalate"` to a Slack/Telegram channel |

The auto-approved tier still writes an `action.rule_applied` audit event — low-risk doesn't mean unlogged, it means no one has to act on it in real time.

## Where oversight stops being real

A gate is only oversight if the agent has no other way to reach the ERP. If the procurement agent holds ERP credentials directly and only *chooses* to call Impri first, a bad plan, a prompt injection from a scraped vendor page, or a future code change can route around the check entirely. The point check above only means something if `erp.purchase_order.submit` is a wrapped function and the raw ERP client is not reachable from the agent's tool surface — see [the SDK integrations guide](integrations.md) for how to build that wrapper.

Impri also does not decide *which* steps need oversight, does not interpret whether a given PO is a good deal, and is not a workflow engine — if your agentic pipeline needs branching logic across many systems beyond approve/reject, that belongs in something like n8n or Temporal, with Impri as one node in it. What Impri owns is narrower and more mechanical: hold the proposed action, notify the right human or channel, record the decision, and refuse to let the agent past that data dependency.

## Next step

Start with the three-call pattern in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), then layer in tiering once you have more than one action kind — see [the rules engine](rules.md) and [the audit log](audit-log.md) for the retrospective side of oversight.
