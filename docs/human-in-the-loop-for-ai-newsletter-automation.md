# Human-in-the-Loop for AI Newsletter Automation

Newsletter agents draft copy and queue the send — human-in-the-loop for AI newsletter automation stops a bad issue before it reaches your whole list.

---

## Why newsletters are a bad place to trust an agent fully

A newsletter send is one of the least forgiving actions an agent can take. It goes to every subscriber at once, it cannot be unsent, and a bad issue (wrong subject line, a broken personalization token, a hallucinated product claim, a link to the wrong URL) is visible to your entire audience within minutes. Compare that to an agent editing a database row you can just fix — a newsletter mistake is public and permanent.

This is exactly the profile of action that benefits from a gate: high blast radius, irreversible, and cheap to review before it happens but expensive to fix after. The agent should still do the drafting — subject line, body copy, send-time selection — but the "actually deliver this to the list" step needs a human decision in between.

---

## Wiring the gate around the send step

The pattern is the same three calls as any Impri integration: push the drafted issue as a pending action, wait for a decision, then call your ESP's send endpoint only if approved.

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
HEADERS = {"Authorization": f"Bearer {IMPRI_KEY}", "Content-Type": "application/json"}

def push_newsletter_for_approval(subject: str, body_markdown: str, esp_draft_url: str) -> str:
    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers=HEADERS,
        json={
            "kind": "newsletter.campaign.send",
            "title": f"Weekly issue: {subject}",
            "preview": {"format": "markdown", "body": body_markdown},
            "target_url": esp_draft_url,
            "expires_in": 21600,  # 6h — a weekly issue reviewed a day late is stale
            "editable": ["preview.body"],
            "idempotent": False,
            "undo": "None — email cannot be unsent. Rejection is the only safety net.",
        },
    )
    return resp.json()["id"]

def wait_for_decision(action_id: str) -> dict:
    while True:
        result = requests.get(f"https://api.impri.dev/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            return result
        time.sleep(15)

action_id = push_newsletter_for_approval(subject, draft_body, esp_draft_url)
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    final_body = decision["decision"]["final_preview"]["body"]  # carries editor's changes
    send_campaign(esp_campaign_id, final_body)  # your ESP call — Mailchimp, ConvertKit, Buttondown, etc.
    requests.post(
        f"https://api.impri.dev/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
```

The `esp_draft_url` in `target_url` is worth keeping — it lets the reviewer open the actual campaign in your ESP's editor if they want to check formatting or images the markdown preview can't show.

---

## Why `expires_in` matters more here than elsewhere

A weekly newsletter has a narrow relevance window. Setting `expires_in` to something short — hours, not the 72-hour default — means a Friday draft that nobody reviewed by Monday automatically expires instead of going out stale on Tuesday with last week's news. Treat `expired` exactly like `rejected` in your agent: no send happens, and if the content is still relevant you can push a fresh action with updated copy.

---

## What the reviewer actually approves

| Reviewer sees | Reviewer does not see |
|---|---|
| Rendered markdown of the full issue body | Your ESP's audience segmentation logic |
| Subject line, and the ESP draft link via `target_url` | Whether the agent's copy is factually accurate — that's still on you upstream |
| An editable body they can fix typos or claims in before approving | List size or delivery infrastructure |

Impri does not check facts or brand voice — it presents the draft to a human who does. If your agent pulls product details or numbers into the newsletter from an upstream source, validate those before the action is even created; the approval step catches "should this go out," not "is this true."

---

## Boundary: this only holds if the send credential lives behind the gate

The gate only works if `send_campaign()` above is genuinely unreachable without an `approved` status — same as any other Impri integration. If the agent also holds a standing ESP API key it could call directly (outside this code path), the approval step is decorative. Keep the send credential inside the wrapper that checks the decision first; see [wrapping a tool with a human approval step](wrapping-a-tool-with-a-human-approval-step.md) for the general pattern.

---

## Next step

Start with [the quickstart](quickstart.md) to get an API key, then see [approve emails before your AI agent sends them](approve-emails-before-your-ai-agent-sends-them.md) for the one-off email version of this same pattern, or [human approval for AI content pipelines](human-approval-for-ai-content-pipelines.md) if the newsletter is one stage in a larger content workflow.
