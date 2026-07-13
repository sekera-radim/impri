# Adding Human Approval to CrewAI Agents

CrewAI agents call tools on their own to get work done. This guide shows how to put a human approval step in front of any CrewAI tool so it proposes an action and only runs once you approve it.

---

## The problem with autonomous crews

CrewAI is built around agents that pick and call tools by themselves. That autonomy is the point, but it also means a tool with a real side effect — sending an email, posting to a channel, hitting a paid API — fires the moment the agent decides to call it. There is no natural pause.

Telling the agent "ask me first" in the task description does not hold. The model can reason past it, and a crew running unattended has nobody to ask. What you need is a tool that structurally cannot execute its side effect until a human has said yes.

---

## Wrap the tool, not the crew

The clean place for the gate is the tool itself. Impri provides the gate: your tool proposes the action, blocks until a human decides, and only then runs. Everything else in the crew stays the same.

Here is a CrewAI custom tool that sends an email, wrapped so the send is unreachable without an approved Impri decision:

```python
import os, time, requests
from crewai.tools import BaseTool

IMPRI = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}",
     "Content-Type": "application/json"}

class ApprovedEmailTool(BaseTool):
    name: str = "send_email"
    description: str = "Send an email. A human reviews the draft before it goes out."

    def _run(self, to: str, subject: str, body: str) -> str:
        # 1. Propose the action — nothing is sent yet.
        action = requests.post(f"{IMPRI}/v1/actions", headers=H, json={
            "kind": "email.send",
            "title": f"Email to {to}: {subject}",
            "preview": {"format": "markdown", "body": body},
            "editable": ["preview.body"],   # human may edit the text first
            "expires_in": 86400,
        }).json()

        # 2. Poll until a human decides.
        while True:
            time.sleep(10)
            state = requests.get(f"{IMPRI}/v1/actions/{action['id']}", headers=H).json()
            if state["status"] != "pending":
                break

        if state["status"] != "approved":
            return f"Not sent — human {state['status']} the draft."

        # 3. Execute with the approved (possibly edited) content.
        final = state["decision"]["final_preview"]["body"]
        send_via_your_provider(to, subject, final)   # your real send
        requests.post(f"{IMPRI}/v1/actions/{action['id']}/result",
                      headers=H, json={"status": "executed"})
        return "Sent after human approval."
```

Give this tool to your agent in place of a raw sender:

```python
from crewai import Agent

outreach = Agent(
    role="Outreach assistant",
    goal="Draft and send partnership emails",
    tools=[ApprovedEmailTool()],
)
```

The agent still decides *what* to send and *when* to call the tool. It just cannot complete the send without you.

---

## Why the block belongs in the tool

CrewAI's `_run` is synchronous, so the polling loop holds the tool call open until the decision arrives. The gate is real because `send_via_your_provider(...)` is only reachable after `status == "approved"`. If you leave the raw send available elsewhere in the crew, the agent can route around the gate — Impri is a chokepoint you confine the tool to, not a network-level interceptor of every egress.

A few practical notes:

- **Edits win.** Send `decision.final_preview.body`, never the original `preview.body`. When you mark a field in `editable`, the human can fix the draft in the inbox and your tool executes their version.
- **Expiry is a feature.** `expires_in` (seconds; min 300, max 30 days) auto-expires a stale proposal. Treat `expired` the same as `rejected`.
- **Fully unattended crews.** A 10-second poll is fine for a crew you are watching. For one that runs for hours, prefer the [MCP server](mcp.md) or a webhook so you are not holding a thread open the whole time.

---

## What Impri does and does not do

Impri is only the approval gate. It stores the proposed action, notifies you, and holds the decision — it does not run your crew, interpret the email, or send anything itself. That keeps the integration to a single tool wrapper.

If you need branching, multi-step orchestration, that is CrewAI's job (or a workflow engine); Impri is one gated step inside it.

---

## Next step

Start with the [quickstart](quickstart.md) to get an API key with the `actions` scope, then read the [human approval pattern](how-to-add-human-approval-to-an-ai-agent.md) for the full propose → approve → execute contract. For a ready-made wrapper and other frameworks, see [integrations](integrations.md).
