# Approve AI Agent Actions From Slack

Connect Impri to Slack and your AI agent's proposed actions land in a channel where you can approve or reject them with a single tap — no dashboard required.

---

## How it works

When an agent pushes a proposed action to Impri, Impri routes the approval notification to wherever you've configured it — including a Slack channel. The agent then polls for the decision. If you approve in Slack, the agent proceeds; if you reject, it stops. The agent code is identical regardless of which channel you use for approvals. What changes is the notification routing, which you configure once in the Impri dashboard.

The action card that arrives in Slack shows the action title, a preview of the content (formatted as the agent sent it), and Approve / Reject buttons. Clicking either one records the decision immediately and unblocks the polling agent.

---

## Setting up Slack notifications

Connect your Slack workspace once via the Impri notifications settings. The full walk-through — including creating the Slack app, OAuth scopes, and which channel gets which actions — is in the [Slack approval guide](slack-approval.md). Once connected, every action your agent pushes will trigger a Slack notification automatically.

If you want different agents to route to different channels, configure separate API keys and assign each key a distinct notification target in the dashboard.

---

## The agent side

The agent code follows the same push → poll → execute pattern regardless of approval channel. Here's a complete Python example for an agent that drafts a LinkedIn update and waits for your tap in Slack before posting it.

```python
import time
import httpx

IMPRI_API_KEY = "im_your_key_here"
IMPRI_BASE = "https://api.impri.dev"

def propose_and_wait(draft: str) -> dict | None:
    """Push a social post draft for approval. Returns the decision or None on rejection/expiry."""

    # 1. Push the proposed action
    resp = httpx.post(
        f"{IMPRI_BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={
            "kind": "social.post",
            "title": "LinkedIn post: Q3 product update",
            "preview": {
                "format": "markdown",
                "body": draft,
            },
            "expires_in": 3600,      # 1 hour — stale social posts aren't worth sending
            "editable": ["preview.body"],  # let the reviewer fix wording before approving
        },
        timeout=10,
    )
    resp.raise_for_status()
    action = resp.json()
    action_id = action["id"]

    print(f"Action pending — check Slack. ID: {action_id}")

    # 2. Poll until a human decides in Slack (or until expiry)
    while True:
        result = httpx.get(
            f"{IMPRI_BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
            timeout=10,
        ).json()

        status = result["status"]
        if status != "pending":
            break
        time.sleep(10)

    if status != "approved":
        print(f"Not proceeding — decision: {status}")
        return None

    # 3. Return the final content (may include human edits made before approving)
    return result["decision"]["final_preview"]


def post_to_linkedin(content: str) -> None:
    # your actual LinkedIn posting code here
    print(f"Posting: {content}")


def run_agent(draft: str) -> None:
    decision = propose_and_wait(draft)
    if decision is None:
        return  # rejected or expired — nothing to post

    post_to_linkedin(decision["body"])

    # 4. Report result back to Impri (closes the audit record)
    httpx.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",  # reuse action_id from outer scope
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={"status": "executed"},
        timeout=10,
    )
```

A few things worth noting:

- `expires_in: 3600` keeps the approval window tight. A LinkedIn post about a product update that sat unapproved for two hours is probably no longer timely. Adjust this to match how quickly actions become stale.
- `editable: ["preview.body"]` lets you rewrite the draft in Slack before tapping Approve. The approved version comes back in `decision.final_preview.body` — always use that, not the original draft.
- A rejected or expired action returns from `propose_and_wait` as `None`. The posting code is never reached. That is the gate.

---

## What the Slack card shows

When the notification arrives in Slack, the card includes:

| Field | Source |
|-------|--------|
| Action title | `title` from your push call |
| Preview body | `preview.body`, rendered as markdown |
| Expiry time | derived from `expires_in` |
| Approve / Reject buttons | always present |
| Edit before approving | available when `editable` paths are set |

You can approve from the Slack mobile app, desktop app, or web — whichever is in reach when the notification arrives.

---

## When Slack approval fits

Slack is a natural fit when you or your team already have Slack open and want approvals to arrive in the same place as other work notifications. It is especially useful for:

- Social media drafts where timing matters (short `expires_in`)
- Outreach emails where one person on the team should review before send
- Publishing pipelines where a content team needs sign-off

If you need approvals routed to a mobile push with no app required, see [notifications](notifications.md) for ntfy and web push options. If your team uses Telegram instead, the setup is covered in the [Telegram approval docs](telegram-approval.md).

---

## Next steps

Set up Slack as your notification channel: [Slack approval guide](slack-approval.md).

For a full explanation of the push → approve → execute pattern and how to make the gate genuinely binding, see [How to Add Human Approval to an AI Agent](how-to-add-human-approval-to-an-ai-agent.md).
