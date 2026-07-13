# Human-in-the-Loop for the OpenAI Agents SDK

Add human-in-the-loop approval to the OpenAI Agents SDK by wrapping your tool with an Impri gate — the tool only executes once a human approves the proposed action.

---

## The idea in one sentence

The OpenAI Agents SDK runs tools as Python functions. Wrap any function that reaches an external system so it pushes a draft to Impri first, blocks on a human decision, and only proceeds to the actual API call on approval.

---

## Scenario: an issue triage agent

You have a developer productivity agent that reads team messages and opens GitHub issues for actionable items. Without a gate, it creates issues immediately. With one, it proposes each issue and waits for you to approve, reject, or edit the draft before it posts anything to GitHub.

This example uses the `openai-agents` Python package. Install it along with `httpx`:

```
pip install openai-agents httpx
```

---

## Full implementation

```python
import os
import time
import httpx
from agents import Agent, Runner, function_tool

IMPRI_API_KEY = os.environ["IMPRI_API_KEY"]
IMPRI_BASE = "https://api.impri.dev"
IMPRI_HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}


# --- Impri gate: push, then poll until decided ---

def _push_and_poll(kind: str, title: str, preview_body: str) -> tuple[str, dict]:
    r = httpx.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=IMPRI_HEADERS,
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": preview_body},
            "expires_in": 3600,        # 1 hour to approve before expiry
            "editable": ["preview.body"],  # reviewer can edit the body
        },
        timeout=10,
    )
    r.raise_for_status()
    action_id = r.json()["id"]

    while True:
        poll = httpx.get(
            f"{IMPRI_BASE}/v1/actions/{action_id}",
            headers=IMPRI_HEADERS,
            timeout=10,
        ).json()
        if poll["status"] != "pending":
            return action_id, poll
        time.sleep(10)


# --- Gated tool ---

@function_tool
def create_github_issue(repository: str, title: str, body: str) -> str:
    """
    Propose a new GitHub issue. The issue is not created until a human
    approves it. The reviewer may edit the body before approving.
    """
    preview = f"**Repository:** `{repository}`\n\n**Title:** {title}\n\n---\n\n{body}"
    action_id, poll_result = _push_and_poll(
        kind="github.issue.create",
        title=f"New issue: {title}",
        preview_body=preview,
    )

    if poll_result["status"] != "approved":
        return f"Issue not created — decision was '{poll_result['status']}'."

    # Use the human-approved version (carries edits if the reviewer changed anything)
    approved_body = poll_result["decision"]["final_preview"]["body"]

    issue_url = _post_to_github(repository, title, approved_body)  # your GitHub call

    # Report execution back to Impri for the audit log
    httpx.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",
        headers=IMPRI_HEADERS,
        json={"status": "executed"},
        timeout=10,
    )
    return f"Issue created: {issue_url}"


# --- Agent ---

triage_agent = Agent(
    name="Issue Triage Agent",
    instructions=(
        "You read bug reports from team messages, identify actionable items, "
        "and create a GitHub issue for each one using create_github_issue. "
        "Never fabricate issue URLs."
    ),
    tools=[create_github_issue],
)


# --- Run ---

if __name__ == "__main__":
    import asyncio

    result = asyncio.run(
        Runner.run(
            triage_agent,
            input=(
                "Today's bugs: login breaks on Safari 17 for SSO users. "
                "CSV export hangs for files over 50 MB."
            ),
        )
    )
    print(result.final_output)
```

---

## Walking through the gate

When the agent calls `create_github_issue`, three things happen in sequence:

**1. Push.** `_push_and_poll` posts to `POST /v1/actions` with the issue draft as a markdown preview. Impri stores it, notifies you (email, Slack, Telegram — whichever you configured), and returns an `action_id`.

**2. Poll.** The function loops on `GET /v1/actions/{action_id}` every 10 seconds. The agent is blocked here — it cannot proceed to the GitHub call or return a result to the runner until `status` leaves `"pending"`.

**3. Execute or discard.** If `status == "approved"`, the function reads `poll_result["decision"]["final_preview"]["body"]` (the text as the reviewer left it) and passes it to your GitHub API call. On any other status (`rejected`, `expired`), it returns early and nothing is posted.

The tool is the agent's only path to GitHub. There is no code branch that bypasses the gate.

---

## When the reviewer edits the draft

Setting `"editable": ["preview.body"]` allows the reviewer to rewrite the issue body in the Impri inbox before approving. The polling response carries:

- `decision.final_preview` — the content as the reviewer left it (always use this, not the original `preview`)
- `decision.diff` — a unified diff of changes, present only when something was modified

In the example above, `approved_body = poll_result["decision"]["final_preview"]["body"]` picks this up automatically. The agent sends exactly what the human approved.

---

## Production considerations

**Expiry.** The example uses `expires_in: 3600` (one hour). For issues that are time-sensitive (a live incident), set it shorter. For lower-urgency drafts, you can go up to 30 days (2592000 seconds).

**Concurrent proposals.** If the agent finds two bugs, it will call `create_github_issue` twice — once for each. Both end up as separate cards in your inbox and can be approved or rejected independently.

**Rate limit.** `POST /v1/actions` is limited to 60 requests per minute per API key. An agent processing a large backlog in a loop will hit this limit; add a short sleep between iterations.

---

## Next steps

- [Quickstart](quickstart.md) — get your first action into the inbox in under five minutes
- [Integrations](integrations.md) — Python and TypeScript SDK wrappers for the REST calls
- [MCP server](mcp.md) — if you use Claude Code or another MCP client, the Impri MCP tools replace the HTTP calls entirely
