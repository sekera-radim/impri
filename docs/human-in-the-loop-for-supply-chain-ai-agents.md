# Human-in-the-Loop for Supply Chain AI Agents

An AI agent that reorders stock, renegotiates vendor terms, or reroutes shipments needs a human checkpoint before the money or the goods move — this shows the gate for procurement and logistics agents.

---

## Why supply chain agents need a harder gate than most

A support bot that drafts a bad reply wastes a customer's time. A supply chain agent that acts on a bad decision writes a purchase order, commits warehouse capacity, or cancels a shipment already in transit — and those are expensive to undo, if they can be undone at all. The agent is also the one most likely to be fed unreliable input: a demand-forecast anomaly, a scraped competitor price, a supplier's automated email with a typo'd unit count. None of that should turn directly into a PO.

The fix isn't slowing the agent down everywhere. It's routing the specific actions that move inventory or money through one gate, while letting read-only work (checking stock levels, pulling lead times, querying a supplier catalog) run freely.

## What to gate vs. what to leave alone

| Action | Gate it? |
|---|---|
| Query current stock levels, lead times, supplier catalogs | No — read-only |
| Generate a reorder recommendation | No — it's a draft, not an action |
| Submit a purchase order to a supplier | Yes |
| Change a vendor's payment terms or pricing tier | Yes |
| Cancel or reroute an in-transit shipment | Yes |
| Flag a low-stock SKU for review | No — informational |

The pattern below applies to any of the "yes" rows; a reorder PO is the concrete example.

## Gating a reorder decision

The agent proposes the PO as an Impri action instead of calling the supplier API directly. A human — usually whoever owns that supplier relationship — sees the SKU, quantity, and unit cost before it goes out.

```python
import os
import time
import requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_reorder(sku: str, qty: int, unit_cost: float, supplier: str) -> str:
    body = {
        "kind": "purchase_order.submit",
        "title": f"Reorder {qty}x {sku} from {supplier}",
        "preview": {
            "format": "markdown",
            "body": (
                f"**SKU:** {sku}\n**Quantity:** {qty}\n"
                f"**Unit cost:** ${unit_cost:.2f}\n**Total:** ${unit_cost * qty:.2f}\n"
                f"**Supplier:** {supplier}\n\nTriggered by reorder-point breach."
            ),
        },
        "idempotent": False,
        "undo": f"Cancel PO with supplier {supplier} before it ships; contact procurement@ to confirm.",
        "editable": ["preview.body"],
        "expires_in": 43200,  # 12h — stock decisions go stale fast
    }
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json=body)
    return resp.json()["id"]

def wait_for_decision(action_id: str) -> dict:
    while True:
        resp = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(15)

action_id = propose_reorder("SKU-4471", 500, 3.20, "Northwind Supplies")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    final = decision["decision"]["final_preview"]  # carries any edits the buyer made
    # submit_purchase_order(final["body"])  # your actual supplier-API call
    requests.post(
        f"{API}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
```

Three things matter here specifically for supply chain use cases:

- **`idempotent: false`** — resubmitting the same PO after a retry or a timeout duplicates a real order. The approval card shows the reviewer a warning badge so they know a retry isn't free.
- **`undo`** — procurement approvers want to know the rollback path before they click approve, not after. A PO is not a config flag; "cancel before it ships" is honest about how partial the undo actually is.
- **Short `expires_in`** — a reorder recommendation based on today's stock count is stale in a day. Let it expire rather than have someone approve a decision based on yesterday's numbers.

## Multiple approvers, one SKU category

Procurement teams commonly split ownership by supplier or category rather than having one person approve everything. Route the notification accordingly — Impri's channel integrations (see [Slack approval](slack-approval.md)) let you point different `kind` values or title patterns at different channels or reviewers, so the person who owns the Northwind relationship sees Northwind POs, not every SKU in the warehouse.

## What this doesn't solve

Impri holds the decision and shows the reviewer what's about to happen — it does not evaluate whether the reorder quantity is *correct*. If your forecasting model is systematically wrong, a human approving a bad PO one at a time won't catch that pattern; you still need monitoring on the forecast itself. Impri is also not a substitute for your ERP's own PO validation (budget limits, duplicate-supplier checks) — those should run before the action is even proposed, so the human is approving something already sane on its face.

---

Next: wire this into your agent's actual supplier client with the [Python SDK](sdk-python.md), or read the [quickstart](quickstart.md) to get an API key first. For an audit trail of every reorder decision, see [adding an audit log](adding-an-audit-log-to-your-ai-agent.md).
