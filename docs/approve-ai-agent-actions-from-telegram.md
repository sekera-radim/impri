# Approve AI Agent Actions From Telegram

Get your AI agent's pending actions as Telegram push notifications with inline Approve/Reject buttons, so you can gate its actions from your phone wherever you are.

---

## Who this is for

If you're running an agent solo — handling customer refunds, drafting support replies, posting to your company's social accounts — you're probably not sitting at a desk with an inbox tab open all day. Telegram's push notifications land on your phone the moment an action needs a decision, and the inline keyboard lets you approve or reject without opening a browser or unlocking a separate app. This page covers wiring a Python agent to push actions that show up as Telegram approval prompts.

## Does this replace the web inbox?

No — every action pushed to Impri still shows up in the [web inbox](inbox.md) with full detail and audit history. Telegram (like [Discord](discord-approval.md) and [Slack](slack-approval.md)) is one more place the *notification* and *decision* can happen; the record lives in Impri either way. Turning on Telegram approvals doesn't turn off anything else.

## How fast is it, really?

| Channel | Typical time-to-decision | Best for |
|---|---|---|
| Web inbox only | Hours (whenever you check it) | Non-urgent, batch review |
| Email notification | Tens of minutes | Medium urgency |
| Telegram inline buttons | Seconds to minutes | Time-sensitive, mobile-first |

Telegram wins here because the notification *is* the decision surface — no click-through to a web page required.

## Setting it up

Bot creation (talking to `@BotFather`, getting your chat ID) and turning on `approval_mode: true` for the channel are covered in [Telegram Approval Bot](telegram-approval.md). Once that's done, any action you push reaches the configured chat with inline **✅ Approve** / **❌ Reject** buttons — nothing extra to set on the agent side.

## Example: a refund-approval agent

Here's a Python agent using the REST API directly (no SDK) that drafts a refund decision from a support ticket and waits for a human to sign off from their phone before actually issuing it:

```python
import os
import time
import requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}


def propose_refund(ticket_id: str, customer: str, amount_usd: float, reason: str) -> str:
    resp = requests.post(
        f"{API}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "payment.refund",
            "title": f"Refund ${amount_usd:.2f} to {customer} (ticket {ticket_id})",
            "preview": {
                "format": "markdown",
                "body": f"**Reason:** {reason}\n\n**Amount:** ${amount_usd:.2f}\n**Customer:** {customer}",
            },
            "idempotent": False,
            "undo": f"No automatic undo — would require a manual counter-charge for ticket {ticket_id}",
            "expires_in": 3600,  # 1h — refunds go stale fast once a customer is on hold
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]


def await_decision(action_id: str, poll_every_s: int = 5, timeout_s: int = 3600) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r
        time.sleep(poll_every_s)
    raise TimeoutError(f"action {action_id} still pending after {timeout_s}s")


def handle_ticket(ticket_id, customer, amount_usd, reason):
    action_id = propose_refund(ticket_id, customer, amount_usd, reason)
    result = await_decision(action_id)

    if result["status"] != "approved":
        print(f"{ticket_id}: {result['status']}, no refund issued")
        return

    issue_refund(customer, amount_usd)  # your payment processor call
    requests.post(
        f"{API}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
```

Because `idempotent` is set to `false`, the Telegram card also carries a "retrying may duplicate this action" warning — worth knowing before you tap approve twice because the button felt slow.

## What you're actually gating

Tapping Approve in Telegram does not touch your payment processor. It only flips the action's status to `approved` inside Impri. `issue_refund()` above still has to run — the gate only works if that function is unreachable except through this exact path. If some other part of your codebase can call your payment processor directly with the same credentials, an agent (or a bug) can bypass the approval entirely. See [the integration guide](how-to-add-human-approval-to-an-ai-agent.md) for the chokepoint pattern in more depth.

## Next step

New to Impri? Start with the [quickstart](quickstart.md) to get an API key, then set up [Telegram Approval Bot](telegram-approval.md) for the inline buttons described here.
