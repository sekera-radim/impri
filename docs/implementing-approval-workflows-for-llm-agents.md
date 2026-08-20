# Implementing Approval Workflows for LLM Agents

An approval workflow for an LLM agent means one thing in practice: the agent proposes, a human decides, and the side effect only fires after that decision — here's how to wire it in.

---

## Where this fits in an agent's control loop

Most LLM agent frameworks (LangChain, a custom ReAct loop, whatever you rolled yourself) already have a point where the agent decides "call this tool now." An approval workflow inserts a pause at that exact point for any tool with a real-world side effect — sending something, writing to a database, spending money. The tool call is split into two halves: a **propose** call that never touches the real system, and an **execute** call that only runs after a human decision comes back.

This is different from asking the LLM to "confirm before acting" in its system prompt. A prompt instruction is advisory — the model can be talked past it by a bad context, a prompt injection in tool output, or just a wrong turn in reasoning. A workflow needs an actual data dependency: the execute code path must be unreachable without an external `approved` status.

## Building the workflow with Impri

Impri gives you three calls that form this workflow: push the action, wait for a decision, execute and report. Here's a Python agent function that wraps a "create a support ticket refund" tool:

```python
import requests
import time

IMPRI_BASE = "https://api.impri.dev"
API_KEY = "im_your_key_here"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}

def request_approval(kind, title, body, editable=None, expires_in=3600):
    resp = requests.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json={
        "kind": kind,
        "title": title,
        "preview": {"format": "markdown", "body": body},
        "editable": editable or [],
        "expires_in": expires_in,
    })
    return resp.json()["id"]

def wait_for_decision(action_id, poll_every=5):
    while True:
        resp = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(poll_every)

def issue_refund_with_approval(order_id, amount, reason):
    action_id = request_approval(
        kind="payment.refund",
        title=f"Refund ${amount} for order {order_id}",
        body=f"Reason: {reason}\nOrder: {order_id}\nAmount: ${amount}",
        editable=["preview.body"],
    )
    decision = wait_for_decision(action_id)

    if decision["status"] != "approved":
        return {"executed": False, "status": decision["status"]}

    # Real side effect only happens here, after approval
    payment_api.refund(order_id, amount)

    requests.post(f"{IMPRI_BASE}/v1/actions/{action_id}/result",
                   headers=HEADERS, json={"status": "executed"})
    return {"executed": True}
```

The agent's tool-calling code calls `issue_refund_with_approval` instead of a direct `payment_api.refund`. That substitution is the entire integration — no framework-specific glue required, because the workflow lives outside the LLM's reasoning loop entirely.

---

## Designing the workflow, not just the API calls

Wiring three HTTP calls is the easy part. The workflow design decisions that actually matter:

| Decision | Guidance |
|---|---|
| Which tools get gated | Anything with an external side effect: send, post, pay, delete, deploy. Read-only tools don't need a gate. |
| Expiry per action kind | Short for time-sensitive actions (a live chat reply), longer for batch review (end-of-day content queue). |
| Who can edit before approving | Set `editable` only on fields a reviewer should be able to fix without rejecting outright — usually just the draft body. |
| What happens on reject/expire | Treat both the same: log it, don't retry silently, optionally let the agent re-propose if the underlying task is still relevant. |

One workflow mistake worth naming explicitly: gating the *call* but leaving the agent holding a credential that can reach the same system directly. If the agent's code (or a tool it can invoke) still has the raw API key for the payment provider, it can route around the approval step entirely. The gate only works if the wrapped function is the agent's only path to the side effect — see [how this actually gates execution](how-to-add-human-approval-to-an-ai-agent.md) for the full argument.

## Multi-step agents and workflow ordering

If your agent runs several actions in sequence — draft a refund, then email the customer about it — decide whether each step needs its own approval or whether one approval covers the batch. Impri doesn't orchestrate multi-step sequencing itself; it holds individual decisions. For agents that need branching logic across many gated steps, treat Impri as the approval primitive inside a larger orchestration layer (an n8n workflow, a Temporal workflow, or your own state machine) rather than trying to make the approval API do the sequencing.

---

## Reporting outcomes back

Don't skip the `POST /v1/actions/:id/result` call. Without it, an approved action has no record of whether execution actually succeeded — which matters when you're debugging why a customer says they never got their refund. Pass `status: "execute_failed"` if your side-effect call throws, so the failure shows up on the action instead of silently vanishing from the agent's logs.

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then wire in [MCP](mcp.md) if your agent runs inside a client that supports it — it collapses these three calls into three tool calls with no HTTP code at all.
