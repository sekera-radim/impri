# Human Approval in Multi-Agent Systems

When a pipeline of agents hands work from a researcher to a writer to a publisher, human approval belongs at the one step that produces a real-world side effect — not scattered across every hop.

---

## Where approval actually belongs in a pipeline

A common multi-agent shape: one agent researches a topic, hands its findings to a second agent that drafts content, which hands off to a third agent that publishes. It's tempting to add a "check with a human" step between every handoff. In practice that just slows the pipeline down without adding safety — the research-to-draft handoff and the draft-to-final handoff are internal state transitions. Nothing external happens until the publish step. That's the one that needs a gate.

Impri is not a multi-agent coordination layer — it won't route messages between your agents or manage the handoff logic. That's your orchestrator's job (LangGraph, a custom TypeScript pipeline, whatever you're running). What Impri does is sit at the one node in the graph where an agent is about to take an action a human hasn't seen yet.

```
Research agent ──▶ Writer agent ──▶ [Impri gate] ──▶ Publisher agent
     (internal)        (internal)      (human)           (external effect)
```

---

## Gating only the terminal node

Here's a three-agent pipeline in TypeScript where only the last hop — the one that actually publishes — talks to Impri:

```typescript
import { ImpriClient, ImpriRejected, ImpriExpired, ImpriTimeout } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function runPipeline(topic: string) {
  const findings = await researchAgent.run(topic);       // internal, no gate
  const draft = await writerAgent.run(findings);          // internal, no gate

  // Only the node with a real side effect talks to Impri
  const created = await impri.createAction({
    kind: "blog.publish",
    title: `Draft: ${draft.title}`,
    preview: { format: "markdown", body: draft.body },
    editable: ["preview.body"],
    expiresIn: 21600, // 6h — pipeline runs are usually reviewed same-day
  });

  try {
    const action = await impri.awaitDecision(created.id, { timeoutS: 3600 });
    const url = await publisherAgent.publish(action.decision!.finalPreview!.body);
    await impri.reportResult(created.id, "executed", { url });
  } catch (e) {
    if (e instanceof ImpriRejected || e instanceof ImpriExpired) {
      console.log("Pipeline stopped: human did not approve the publish step.");
    } else if (e instanceof ImpriTimeout) {
      console.log("Still pending — action remains open server-side.");
    } else {
      throw e;
    }
  }
}
```

The research and writer agents never import the Impri client at all — they don't need to know a gate exists downstream. That separation matters: if you later swap in a different writer agent, or add a fourth agent to the chain, none of that touches the approval logic, because the approval logic only lives at the publish boundary.

---

## Handling parallel agents feeding one gate

Some pipelines run several agents in parallel and merge their outputs into a single action — e.g. three research agents covering different angles, merged into one draft by a synthesis agent. Push exactly one action for the merged result, not one per contributing agent:

| Pattern | What to gate |
|---|---|
| Sequential pipeline (research → write → publish) | The final, external-effect step only |
| Fan-out / fan-in (parallel research → merge → publish) | The merged output, once, after synthesis |
| Multiple independent agents each publishing separately | One action per agent, each gated at its own publish step |

Gating every contributing agent individually multiplies review load for no safety benefit — the human needs to judge the merged result, not each input to it.

---

## Keeping the gate a real chokepoint

This only works as a genuine gate if the publisher agent has no other way to publish. If `publisherAgent.publish()` can be called directly by some other code path with the same credentials, an agent — or a bug, or an injected instruction picked up during research — can route around Impri entirely. Wrap the actual publish call so it only ever runs with an approved `final_preview`, the same pattern described in [the approval guide](how-to-add-human-approval-to-an-ai-agent.md). If your orchestrator is Claude Agent SDK-based, see [claude-agent-sdk](claude-agent-sdk.md) for wiring the gate into a tool definition rather than free-floating code.

---

## What Impri won't do for your pipeline

It won't manage retries between agents, won't decide which agent runs next, and won't detect that a "multi-agent system" is even involved — as far as Impri is concerned, one action came in from one API key. All the orchestration — LangGraph state, queue handoffs, error recovery between agents — stays in your pipeline code. Impri's job starts and ends at: store the action, notify a human, hold the decision until someone makes it.

---

## Next step

Read [integrations](integrations.md) for wrapping the executor tool in your framework, or [cookbook](cookbook.md) for other multi-step agent patterns.
