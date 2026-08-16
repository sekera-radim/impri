# Approve AI Agent Actions by Email

Route every pending AI agent action to your email inbox, so approving what an agent wants to do takes nothing more than a mail client you already use daily.

---

## You don't always want another app

Slack, Discord, and Telegram are the obvious channels for approval notifications, and for a team that already lives in one of them, they're the right default. But plenty of agent setups don't have a team channel behind them at all — a solo project, an internal tool with one reviewer, a client automation where you're the only person who'll ever open the inbox. Installing a chat app just to get pinged about the occasional pending action is overhead nobody asked for. Email is the one channel every reviewer already has open, on every device, with nothing new to configure on the receiving end.

## Setting up the email channel

Email is a notification channel like Slack or Telegram — configured once per project with an admin-scope key, not per action. The server needs SMTP configured to actually deliver mail; once that's in place, adding the channel is a single request:

```python
import requests

resp = requests.post(
    "https://api.impri.dev/v1/notification-channels",
    headers={"Authorization": f"Bearer {ADMIN_KEY}"},
    json={
        "name": "Ops inbox",
        "type": "email",
        "config": {"to": "ops@example.com"},
        "enabled": True,
        "digest_window_sec": 300,
    },
)
channel = resp.json()
```

`digest_window_sec` matters more for email than for chat channels. Set it to 300-600 seconds and a burst of actions landing within that window arrives as one email instead of ten separate ones hitting your inbox back to back.

---

## A concrete example: a scheduling agent

Say an agent manages calendar invites for a small team — it reads a shared inbox for meeting requests and drafts events, but it shouldn't be the one deciding whose calendar gets booked. Each proposal becomes a pending action:

```python
import requests, time

action = requests.post(
    "https://api.impri.dev/v1/actions",
    headers={"Authorization": f"Bearer {AGENT_KEY}"},
    json={
        "kind": "calendar.event.create",
        "title": "Book: Product sync w/ Acme Corp, Thu 3pm",
        "preview": {
            "format": "markdown",
            "body": "**Attendees:** you, jane@acme.com\n**When:** Thu 14:00-14:30 PT\n**Location:** Google Meet",
        },
        "expires_in": 43200,
        "editable": ["preview.body"],
    },
).json()
action_id = action["id"]

while True:
    result = requests.get(
        f"https://api.impri.dev/v1/actions/{action_id}",
        headers={"Authorization": f"Bearer {AGENT_KEY}"},
    ).json()
    if result["status"] != "pending":
        break
    time.sleep(15)

if result["status"] == "approved":
    body = result["decision"]["final_preview"]["body"]
    create_calendar_event(body)  # your booking function
    requests.post(
        f"https://api.impri.dev/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {AGENT_KEY}"},
        json={"status": "executed"},
    )
```

The reviewer gets an email with the meeting details and a link into the inbox. They can adjust the time in `preview.body` before approving — the agent reads `final_preview`, not the original draft, so the edit is what actually gets booked.

---

## What the email actually contains, and what it doesn't

The email is a notification, not the approval surface itself. It tells you an action is pending and links you into the inbox — it doesn't carry inline approve/reject buttons the way a Slack message can. That's a deliberate boundary: email has no reliable way to authenticate a one-click decision without exposing something equivalent to a bearer token in a link, so the actual decision stays behind the same authenticated inbox every channel points back to. If you want closer to true one-tap approval from a notification, [approving from Telegram](telegram-approval.md) gets nearer that; email suits "I'll review this in the next few minutes," not "decide in one thumb-tap."

Five consecutive delivery failures — bad SMTP config, a bounced address — disable the channel automatically instead of retrying silently. Check Settings → Notifications if approvals stop arriving by mail.

---

## Next step

If you haven't wired up the three-call approval flow yet, start with [the quickstart](quickstart.md) — email is a notification channel layered on the same `POST /v1/actions` pattern shown in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).
