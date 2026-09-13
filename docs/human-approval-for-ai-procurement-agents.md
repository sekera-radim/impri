# Human Approval for AI Procurement Agents

An AI agent that can generate a purchase order is one bad supplier match away from a real invoice. This is the pattern for putting a human sign-off between the agent's recommendation and the money actually moving.

---

## Why procurement is a stricter case than "approve this email"

Most human-in-the-loop examples are about tone and wording — did the agent phrase the outreach email well. Procurement is different: the downside of a bad approval is a line item on next month's invoice, a vendor relationship, or a budget line that someone in finance has to explain. That changes what the approval card needs to show and what metadata is worth attaching to the action, not the mechanics of the gate itself.

A procurement agent typically does three things before it should ever be allowed to touch a vendor system: match a need to a catalog item or RFQ response, compute a total against budget, and draft the PO. All three can be done by the agent. The fourth step — actually submitting the PO to the ERP or emailing the vendor a confirmed order — is the one that needs a human in the loop.

---

## The purchase order approval flow

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_purchase_order(vendor, items, total_usd):
    body = {
        "kind": "procurement.purchase_order.create",
        "title": f"PO for {vendor}: ${total_usd:,.2f}",
        "preview": {
            "format": "markdown",
            "body": (
                f"**Vendor:** {vendor}\n\n"
                f"**Items:**\n" + "\n".join(f"- {i['qty']}x {i['name']} @ ${i['unit_price']}" for i in items) +
                f"\n\n**Total:** ${total_usd:,.2f}"
            ),
        },
        "target_url": f"https://erp.internal.example.com/vendors/{vendor}",
        "expires_in": 259200,  # 72h — a stale PO shouldn't auto-submit later
        "editable": ["preview.body"],
        "idempotent": False,  # submitting the same PO twice creates a duplicate order
        "undo": "Cancel PO via ERP > Purchase Orders > Cancel (before vendor acknowledges)",
    }
    resp = requests.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json=body)
    return resp.json()["id"]

def wait_for_decision(action_id, poll_seconds=15):
    while True:
        resp = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(poll_seconds)

action_id = propose_purchase_order("Acme Supplies Ltd.", [
    {"name": "A4 paper, 500-sheet", "qty": 40, "unit_price": 4.25},
    {"name": "Toner cartridge, black", "qty": 12, "unit_price": 38.00},
], total_usd=626.00)

decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    final_body = decision["decision"]["final_preview"]["body"]
    # submit_po_to_erp(final_body) — your actual ERP call
    requests.post(f"{IMPRI_BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed", "payload": {"erp_po_number": "PO-88213"}})
else:
    print(f"PO not submitted — decision was {decision['status']}")
```

A rejected or expired decision means the ERP call is simply never made. There's no separate "cancel" step to remember — the agent's code path to `submit_po_to_erp` only exists inside the `approved` branch.

---

## Let the reviewer edit numbers before they commit

Procurement drafts often need a small correction — a quantity typo, a unit price the agent misread from a quote PDF — rather than an outright rejection. Setting `editable: ["preview.body"]` lets the person approving the PO fix the draft directly in the inbox card instead of rejecting it and asking the agent to redo the whole thing. `decision.diff` on the response shows exactly what was changed, which matters when finance later asks why a PO total doesn't match the original AI-generated draft.

---

## Audit trail for finance and compliance

Every procurement approval Impri holds becomes a queryable record: who approved it, when, and what the final approved content was versus what the agent originally proposed. For a finance or compliance review, that's the artifact that answers "why did this vendor get paid" without anyone having to reconstruct it from Slack messages or email threads. See [the audit log docs](audit-log.md) for what's retained and for how long.

---

## What Impri does not do here

Impri does not talk to your ERP, does not check the PO against a budget, and does not validate that the vendor and pricing are legitimate — all of that is the agent's job before the action is ever created. Impri's only responsibility is holding the "submit or don't" decision and making sure the ERP call in your code is unreachable without an `approved` status. If the agent still holds a credential that can call the ERP directly, wrap that credential so the approved decision is genuinely the only path — see [SDK integrations](sdk-python.md) for how to structure that wrapper.

Next step: if this is your first Impri integration, start with the [quickstart](quickstart.md) to get an API key, then come back and adapt the code above to your ERP.
