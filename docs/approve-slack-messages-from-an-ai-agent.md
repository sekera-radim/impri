# Approve Slack Messages From an AI Agent

Put a human approval step in front of every Slack message your AI agent sends — review, edit, or reject the exact wording before `chat.postMessage` fires.

---

## Two different "Slack" problems

There are two unrelated things people mean by "Slack" and Impri approvals, and it's worth being explicit about which one this page covers. [Approve AI agent actions from Slack](approve-ai-agent-actions-from-slack.md) is about using Slack as your *notification channel* — approval cards for any kind of action (emails, GitHub issues, refunds) show up in a Slack DM with buttons. This page is the other direction: your agent's job *is* to post messages into Slack, and you want a human to read the exact text before it goes out. The action being gated has `kind: "slack.message.send"`, not the notification transport.

You can combine both — get the review card in Slack for an action that itself posts to Slack — but for a customer-facing channel, most teams don't want approve/reject noise landing in the same workspace the customer can see, so the example below routes notifications elsewhere.

---

## Scenario: a bot in a shared support channel

A company runs a support bot in a Slack Connect channel shared with a customer. The bot reads incoming messages, drafts a reply, and — before this gate existed — posted it immediately. One bad reply in a channel the customer can see is worse than a slow reply, so every draft now waits for a teammate to approve it from their phone.

```python
import os
import time
import httpx
from slack_sdk import WebClient

IMPRI_API_KEY = os.environ["IMPRI_API_KEY"]
IMPRI_BASE = "https://api.impri.dev"
slack = WebClient(token=os.environ["SLACK_BOT_TOKEN"])


def propose_and_wait(channel: str, draft: str) -> tuple[str, str] | None:
    """Push a Slack reply draft for approval. Returns (action_id, approved_text), or None."""
    resp = httpx.post(
        f"{IMPRI_BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={
            "kind": "slack.message.send",
            "title": f"Reply in #{channel}",
            "preview": {"format": "plain", "body": draft},
            "expires_in": 900,              # 15 minutes — a stale support reply isn't worth sending
            "editable": ["preview.body"],
        },
        timeout=10,
    )
    resp.raise_for_status()
    action_id = resp.json()["id"]

    while True:
        poll = httpx.get(
            f"{IMPRI_BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
            timeout=10,
        ).json()
        if poll["status"] != "pending":
            break
        time.sleep(5)

    if poll["status"] != "approved":
        return None

    return action_id, poll["decision"]["final_preview"]["body"]


def handle_customer_message(channel_id: str, draft_reply: str) -> None:
    decision = propose_and_wait(channel_id, draft_reply)
    if decision is None:
        return  # rejected or expired — the bot stays quiet

    action_id, approved_text = decision
    slack.chat_postMessage(channel=channel_id, text=approved_text)

    httpx.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={"status": "executed"},
        timeout=10,
    )
```

`handle_customer_message` never calls `slack.chat_postMessage` on a rejected or expired draft — `propose_and_wait` returns `None` and the function exits before reaching the Slack client at all.

---

## What the reviewer sees and can change

Because `editable` includes `preview.body`, the approver can fix a tone problem or a factual slip directly in the Impri card before tapping approve. `poll["decision"]["final_preview"]["body"]` always carries whatever the reviewer left — the edited version if they changed it, the original otherwise — so `handle_customer_message` never needs to check whether an edit happened; it just uses the field.

| Field | What it controls |
|---|---|
| `preview.body` | The draft text shown to the reviewer, and posted to Slack if approved unedited |
| `editable: ["preview.body"]` | Lets the reviewer rewrite the reply before approving |
| `expires_in: 900` | How long an unanswered draft stays postable — short here because support replies age fast |
| `decision.final_preview.body` | What actually gets sent — always read from here, never from the original draft |

---

## Picking where the approval notification lands

Nothing about this pattern requires the approval card itself to avoid Slack — you can route it to a Slack channel via [Slack approval](slack-approval.md) exactly as described there, as long as it's a different, internal channel from the one the bot posts into. If you'd rather not stand up Slack OAuth just for reviewing outbound bot messages, a push notification through [ntfy or web push](notifications.md) gets a reviewer the same one-tap approve/reject without opening Slack at all.

---

## Where this breaks down

This gate only holds if `slack.chat_postMessage`(or your equivalent Slack call) is unreachable except through `handle_customer_message`. If the bot process also has a cron job, a webhook handler, or another code path that holds the same `SLACK_BOT_TOKEN` and can post independently, that path bypasses the gate — Impri has no way to intercept a Slack API call it never sees. Keep the bot token scoped to the one function that calls `propose_and_wait` first.

---

## Next step

- [Quickstart](quickstart.md) — get an API key and push your first action
- [How to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) — the push → poll → execute pattern this page builds on
- [Approve AI agent actions from Slack](approve-ai-agent-actions-from-slack.md) — the other direction: getting approval notifications delivered inside Slack
