# Review AI Agent Decisions Before They Happen

Give a support agent the power to issue refunds and you also give it the power to issue a $4,000 refund by mistake — here's how to review the decision before it fires, not after.

---

## The problem: agents act, then you find out

Most "AI agent went wrong" stories share a shape: the agent did something reasonable-sounding with unreasonable consequences, and the first human to see it was the one cleaning up afterward. A refund bot that reads an angry email and issues a full refund instead of a partial one. A triage agent that closes a ticket that should have escalated. The fix people reach for first — "add a confirmation step in the prompt" — doesn't hold up, because the agent is still the one deciding whether to actually stop, and there is no record of what almost happened.

What you want instead is a point where the agent's decision becomes visible to a person *before* the side effect happens, and where the code path that executes the side effect is structurally unable to run without that person's yes.

## The pattern: propose, wait, execute

This is the same three-call shape regardless of what the agent does: push the proposed decision, poll for a human verdict, only then run the code that has the real-world effect.

```python
import requests
import time

IMPRI_KEY = "im_your_key_here"
BASE = "https://api.impri.dev"
headers = {"Authorization": f"Bearer {IMPRI_KEY}"}

def propose_refund(customer_email, order_id, amount_cents, reason):
    resp = requests.post(f"{BASE}/v1/actions", headers=headers, json={
        "kind": "refund.issue",
        "title": f"Refund ${amount_cents/100:.2f} — order {order_id}",
        "preview": {
            "format": "markdown",
            "body": f"**Customer:** {customer_email}\n**Order:** {order_id}\n"
                    f"**Amount:** ${amount_cents/100:.2f}\n**Reason:** {reason}"
        },
        "idempotent": False,
        "undo": f"Reverse the refund via the payment processor's dispute flow for order {order_id}",
        "expires_in": 21600,  # 6 hours — refunds tied to a live support ticket shouldn't sit for days
        "editable": ["preview.body"],
    })
    return resp.json()["id"]

def wait_for_decision(action_id):
    while True:
        resp = requests.get(f"{BASE}/v1/actions/{action_id}", headers=headers).json()
        if resp["status"] != "pending":
            return resp
        time.sleep(10)

action_id = propose_refund("jane@example.com", "ord_8842", 4000, "Duplicate charge, confirmed in billing log")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    issue_refund(order_id="ord_8842", amount_cents=4000)  # your real refund call
    requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=headers,
                  json={"status": "executed", "payload": {"order_id": "ord_8842"}})
```

The `issue_refund` call only sits behind the `if decision["status"] == "approved"` branch. There's no path through this code where the refund fires without a human having seen the amount, the order, and the reason first.

## What "before they happen" actually means

The `idempotent: false` and `undo` fields aren't decoration — they change what the reviewer sees on the approval card. A refund is exactly the kind of action where re-running it after a timeout retry would double-charge the wrong direction, so flagging it as non-idempotent surfaces that risk before approval, not after a support escalation. Reviewing "before it happens" means the human sees the actual amount and reason the agent is about to act on, with the option to edit the body before saying yes — not a generic "AI wants to do something, ok?" prompt.

## Boundaries: what this doesn't cover

Impri stores the proposed action, notifies the human, and holds the decision — it does not evaluate whether $4,000 is a reasonable refund, and it does not touch your payment processor. That judgment call, and the actual API call to your billing system, stay entirely in your code. Impri is also only a real gate if the refund call has no other path to firing — an agent holding a raw payment-processor credential could route around this check entirely, so the wrapper around `issue_refund` needs to be the only place that credential is used. See [the how-to guide](how-to-add-human-approval-to-an-ai-agent.md) for the full mechanics, and the [audit log](audit-log.md) for how approved and rejected decisions get recorded over time.

## Next step

The [Python SDK](sdk-python.md) wraps the three calls above into a couple of function calls if you'd rather not hand-roll the polling loop. Start with the [quickstart](quickstart.md) to get an API key, cloud or self-hosted.
