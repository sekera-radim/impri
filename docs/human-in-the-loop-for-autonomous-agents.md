# Human-in-the-Loop for Autonomous AI Agents

Autonomous agents plan and chain tool calls on their own — human-in-the-loop for autonomous AI agents means picking which of those calls actually need a person to say yes.

An agent that plans its own next step, calls tools in a loop, and decides when it's done is exactly the kind of system where "just review everything" doesn't scale — it might make forty tool calls to answer one question. The useful pattern isn't gating every step; it's gating the handful of steps that have a real-world side effect, and letting the rest run freely.

---

## Autonomy is fine, unreviewed side effects are not

Think about what an autonomous research-and-outreach agent actually does end to end: search the web, read pages, summarize findings, draft a message, send the message. The first three steps are read-only and reversible — nothing bad happens if the agent's search query is a little off. The last step is not: once an email is sent, it's sent. The gate belongs on step four, not on the whole loop.

That's the core design decision for this pattern: classify each tool the agent can call as *free* (read-only, internal, reversible) or *privileged* (external side effect), and only wrap the privileged ones.

## Wrapping privileged tools in the agent's tool loop

```typescript
type Tool = (args: Record<string, unknown>) => Promise<unknown>;

const IMPRI_API = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

function requireApproval(kind: string, title: string, toPreview: (args: any) => string, execute: Tool): Tool {
  return async (args) => {
    const create = await fetch(`${IMPRI_API}/v1/actions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind,
        title,
        preview: { format: "markdown", body: toPreview(args) },
        editable: ["preview.body"],
        expires_in: 3600,
      }),
    }).then((r) => r.json());

    let decision;
    do {
      await new Promise((r) => setTimeout(r, 5000));
      decision = await fetch(`${IMPRI_API}/v1/actions/${create.id}`, { headers: HEADERS }).then((r) => r.json());
    } while (decision.status === "pending");

    if (decision.status !== "approved") {
      return { skipped: true, reason: decision.status };
    }
    return execute({ ...args, body: decision.decision.final_preview.body });
  };
}

// Only the side-effecting tool gets wrapped — search and summarize stay free.
const tools: Record<string, Tool> = {
  web_search: async (args) => searchWeb(args.query as string),
  summarize: async (args) => summarizeText(args.text as string),
  send_outreach_email: requireApproval(
    "email.send",
    "Autonomous agent: outreach email draft",
    (args) => args.body as string,
    async (args) => sendEmail(args.to as string, args.body as string)
  ),
};
```

The agent's planning loop calls `tools[toolName](args)` the same way for every tool — it doesn't need special-case logic for "this one needs approval." The gate is invisible to the planner and unavoidable for the executor, which is what keeps a plan-and-act loop from talking itself past the check.

---

## Why "ask the model to pause" isn't the gate

An autonomous agent's plan is generated text — you can prompt it to "pause before sending emails," and most of the time it will. But the plan is not the execution path. If the model skips the instruction, misreads the situation, or a later planning step overwrites the earlier one, nothing stops `send_outreach_email` from running. Wrapping the tool itself, as above, removes that dependency: the underlying `sendEmail` function is only reachable through `requireApproval`, regardless of what the plan says.

This matters more for autonomous agents than for simple request/response ones, because autonomous loops run many steps unsupervised between the start of a task and its conclusion — there's more surface for the plan to drift from what a human actually intended.

---

## Choosing what counts as privileged

| Tool call | Free or privileged? |
|---|---|
| Web search, page read | Free — no side effect |
| Draft generation, summarization | Free — output stays internal |
| Send email, post message, publish content | Privileged — externally visible |
| Write to a production database | Privileged — hard to undo |
| Call a paid third-party API (SMS, ads spend) | Privileged — costs money |

If you're unsure whether a tool belongs in the privileged column, ask whether a bad call would be visible to someone outside your system, or cost money, before anyone notices. If yes, wrap it.

---

## Boundaries worth stating plainly

Impri holds the decision and notifies a human — it doesn't plan the agent's steps, decide which tools are privileged, or interpret whether a given draft is good. That classification work above is yours to do once, per tool, when you build the agent. Impri also isn't a multi-agent coordination layer: if your "autonomous agent" is actually several agents handing off work to each other, the approval gate still only covers the specific tool call it wraps, not the handoff logic between agents.

For the full three-call pattern this wrapper is built on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For a broader look at building the loop itself with review checkpoints baked in from the start, see [how to build a human-in-the-loop AI agent](how-to-build-a-human-in-the-loop-ai-agent.md). If your agent is built on LangGraph specifically, [human-in-the-loop for LangGraph](human-in-the-loop-langgraph.md) covers the framework-specific checkpoint API.
