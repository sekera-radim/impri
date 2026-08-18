# One-Tap Approve/Reject for AI Agent Actions

Give a human a single tap to approve or reject what an AI agent wants to do — from a phone notification, no dashboard tab required, in seconds.

---

## The scenario: a support-reply agent that can't be trusted alone

Say you have an agent that reads incoming support tickets and drafts replies. Most drafts are fine. Some aren't — a misread ticket, a wrong refund amount, a tone that doesn't fit an angry customer. You don't want to review every reply in a web dashboard between other work; you want a push notification that shows the draft and lets you tap **Approve** or **Reject** and move on.

That's the entire feature Impri is built around: the agent pushes a proposed action, a human gets notified wherever they already look (phone lock screen, Telegram, Slack), and one tap resolves it. No typing, no dashboard, unless something actually needs a closer look.

---

## The flow in code

Three calls. The agent doesn't need to know which channel the human taps from — that's a notification setting, not an API parameter.

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_approval(ticket_id: str, reply_body: str) -> dict:
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "support.reply",
        "title": f"Reply to ticket #{ticket_id}",
        "preview": {"format": "markdown", "body": reply_body},
        "target_url": f"https://helpdesk.example.com/tickets/{ticket_id}",
        "expires_in": 3600,  # stale after an hour, don't send a late reply
    })
    return resp.json()

def wait_for_decision(action_id: str) -> str:
    while True:
        r = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r["status"], r
        time.sleep(5)

action = request_approval("48213", "Hi, thanks for reaching out — I've issued a full refund...")
status, result = wait_for_decision(action["id"])

if status == "approved":
    send_reply(result["decision"]["final_preview"]["body"])  # your send function
    requests.post(f"{API}/v1/actions/{action['id']}/result", headers=HEADERS,
                   json={"status": "executed"})
```

Note there's no `editable` field here — this action is deliberately approve-or-reject only. If you also want the human to be able to tweak the wording before it goes out, see [editing drafts before approving](edit-ai-agent-drafts-before-approving.md); that's a different, slightly heavier flow.

---

## Where the tap actually happens

The `POST /v1/actions` call is channel-agnostic. Where the human taps depends on how notifications are configured for their account, not on anything the agent sends:

| Channel | What the human sees |
|---|---|
| Web push | Native OS notification, tap opens the card directly |
| Telegram | Message with inline Approve/Reject buttons |
| Slack / Discord | Message with action buttons in the configured channel |
| Email | Fallback with a link to the inbox card |
| ntfy | Push to any device running the ntfy app |

See [notifications](notifications.md) for setup, or [Telegram approval](telegram-approval.md) and [Slack approval](slack-approval.md) for the two most common one-tap setups.

---

## What "one tap" does and doesn't guarantee

The tap resolves `status` to `approved` or `rejected` — that's the whole contract. It does not mean Impri checked the content is correct; it means a specific human looked at the title and preview and made a call. The gate only holds if the agent has no other way to send the reply — if it also holds a raw API key to the helpdesk and can call it directly, a human tapping "reject" here doesn't stop that path. Wrap the actual send function so the approved decision is the only way in; see [the MCP server](mcp.md) for a pattern that does this without writing the polling loop yourself.

---

## Rejected and expired look the same to your code

Both leave `status` as anything other than `approved`, and in both cases the execution branch is simply never reached. A ticket reply that expired after an hour is exactly as unsendable as one someone explicitly rejected — treat them identically rather than special-casing `expired`.

Next: [quickstart](quickstart.md) to get an API key and push your first action, or [MCP](mcp.md) if your agent runs inside Claude Code or Claude Desktop.
