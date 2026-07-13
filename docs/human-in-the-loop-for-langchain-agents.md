# Human-in-the-Loop Approval for LangChain Agents

Add a human approval gate to any LangChain agent tool in under 40 lines — block side effects until a human approves the draft, with full edit support and an audit record.

---

## The problem with tool-calling agents

LangChain agents using ReAct or function-calling loops can invoke tools many times in a single run. That is fine for read-only tools. When a tool sends an email, posts a comment, modifies a record, or calls an external API, every invocation is a permanent side effect.

The typical mitigations — restrictive system prompts, dry-run flags, verbose logging — reduce the frequency of mistakes. They do not eliminate them, and they leave no enforced gate. A model can reason itself past a "please confirm before sending" instruction. Logging after the fact does not undo the action.

What works structurally is replacing the tool's direct executor with a version that **cannot complete without a human decision**. The agent continues to function normally; it simply cannot reach the final action.

---

## Where to hook in

LangChain's tool abstraction is the right integration point. A `BaseTool` subclass controls what happens when the agent calls the tool — including the ability to pause, wait for an external signal, and return a result based on that signal.

The pattern:

1. The agent invokes the tool with its proposed inputs (recipient, subject, body — whatever the action needs).
2. The tool pushes the proposal to Impri and receives an `action_id`.
3. The tool polls `GET /v1/actions/:id` until the human decides.
4. On `approved`, it executes using `decision.final_preview` (which carries any edits the human made).
5. On `rejected` or `expired`, it returns a string explaining the outcome — the agent can then decide what to do next.

The key property: execution is gated on a data dependency (the API returning `status: "approved"`), not on a prompt instruction the model could rationalize away.

---

## Implementation

```python
import os
import time
import requests
from langchain.tools import BaseTool

IMPRI_API_KEY = os.environ["IMPRI_API_KEY"]
IMPRI_BASE = "https://api.impri.dev"

class ApprovedEmailTool(BaseTool):
    name = "send_email"
    description = (
        "Sends an email to a recipient. "
        "The draft must be approved by a human before it is sent."
    )

    def _run(self, to: str, subject: str, body: str) -> str:
        # 1. Push the proposed action for human review
        resp = requests.post(
            f"{IMPRI_BASE}/v1/actions",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
            json={
                "kind": "email.send",
                "title": f"Email to {to}: {subject}",
                "preview": {
                    "format": "markdown",
                    "body": f"**To:** {to}\n**Subject:** {subject}\n\n---\n\n{body}",
                },
                "editable": ["preview.body"],
                "expires_in": 3600,
            },
        )
        resp.raise_for_status()
        action_id = resp.json()["id"]

        # 2. Poll until the human decides
        while True:
            result = requests.get(
                f"{IMPRI_BASE}/v1/actions/{action_id}",
                headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
            ).json()

            if result["status"] != "pending":
                break
            time.sleep(10)

        # 3. Execute only on approval — use final_preview in case the human edited
        if result["status"] != "approved":
            return f"Action {result['status']}. Email not sent."

        approved_body = result["decision"]["final_preview"]["body"]
        _send_via_smtp(to, subject, approved_body)  # your sending function

        # 4. Report the outcome back to Impri
        requests.post(
            f"{IMPRI_BASE}/v1/actions/{action_id}/result",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
            json={"status": "executed"},
        )
        return f"Email sent to {to}."

    async def _arun(self, *args, **kwargs):
        raise NotImplementedError("Use _run (synchronous) for this tool.")


def _send_via_smtp(to: str, subject: str, body: str) -> None:
    # your actual email sending logic
    ...
```

Wire it into your agent the same way any other tool would be used:

```python
from langchain.agents import initialize_agent, AgentType
from langchain.chat_models import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o")
tools = [ApprovedEmailTool()]

agent = initialize_agent(
    tools=tools,
    llm=llm,
    agent=AgentType.OPENAI_FUNCTIONS,
    verbose=True,
)

agent.run("Draft a follow-up email to alice@example.com about the Q3 contract renewal.")
```

The agent composes the email and calls `send_email`. `send_email` pauses, waits for approval, and only proceeds when a human says yes. The agent's reasoning loop is unchanged; the gate is structural.

---

## Human edits and final_preview

Setting `"editable": ["preview.body"]` lets the reviewer modify the body text before approving. When they do, `decision.final_preview.body` holds the edited version and `decision.diff` holds a unified diff of what changed.

Always use `final_preview.body` for execution, never the original `body` argument passed to the tool. That is the version the human actually approved.

---

## Expiry and polling behavior

The `expires_in` field sets how long Impri holds the action open (in seconds; minimum 300, maximum 30 days, default 72 hours). After expiry the status becomes `expired` and the action cannot be approved.

For a live agent loop, short expiries (an hour or less) are usually right — a draft that sat overnight has likely lost its context. Treat `expired` the same as `rejected` in the tool's return value: the agent will see the string and can decide whether to retry, escalate, or give up.

---

## What Impri is not

Impri stores the proposed action, notifies the human via inbox card (with optional Slack, Discord, or Telegram), and holds the decision. It does not generate content, interpret what the action does, or execute anything itself.

It is a genuine gate only as long as `ApprovedEmailTool` is the agent's **only** path to sending email. If the agent also holds a raw SMTP credential or a direct API key with email-sending access, it can route around this wrapper. Confine the side-effect credential to the tool; give the agent no other way to reach it.

---

## Next steps

- [Quickstart](quickstart.md) — API key and first action in five minutes
- [Python SDK](sdk-python.md) — typed client wrapping the REST calls above
- [Slack and Telegram approval](slack-approval.md) — get notified and approve from your phone instead of the inbox UI
