# Human Approval Before an Agent Sends SMS

An AI agent that can text customers can also text the wrong customer, at 2am, with a broken merge field — add a human approval gate before any SMS goes out and you catch that before it's sent, not after.

---

## Why SMS needs its own gate

Email has a delete-before-read grace period. SMS doesn't. It lands on a phone, in a notification, usually within seconds — there is no draft folder, no "recall message," and no spam filter quietly eating the mistake. If your agent drafts appointment reminders, shipping updates, or re-engagement texts, a bad run (wrong phone number pulled from a stale record, a broken template variable rendering as `{{first_name}}`, a message meant for internal QA going to a real customer) becomes a customer-facing incident immediately.

Twilio, Vonage, and similar providers will happily send whatever string you hand them — they don't know if the content makes sense. That check has to happen before the API call, and it has to be a human, not another prompt asking the model to "double-check itself."

## The gate in practice

Say you run a scheduling agent for a dental clinic. It reads tomorrow's appointment list, drafts a reminder text per patient, and used to call the Twilio API directly. Now it pushes each draft to Impri first and only sends after a receptionist approves it:

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_KEY}", "Content-Type": "application/json"}

def push_sms_for_approval(to_number, body):
    resp = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json={
        "kind": "sms.send",
        "title": f"Reminder SMS to {to_number}",
        "preview": {"format": "plain", "body": body},
        "expires_in": 3600,          # stale reminder isn't worth sending after an hour
        "editable": ["preview.body"],
        "idempotent": False,         # resending would double-text the patient
    })
    resp.raise_for_status()
    return resp.json()["id"]

def wait_for_decision(action_id, poll_every=5):
    while True:
        resp = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(poll_every)

action_id = push_sms_for_approval("+15551234567", "Hi Sam, reminder: your cleaning is tomorrow at 2pm.")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    final_body = decision["decision"]["final_preview"]["body"]
    # send via Twilio only after approval
    twilio_client.messages.create(to="+15551234567", from_=CLINIC_NUMBER, body=final_body)
    requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed"})
```

The Twilio call is inside the `if approved` branch and nowhere else in the codebase — that's what makes this a real gate rather than a formality. If the agent (or a bug, or a prompt-injected instruction from some upstream data source) tries to skip straight to `twilio_client.messages.create(...)`, it still needs the API key and the wrapper, and neither one is reachable outside that branch.

## What the receptionist sees, and why editable matters

Setting `editable: ["preview.body"]` means the approval card in the inbox isn't just an approve/reject button — the receptionist can fix a typo, adjust the tone, or correct a name before sending, and Impri returns that edited text as `decision.final_preview.body`. Always send that field, never the original `preview.body`; if a human touched the message, the original is not what should go out.

This matters more for SMS than most channels because there's no second chance to clarify. An email with an awkward phrase gets a follow-up. A text that says "your appointment is cancelled" instead of "your appointment is confirmed" because of one autocorrected word gets a phone call from a confused patient.

## Rate limits and batch runs

If your agent processes a full day's appointment list in one run, it might push 40-50 actions in a burst. `POST /v1/actions` is capped at 60 requests per minute per key, which comfortably covers a clinic's daily volume — but if you're running this for a larger operation (a pharmacy chain, a multi-location practice), stagger the pushes or use separate keys per location rather than hammering one key past the limit.

## Boundaries

Impri stores the drafted message, notifies the reviewer, and holds the decision — it does not read the message content, does not know what "sounds right" for your clinic's tone, and does not talk to Twilio on your behalf. Your agent still owns sending the SMS; Impri owns making sure a human said yes first. For the two other integration paths (MCP tool calls instead of raw HTTP, and wiring the executor so the credential genuinely can't be reached without an approval) see the [main integration guide](how-to-add-human-approval-to-an-ai-agent.md).

If you want the reviewer to approve straight from Slack instead of the web inbox, see [Slack approval](slack-approval.md). New to Impri? Start with the [quickstart](quickstart.md).
