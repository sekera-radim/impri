# Pydantic AI Human-in-the-Loop with an Approval Inbox

Pydantic AI ends a run with DeferredToolRequests when a tool needs approval. Send each call to Impri, save the history, and resume once a person decides.

---

## How Pydantic AI pauses a tool call

Mark a tool with `requires_approval=True` and add `DeferredToolRequests` to the agent's `output_type`. When the model calls that tool, Pydantic AI doesn't run it. The run ends, and `result.output` is a `DeferredToolRequests` whose `approvals` list holds each pending call: tool name, arguments and `tool_call_id`. You continue with a second run that gets the saved message history plus a `DeferredToolResults` mapping each `tool_call_id` to `ToolApproved` or `ToolDenied`. Leave `DeferredToolRequests` out of `output_type` and the run fails with a `UserError` instead of pausing.

Nothing waits in memory between the two runs. That is what makes the pattern fit an approval inbox: the reviewer can answer from a phone an hour later, after your worker has restarted. The [Pydantic AI deferred tools docs](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/) show both runs in one process. Below, the pause becomes a card in Impri, and the second run starts when someone decides it.

## The agent and the gated tool

Requirements: `pip install pydantic-ai httpx`, an Impri API key in `IMPRI_API_KEY`.

```python
import os
import httpx
from pydantic_ai import Agent, DeferredToolRequests, RunContext

from mailer import send_email  # your email provider; returns a message id

impri = httpx.Client(
    base_url=os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev"),
    headers={"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"},
)

agent = Agent(
    os.environ["AGENT_MODEL"],  # any model string Pydantic AI supports
    output_type=[str, DeferredToolRequests],
    instructions="You answer support tickets. Reply to customers with send_customer_email.",
)


@agent.tool(requires_approval=True)
def send_customer_email(ctx: RunContext[None], to: str, subject: str, body: str) -> str:
    """Email a customer. A person approves every call before it runs."""
    action_id = ctx.tool_call_metadata["impri_action_id"]
    message_id = send_email(to=to, subject=subject, body=body)
    impri.post(f"/v1/actions/{action_id}/result", json={"status": "executed", "detail": message_id})
    return f"Email sent to {to} (message {message_id})."
```

The body of `send_customer_email` runs only after approval. `ctx.tool_call_metadata` carries the Impri action id you pass in on resume, so the tool can report the outcome and the card moves from `approved` to `executed`.

## Step 1: turn the pause into a card

```python
import json
from pathlib import Path

PENDING = Path("pending")  # a table in your database in production


def start(conversation_id: str, ticket: str) -> str | None:
    result = agent.run_sync(ticket)
    if not isinstance(result.output, DeferredToolRequests):
        return result.output  # finished without a gated call
    state = {"messages": result.all_messages_json().decode(), "calls": {}}
    for call in result.output.approvals:
        args = call.args_as_dict()
        r = impri.post("/v1/actions", json={
            "kind": "email.send",
            "title": f"Email {args['to']}: {args['subject']}",
            "preview": {"format": "plain", "body": args["body"]},
            "editable": ["preview.body"],
            "idempotency_key": f"{conversation_id}:{call.tool_call_id}",
            "callback_url": f"https://support.example.com/impri/{conversation_id}",
        })
        r.raise_for_status()
        state["calls"][call.tool_call_id] = {"action_id": r.json()["id"], "args": args}
    PENDING.mkdir(exist_ok=True)
    (PENDING / f"{conversation_id}.json").write_text(json.dumps(state))
    return None  # paused: no process waits for the reviewer
```

Each pending call becomes one action. `preview.body` is the email the customer will get, and `editable: ["preview.body"]` lets the reviewer rewrite it before approving. The `idempotency_key` comes from the tool call id, so a retried POST returns the same card instead of a second one. `callback_url` is where Impri sends a signed webhook when the card is decided or expires ([Webhooks](webhooks.md)): your handler checks the signature and calls `resume()`.

## Step 2: resume with the decision

