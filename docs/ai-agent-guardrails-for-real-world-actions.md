# AI Agent Guardrails for Real-World Actions

Real AI agent guardrails don't live in the prompt — they live in the code path between a decision and a side effect, where a human can actually intervene.

---

## "Guardrails" usually means a prompt, not a gate

Search for "AI agent guardrails" and most results describe system-prompt phrasing: "always ask before doing X," constitutional AI, refusal training, output filters that scan for toxic content. Those are useful for *what the model says*. They do nothing for *what the model's tools do*, because a tool call bypasses the conversational layer entirely. If your agent has a `send_email(to, body)` function bound to it, a prompt instruction not to email strangers is a suggestion the model can talk itself past — via prompt injection, a misread instruction, or a plain reasoning error. The tool still runs.

A structural guardrail sits below the prompt, in the function the tool calls. It does not ask the model to behave — it makes the side effect unreachable without an external signal.

---

## The shape of a structural guardrail

Three properties separate a real gate from a prompt suggestion:

1. **The side effect is wrapped, not warned about.** The function that actually sends the email, writes the row, or calls the paid API checks for an approval before it runs — the model never gets a code path that skips the check.
2. **The decision comes from outside the agent's context.** If the "approval" is another LLM call or a self-check the same agent performs, a bad instruction that fooled the first agent can fool the second. A human, in a different process, breaks that chain.
3. **Nothing executes on ambiguity.** Pending, expired, and rejected are all "no." Only an explicit approved decision reaches the executor.

Here's the wrapper pattern in Python, using Impri as the gate for a database-writing agent tool:

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def guarded_db_write(table: str, row: dict) -> dict:
    """The ONLY function the agent's tool schema exposes for writes.
    There is no direct db.insert() in the agent's toolset."""
    resp = requests.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json={
        "kind": "db.write",
        "title": f"Insert into {table}: {row.get('name', row)}",
        "preview": {"format": "plain", "body": str(row)},
        "expires_in": 1800,
        "idempotent": False,
        "undo": f"DELETE FROM {table} WHERE id = <new_row_id>",
    })
    action_id = resp.json()["id"]

    while True:
        status = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if status["status"] != "pending":
            break
        time.sleep(5)

    if status["status"] != "approved":
        return {"executed": False, "reason": status["status"]}

    row_id = db.insert(table, status["decision"]["final_preview"])  # your real insert
    requests.post(f"{IMPRI_BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                   json={"status": "executed", "payload": {"row_id": row_id}})
    return {"executed": True, "row_id": row_id}
```

The agent only ever sees `guarded_db_write`. There is no `db.insert` in its tool list for it to call around the gate. That's the whole guardrail — not the polling loop, the withholding of the raw capability.

---

## Where this breaks down

A gate is only as strong as the narrowest path to the side effect. Two common leaks:

- **A second tool with the same power.** If the agent also has raw shell access or a generic HTTP client tool, it can reimplement the write itself and skip `guarded_db_write` entirely. The guardrail has to be the *only* door, not one of several.
- **Credentials handed to the agent directly.** If the database connection string or API key lives in the agent's environment and it can execute arbitrary code, no wrapper function matters — it can open the connection itself. Keep the real credential in the executor process, not in anything the model can read or execute against.

This is why "add guardrails" is really an architecture question before it's an API integration question: what capabilities does the agent's runtime actually expose, and is the gated function the sole path to each one?

---

## Guardrails aren't a workflow engine

Impri, which the code above uses, only stores the proposed action, notifies a human, and holds the decision — it doesn't interpret the row being written or branch on business logic. If you need conditional routing (route financial writes to one approver, content writes to another, auto-approve under a threshold) that's workflow logic your agent or an orchestrator like n8n should own; Impri is one gate you can call from inside it.

For the three-call pattern in more detail, including MCP tool bindings so you don't hand-write the polling loop, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). If you're wiring this into LangChain, LangGraph, or a custom agent loop, [the integrations doc](integrations.md) covers wrapping tool functions specifically. And if the guardrail should also cover an emergency stop — not just gating new actions but halting an agent mid-run — see [adding a kill switch](add-a-kill-switch-to-your-ai-agent.md).

Next: [quickstart](quickstart.md) to get an API key and push your first gated action in a few minutes.
