# Human-in-the-Loop Tools for LLM Agents, Compared

A practical comparison of the four categories of human-in-the-loop tooling for LLM agents — framework-native interrupts, workflow-engine nodes, general approval software, and dedicated gates — so you pick by category, not by name.

---

## The four categories

"HITL tool" gets used for four genuinely different things. Sorting a candidate into the right one answers most of the "does this fit my stack" question before you read a single doc page.

| Category | Example | Lives where | Built for |
|---|---|---|---|
| Framework-native interrupt | LangGraph `interrupt()`, OpenAI Agents SDK approval hooks | Inside your agent process | Pausing a graph/run mid-execution |
| Workflow-engine node | n8n Wait node, Temporal signals | Inside an orchestration platform | Pausing a broader multi-step workflow |
| General approval/ticketing software | Jira workflow, generic BPM tools | Separate app, not agent-aware | Human approval processes in general |
| Dedicated agent approval gate | Impri | Separate service, agent-aware | Agent proposes → human decides → agent executes |

---

## Framework-native interrupts

If you're building on LangGraph, CrewAI, the OpenAI Agents SDK, or a similar framework, there's often a built-in way to pause a run and wait for external input. LangGraph's `interrupt()` is the clearest example: it suspends graph execution at a node and resumes when you feed a value back in.

```typescript
// LangGraph-style interrupt, illustrative
import { interrupt } from "@langchain/langgraph";

async function sendEmailNode(state: AgentState) {
  const decision = interrupt({
    kind: "email.send",
    draft: state.draftBody,
  });
  // Execution resumes here once the graph is fed a decision externally
  if (decision.approved) {
    await sendEmail(decision.finalBody ?? state.draftBody);
  }
  return state;
}
```

This is the tightest integration you can get — no network hop, no separate service, the pause is a first-class part of the graph. The tradeoff is that the "waiting for a human" part is entirely up to you: something still has to notify a reviewer, render a card they can act on from their phone, and store the decision. The interrupt is the pause primitive, not the inbox, the notification, or the audit log around it. Teams often end up building (or bolting on) exactly the kind of gate described below, just triggered from inside the interrupt.

## Workflow-engine nodes

If the agent step is one node in a larger n8n or Temporal workflow, the engine's own human-input primitive is usually the right default — n8n's Wait node resumes on a webhook call; Temporal workflows can block on a signal sent by an external approval action. You avoid adding a new service, and the approval step shows up in the same execution history as the rest of the workflow.

The limitation shows up when the approval step needs to be agent-specific: a diff view of what a human edited before approving, a notion of "this draft expired, don't send it," a mobile-first card instead of a generic form. Workflow engines are general-purpose by design; they don't know that this particular wait step is "should this LLM-drafted email go out."

## General approval/ticketing software

Some teams route agent actions through whatever approval tooling already exists — a Jira workflow, a lightweight BPM tool. It avoids new infrastructure, but these systems have no concept of an agent polling for status, no `final_preview` carrying a human edit back to the exact text the agent should execute, and no expiry tuned to "this draft is now stale." Expect to write and maintain glue code, and expect it to break when the ticketing tool changes its API.

## Dedicated agent approval gates

The fourth category is software built specifically for the agent-proposes → human-decides → agent-executes loop and nothing else. Impri is in this category: an agent pushes a proposed action, a human approves, rejects, or edits it from an inbox (web, Slack, Telegram, Discord, or push notification), and the agent polls or blocks for the decision before doing anything.

```bash
# Push a proposed action from any agent, any framework
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -d '{
    "kind": "social.post",
    "title": "LinkedIn post: Q3 product update",
    "preview": { "format": "markdown", "body": "Excited to share..." },
    "editable": ["preview.body"],
    "expires_in": 14400
  }'
# → { "id": "act_...", "status": "pending", "inbox_url": "..." }
```

Because it's agent-agnostic — REST or MCP, no framework required — it composes with any of the other three categories rather than competing with them: trigger the push from inside a LangGraph `interrupt()`, or from an n8n node, and let Impri own the inbox, notification, human-edit, and audit-log surface instead of building that part yourself.

---

## Picking one

Start from where your agent already lives, not from a feature list:

- Already on LangGraph, CrewAI, or a framework with built-in interrupts? Use the interrupt to pause — see [human-in-the-loop for LangGraph agents](human-in-the-loop-langgraph.md) — and decide separately whether you need a real inbox behind it.
- Already orchestrating in n8n or Temporal? Use its wait/signal node as the pause point.
- Need the inbox, human-edit, and audit trail without building it, regardless of framework? That's what a dedicated gate is for — see the [minimal REST/MCP integration](how-to-add-human-approval-to-an-ai-agent.md).

None of these are mutually exclusive. Most real setups combine a framework-native pause with a dedicated gate behind it, because the pause and the inbox solve different halves of the problem.
