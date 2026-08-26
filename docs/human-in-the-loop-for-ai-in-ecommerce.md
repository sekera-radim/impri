# Human-in-the-Loop for AI in E-commerce

Human-in-the-loop for AI in e-commerce means gating discount codes and order cancellations behind a human tap before an agent's mistake touches revenue.

---

## Where the risk actually sits

Most e-commerce AI agents aren't dangerous because they're wrong often — they're dangerous because the actions they can take are asymmetric. A shopping assistant that misreads a return policy and offers a customer 15% off instead of 5% costs you a few dollars. The same agent, given a long enough conversation and a persistent customer, can be talked into stacking discount codes, waiving shipping, or canceling and refunding an order that already shipped. None of that requires a bug — it's the normal behavior of a model trying to be helpful in a conversation it doesn't fully control.

The fix isn't to make the agent more cautious in its system prompt. It's to make a specific set of actions — the ones that move money or reverse a fulfilled order — require a human decision before they execute.

## Sorting actions by what they cost you if wrong

Not every action an e-commerce agent takes needs a gate. Updating a saved-for-later list or answering a sizing question doesn't touch money. Splitting the agent's action surface into tiers makes it obvious which calls get wrapped:

| Action | Reversible? | Gate it? |
|---|---|---|
| Answer product/sizing question | n/a | No |
| Apply a pre-approved loyalty discount | Yes, easily | No |
| Issue a custom discount code | Only if unused | Yes |
| Cancel an unshipped order | Yes | Yes |
| Cancel/refund a shipped order | No (money moved) | Yes |

The bottom three go through Impri as pending actions. The top two stay fully automated.

## Gating a discount code from a Python support bot

The agent still decides *what* to offer — Impri just sits between that decision and the code actually being issued:

```python
import os
import time
import requests

API = "https://api.impri.dev/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_discount(customer_email, code, percent, reason, order_id=None):
    resp = requests.post(f"{API}/actions", headers=HEADERS, json={
        "kind": "support.discount_code",
        "title": f"Issue {percent}% code to {customer_email}",
        "preview": {
            "format": "markdown",
            "body": f"**Customer:** {customer_email}\n**Code:** {code}\n"
                    f"**Discount:** {percent}%\n**Reason:** {reason}",
        },
        "editable": ["preview.body"],
        "idempotent": False,  # issuing the same code twice = double discount
        "undo": "Deactivate the code in the discounts admin panel",
        "expires_in": 3600,  # a support conversation goes stale fast
    })
    action_id = resp.json()["id"]

    while True:
        status = requests.get(f"{API}/actions/{action_id}", headers=HEADERS).json()
        if status["status"] != "pending":
            break
        time.sleep(5)

    if status["status"] != "approved":
        return None  # rejected or expired — never issued

    final_body = status["decision"]["final_preview"]["body"]
    issued_code = create_discount_in_store(code, percent)  # your store's API

    requests.post(f"{API}/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed", "payload": {"code": issued_code}})
    return issued_code
```

Order cancellations use the same shape with `kind: "support.order_cancel"` and a preview that shows order ID, items, and fulfillment status — a reviewer approving a cancellation on a shipped order needs to see "shipped" in the card, not just the order number.

## What the reviewer sees, and why that matters more than the code

The person approving isn't reading source code — they're reading a card with a customer email, a percentage, and a reason. That's the entire point: a five-second mobile decision on the one message where an agent's judgment actually needs checking, instead of a blanket rule like "never discount more than 10%" that a persuasive conversation can still argue its way around within.

## What Impri does not do here

Impri stores the proposed discount or cancellation, notifies whoever's on support duty, and holds the decision — it doesn't know your discount policy, doesn't talk to your store's API, and doesn't decide whether 15% is reasonable. That judgment is still the human's, and the actual code creation or order update is still your agent's code to write. The gate only holds if the agent's store credentials are wrapped so `create_discount_in_store` can't be reached without an approved decision — see [wrapping a tool with a human approval step](wrapping-a-tool-with-a-human-approval-step.md).

---

Next: [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the base REST/MCP pattern, and [approve refunds issued by an AI support agent](approve-refunds-issued-by-an-ai-support-agent.md) if refunds specifically are your next gate.
