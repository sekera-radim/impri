# How to Pause an AI Agent for Human Input

Learn how to pause an AI agent mid-run and wait for a human decision before it continues — without polling hacks or losing state.

---

## The problem: agents don't stop on their own

A tool-calling agent that runs in a loop — plan, call a tool, observe, repeat — has no natural place to stop and ask "should I actually do this?" Once a tool call is dispatched, the side effect happens. Bolting a `confirm=True` flag onto the tool doesn't help either: nothing forces the agent to check it before firing, and there's no record of who said yes.

What you actually need is a step in the graph that *cannot* proceed until an external decision arrives. That means the pause has to live outside the agent's own reasoning — in a place the agent can't talk itself past.

---

## Where to insert the pause

If you're building on a graph-based framework (LangGraph, or a hand-rolled state machine), the natural spot is a dedicated node between "agent decided on an action" and "tool executes." That node does three things: push the proposed action somewhere durable, block on the decision, and only then hand control to the real tool.

```python
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

def human_gate_node(state):
    """LangGraph node: pause the run until a human approves the pending action."""
    proposed = state["pending_action"]  # built by the previous agent node

    resp = requests.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json={
        "kind": "db.schema_change",
        "title": f"Apply migration: {proposed['name']}",
        "preview": {"format": "markdown", "body": proposed["sql"]},
        "expires_in": 1800,          # 30 minutes — this decision goes stale fast
        "editable": ["preview.body"],
    })
    action_id = resp.json()["id"]

    # Block the graph here. This is the pause.
    while True:
        result = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(5)

    if result["status"] != "approved":
        state["migration_applied"] = False
        return state

    # Human may have edited the SQL before approving — always use final_preview
    state["approved_sql"] = result["decision"]["final_preview"]["body"]
    return state
```

The graph node blocks on `time.sleep(5)` inside the loop, so the agent's own control flow physically cannot reach the next node — running the migration — without that `status: "approved"` coming back from the API.

---

## What the human sees while the agent waits

The moment `POST /v1/actions` returns, a card appears in the reviewer's inbox (and a notification fires via email, ntfy, or a Slack/Discord/Telegram channel, if configured). The reviewer sees the title, the rendered preview, and — because `editable` includes `preview.body` — a text box to tweak the SQL before approving. Nothing about this requires the agent to be reachable; the agent is asleep in its polling loop, and the decision gets written to the action record whenever the human gets to it.

---

## Handling a stale pause

`expires_in` matters more here than in a fire-and-forget action. A schema migration proposed 25 minutes ago against a database that's since changed shouldn't auto-apply just because a human finally taps approve. Set `expires_in` tight for anything time-sensitive (this example uses 1800 seconds), and treat `expired` the same as `rejected` in your node — fall through without executing, and let the agent decide whether to re-propose.

| Outcome | What the graph should do |
|---|---|
| `approved` | Proceed to the execution node with `final_preview` |
| `rejected` | Skip execution, log the reason if the reviewer left one |
| `expired` | Skip execution, treat as stale — re-plan if still relevant |

---

## Pausing without a graph framework

If your agent is a plain loop rather than a graph, the same pattern applies — the "pause" is just the function call that doesn't return until the action is decided. For agents running inside Claude Code or another MCP client, [`mcp.md`](mcp.md) wraps this exact poll loop into a single blocking tool call (`impri_await_decision`), so you don't hand-write the `while` loop at all.

---

## Next step

Start with [quickstart](quickstart.md) to get an API key, then see [the full REST/MCP walkthrough](how-to-add-human-approval-to-an-ai-agent.md) for the three-call pattern this pause node is built on. If you're integrating with Python specifically, [sdk-python](sdk-python.md) covers the client library.
