# What Is an Approval Inbox for AI Agents?

An approval inbox for AI agents is a stored, pending action — proposed by code, held in a `pending` state — that a human opens, reviews, and either approves or rejects before anything happens.

---

## The one-sentence version

Instead of an agent calling `send_email()` or `create_issue()` directly, it calls something like `push_action()`. That call doesn't do the thing — it creates a record describing the thing, and the record sits in an inbox until a person acts on it. The agent's execution code only runs after that record's status changes.

That's the whole concept. Everything else — cards, channels, expiry, editing — is detail on top of "propose, then wait for a decision."

---

## What's actually inside a card

When people picture "approval inbox" they usually picture a UI. Underneath the UI, each card is backed by a small, specific record:

| Field | What it holds |
|---|---|
| `kind` | A label for the action type, e.g. `"github.issue_comment"` |
| `title` | Short human-readable summary shown in the list view |
| `preview` | The actual content to review — `format` + `body` |
| `status` | `pending`, `approved`, `rejected`, or `expired` |
| `editable` | Which paths the reviewer is allowed to change before approving |
| `expires_in` | Seconds until the action auto-expires if nobody acts |

Nothing here is agent-specific magic — it's a row in a database with a state machine attached. The "inbox" is just the view that lists every row still in `pending`.

---

## Lifecycle of a card

A card only ever moves one of three ways from `pending`:

```
pending ──approve──▶ approved ──(agent executes)──▶ done
   │
   ├──reject───────▶ rejected  (agent never executes)
   │
   └──timeout──────▶ expired   (agent never executes)
```

The agent's own code enforces the third branch of that diagram — it has to poll or wait for a terminal status and simply not call the real side-effecting function until it sees `approved`.

---

## A minimal example: gating a GitHub bot

Say you have an agent that watches issues and drafts comments in response. Instead of posting straight to the GitHub API, it pushes a card first:

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_comment(issue_number: int, body: str) -> str:
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "github.issue_comment",
        "title": f"Reply to issue #{issue_number}",
        "preview": {"format": "markdown", "body": body},
        "expires_in": 21600,       # 6 hours — stale replies aren't worth posting
        "editable": ["preview.body"],
    })
    return resp.json()["id"]

def wait_and_post(action_id: str, issue_number: int):
    while True:
        r = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            break
        time.sleep(10)

    if r["status"] == "approved":
        final_body = r["decision"]["final_preview"]["body"]
        post_github_comment(issue_number, final_body)  # your real API call
```

`post_github_comment` is never reached for a rejected or expired card — the function returns before that line runs. That's the gate: not a prompt instruction, a return statement guarded by data from the API.

---

## Inbox vs. a one-off Slack ping

A single "hey, approve this?" message works when an agent proposes things rarely. It breaks down the moment you have more than one thing pending at once — a message you don't act on immediately scrolls away, and there's no single place to see everything still waiting. An inbox is durable: a card stays listed as `pending` until someone decides, regardless of which channel notified them about it (email, Slack, Telegram, push — see [notifications](notifications.md)).

---

## Where it fits in your stack

The inbox is not a replacement for your agent's logic, and it doesn't decide anything on its own — a human still makes every call. It also isn't a workflow engine: it doesn't branch, retry, or schedule. It holds exactly one thing — the pending/approved/rejected/expired state of a proposed action — and lets your agent's own code react to that state.

If you're wiring this into an agent for the first time, [the full walkthrough](how-to-add-human-approval-to-an-ai-agent.md) covers both the REST and MCP integration paths, and [quickstart](quickstart.md) gets you an API key to try it against.
