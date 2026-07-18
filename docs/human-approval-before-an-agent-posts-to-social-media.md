# Human Approval Before an Agent Posts to Social Media

Add human approval before an agent posts to social media — review the exact text, edit tone or facts, and stop a bad post before it ever goes live.

---

## Why social posts need a slower gate than they get

A support-triage agent that misreads a ticket wastes ten minutes. A social agent that misreads a trending topic, a competitor's outage, or a user complaint and posts about it publicly wastes a lot more than ten minutes — and it's visible to everyone, indexed by search engines, and screenshot-able forever. Agents that monitor mentions, drafts replies, or schedule posts from a content calendar are exactly the kind of "drafts well, doesn't know when to stop" system that needs a human in the loop before the "publish" call, not after.

The naive fix — telling the agent "always ask before posting" in its system prompt — is not a gate. It's a suggestion the model can talk itself past, especially once external content (a scraped tweet, a Reddit thread, a competitor's blog) is sitting in its context and shaping what it decides to write. What you want instead is a code path where the actual platform API call is unreachable until an external decision says so.

---

## The gate, end to end (Python)

Three calls: push the draft, poll for a decision, execute only on approval.

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {
    "Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}",
    "Content-Type": "application/json",
}

def push_post_for_approval(draft_text: str, scheduler_url: str) -> str:
    resp = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "social.post",
            "title": "LinkedIn: reply to outage thread mentioning our API",
            "preview": {"format": "markdown", "body": draft_text},
            "target_url": scheduler_url,
            "expires_in": 1800,  # 30 min — a stale reply reads as tone-deaf
            "editable": ["preview.body"],
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]

def wait_for_decision(action_id: str) -> dict:
    while True:
        data = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if data["status"] != "pending":
            return data
        time.sleep(10)

action_id = push_post_for_approval(draft, "https://buffer.com/queue/abc123")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    final_body = decision["decision"]["final_preview"]["body"]
    post_to_linkedin(final_body)  # your platform call
    requests.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
else:
    logger.info("post not published, status=%s", decision["status"])
```

`post_to_linkedin` only runs inside the `approved` branch — there is no code path from "agent drafted a reply" to "reply is live" that skips the decision.

---

## What the reviewer sees on the approval card

- **Title** — a one-line summary ("reply to outage thread"), not the full post, so a reviewer scanning a phone notification knows what's being asked.
- **Preview body** — the exact text that will be posted, rendered as markdown, editable inline. A reviewer can fix a wrong product name or soften a line without kicking it back to the agent.
- **`target_url`** — a link to the draft sitting in your scheduling tool (Buffer, Hootsuite, or the platform's own composer), so the reviewer can see formatting and any attached media before approving.
- **Expiry countdown** — set short (30–60 minutes) for anything time-sensitive. A reply to a live incident thread that sits pending for two days is worth rejecting on principle, since [expiry is a correctness feature, not just cleanup](how-to-add-human-approval-to-an-ai-agent.md).

---

## Handling rejection, expiry, and edits

A `rejected` or `expired` status means the polling loop above exits with `post_to_linkedin` never called — nothing gets special-cased. If the reviewer edited the draft, `decision.final_preview.body` carries the edited text; always read from there, never from the original `preview.body`, since the API only returns the version the human actually approved.

| Situation | What happens |
|---|---|
| Reviewer approves as-is | Original draft posts unchanged |
| Reviewer edits then approves | Edited text posts (`final_preview.body`) |
| Reviewer rejects | Nothing posts; log and move on |
| Window expires unattended | Treated as rejected; re-draft if still relevant |

---

## What Impri does not check

Impri stores the draft, notifies a human, and holds the decision — it does not read the post and judge whether it violates a platform's terms of service, your brand voice guide, or defamation law. That judgment stays with the human reviewing the card. Impri also isn't a scheduling tool: it doesn't manage a content calendar or pick posting times, it just gates the one action — the actual platform-side publish call — that turns a draft into something public.

For a phone-first workflow, pair this with [Telegram approval](telegram-approval.md) so a reviewer can approve or edit from a notification without opening a dashboard, and check [the audit log](audit-log.md) later for a record of every post approved, by whom, and what was changed before it went out.

Next step: [quickstart](quickstart.md) to get an API key and try this against a test project.
