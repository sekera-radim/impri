# Approve AI Agent Actions From Your Phone

Approve AI agent actions from your phone by routing pending approvals through push notifications — ntfy, Telegram, or web push — so a yes/no decision doesn't require sitting down at a laptop.

---

## The laptop isn't always where the decision happens

If an agent only ever needs approval while you're already at your desk, a browser tab open to the inbox is enough. That assumption breaks quickly: a restock agent notices low inventory at 9pm, a monitoring agent wants to restart a service while you're at lunch, an outreach agent finishes a draft while you're on a train. The agent doesn't wait for convenient timing — it proposes the action the moment it's ready. Getting the decision to your phone, not just to a browser tab, is what keeps the approval loop from turning into a queue of stale actions by the time you're back at a keyboard.

## Three ways a pending action reaches your phone

| Channel | Setup | Approve without opening the app? |
|---|---|---|
| [ntfy](notifications.md) | Point a channel at any ntfy server + topic, no account needed | No — tap to open the inbox link |
| [Telegram](telegram-approval.md) | Create a bot, set `approval_mode: true` | Yes — inline Approve/Reject buttons in the chat |
| Web push | Subscribe from a mobile browser tab | No — tap to open the inbox link |

If you want a genuine one-tap decision from the lock screen, Telegram's `approval_mode` is the only one of the three with buttons built into the notification itself. ntfy and web push get you the fastest alert, but tapping still opens the web inbox to decide.

## Example: a restock agent that pages you, not a dashboard

A small shop's inventory agent checks stock levels daily. When something dips below its reorder point, it drafts a purchase order and needs a human to approve the spend — but the owner isn't watching a dashboard, they're on the shop floor with their phone.

```python
import os
import time
import requests

IMPRI_API = "https://api.impri.dev"
HEADERS = {
    "Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}",
    "Content-Type": "application/json",
}

def request_reorder_approval(sku: str, qty: int, unit_cost: float, supplier: str) -> str:
    total = qty * unit_cost
    resp = requests.post(
        f"{IMPRI_API}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "inventory.reorder",
            "title": f"Reorder {qty}x {sku} from {supplier} (${total:.2f})",
            "preview": {
                "format": "markdown",
                "body": f"Stock for **{sku}** is below reorder point.\n\n"
                        f"- Supplier: {supplier}\n- Qty: {qty}\n- Unit cost: ${unit_cost:.2f}\n"
                        f"- **Total: ${total:.2f}**",
            },
            "editable": ["preview.body"],
            "expires_in": 21600,  # 6 hours — stock decisions don't need to sit for days
            "idempotent": False,
            "undo": f"Cancel the PO with {supplier} before it ships (usually same-day)",
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]

def wait_for_decision(action_id: str, poll_every_s: int = 15) -> dict:
    while True:
        r = requests.get(f"{IMPRI_API}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r
        time.sleep(poll_every_s)

action_id = request_reorder_approval("SKU-8842", qty=150, unit_cost=4.10, supplier="Anker Direct")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    place_order(decision["decision"]["final_preview"]["body"])  # your ordering function
```

The push notification is what makes this usable — without it, `wait_for_decision` polls silently for hours while the owner has no idea a decision is waiting. With an ntfy or Telegram channel configured on the project, the phone buzzes within seconds of the `POST /v1/actions` call, well before the agent's own poll loop would surface anything.

## Adjusting the order from the notification

Because `editable: ["preview.body"]` is set, the owner isn't limited to approve-or-reject. Opening the inbox link from the phone shows the draft with an edit option — dropping the quantity from 150 to 100 units, for instance — before approving. The agent always executes `decision.final_preview.body`, so a phone edit reaches the order exactly as typed, not the agent's original draft.

## What phone approval doesn't solve

Getting the notification to a phone is a delivery-channel problem, and Impri treats it as exactly that — it doesn't change what's being decided or add any judgment of its own. A few things worth being precise about:

- **It's not a substitute for expiry.** A reorder decision that sits unanswered for two days because a phone was on airplane mode should probably expire, not linger — `expires_in` handles that regardless of which channel notified you.
- **It's not real-time on every channel.** ntfy and web push are near-instant but still require opening the inbox to decide; only Telegram's `approval_mode` buttons let you decide from the notification itself.
- **It doesn't replace an audit trail.** Whichever channel you approve from, the decision is recorded the same way — `decided_by` reflects the channel (e.g. `tg:{telegram_user_id}` for Telegram button taps) alongside the same data any web-inbox decision would produce.

## Next step

Set up a channel first — see [notification channels](notifications.md) for ntfy/web push or [the Telegram approval bot](telegram-approval.md) for in-chat buttons — then wire the three-call pattern from [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) into whatever proposes the action.
