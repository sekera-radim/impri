# Open-Source Human-in-the-Loop Tools for AI Agents

Comparing open-source human-in-the-loop tools for AI agents — from framework-native pause points to dedicated, self-hostable approval gates you wire in directly.

---

## Two different things get called "human-in-the-loop"

Search for open-source human-in-the-loop tooling and you'll get two categories that solve different problems. The first is a **pause point inside an agent framework** — a way to stop a graph or chain mid-run and wait for input before continuing. The second is a **standalone approval gate** — a small service that sits between "agent decided to do X" and "X actually happens," independent of which framework built the agent. Which one you need depends on whether the thing you're gating lives inside one framework's run loop or has to work the same way regardless of what produced the action.

---

## Framework-native pause points

If your agent is already built on a specific framework, that framework likely has *some* mechanism for pausing on a step:

- **LangGraph** has interrupt/checkpoint support for pausing a graph at a node and resuming once external input arrives — useful if your whole system is already a LangGraph graph, since the pause is a native part of the graph's state machine.
- **CrewAI** supports human input on a task before the crew proceeds — the crew blocks in-process waiting for a response.
- **AutoGen** has a user-proxy agent pattern where a human (or human-driven process) sits in the conversation loop as one of the participants.

These are genuinely useful, and if you're all-in on one framework they're the path of least resistance. The tradeoff: the pause lives inside that framework's process. There's usually no built-in mobile notification, no audit trail independent of your app logs, and no shared review surface if you run agents across more than one framework or language.

---

## Workflow-engine HITL nodes

If your agent action is a step inside a larger orchestrated workflow, the workflow engine may already have an approval primitive: n8n has a human-in-the-loop / wait-for-approval node, and Temporal supports pausing a workflow execution on a signal that a human (or a service acting for one) sends later. These work well when the agent step is genuinely embedded in a bigger workflow — but they pull in the whole orchestration engine even if your only need is "pause this one action for a yes/no."

---

## Dedicated approval-gate services

The alternative is a small service whose only job is holding the decision — framework-agnostic, callable from a bash script, a Python agent, a TypeScript MCP tool, or a cron job, all the same way. Impri is one (MIT-licensed self-hostable core, hosted option at impri.dev): it stores the proposed action, notifies a human across email/Slack/Telegram/Discord/push, and returns a decision your agent polls for. No framework dependency, no workflow engine required.

```python
import os, time, requests

BASE = os.environ.get("IMPRI_BASE_URL", "http://localhost:8484")
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_action(kind, title, body):
    resp = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json={
        "kind": kind,
        "title": title,
        "preview": {"format": "markdown", "body": body},
        "expires_in": 3600,
    })
    return resp.json()["id"]

def wait_for_decision(action_id):
    while True:
        resp = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(10)

action_id = propose_action("post.publish", "Publish weekly digest", "## This week...\n...")
decision = wait_for_decision(action_id)
if decision["status"] == "approved":
    publish(decision["decision"]["final_preview"]["body"])
```

Running the base URL against `localhost:8484` means this is the self-hosted core — no cloud dependency at all. [Self-hosting](self-hosting.md) covers running it with Docker.

---

## Comparison at a glance

| Tool | Scope | Self-hostable | Works outside its framework |
|---|---|---|---|
| LangGraph interrupts | Pause within a LangGraph graph | Yes (it's your app) | No — tied to the graph |
| CrewAI human input | Pause within a crew task | Yes (it's your app) | No — tied to CrewAI |
| AutoGen user proxy | Human as a conversation participant | Yes (it's your app) | No — tied to AutoGen |
| n8n HITL node | Approval step inside an n8n workflow | Yes | Only as an n8n node |
| Impri | Dedicated approval gate | Yes (MIT core) | Yes — REST/MCP, any language |

---

## Picking one

If your agent lives entirely inside one framework and never needs to be reviewed from outside that process, the native pause point is less to set up. If you run agents across multiple frameworks, languages, or scripts and want one review inbox, one audit trail, and one notification path regardless of what produced the action, a dedicated gate is the better fit — and you can still call it from inside a LangGraph node or an n8n workflow as one step. See [integrations](integrations.md) for wiring it into an existing agent SDK, or [the MCP server](mcp.md) if your agent runs inside an MCP client.

## Next step

[Quickstart](quickstart.md) gets a self-hosted instance or a cloud key running in a few minutes either way.
