# Human-in-the-Loop Checkpoints in LangGraph

LangGraph's `interrupt()` pauses a graph mid-run and persists its state — pair it with Impri and approval no longer needs a process sitting idle waiting.

---

## The difference from a polling tool

The common human-in-the-loop pattern — the one used by most [framework integrations](integrations.md) — has a tool push an action to Impri, then sit in a loop calling `GET /v1/actions/:id` every few seconds until the status changes. That works, but it ties up a process (and a thread, and a container) for however long the approval takes, which can be minutes or a day.

LangGraph has a different primitive for this: `interrupt()`. Called inside a node, it pauses graph execution at that exact point and — because the graph is compiled with a checkpointer — persists everything needed to resume later. The invoking process can return, exit, redeploy. Nothing is blocked. Resuming is a separate call, `graph.invoke(new Command({ resume: value }), config)`, made whenever the decision is actually ready, keyed by the same `thread_id`.

That maps cleanly onto Impri: push the action, call `interrupt()` with its id, and let something external — a cron job, a webhook handler — resume the graph once Impri reports a decision.

---

## Building the graph

A support-ticket agent that can issue refunds, with the refund node gated:

```typescript
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";

const IMPRI_BASE = "https://api.impri.dev";
const IMPRI_API_KEY = process.env.IMPRI_API_KEY!;

const State = Annotation.Root({
  ticketId: Annotation<string>(),
  customer: Annotation<string>(),
  refundCents: Annotation<number>(),
  actionId: Annotation<string | undefined>(),
  approved: Annotation<boolean>(),
});

async function proposeRefund(state: typeof State.State) {
  const res = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IMPRI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "refund.issue",
      title: `Refund $${(state.refundCents / 100).toFixed(2)} to ${state.customer}`,
      preview: {
        format: "markdown",
        body: `Ticket **${state.ticketId}** — refund **$${(state.refundCents / 100).toFixed(2)}** to ${state.customer}.\n\nReason: card charged twice by a retry bug.`,
      },
      editable: ["preview.body"], // reviewer can amend the reason, not the amount
      expires_in: 86400,
    }),
  });
  const action = await res.json();

  // Pauses here. The checkpointer saves this point — nothing stays blocked.
  const decision = interrupt({ actionId: action.id });
  return { actionId: action.id, approved: decision.approved };
}

async function issueRefund(state: typeof State.State) {
  if (!state.approved) return {};
  await refundProvider.issue(state.customer, state.refundCents); // your payment call
  return {};
}

const graph = new StateGraph(State)
  .addNode("proposeRefund", proposeRefund)
  .addNode("issueRefund", issueRefund)
  .addEdge(START, "proposeRefund")
  .addEdge("proposeRefund", "issueRefund")
  .addEdge("issueRefund", END)
  .compile({ checkpointer: new MemorySaver() });
```

The refund amount is deliberately not editable — `editable` only rewrites `preview.body`, which is markdown text, not a structured field. Making the dollar figure editable would mean parsing it back out of prose, which is fragile. Let reviewers edit the reason; keep the amount as a fixed value the agent already computed.

---

## The resume side: a decision poller

Something still has to notice when Impri's status changes and call back into the graph. It does not need to be the process that started the run:

```typescript
async function pollAndResume(threadId: string, actionId: string) {
  const res = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, {
    headers: { Authorization: `Bearer ${IMPRI_API_KEY}` },
  });
  const result = await res.json();
  if (result.status === "pending") return false;

  const config = { configurable: { thread_id: threadId } };
  await graph.invoke(
    new Command({ resume: { approved: result.status === "approved" } }),
    config,
  );
  return true;
}

// Run on a schedule per open action — or trigger it from a webhook
// instead of polling; see the webhooks doc.
setInterval(() => pollAndResume("ticket-482", "act_abc123"), 10_000);
```

`result.status` of `expired` resolves the same as `rejected` here — `approved` is `false`, `issueRefund` short-circuits, and the graph reaches `END` without ever calling the payment provider.

---

## Durability matters more than it looks

`MemorySaver` is in-process and disappears on restart — fine for the example above, not for a refund approval that might sit open overnight. Swap it for one of LangGraph's persistent checkpointers (Postgres, SQLite) before this touches real money, so the paused state survives a deploy between the push and the decision.

---

## What Impri is and isn't doing here

Impri stores the proposed refund, notifies a human, and holds the decision — nothing more. It does not know what LangGraph is, does not call `resume` for you, and does not decide whether $40 is a reasonable refund for this ticket. The gate is only real if `issueRefund` is the sole path to `refundProvider.issue` — if another node, or another agent, can call that function directly, this checkpoint is decorative.

---

## Next step

- [Quickstart](quickstart.md) — get an API key and push your first action
- [TypeScript SDK](sdk-typescript.md) — a typed client instead of raw `fetch` calls
- [Webhooks](webhooks.md) — trigger the resume the moment a decision lands, instead of polling on an interval
