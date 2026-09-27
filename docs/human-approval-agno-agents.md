# Human Approval for Agno Agents: Adding an External Approval Inbox

Add human approval to an Agno agent with an external inbox: wrap risky tools so they push to Impri, wait for a decision, and act only after an approve.

---

## The problem: approval that lives inside the terminal

Agent frameworks typically pause a run and ask the operator to confirm. That works while you are sitting at the process. It stops working when the agent runs as a service, on a schedule, or while you are away from your desk — nobody is at the prompt, and the run just sits there.

An external inbox moves the question to where you are: a push notification, an email, a Slack or Telegram message. The agent's tool blocks until a person decides.

Impri is only the approval gate. It stores the proposal, notifies a human and holds the decision. It doesn't run your agent, interpret the action or execute anything.

---

## Wrap the tool, not the agent

The cleanest pattern is a plain Python function you hand to the agent as a tool. Inside it, the function proposes, waits, and only then performs the side effect. The model never gets a second, ungated route.

```python
# gated_tools.py
import os
import time
import requests

BASE = os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev")
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}


def _ask_human(kind: str, title: str, body: str) -> dict:
    """Push an action and block until a human decides. Returns the action JSON."""
    created = requests.post(
        f"{BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "expires_in": 3600,
            "editable": ["preview.body"],
        },
        timeout=15,
    )
    created.raise_for_status()
    action_id = created.json()["id"]

    while True:
        action = requests.get(
            f"{BASE}/v1/actions/{action_id}", headers=HEADERS, timeout=15
        ).json()
        if action["status"] != "pending":
            action["id"] = action_id
            return action
        time.sleep(5)


def post_release_notes(version: str, notes: str) -> str:
    """Publish release notes to the public changelog (requires human approval)."""
    action = _ask_human(
        kind="changelog.publish",
        title=f"Release notes for {version}",
        body=notes,
    )
    if action["status"] != "approved":
        return f"Not published: request was {action['status']}."

    final_notes = action["decision"]["final_preview"]["body"]
    try:
        publish_to_changelog(version, final_notes)  # your real side effect
    except Exception:
        _report(action["id"], "execute_failed")
        raise
    _report(action["id"], "executed")
    return "Published."


def _report(action_id: str, status: str) -> None:
    requests.post(
        f"{BASE}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": status},
        timeout=15,
    ).raise_for_status()
```

Then register `post_release_notes` in the agent's tool list the same way you register any other Python function. Because it returns a plain string on rejection or expiry, the model can tell the user what happened instead of crashing.

---

## Choices worth making deliberately

**Return the outcome as text.** A rejected action is a normal result, not an exception. Returning `"Not published: request was rejected."` lets the agent explain and offer a revision.

**Keep `expires_in` short for interactive agents.** One hour here means an unanswered request expires as `expired` rather than lingering for the 72-hour default.

**Always use `final_preview`.** The reviewer may have edited the notes. Publishing the agent's original text would silently ignore their correction.

**Blocking vs. not blocking.** The loop above blocks the tool call, which is simplest for a chat-style agent. For long waits, don't hold a worker thread open; see [the MCP route](mcp.md), where `impri_await_decision` does the waiting for you.

---

## A gate is only a gate if it's the only path

This is the honest limit. If your agent also has a general shell tool, or a second function that can call the changelog API directly, the model can route around the wrapped tool. Put the credential for the side effect behind the gated function only, and keep it out of the agent's other tools.

Impri also doesn't judge the content. A reviewer sees the proposed text and decides; there is no automatic moderation.

---

## Where the reviewer decides

Decisions can be made in the [inbox](inbox.md), or from chat with [Slack](slack-approval.md) or [Telegram](telegram-approval.md), and [notifications](notifications.md) cover email, ntfy and web push. Each request and its result show up in the [audit log](audit-log.md). A Python SDK is also available: see [sdk-python](sdk-python.md).

---

## Next step

Create a key in the [quickstart](quickstart.md), paste the wrapper above around your riskiest tool, and try one request end to end. The [general how-to](how-to-add-human-approval-to-an-ai-agent.md) covers the same three calls over curl and MCP.
