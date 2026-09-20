# Approve AI Agent Expense Reports and Invoices

Put a human approval gate in front of an AI accounts-payable agent so no invoice gets paid and no expense gets reimbursed without someone actually saying yes.

---

## The scenario

An AP agent reads incoming vendor invoices (email attachments, a shared inbox, an OCR pipeline), matches them against purchase orders, and decides what to pay and when. A parallel version handles employee expense reports: it checks receipts against policy and proposes a reimbursement. Both are the same shape of problem — the agent is confident, the amounts are real money, and the failure mode (a duplicate payment, a mis-scanned amount, a receipt for something against policy) is not something you want discovered after the transfer clears.

This is a worse candidate for "just let it run" than most agent tasks, because the two most common invoice-agent bugs — double-processing the same invoice, and misreading a decimal point from OCR — both look completely normal in a log until the money is already gone.

## Wiring the gate into an AP agent

The agent pushes one action per invoice or expense report, waits for a decision, and only calls your payment API once it gets `approved` back.

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_payment_approval(invoice):
    body = (
        f"Vendor: {invoice['vendor']}\n"
        f"Amount: {invoice['currency']} {invoice['amount']}\n"
        f"PO match: {invoice['po_number']} ({invoice['match_confidence']}% confidence)\n"
        f"Due: {invoice['due_date']}"
    )
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "invoice.pay",
        "title": f"Pay {invoice['vendor']} — {invoice['currency']} {invoice['amount']}",
        "preview": {"format": "markdown", "body": body},
        "idempotent": False,
        "undo": f"Void payment via /payments/{{payment_id}}/void within 24h",
        "expires_in": 172800,  # 48h — invoices are rarely this urgent
    }).json()
    return resp["id"]

def wait_and_pay(action_id, invoice):
    while True:
        result = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(15)

    if result["status"] == "approved":
        payment_id = pay_invoice(invoice)  # your payment rail
        requests.post(f"{API}/v1/actions/{action_id}/result", headers=HEADERS, json={
            "status": "executed",
            "payload": {"payment_id": payment_id},
        })
    # rejected or expired: do nothing, leave the invoice for manual handling
```

`idempotent: False` puts a warning badge on the card — the reviewer sees "retrying may duplicate this action" before approving, which is exactly the property you want when the agent's own retry logic could otherwise double-pay a vendor. `undo` gives the approver a documented rollback path instead of them having to guess whether a bad payment can be clawed back.

## What the approval card should show

Put the numbers the human actually needs to make the call in the preview body, not buried in a linked system:

| Field | Why it belongs on the card |
|---|---|
| Vendor name and amount | The two things a human checks first against memory |
| PO match confidence | Low confidence is the signal to look closer, not to trust the agent |
| Due date | Determines whether this is worth interrupting someone for right now |
| Currency | Silent currency bugs are a classic OCR failure mode |

## Handling rejection and low-confidence matches

Treat `expired` the same as `rejected` — an invoice approval that timed out is not an invoice that got silently approved. If the PO match confidence is below whatever threshold you set, don't even bother the human with an approval card yet; route it to manual review first and only push an Impri action once the agent (or a person) is confident enough to propose a specific payment.

## Boundaries

Impri stores the proposed payment, shows it to a human, and holds the decision — it does not verify the invoice against your accounting system or check budget headroom. That reconciliation logic stays in your agent or your ERP integration. And the gate only holds if the agent has no other path to `pay_invoice()` — if it also holds a standing API key to your payment processor for "emergencies," that's the path that bypasses this entirely.

Next: [wire this into the base flow](how-to-add-human-approval-to-an-ai-agent.md) if you haven't already, then look at [the Python SDK](sdk-python.md) to skip the raw `requests` calls, and check [audit-log](audit-log.md) for how approved/rejected payments show up for your books.
