#!/usr/bin/env python3
"""
payment-approval.py — Impri cookbook recipe #4
Python stdlib only (urllib, json). Python 3.8+.

Pattern: a finance/expense agent gates payments above a configured threshold
on human approval. Low-value payments pass through automatically; high-value
ones land in the inbox for review.

Run:
    IMPRI_API_KEY=im_xxx python3 agent.py
    IMPRI_API_KEY=im_xxx IMPRI_BASE_URL=https://api.impri.dev python3 agent.py
    IMPRI_API_KEY=im_xxx APPROVAL_THRESHOLD=50 python3 agent.py

Required scope: actions
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Any

API_KEY = os.environ.get("IMPRI_API_KEY")
BASE = os.environ.get("IMPRI_BASE_URL", "http://localhost:8484").rstrip("/")
# Payments at or above this amount (USD) require human approval.
APPROVAL_THRESHOLD = float(os.environ.get("APPROVAL_THRESHOLD", "100"))

if not API_KEY:
    print("Set IMPRI_API_KEY (it starts with im_).", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Minimal API helper (stdlib only)
# ---------------------------------------------------------------------------

def api(path: str, method: str = "GET", body: dict | None = None) -> dict:
    url = f"{BASE}/v1{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw)
            msg = payload.get("message") or payload.get("error") or raw.decode()
        except Exception:
            msg = raw.decode()
        raise RuntimeError(f"{method} /v1{path} → {e.code}: {msg}") from e


# ---------------------------------------------------------------------------
# The payment the agent wants to make.
# In production this would come from an expense report, procurement system, etc.
# ---------------------------------------------------------------------------

payment = {
    "id": "pay_invoice_7821",
    "vendor": "Acme Cloud Infrastructure",
    "amount_usd": 349.50,
    "currency": "USD",
    "invoice_ref": "INV-2026-07-001",
    "description": "Monthly compute (July 2026) — 3× r7g.xlarge + bandwidth",
    "payment_method": "ACH direct debit — **** 4821",
    "due_date": "2026-07-15",
    "invoice_url": "https://billing.acmecloud.example.com/invoices/INV-2026-07-001",
}


def build_preview(p: dict) -> str:
    return (
        f"## Payment approval request\n\n"
        f"**Vendor:** {p['vendor']}\n"
        f"**Amount:** ${p['amount_usd']:,.2f} {p['currency']}\n"
        f"**Invoice:** {p['invoice_ref']}\n"
        f"**Due:** {p['due_date']}\n"
        f"**Method:** {p['payment_method']}\n\n"
        f"### Description\n{p['description']}\n\n"
        f"[View invoice ↗]({p['invoice_url']})"
    )


# ---------------------------------------------------------------------------
# Stub: replace with your actual payment processor call.
# ---------------------------------------------------------------------------

def execute_payment(p: dict) -> str:
    print(f"   [stub] initiating payment of ${p['amount_usd']:.2f} to {p['vendor']}")
    # In production:
    #   stripe.PaymentIntent.create(amount=int(p['amount_usd']*100), currency='usd', ...)
    #   or bank_transfer_api.send(...)
    return f"txn_stub_{p['id']}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    p = payment
    print(f"\nImpri payment-approval → {BASE}")
    print(f"  Payment: ${p['amount_usd']:.2f} to {p['vendor']}")
    print(f"  Threshold: ${APPROVAL_THRESHOLD:.2f}\n")

    # Payments below the threshold are executed without a gate.
    if p["amount_usd"] < APPROVAL_THRESHOLD:
        print(f"  Amount below threshold (${APPROVAL_THRESHOLD:.2f}) — auto-executing without approval.")
        txn_id = execute_payment(p)
        print(f"  OK — payment executed automatically: {txn_id}")
        return

    # Above threshold: gate on human approval.
    print(f"  Amount exceeds threshold — requesting human approval.")

    action = api("/actions", "POST", {
        "kind": "payment.initiate",
        "title": f"Pay ${p['amount_usd']:.2f} to {p['vendor']} ({p['invoice_ref']})",
        "preview": {
            "format": "markdown",
            "body": build_preview(p),
        },
        "target_url": p["invoice_url"],
        "payload": {
            "payment_id": p["id"],
            "amount_usd": p["amount_usd"],
            "vendor": p["vendor"],
            "invoice_ref": p["invoice_ref"],
        },
        # Idempotency: re-running for the same invoice never creates a duplicate.
        "idempotency_key": f"payment-{p['invoice_ref']}",
        "expires_in": 86400,  # 24 h — don't approve yesterday's payment
    })

    print(f"  Created action {action['id']} (status: {action['status']})")
    inbox = action.get("inbox_url") or BASE.replace(":8484", ":8080")
    print(f"  Open your inbox: {inbox}\n")

    # Poll for decision.
    current = action
    while current["status"] == "pending":
        time.sleep(3)
        current = api(f"/actions/{action['id']}")
        print(f"  Waiting for human decision... ({current['status']})", end="\r", flush=True)

    print(f"\n  Decision: {current['status'].upper()}")

    if current["status"] != "approved":
        print("  Not approved — payment was NOT made.")
        sys.exit(1)

    # Execute the payment.
    try:
        txn_id = execute_payment(p)
        api(f"/actions/{action['id']}/result", "POST", {
            "status": "executed",
            "detail": f"Transaction ID: {txn_id}",
        })
        print(f"  OK — payment executed ({txn_id}) and reported to Impri.")
    except Exception as err:
        api(f"/actions/{action['id']}/result", "POST", {
            "status": "execute_failed",
            "detail": str(err),
        })
        print(f"  Approved but payment failed → execute_failed: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"\nAgent error: {e}", file=sys.stderr)
        sys.exit(1)
