# What Is Human-in-the-Loop for AI Agents?

Human-in-the-loop for AI agents means a required human decision before any side effect runs — learn what it is, when you need it, and how to wire the pattern in.

---

## The core problem

The moment an agent can write to the outside world — send an email, post to an API, modify a record, create a ticket — it can make irreversible mistakes at machine speed. A single bad draft, a misread context, or a prompt injection propagates immediately.

Adding a system prompt line like "confirm before acting" does not fix this. The model still has to be trusted to comply, nothing enforces that it does, and there is no audit record of what happened.

---

## What "human-in-the-loop" actually means for agents

In the context of AI agents, HITL has a specific technical meaning: the agent's code is structured so that executing a side effect is blocked on an external state transition — a human moving a decision from `pending` to `approved`.

This is different from three things developers often confuse it with:

- **Asking the user mid-conversation.** A model can reason itself past its own confirmation prompt. This is not a structural guarantee.
- **Post-hoc log review.** Reading what the agent did after the fact finds mistakes; it does not prevent them.
- **Rate-limiting or monitoring.** These slow down or alert on bad behavior; they do not require sign-off before the action runs.

HITL is structural: the execution path for a side effect has a data dependency on a decision the agent cannot generate itself.

---

## When do you need it?

Not every agent needs a human checkpoint. A retrieval-only agent that reads and summarizes never does. A notification based on a rigid rule, or an agent operating in a sandboxed test environment, may be fine without one.

You need HITL when all of these are true:

| Condition | Why it matters |
|-----------|----------------|
| The action reaches external systems | Actions outside your control are hard to reverse |
| The content is generated, not templated | LLMs make errors a human reviewer can catch |
| You cannot automatically verify correctness | No test can tell you "this draft is the right thing to send" |
| Stakes are non-trivial | The cost of a bad action exceeds the cost of a short review delay |

---

## The propose → approve → execute pattern

The standard pattern is three steps. The agent proposes the action by pushing it to a queue; a human reviews and decides; the agent reads the decision and either executes or discards.

```python
import httpx, time, os

HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}
BASE = "https://api.impri.dev"

def push_action(kind, title, body):
    r = httpx.post(
        f"{BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "expires_in": 3600,
            "editable": ["preview.body"],
        },
    )
    return r.json()["id"]

def await_decision(action_id):
    while True:
        r = httpx.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r
        time.sleep(10)

# In your agent:
action_id = push_action(
    kind="slack.message.send",
    title="Post sprint summary to #product",
    body="## Sprint 42 complete\n\nAll 14 tasks shipped. Velocity: 38 points.",
)
result = await_decision(action_id)

if result["status"] == "approved":
    body = result["decision"]["final_preview"]["body"]
    send_to_slack(body)  # your Slack call, using the human-approved text
```

The key property: `send_to_slack` can only be reached after `status == "approved"`. The execution block is never reached on rejection or expiry — there is no branch to skip around the gate.

This is a real gate only as long as `send_to_slack` is the agent's sole path to Slack. If the agent still holds the raw credential to call Slack directly, it can route around the gate. Impri is a chokepoint you confine the agent to, not a network-level interceptor.

---

## What HITL is not

**Not content moderation.** Impri does not read or judge the content itself. It surfaces the proposed action to a specific human — you — who makes the call.

**Not a workflow engine.** There is no branching logic, retry scheduling, or multi-step orchestration built into the gate. If you need those, use a workflow tool (n8n, Temporal, Inngest) and put the HITL gate as one step inside it.

**Not agent-to-agent coordination.** HITL is a human decision point, not a handoff between agents. If you need agents to coordinate with each other, that is a separate concern.

---

## Expiry is a feature

Every proposed action has an expiry (default 72 hours, configurable from 5 minutes to 30 days). After expiry the status becomes `expired` and the action cannot be approved.

This is intentional. A draft reply to a thread that is three days old is often not worth sending. An agent working in a time-sensitive domain should set `expires_in` accordingly. Treat `expired` the same as `rejected` in your code: do not execute.

---

## Next step

To wire this into an existing agent in about ten minutes, follow [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). To get your first action into the inbox immediately, start with the [quickstart](quickstart.md).
