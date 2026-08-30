# Agentic AI Safety Patterns

Five patterns — sandboxing, least privilege, rate limits, audit trails, and human approval gates — that keep an autonomous agent's mistakes small instead of catastrophic.

---

Most teams building an agent that can touch production systems reach for one safety measure: a stricter prompt. That helps less than it seems like it should, because a prompt is advice the model can misread or be talked out of. The patterns below are structural instead — they hold even when the model's reasoning that day is wrong.

Running example throughout: a DevOps agent that watches a queue of infrastructure change requests and can run `terraform apply` against a real environment.

## Pattern 1 — Sandbox the blast radius first

Before anything else, decide what environment the agent is even allowed to touch. Give it credentials scoped to staging by default, and treat production access as a separate, explicitly granted capability — ideally one that requires the same approval gate described below rather than a standing credential.

```typescript
const terraformEnv = process.env.AGENT_TARGET_ENV; // "staging" by default, never inferred from the request
if (terraformEnv === "production" && !process.env.ALLOW_PROD_APPLY) {
  throw new Error("Production apply requires ALLOW_PROD_APPLY and an approved change");
}
```

This doesn't replace approval — it bounds the damage a misconfigured or compromised agent can do while an approval flow is being wired up.

## Pattern 2 — Least-privilege credentials, not one shared key

An agent that reads Terraform plans doesn't need a key that can also apply them. An agent that drafts an action doesn't need the scope that executes it. Split credentials by what the agent actually does, and prefer short-lived, narrowly scoped tokens over one admin key reused everywhere. If you're using Impri for the approval step itself, give the agent an `actions` scope key, not `admin` — a compromised agent process shouldn't be able to also manage your team's API keys.

## Pattern 3 — Rate limit the loop, not just the endpoint

Agents get stuck in loops in ways scripts rarely do — a misread error message can cause the same "fix" to be retried a hundred times. Rate limiting the outbound action (not just relying on the target API's own limits) turns a runaway loop into a throttled nuisance instead of a hundred applied changes. Impri's action endpoint is capped at 60 requests/minute per key for exactly this reason — an agent caught in a retry loop hits that ceiling before it hits anything expensive.

## Pattern 4 — A human approval gate on irreversible actions

This is the pattern that catches what the first three don't: a well-scoped, rate-limited agent that is still about to do the *wrong* thing. The gate has to be structural — the executor function must be unreachable except from the approved branch — not a prompt instruction asking the model to pause.

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function proposeApply(plan: string, changeSummary: string) {
  const action = await impri.actions.create({
    kind: "infra.terraform_apply",
    title: `Apply: ${changeSummary}`,
    preview: { format: "markdown", body: "```\n" + plan + "\n```" },
    undo: "Re-apply the previous known-good state file",
    idempotent: false,
    expires_in: 1800,
  });

  const decision = await impri.actions.awaitDecision(action.id, { timeoutS: 1800 });

  if (decision.status !== "approved") {
    return; // rejected or expired — runTerraformApply is never called
  }

  await runTerraformApply(plan); // the only call site for the real side effect
  await impri.actions.reportResult(action.id, { status: "executed" });
}
```

Only the code path after `decision.status === "approved"` can reach `runTerraformApply`. That's the difference between this and a Slack message that says "reply APPROVE to continue" — there, the agent is still the one deciding whether it heard a yes.

## Pattern 5 — Audit everything, especially near-misses

Every proposal, decision, and execution result should be logged somewhere a human can review later — not just the ones that got approved. A rejected action tells you the agent's judgment was off in a specific, reviewable way, which is exactly the signal you need to tighten Pattern 1 or 2 before it happens again with higher stakes.

## Putting the patterns together

| Pattern | Stops | Doesn't stop |
|---|---|---|
| Sandboxing | Blast radius of any single mistake | The agent proposing a bad action within its sandbox |
| Least privilege | Lateral misuse of one credential | A well-scoped agent still making a bad call |
| Rate limiting | Runaway loops, retry storms | A single deliberate bad action |
| Approval gate | Any specific bad action from executing | Bad actions from being *proposed* |
| Audit log | Nothing in real time — it's forensic | — |

None of these five is sufficient alone, and none of them requires the others to be worth doing. An approval gate on top of a shared admin key with no rate limit is still better than nothing, but it's leaving the other four patterns' protection on the table.

## Next step

For the full three-call approval flow (REST and MCP), see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). If your agent runs through the Claude Agent SDK specifically, [the Claude Agent SDK integration](claude-agent-sdk.md) shows the same pattern wired into that runtime, and the [TypeScript SDK reference](sdk-typescript.md) covers the client used above.
