# Human-in-the-Loop for the OpenAI Agents SDK

The OpenAI Agents SDK pauses a run before any tool marked needs_approval. Send each pause to an Impri inbox, save the run, and resume it once a human decides.

*Updated 2026-11-15. Tested with `openai-agents` 0.24.0 (Python) against a self-hosted Impri server.*

## What the SDK does, and what it leaves to you

The SDK has human-in-the-loop built in ([official guide](https://openai.github.io/openai-agents-python/human_in_the_loop/)):

1. `@function_tool(needs_approval=True)` stops the run before that tool executes. `Runner.run` returns with `result.interruptions`, one item per paused call, each with `name`, `arguments` (a JSON string) and `call_id`.
2. `state = result.to_state()`, then `state.approve(item)` or `state.reject(item, rejection_message="...")`, then `Runner.run(agent, state)` continues. The rejection message is what the model reads.
3. `state.to_string()` and `RunState.from_string(agent, text)` let a different process resume the run, hours later.
4. `needs_approval` also accepts an async function `(run_context, params, call_id) -> bool`, so only some calls pause (say, issues in public repositories).

It leaves to you who is asked and where, what happens when nobody answers, a record of who approved what, and edits: `approve()` runs the tool with exactly the arguments the model wrote. Impri covers those: each pause becomes a card in the inbox (with notifications to the project's Slack, Discord, Telegram, ntfy, email or webhook channels), it expires if nobody decides, the decision goes to the audit log, and the reviewer can edit the text before approving.

## The full example: an issue triage agent

`start` runs the agent until it pauses, creates one Impri card per paused call and saves the run. `resume` runs from a cron job or worker (or a webhook handler, if you add `callback_url`: see [Webhooks](webhooks.md)) and continues once every card is decided.

```
pip install openai-agents httpx
export OPENAI_API_KEY=...           # for the model
export IMPRI_API_KEY=...            # your Impri project key
python triage.py start "Login breaks on Safari 17 for SSO users. CSV export hangs over 50 MB."
python triage.py resume <run id>    # later, as often as you like
```

```python
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

import httpx
from agents import Agent, RunState, Runner, function_tool
from agents.tool_context import ToolContext

IMPRI = httpx.Client(
    base_url=os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev"),
    headers={"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"},
    timeout=10,
)
RUNS = Path("runs")  # paused runs; use your database in production


def open_issue(repository: str, title: str, body: str) -> str:
    raise NotImplementedError("your GitHub API call; return the issue URL")


@function_tool(needs_approval=True)
def create_github_issue(
    ctx: ToolContext[dict], repository: str, title: str, body: str
) -> str:
    """Open a GitHub issue in the given repository."""
    action_id = ctx.context["impri"][ctx.tool_call_id]
    decision = IMPRI.get(f"/v1/actions/{action_id}").json()["decision"]
    body = decision["final_preview"]["body"]  # the text as the reviewer left it
    try:
        url = open_issue(repository, title, body)
    except Exception as exc:
        IMPRI.post(f"/v1/actions/{action_id}/result",
                   json={"status": "execute_failed", "detail": str(exc)[:500]})
        raise
    IMPRI.post(f"/v1/actions/{action_id}/result",
               json={"status": "executed", "detail": url})
    return f"Created {url}"


agent = Agent(
    name="Issue triage",
    instructions="Turn each actionable bug in the message into one GitHub issue.",
    tools=[create_github_issue],
)


def park_or_finish(run_id: str, result) -> None:
    """Send each paused tool call to Impri and save the run, or finish."""
    file = RUNS / f"{run_id}.json"
    if not result.interruptions:
        file.unlink(missing_ok=True)
        print(result.final_output)
        return
    actions = result.context_wrapper.context["impri"]
    for item in result.interruptions:
        args = json.loads(item.arguments or "{}")
        r = IMPRI.post("/v1/actions", json={
            "kind": "github.issue.create",
            "title": f"New issue in {args['repository']}: {args['title']}",
            "preview": {"format": "markdown", "body": args["body"]},
            "editable": ["preview.body"],
            "idempotency_key": item.call_id,  # a retry reuses the same card
            "expires_in": 24 * 3600,
        })
        r.raise_for_status()
        actions[item.call_id] = r.json()["id"]
    RUNS.mkdir(exist_ok=True)
    state = result.to_state()
    file.write_text(json.dumps({"state": state.to_string(), "actions": actions}))
    print(f"waiting for approval: {run_id}")


async def start(message: str) -> None:
    run_id = uuid.uuid4().hex
    result = await Runner.run(agent, message, context={"impri": {}})
    park_or_finish(run_id, result)


async def resume(run_id: str) -> None:
    saved = json.loads((RUNS / f"{run_id}.json").read_text())
    state = await RunState.from_string(agent, saved["state"])
    for item in state.get_interruptions():
        status = IMPRI.get(f"/v1/actions/{saved['actions'][item.call_id]}").json()["status"]
        if status == "pending":
            return  # nobody has decided yet: try again later
        if status == "approved":
            state.approve(item)
        elif status == "executed":  # it ran before a crash: never run it twice
            state.reject(item, rejection_message="Already opened. Do not open it again.")
        else:  # rejected, expired or execute_failed
            state.reject(item, rejection_message=(
                f"The issue was {status} in Impri. Do not open it again."))
    park_or_finish(run_id, await Runner.run(agent, state))


if __name__ == "__main__":
    command, arg = sys.argv[1], sys.argv[2]
    asyncio.run(start(arg) if command == "start" else resume(arg))
```

## How the pieces fit

**One card per call.** The `idempotency_key` is the SDK's `call_id`: if the process crashes after posting and retries, Impri returns the existing card instead of creating a second one.

**The run waits on disk.** The snapshot holds the conversation, the paused calls and the run context, a plain dict mapping each `call_id` to its Impri action id. The SDK serializes a dict context and restores it, so the tool finds its card in the new process.

**Each decision maps to the SDK.** `pending`: do nothing, try later. `approved`: `state.approve(item)`. `rejected` or `expired`: `state.reject(...)` with a message telling the model not to retry. Cards here expire after 24 hours (`expires_in` takes 300 seconds to 30 days). `executed` means the tool already ran but the process died before saving the run; rejecting with "Already opened" keeps it from running twice.

**Edits survive approval.** With `editable: ["preview.body"]` the reviewer can rewrite the issue body. The tool posts `decision.final_preview.body` from `GET /v1/actions/{id}`, not the model's draft, then reports `executed`. If the GitHub call fails, the card becomes `execute_failed` and the model gets the SDK's generic tool error; a retry is a new call and a new card. One gap remains: a crash between opening the issue and reporting it leaves the card `approved`, so the next `resume` opens it again. Make the GitHub call idempotent where duplicates hurt.

## What we verified

We ran the file in two processes, with the SDK's `ScriptedModel` (`agents.testing`) in place of the model and a stub for the GitHub call:

- two proposed issues paused the run and became two cards;
- `resume` before any decision changed nothing;
- approval with an edited body opened the issue with the edited text (card `executed`);
- a rejection reached the model as the rejection message, and nothing was opened;
- a failing GitHub call left the card `execute_failed`; a crash after the tool ran, then a second `resume`, did not open the issue twice.

## Keep the snapshot on your server

The SDK warns that `RunState.from_string` doesn't authenticate the snapshot, which holds approvals and pending tool calls. Never accept saved state from a browser or other client. Here the snapshot stays in your storage; only the decision comes from outside, read from Impri's API with your key.

## When a blocking gate in the tool is enough

If someone answers within minutes and the process stays up (a local CLI agent), the tool can post the card and poll `GET /v1/actions/{id}` itself. Shorter, but the run lives in memory and a restart or deploy loses it. Anything that waits longer needs pause and resume.

## Next step

Create a free project on [Impri Cloud](https://app.impri.dev/?signup=1), copy its API key into `IMPRI_API_KEY` and run `triage.py start`; the first card shows up in your inbox. Prefer your own server? Follow [self-hosting](self-hosting.md) and set `IMPRI_BASE_URL`. Building in TypeScript: the same flow with `needsApproval` is in [Human approval for OpenAI AgentKit](human-approval-for-openai-agentkit.md).
