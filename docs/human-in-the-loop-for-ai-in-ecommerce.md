# Human-in-the-Loop AI for E-commerce Discounts

Let a support bot propose discount codes and order cancellations, but issue them only after a person approves in Impri: one card per chat, no blocked chat.

---

## Where the risk sits

A support or shopping assistant that misreads a return policy and offers 15% off instead of 5% costs you a few dollars. Given a long conversation and a persistent customer, the same assistant can be talked into stacking codes, waiving shipping or cancelling an order that already shipped. No bug is needed: it's a model trying to help in a conversation it doesn't control.

A stricter system prompt is something the next message can argue with. A decision made by a person outside the conversation is not. So the bot still decides *what* to offer, and actions that move money wait for a human.

## Which actions need a person

| Action | Undo | Who decides |
|---|---|---|
| Answer a sizing or policy question | nothing to undo | the bot |
| Loyalty discount up to 5% | deactivate the code | an Impri rule, at once |
| Custom discount above 5% | only while unused | a person in the inbox |
| Cancel an unshipped order | re-create the order | a person |
| Cancel or refund a shipped order | money has moved | a person |

The 5% row is a [rule](rules.md) in your Impri project: `kind_pattern` `support.discount_code`, a payload condition `{"path": "percent", "op": "lte", "value": 5}` and `rule_action` `auto_approve`. The card is approved on creation, still logged, and goes through the same code path below.

## Step 1: the bot proposes and returns

The agent's tool creates the card and returns a sentence for the customer at once; it never waits for the decision.

```python
import os
import httpx

IMPRI = os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev")
PUBLIC_URL = os.environ["PUBLIC_URL"]  # where Impri can reach your webhook
impri = httpx.Client(
    base_url=IMPRI,
    headers={"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"},
    timeout=10,
)

def propose_discount(conversation_id: str, email: str, percent: int, reason: str) -> str:
    """Tool the agent calls. The code itself is issued by the webhook below."""
    r = impri.post("/v1/actions", json={
        "kind": "support.discount_code",
        "title": f"{percent}% discount for {email}",
        "preview": {
            "format": "markdown",
            "body": f"**Customer:** {email}\n\n**Discount:** {percent}%\n\n"
                    f"**Agent's reason:** {reason}",
        },
        "payload": {"conversation_id": conversation_id, "email": email, "percent": percent},
        "editable": ["payload.percent"],
        "idempotency_key": f"discount:{conversation_id}",
        "idempotent": False,
        "undo": "Deactivate the code in the store's discount admin",
        "expires_in": 3600,
        "callback_url": f"{PUBLIC_URL}/impri-webhook",
    })
    r.raise_for_status()
    card = r.json()
    if r.status_code == 200:  # this conversation already has a discount card
        return f"This chat already has a discount request ({card['status']}). Don't offer another."
    if card["status"] == "approved":  # a rule approved it
        return "Approved. The code will arrive in this chat within a minute."
    return "A teammate will confirm the discount. The code will arrive in this chat."
```

Three fields carry the protection:

- **`idempotency_key`, one per conversation.** A customer who asks again, or asks for more, gets the same card back with a `200`, even after it was rejected. Without a key, Impri folds a repeat only when its kind, title and body are identical and the first card is still pending, so "15%" followed by "20%" would open two cards.
- **`payload.percent` is what gets issued**, and it is the one field the reviewer may edit. The card body shows the agent's figure and its reason.
- **`callback_url`** must be reachable from Impri: on the cloud, a public URL, since Impri doesn't deliver to private addresses.

## Step 2: issue the code when the decision arrives

The handler lives in the same module as the tool. Impri posts a signed webhook to `callback_url` when the card is created, decided or expires, and each delivery carries the status at the moment it is sent. A card decided before the first delivery goes out arrives with that status twice, and a retry repeats it, so the handler must be safe to run again. The body has no payload: the handler reads the action for the reviewer's edit.

