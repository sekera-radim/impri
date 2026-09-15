# Human-in-the-Loop for LangChain Deep Agents

Deep Agents pause on `interrupt_on` and wait for *any* resume value — pairing that pause with Impri turns it into a real approval, with a mobile inbox card, an editable draft, and a decision record.

---

## What `interrupt_on` actually gives you

LangChain's Deep Agents add a `HumanInTheLoopMiddleware` to the stack when you configure `interrupt_on` for a tool. When the agent calls that tool, the underlying LangGraph run suspends via `interrupt()`, checkpoints its state, and returns control to whoever is driving the graph. Nothing resumes it until your code calls `.invoke()` again with a `Command({ resume: ... })`.

That's a real pause. But `interrupt()` doesn't know who's supposed to supply the resume value, doesn't notify anyone, and doesn't keep a record of a decision — it's a suspended coroutine waiting for *your* code to hand back *something*. Whether that something came from a person who actually looked at the request is entirely on you to build. This is the same primitive LangGraph.js exposes directly, so the wiring below applies whether you're calling it from a Deep Agents `interrupt_on` tool or a hand-built LangGraph.js graph.

---

## Wiring Impri behind the pause

The tool that triggers the interrupt pushes an Impri action first, so the human sees a real inbox card instead of a raw graph state:

```typescript
import { interrupt } from "@langchain/langgraph";

async function updateCrmRecord(input: { dealId: string; fields: Record<string, string> }) {
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
    },
    body: JSON.stringify({
      kind: "crm.update",
      title: `Update deal ${input.dealId}: ${Object.keys(input.fields).join(", ")}`,
      preview: { format: "markdown", body: "```json\n" + JSON.stringify(input.fields, null, 2) + "\n```" },
      editable: ["preview.body"],
      expires_in: 3600,
    }),
  }).then((r) => r.json());

  // Suspends the graph here. Nothing after this line runs until something
  // resumes this thread with a Command.
  return interrupt({ impriActionId: res.id, inboxUrl: res.inbox_url });
}
```

A separate poller — not part of the graph — watches the Impri action and resumes the thread once it's decided:

```typescript
import { Command } from "@langchain/langgraph";

async function resumeWhenDecided(threadId: string, actionId: string, graph) {
  let decision;
  do {
    await new Promise((r) => setTimeout(r, 10_000));
    decision = await fetch(`https://api.impri.dev/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    }).then((r) => r.json());
  } while (decision.status === "pending");

  await graph.invoke(new Command({ resume: decision }), {
    configurable: { thread_id: threadId },
  });
}
```

The graph's resume value is now the actual Impri decision, not a stand-in. Downstream nodes can check `decision.status` and only proceed to the real CRM write on `"approved"`.

---

## Two things are paused, for two different reasons

While this is in flight, two independent systems are tracking the wait: LangGraph's checkpointer holds the graph's suspended state so `resumeWhenDecided` can pick the thread back up exactly where it left off, and Impri holds the pending action so a human has something to look at and decide on. Neither replaces the other. If your checkpointer is in-memory and the process restarts, you lose the ability to resume the *graph* — the Impri action is unaffected and still resolvable, but nothing will be listening for it until the poller comes back up.

---

## Editing structured fields, not just prose

Because `preview.body` here is a JSON blob rather than free text, editing still works the same way: set `editable: ["preview.body"]`, and a reviewer who spots a wrong field value can fix it in the inbox before approving. Parse it back out of `decision.final_preview.body` rather than the original `input.fields` — that's the version a human actually signed off on:

```typescript
const approvedFields = JSON.parse(decision.final_preview.body.replace(/```json\n|\n```/g, ""));
```

---

## What Impri isn't doing here

Impri doesn't understand LangGraph's state machine, doesn't call `resumeWhenDecided` for you, and doesn't replace the checkpointer. It stores one thing — the proposed CRM update and the eventual yes/no — and leaves the graph orchestration to LangGraph, same as it would with any other framework wrapped around it.

---

Next: [MCP](mcp.md) covers running this without hand-rolled HTTP calls if your agent runs inside an MCP client, and the [TypeScript SDK](sdk-typescript.md) wraps the push/poll pair used above.
