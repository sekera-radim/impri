# Approve AI Voice Agent Calls Before They Dial

Give a human the last word before your voice agent places an outbound call — approve the script and number from your phone, then let the dialer run.

---

## Why a dial-time gate matters more than a chat-time one

A chat agent that sends a bad message is embarrassing. A voice agent that calls the wrong number, calls at 11pm, or reads out a hallucinated price to a real person on the phone is a different class of problem — the damage happens the instant the line connects, and there is no "delete message" afterward. If your agent is wired to a telephony provider (Twilio, Vapi, Retell, Bland) and decides on its own when to dial, the call itself is the side effect that needs a gate, not just the script that gets read.

The fix is the same pattern used for email or publishing: the agent proposes the call — who it's calling, what it plans to say — and a human approves or rejects before the dialer function ever runs.

---

## Wiring the gate into a Python dial function

Say your agent decides to call a lead back with a follow-up script. Instead of handing the script straight to your `dial()` function, push it to Impri first and only call once you get `approved` back.

```python
import time
import requests

API = "https://api.impri.dev/v1/actions"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

def request_call_approval(phone_number: str, opening_line: str, call_notes: str) -> dict:
    resp = requests.post(API, headers=HEADERS, json={
        "kind": "voice.outbound_call",
        "title": f"Outbound call to {phone_number}",
        "preview": {
            "format": "markdown",
            "body": f"**Number:** {phone_number}\n\n**Opening line:** {opening_line}\n\n**Notes:** {call_notes}",
        },
        "editable": ["preview.body"],
        "expires_in": 1800,  # a stale call script isn't worth dialing 30 min later
        "idempotent": False,
    })
    action = resp.json()
    action_id = action["id"]

    while True:
        time.sleep(5)
        check = requests.get(f"{API}/{action_id}", headers=HEADERS).json()
        if check["status"] != "pending":
            return check

def place_call(phone_number: str, script: str):
    decision = request_call_approval(phone_number, script, call_notes="Follow-up on demo request")
    if decision["status"] != "approved":
        return  # rejected or expired — the dialer is never invoked

    final_script = decision["decision"]["final_preview"]["body"]
    dial(phone_number, final_script)  # your Twilio/Vapi/Retell call function

    requests.post(f"{API}/{action_id}/result", headers=HEADERS, json={"status": "executed"})
```

The `dial()` call sits behind the `if decision["status"] != "approved": return` line — there is no code path that reaches it without a human decision in hand.

---

## What the reviewer actually sees

The inbox card shows the phone number, the opening line, and any notes your agent attached — rendered as markdown, not read as a live phone call. Because `preview.body` is listed in `editable`, the reviewer can rewrite a clumsy opening line or fix a wrong area code before tapping approve, and `decision.final_preview.body` carries that edit back to your `place_call` function. Set `idempotent: false` so the card also warns "retrying may duplicate this action" — useful if your retry logic ever considers re-dialing after a dropped connection.

A short `expires_in` (30 minutes above) matters here specifically: a call script approved yesterday is a call script about yesterday's context.

---

## Where this fits with voice agent frameworks

Impri doesn't touch your telephony stack — it doesn't know Twilio from Vapi, and it never places the call itself. It sits one layer above: your agent's decision logic calls `request_call_approval()` before it calls whatever your framework's `create_call()` method is. The gate only holds if the agent has no other way to reach the phone line — if it also holds a raw Twilio API key it can call directly, route the credential through the same wrapper function that does the approval check, not through the agent's general toolset.

For approving calls from your phone rather than a browser tab, pair this with [Telegram approvals](telegram-approval.md) — a call script fits comfortably in a chat message.

---

## Next step

New to the three-call pattern (push, poll, execute)? Start with [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), or jump straight to the [Python SDK](sdk-python.md) to skip writing the `requests` calls by hand. If you're setting up your first API key, the [quickstart](quickstart.md) covers both cloud and self-hosted setup.