```python
import hashlib
import hmac
import time
from flask import Flask, abort, request

WEBHOOK_SECRET = os.environ["IMPRI_WEBHOOK_SECRET"]  # GET /v1/project → webhook_secret
MAX_PERCENT = 20  # your policy, checked again after a human edit
answered: set[str] = set()  # action ids already answered; keep this in your database
app = Flask(__name__)

def create_discount_code(code: str, percent: int) -> None: ...  # your store; succeed if code exists
def tell_customer(conversation_id: str, text: str) -> None: ...  # your chat channel

@app.post("/impri-webhook")
def impri_webhook():
    ts = request.headers.get("X-Impri-Timestamp", "")
    nonce = request.headers.get("X-Impri-Nonce", "")
    sent = request.headers.get("X-Impri-Signature", "").removeprefix("sha256=")
    signed = f"{ts}.{nonce}.".encode() + request.get_data()
    expected = hmac.new(WEBHOOK_SECRET.encode(), signed, hashlib.sha256).hexdigest()
    if not (ts.isdigit() and abs(time.time() - int(ts)) <= 300
            and hmac.compare_digest(sent, expected)):
        abort(401)

    r = impri.get(f"/v1/actions/{request.get_json()['action_id']}")
    r.raise_for_status()
    action = r.json()
    if action["kind"] != "support.discount_code":
        return "", 204
    chat = action["payload"]["conversation_id"]
    if action["status"] in ("rejected", "expired"):
        if action["id"] not in answered:
            answered.add(action["id"])
            tell_customer(chat, "I can't offer a discount on this order, sorry.")
        return "", 204
    if action["status"] != "approved":  # still pending, or already executed
        return "", 204

    raw = action["payload"]["percent"]  # an inbox edit arrives as text
    percent = int(raw) if str(raw).isdigit() else -1
    if not 1 <= percent <= MAX_PERCENT:
        impri.post(f"/v1/actions/{action['id']}/result", json={
            "status": "execute_failed",
            "detail": f"percent {raw!r} is outside 1-{MAX_PERCENT}, nothing issued",
        }).raise_for_status()
        return "", 204

    code = "SUPPORT-" + hashlib.sha256(action["id"].encode()).hexdigest()[:10].upper()
    create_discount_code(code, percent)  # raises → 500 → Impri delivers again
    impri.post(f"/v1/actions/{action['id']}/result", json={
        "status": "executed", "detail": f"{percent}% code issued", "payload": {"code": code},
    }).raise_for_status()
    tell_customer(chat, f"Here is your {percent}% code: {code}")
    return "", 204
```

The code string comes from the action id, so a retry asks your store for the same code. If `create_discount_code` succeeds quietly when the code exists, a crash between creating it and reporting the result can't issue a second discount.

## What happened when we ran it

We ran both functions as written (Python 3.12, httpx, Flask) against a local Impri server on 2026-11-23, with the store and chat stubbed:

- Three more requests in one conversation returned `200` and the same card; after a rejection, too.
- The reviewer changed `percent` from 15 to 10 in the decision: the webhook arrived without the payload, the `GET` returned `"10"` as a string, and a 10% code was issued.
- An edit to 50 ended as `execute_failed` with the detail above; nothing was issued.
- With the 5% rule, a 5% request came back `approved` from the `POST` and the webhook issued the code with no person involved; an 8% request stayed pending.
- A card rejected, and one expired, before the first delivery each arrived twice; `answered` told each customer once.
- With the store failing once, the handler returned `500`; Impri delivered again 60 seconds later and the code was issued once.
- A re-sent `approved` event for a card already executed returned `204` and issued nothing; a wrong signature or a stale timestamp got `401`.

Webhooks go out on the server's 60-second tick, so expect up to a minute between the tap and the customer's code.

## Order cancellations

Use the same two steps with `kind: "support.order_cancel"` and one key per order. Put the fulfilment status in the card body: the reviewer needs to see "shipped", not just an order number. Refunds have their own page: [approve refunds issued by an AI support agent](approve-refunds-issued-by-an-ai-support-agent.md).

## What Impri does not do here

Impri stores the request, notifies whoever is on duty, records the decision and calls your webhook. It doesn't know your discount policy or talk to your store. The gate holds only if the bot's tools can't reach the store's discount API directly: see [wrapping a tool with a human approval step](wrapping-a-tool-with-a-human-approval-step.md).

---

## Next step

[Self-host Impri](quickstart.md) with `docker compose`, or [start free on the cloud](https://app.impri.dev/?signup=1) and [create an `actions`-scoped key](api-keys.md). Then read [webhooks](webhooks.md) for the signing secret and retries, and set up [notifications](notifications.md) so the request reaches whoever is on support duty.
