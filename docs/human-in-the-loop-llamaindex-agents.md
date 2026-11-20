# LlamaIndex Human-in-the-Loop: Pause a Tool for Approval

LlamaIndex pauses a tool with ctx.wait_for_event until a HumanResponseEvent arrives. Open an Impri card there, save the run, and resume it after the decision.

---

## How LlamaIndex pauses a tool

A `FunctionAgent` tool that takes `ctx: Context` can stop in the middle and wait: `ctx.wait_for_event(HumanResponseEvent, waiter_event=InputRequiredEvent(...))` writes the `InputRequiredEvent` to the event stream, and the caller answers with `send_event(HumanResponseEvent(...))` ([LlamaIndex human in the loop](https://developers.llamaindex.ai/python/framework/understanding/agent/human_in_the_loop/)). Two lines in the [`wait_for_event` reference](https://developers.llamaindex.ai/python/workflows-api-reference/context/) shape everything below. The runtime "replays the entire step when the event arrives", so your tool runs again from its first line. And the default timeout is 2000 seconds, about 33 minutes.

A wiki correction or a refund can wait a day for its reviewer, so don't keep the process alive. Do what the [workflows docs](https://developers.llamaindex.ai/python/llamaagents/workflows/human_in_the_loop/) suggest: snapshot the run with `handler.ctx.to_dict()`, cancel it, and restore it with `Context.from_dict()` when the answer comes. Impri holds the question in between: the tool opens a card, a person approves, edits or rejects it in the inbox, and a second process resumes the run.

## The tool: one card per proposed change

The agent below fixes stale wiki pages. Retrieval stays ungated; only the write goes through Impri.

```python
import hashlib
import os

import httpx
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.workflow import Context, HumanResponseEvent, InputRequiredEvent
from llama_index.llms.openai import OpenAI

IMPRI = os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev")
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}


async def publish_to_wiki(page_id: str, body: str) -> int:
    raise NotImplementedError("your wiki client: write the page, return the revision")


async def propose_wiki_update(ctx: Context, page_id: str, new_body: str, reason: str) -> str:
    """Propose a corrected wiki page. Nothing changes until a human approves it."""
    # LlamaIndex replays this whole function when the wait ends, so the POST runs
    # twice. The idempotency key makes the second POST return the same card.
    key = "wiki:" + hashlib.sha256(f"{page_id}\n{new_body}".encode()).hexdigest()
    async with httpx.AsyncClient(base_url=IMPRI, headers=HEADERS, timeout=30) as impri:
        r = await impri.post("/v1/actions", json={
            "kind": "wiki.page.update",
            "title": f"Update wiki page {page_id}",
            "preview": {"format": "markdown", "body": new_body},
            "payload": {"page_id": page_id, "reason": reason},
            "editable": ["preview.body"],
            "expires_in": 3 * 24 * 3600,
            "idempotency_key": key,
        })
        r.raise_for_status()
        action_id = r.json()["id"]

        # Pause here. The event only wakes the tool; the verdict comes from Impri.
        await ctx.wait_for_event(
            HumanResponseEvent,
            waiter_id=action_id,
            waiter_event=InputRequiredEvent(prefix="Waiting for Impri", action_id=action_id),
            requirements={"action_id": action_id},
            timeout=None,
        )

        r = await impri.get(f"/v1/actions/{action_id}")
        r.raise_for_status()
        action = r.json()
        if action["status"] == "executed":
            return f"Already published ({action_id})."
        if action["status"] != "approved":
            return f"Not published: the reviewer's verdict is {action['status']}."

        body = action["decision"]["final_preview"]["body"]  # the reviewer's edit, if any
        revision = await publish_to_wiki(page_id, body)
        await impri.post(f"/v1/actions/{action_id}/result", json={
            "status": "executed",
            "payload": {"page_id": page_id, "revision": revision},
        })
        return f"Published revision {revision} of {page_id}."


agent = FunctionAgent(
    tools=[propose_wiki_update],  # next to your read-only QueryEngineTool
    llm=OpenAI(model="gpt-4.1"),
    allow_parallel_tool_calls=False,  # one card per turn: see "One card at a time"
    system_prompt=(
        "Answer from the wiki. If a page you retrieved is stale, call "
        "propose_wiki_update with the corrected page instead of only saying so."
    ),
)
```

What each part is for:

- **The idempotency key.** In our runs the POST went out three times per approval: once at the start, once when the restored run replayed the step to rebuild its waiter, once after the event. Impri returns the existing card for a known `idempotency_key` (200 instead of 201) whatever its status. Without the key, the replay after approval opened a second card and the run waited on that one.
- **The verdict comes from Impri, not from the event.** Whoever sends `HumanResponseEvent` only wakes the tool. `GET /v1/actions/:id` says whether the card was approved, and `decision.final_preview.body` holds the text the reviewer signed off on, including their edit (`editable: ["preview.body"]`).
- **`timeout=None`.** With the default, an in-process wait gives up after 2000 seconds and the model gets the tool error "Timed out waiting for HumanResponseEvent" while the card stays pending in the inbox. The card's own expiry (`expires_in`, here 3 days, at most 30) is the deadline that counts.
- **The result report.** `POST /v1/actions/:id/result` with `executed` and a `payload` puts the revision on the card as `result_payload`, so the reviewer sees what was written.

## Save the run, resume after the decision

```python
import asyncio
import json
import sys
from pathlib import Path

import httpx
from llama_index.core.llms import ChatMessage
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.workflow import Context, HumanResponseEvent, InputRequiredEvent

from wiki_agent import HEADERS, IMPRI, agent

RUNS = Path("runs")
RUNS.mkdir(exist_ok=True)


async def start(question: str) -> None:
    handler = agent.run(user_msg=question)
    async for ev in handler.stream_events():
        if isinstance(ev, InputRequiredEvent):
            # Save the paused run under the card's id and let the process exit.
            # to_dict() skips the chat memory, so its messages are saved next to it.
            memory = await handler.ctx.store.get("memory")
            messages = [m.model_dump(mode="json") for m in await memory.aget_all()]
            snapshot = {"ctx": handler.ctx.to_dict(), "messages": messages}
            (RUNS / f"{ev.action_id}.json").write_text(json.dumps(snapshot))
            await handler.cancel_run()
            print(f"waiting for approval: {ev.action_id}")
            return
    print(await handler)


async def resume_decided() -> None:
    async with httpx.AsyncClient(base_url=IMPRI, headers=HEADERS, timeout=30) as impri:
        for saved in RUNS.glob("*.json"):
            action_id = saved.stem
            r = await impri.get(f"/v1/actions/{action_id}")
            r.raise_for_status()
            status = r.json()["status"]
            if status == "pending":
                continue
            snapshot = json.loads(saved.read_text())
            ctx = Context.from_dict(agent, snapshot["ctx"])
            history = [ChatMessage.model_validate(m) for m in snapshot["messages"]]
            handler = agent.run(ctx=ctx)
            await handler.ctx.store.set(
                "memory", ChatMemoryBuffer.from_defaults(chat_history=history, llm=agent.llm))
            await handler.send_event(HumanResponseEvent(response=status, action_id=action_id))
            print(await handler)
            saved.unlink()


if __name__ == "__main__":
    if sys.argv[1] == "start":
        asyncio.run(start(sys.argv[2]))
    else:
        asyncio.run(resume_decided())
```

`python run.py start "Is the on-call doc still accurate?"` prints `waiting for approval: act_…` and exits. Run `python run.py resume` from cron every minute, or from your webhook handler: set `callback_url` on the card and Impri posts a signed request when it is decided or expires (see [webhooks](webhooks.md) for the `X-Impri-Signature` check). A run whose card is still pending is left alone; an expired or rejected one resumes and the tool reports that nothing was published.

**The memory step is not optional.** On llama-index-core 0.14.26 with llama-index-workflows 2.26.1, `to_dict()` skips the agent's chat memory with an `UnserializableKeyWarning`. Resumed without it, as in the documented pattern, the run crashed with `ValueError: Path 'memory' not found in state`, after the tool had already published and marked the card `executed`. `ChatMemoryBuffer.to_dict()` failed on its messages too, so the runner saves the messages with `model_dump(mode="json")`. It sets the memory on `handler.ctx.store` after `run(ctx=...)`: set on the restored context before `run()`, it was lost.

## What we ran

Both files verbatim, each start and each resume a separate Python process, against a local Impri server. The OpenAI model was swapped for LlamaIndex's `MockFunctionCallingLLM` with a scripted tool call, and `publish_to_wiki` for a stub that records its input.

| Scenario | Wiki | The model gets | Card |
|---|---|---|---|
| Approved with an edit, then resumed | the edited text, once | "Published revision 42 of oncall." | `executed`, revision in `result_payload` |
| Rejected, then resumed | nothing | "Not published: the reviewer's verdict is rejected." | `rejected` |
| Resume while the card is pending | nothing, snapshot kept | (run not resumed) | `pending` |
| Same snapshot resumed a second time | nothing | "Already published (act_…)." | `executed` |
| No `idempotency_key` | nothing, the run waits on a second card | nothing yet | a new `pending` card |
| In-process wait, timeout reached | nothing | "Timed out waiting for HumanResponseEvent" | stays `pending` |
| Resumed without the memory step | published | the run crashes | `executed` |
| Two proposals in one model turn | the first one | for the second: "Not published: the reviewer's verdict is pending." | second card left `pending` |

## One card at a time

The last row is why the agent sets `allow_parallel_tool_calls=False`. When the model proposed two pages in one turn, both cards opened before the runner saw the first `InputRequiredEvent`, and the snapshot was filed under one of them. On resume, the one event we sent for the first card also released the second waiting call. Because the tool reads its verdict from Impri, it published nothing, but its card stayed in the inbox with no run behind it. With the flag, `llama_index.llms.openai` sends `parallel_tool_calls: false`, which asks the model for one tool call per turn. Our scripted model ignores that flag, so we checked the request code, not a live model.

## What Impri does here

Impri stores the card, notifies your reviewers, keeps their edit and decision, and records the result. It never reads or writes your wiki: `publish_to_wiki` is your code and runs only after the tool has read `approved` from Impri. An agent key needs only the `actions` scope. Replayed POSTs pass the same checks as new cards: they count toward the 60 requests per minute per key, and on Impri Cloud, once a project has used its plan's monthly approvals, they get a 402, which the tool raises as an error instead of publishing.

## Next step

[Start free on Impri Cloud](https://app.impri.dev/?signup=1), create an API key, put a harmless `publish_to_wiki` in place and run `start`: the card appears in your inbox. To keep everything on your machine, follow [Self-hosting](self-hosting.md) and set `IMPRI_BASE_URL=http://localhost:8484`. On LangGraph instead? The same pattern with `interrupt()` is in [Human-in-the-loop for LangGraph](human-in-the-loop-langgraph.md).
