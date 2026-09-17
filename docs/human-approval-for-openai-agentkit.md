# Human Approval for OpenAI AgentKit Workflows

AgentKit's visual workflow builder makes it easy to chain tool calls into a working agent fast — which also makes it easy to ship one that emails, posts, or files something nobody reviewed.

---

## Where the gap is in a workflow graph

An AgentKit workflow is a graph of nodes: an agent node reasons over the input, tool-call nodes hit your connectors (Slack, a CRM, a ticketing system, an email API), and the output flows to the next node. That graph has no concept of "pause and ask a human" — a tool-call node either runs or it doesn't. If your workflow includes a node that sends a support reply, creates a refund, or posts to a public channel, the only way to add a checkpoint today is a **custom code node** sitting between "agent decided what to do" and "connector executes it."

That's a normal shape for a gate: an HTTP call out, a wait, an HTTP call back. Impri fills that role without you building a queue, a notification path, and a review UI yourself.

## Wiring the gate into a code node

Say the workflow drafts a reply to an inbound support ticket and the last node calls your helpdesk connector to send it. Replace that direct connector call with a code node that pushes the draft to Impri first, waits for a decision, then calls the connector only on approval:

```typescript
import { setTimeout as sleep } from "node:timers/promises";

interface AgentKitInput {
  ticketId: string;
  customerEmail: string;
  draftReply: string;
}

export default async function gateReply(input: AgentKitInput) {
  const push = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "ticket.reply",
      title: `Reply to ticket ${input.ticketId} (${input.customerEmail})`,
      preview: { format: "markdown", body: input.draftReply },
      editable: ["preview.body"],
      expires_in: 3600,
    }),
  });
  const { id } = await push.json();

  let decision;
  while (true) {
    const poll = await fetch(`https://api.impri.dev/v1/actions/${id}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    });
    decision = await poll.json();
    if (decision.status !== "pending") break;
    await sleep(5000);
  }

  if (decision.status !== "approved") {
    return { sent: false, status: decision.status };
  }

  // Hand control back to the workflow's helpdesk connector node with
  // the human-edited body — never the original draft.
  return { sent: true, body: decision.decision.final_preview.body };
}
```

The downstream connector node in AgentKit only fires when this code node returns `sent: true`. If the workflow's helpdesk credential lives exclusively inside that connector node — not also handed to the agent as a raw API key it could call directly — this is a genuine chokepoint, not a suggestion the model can talk itself past.

## What this buys you that a guardrail node doesn't

AgentKit's built-in guardrails are good at pattern-matching — blocking PII leakage, profanity, off-topic responses. They run inline, automatically, no human involved. That's a different job from approval: guardrails answer "is this content acceptable," Impri answers "did a specific person say yes to *this* action, right now." Use both. A guardrail can reject an obviously bad draft before it ever reaches the approval node, so your reviewer only sees drafts worth their time.

| Need | Tool |
|---|---|
| Block disallowed content automatically | AgentKit guardrails |
| Get a specific human's yes/no before an external side effect | Impri |
| Full audit trail of who approved what, when | Impri's [audit log](audit-log.md) |

## Being honest about the boundary

Impri does not know anything about your AgentKit graph, your connectors, or what "ticket.reply" means beyond the string you send it. It stores the proposed action, notifies whoever you've configured, and returns a decision. The workflow author is still responsible for making sure the code node is the *only* path to the connector — if the agent node also has direct access to the helpdesk API as a separate tool, it can route around the gate entirely.

For the underlying three-call pattern this code node implements, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). If your workflow already talks to other services over the [MCP](mcp.md) protocol, the [TypeScript SDK](sdk-typescript.md) wraps the same calls with retries and typed responses instead of raw `fetch`.

Next: [quickstart](quickstart.md) to get an API key and test a single action end to end before wiring it into a full graph.
