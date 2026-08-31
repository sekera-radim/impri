# Human-in-the-Loop, Explained for AI Builders

Human-in-the-loop for AI builders means deciding, up front, which of your agent's actions are allowed to run on their own and which must wait for a person to say yes.

---

## Why "just ask the model to check" doesn't count

The fastest thing to try is a system prompt line: "before doing anything destructive, ask the user for confirmation." It's also the thing that fails silently. The model has no mechanism forcing it to comply — it's a suggestion in a context window, not a control. A long enough conversation, a cleverly worded tool result, or a model that just misjudges the situation, and the "confirmation" step gets skipped. There's also nothing to audit afterward: no record of what was proposed, what was approved, or who approved it.

Human-in-the-loop, as an engineering pattern rather than a prompting trick, means the confirmation happens outside the model — as a real state your code checks — so skipping it isn't something the model is capable of doing.

---

## The spectrum of autonomy

Most teams don't pick one extreme. They place each *kind* of action somewhere on a spectrum:

| Autonomy level | What happens | Example action |
|---|---|---|
| Full autonomy | Agent acts immediately, no review | Read-only lookups, internal logging |
| Notify-only | Agent acts, human is told afterward | Posting a low-stakes internal Slack update |
| Block-until-approved | Agent proposes, waits, only acts on approval | Sending a customer email, deploying code, issuing a refund |
| Fully manual | A human does the action; the agent only drafts | Legal filings, anything with no undo |

The interesting design work isn't "should this agent have human-in-the-loop" as a yes/no — it's sorting your agent's individual tool calls into these buckets. A support agent might autonomously look up an order (full autonomy) but need approval before refunding it (block-until-approved).

---

## Where the block actually happens

For the "block-until-approved" tier, the mechanism is the same three-step shape regardless of framework: propose an action to a store outside the agent's process, wait for a decision, execute only on approval. Impri implements that store — see [the propose, approve, execute pattern](the-propose-approve-execute-pattern.md) for the general shape before looking at a specific integration.

## A deploy-agent example

Consider an agent with a tool that can run `terraform apply` or trigger a deploy. That's a textbook block-until-approved action — cheap to propose, expensive to get wrong. Wired through the [MCP server](mcp.md), the tool-calling side looks like this in an MCP client such as Claude Code:

```typescript
// deploy-tool.ts — the wrapper the agent actually calls
import { spawnSync } from "node:child_process";

interface DeployRequest {
  actionId: string;
  targetEnv: "staging" | "production";
  planSummary: string;
}

async function requestDeployApproval(req: Omit<DeployRequest, "actionId">) {
  // impri_push_action is exposed by the @impri/mcp server the agent has configured
  const pushed = await mcp.call("impri_push_action", {
    kind: "infra.deploy",
    title: `Deploy to ${req.targetEnv}: ${req.planSummary}`,
    preview: { format: "markdown", body: req.planSummary },
    expires_in: 3600,
  });

  const decision = await mcp.call("impri_await_decision", {
    action_id: pushed.action_id,
    timeout_s: 1800,
  });

  if (decision.status !== "approved") {
    return { ran: false, reason: decision.status };
  }

  const result = spawnSync("terraform", ["apply", "-auto-approve"], { encoding: "utf8" });
  await mcp.call("impri_report_result", {
    action_id: pushed.action_id,
    status: result.status === 0 ? "executed" : "execute_failed",
  });
  return { ran: true, exitCode: result.status };
}
```

`spawnSync("terraform", ...)` sits behind the `if (decision.status !== "approved") return` line — a rejected or expired review means that line is never reached in this process's lifetime. That's the entire mechanism; there's no separate "safety layer" to bypass because there's no other code path that calls `terraform apply`.

---

## Choosing where to put the gate

A gate is only real if the wrapped call is the agent's *only* route to the side effect. If the agent also holds a raw cloud credential it could use directly, wrapping one tool with `impri_push_action` doesn't stop it from going around your gate through a different one. Put the approval wrapper at the boundary the agent cannot bypass — ideally the same function that holds the API key or shell access — not at a layer the agent could choose to skip.

---

## Common mistakes

- **Gating everything.** If low-risk, reversible actions also wait on a human, the queue backs up and people start rubber-stamping without reading — which defeats the point.
- **Treating "expired" as "still fine to run."** A three-day-old draft reply is often no longer relevant. Treat expiry the same as rejection: don't execute, and re-propose if the task still matters.
- **Putting the check in the prompt instead of the code.** Covered above, worth repeating: if the model can talk its way past the check, it isn't a gate.

For the concrete REST and MCP call sequence, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For getting a key and running the first call, start at [quickstart](quickstart.md).
