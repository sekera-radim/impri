# Human-in-the-Loop for LangChain Deep Agents

Deep Agents pause a tool call with `interruptOn` and resume on approve, edit or reject decisions. Impri turns each pause into an inbox card a person decides on.

---

## What `interruptOn` gives you

`createDeepAgent` adds LangChain's human-in-the-loop middleware when you pass `interruptOn` (`interrupt_on` in the Python package). When the model proposes a call to a listed tool, the run stops **before the tool executes**, saves its state to the checkpointer and returns `__interrupt__`. Each interrupt's `value` holds `actionRequests` (tool name and arguments, one per paused call) and `reviewConfigs` (the decisions allowed for each).

The run continues only when you invoke the agent again on the same `thread_id` with `new Command({ resume: { decisions } })`: one decision per action request, in the same order.

- `{ type: "approve" }` runs the call as proposed.
- `{ type: "edit", editedAction: { name, args } }` runs it with different arguments.
- `{ type: "reject", message }` skips it and gives the model your message as the tool result.

The resume value is not free-form: the middleware throws when `decisions` is missing or when their count differs from the number of paused calls.

What the pause doesn't do is tell anyone. Nobody is notified, nobody sees the arguments, and no record says who decided. That part is yours, and it belongs in the code that drives the agent, not in the tool.

## Don't push the approval request from inside the tool

A tempting shortcut is a tool that posts the request somewhere and then calls LangGraph's `interrupt()` itself. On resume, LangGraph runs the interrupted node again from the top, so everything before `interrupt()` happens twice (we counted it: two runs of the node body for one pause). That means a second approval card for every decision. With `interruptOn` the pause comes before the tool runs, and the tool body runs once, after the verdict.

## The agent

```typescript
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";

const updateCrmRecord = tool(
  async ({ dealId, fields }) => crm.updateDeal(dealId, fields), // your real write
  {
    name: "update_crm_record",
    description: "Update fields on a CRM deal",
    schema: z.object({ dealId: z.string(), fields: z.record(z.string(), z.string()) }),
  },
);

const agent = createDeepAgent({
  tools: [updateCrmRecord],
  interruptOn: { update_crm_record: { allowedDecisions: ["approve", "edit", "reject"] } },
  checkpointer: new MemorySaver(), // use a persistent checkpointer in production
});
```

## The bridge: one Impri card per paused call

```typescript
import type { ActionRequest, Decision } from "langchain";

const IMPRI = `${process.env.IMPRI_BASE_URL ?? "https://api.impri.dev"}/v1`;

async function impri(path: string, body?: unknown) {
  const res = await fetch(`${IMPRI}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Impri ${res.status}: ${await res.text()}`);
  return res.json();
}

const fence = (args: unknown) => "```json\n" + JSON.stringify(args, null, 2) + "\n```";

async function askHuman(req: ActionRequest, key: string): Promise<Decision> {
  const card = await impri("/actions", {
    kind: `deepagent.${req.name}`,
    title: `Agent wants to run ${req.name}`,
    preview: { format: "markdown", body: fence(req.args) },
    editable: ["preview.body"],
    expires_in: 3600,
    idempotency_key: key, // a restarted driver gets the same card back
  });

  // The verdict lives on GET /v1/actions/:id, under `decision`.
  let action = await impri(`/actions/${card.id}`);
  while (action.status === "pending") {
    await new Promise((r) => setTimeout(r, 10_000));
    action = await impri(`/actions/${card.id}`);
  }
  if (action.status !== "approved") {
    return { type: "reject", message: `A reviewer did not approve this call (${action.status}). Do not retry it.` };
  }

  // The reviewer may have edited the JSON before approving.
  const body: string = action.decision.final_preview.body;
  let args;
  try {
    args = JSON.parse(body.replace(/^```json\n|\n```$/g, ""));
  } catch {
    return { type: "reject", message: "The approved edit was not valid JSON. Ask for the call again." };
  }
  return body === fence(req.args) ? { type: "approve" } : { type: "edit", editedAction: { name: req.name, args } };
}
```

The driver invokes the agent, answers every pause, and resumes:

```typescript
import { Command } from "@langchain/langgraph";
import type { HITLRequest } from "langchain";

const config = { configurable: { thread_id: "deal-42" } };
let result = await agent.invoke({ messages: [{ role: "user", content: "Mark deal 42 as closed-won" }] }, config);

while (result.__interrupt__?.length) {
  const resume: Record<string, { decisions: Decision[] }> = {};
  for (const pause of result.__interrupt__) {
    const decisions = [];
    const { actionRequests } = pause.value as HITLRequest;
    for (const [i, req] of actionRequests.entries()) {
      decisions.push(await askHuman(req, `${config.configurable.thread_id}:${pause.id}:${i}`));
    }
    resume[pause.id] = { decisions };
  }
  result = await agent.invoke(new Command({ resume }), config);
}
```

Three details carry the weight:

- **The resume is keyed by interrupt id.** One invoke can come back with more than one interrupt (subagents that run in parallel, for example), and a map of interrupt id → decisions answers each of them.
- **The idempotency key is the thread, the pause and the position.** If the driver restarts while a card is pending, Impri returns the existing action for that key instead of creating a second card.
- **The edit is read back from what the reviewer approved.** `GET /v1/actions/:id` returns the verdict under `decision`, and `decision.final_preview.body` is the text the person approved. The tool runs with those arguments.

## What we ran

With deepagents 1.17.0, langchain 1.6.6 and @langchain/langgraph 1.7.5, a scripted model and a local Impri server, we ran this code end to end. An approval with an edited amount ran the tool once, with the edited value. A rejection never ran the tool, and the model received the rejection message. Pushing the same pause twice returned the same card.

## What Impri doesn't do here

Impri doesn't resume the graph or hold its state. The checkpointer holds the paused thread, and your driver resumes it. With `MemorySaver`, a restart loses the paused thread while its Impri card stays decidable, so production needs a persistent checkpointer. Polling every 10 seconds is the simple version; an Impri [webhook](webhooks.md) can wake the driver instead. After the tool runs, `POST /v1/actions/:id/result` with `executed` or `execute_failed` puts the outcome next to the decision in the audit log.

## Next step

[Create a free Impri Cloud account](https://app.impri.dev/?signup=1), put its API key in `IMPRI_API_KEY` and run the driver: the first paused call shows up as a card in the inbox and on your phone. Prefer your own infrastructure? [Self-host Impri](self-hosting.md) and point `IMPRI_BASE_URL` at it. For the same pause in a hand-built graph, see [human-in-the-loop for LangGraph](human-in-the-loop-langgraph.md).