```python
from pydantic_ai import DeferredToolResults, ToolApproved, ToolDenied
from pydantic_ai.messages import ModelMessagesTypeAdapter


def resume(conversation_id: str) -> str | None:
    path = PENDING / f"{conversation_id}.json"
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError:
        return None  # already resumed
    results = DeferredToolResults()
    for call_id, call in state["calls"].items():
        action = impri.get(f"/v1/actions/{call['action_id']}").json()
        if action["status"] == "pending":
            return None  # wait until every card is decided
        verdict = (action.get("decision") or {}).get("verdict")
        if verdict == "approve":
            body = action["decision"]["final_preview"]["body"]  # the reviewer's edit, if any
            results.approvals[call_id] = ToolApproved(override_args={**call["args"], "body": body})
            results.metadata[call_id] = {"impri_action_id": call["action_id"]}
        elif verdict == "reject":
            results.approvals[call_id] = ToolDenied("A reviewer rejected this email. Do not resend it.")
        else:  # expired: nobody decided in time
            results.approvals[call_id] = ToolDenied("No reviewer decided in time. The email was not sent.")
    try:
        path.rename(path.with_suffix(".resumed"))  # atomic claim: one caller resumes
    except FileNotFoundError:
        return None
    history = ModelMessagesTypeAdapter.validate_json(state["messages"])
    result = agent.run_sync(message_history=history, deferred_tool_results=results)
    return result.output
```

What this code relies on:

- **The verdict comes from `GET /v1/actions/:id`**, under `decision.verdict`. The webhook only tells you when to look.
- **The saved history stays on your server.** Pydantic AI runs an approved call from whatever history it is given, so a history a client can edit would let the client approve its own calls (the Pydantic AI docs warn about the same trust boundary).
- **`override_args` replaces the arguments, it doesn't merge them.** Pass the whole dict with the edited body, as above. Without an edit, `final_preview.body` is the original text.
- **`ToolDenied` text is what the model reads as the tool's result**, so write it as an instruction ("do not resend").
- **An expired card has no decision.** Deny the call so the run finishes instead of staying paused forever.
- **Resume once.** A webhook retry or a cron that also calls `resume()` must not send the email twice, so `resume()` claims the saved state by renaming the file before it runs the agent. With a database, use a conditional update for the same claim. If that second run fails (the model API is down, say), the state stays in the `.resumed` file: check the card before you retry, because `executed` means the email already went out.

## Only some calls need a person: `ApprovalRequired`

When only some calls need review, for example emails to addresses outside your company, drop `requires_approval` and raise `ApprovalRequired` inside the tool:

```python
from pydantic_ai import ApprovalRequired


@agent.tool
def send_customer_email(ctx: RunContext[None], to: str, subject: str, body: str) -> str:
    if not to.endswith("@yourcompany.com") and not ctx.tool_call_approved:
        raise ApprovalRequired()
    ...  # send; report to Impri only when ctx.tool_call_approved is True
```

On resume, Pydantic AI runs the function again from the top with `ctx.tool_call_approved=True`. In our run the body was entered twice for one email, so keep side effects below the check. `ctx.tool_call_metadata` is `None` for calls that never needed approval.

## What we ran

On 2026-11-18, with pydantic-ai 2.70.0 against a local Impri server. The model was Pydantic AI's `FunctionModel` returning a scripted tool call (no LLM API key), and `start()` and every `resume()` ran in separate processes.

| What happened in Impri | What the model got back | Email sent | Card status |
|---|---|---|---|
| Approved with an edited body | `Email sent to dana@example.com (message …)` | once, with the edited text | `executed` |
| Rejected | "A reviewer rejected this email. Do not resend it." | no | `rejected` |
| Expired (expiry forced on the test server) | "No reviewer decided in time. The email was not sent." | no | `expired` |
| `resume()` before any decision | nothing: `resume()` returned `None`, the run stayed paused | no | `pending` |
| `resume()` called a second time | nothing: `resume()` returned `None` | no second email | `executed` |

Impri makes sure a person approved this email, in the exact text the tool then sends. It doesn't check that the agent picked the right customer: that stays in your code, and the gate only holds if `send_customer_email` is the agent's only way to send mail.

## Next step

[Start free on Impri Cloud](https://app.impri.dev/?signup=1), create an API key and run `start()` on a test ticket: the card appears in your inbox. To keep everything on your own machine, follow [Self-hosting](self-hosting.md) and set `IMPRI_BASE_URL=http://localhost:8484`. The same pattern for other frameworks: [OpenAI Agents SDK](human-in-the-loop-openai-agents-sdk.md), [LangChain Deep Agents](human-in-the-loop-langchain-deep-agents.md).
