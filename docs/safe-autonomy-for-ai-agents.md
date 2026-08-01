# Safe Autonomy: Let Agents Act, but Not Blindly

Full autonomy and full manual review are both wrong defaults for an ops agent — safe autonomy means letting it act freely on the low-risk 90% and gating the 10% that can actually break something.

---

## Autonomy is not binary

"Should this agent be autonomous?" is the wrong question, because it's asking about the agent instead of the action. An agent that restarts a crashed worker, clears a stale cache entry, and pushes to production are three different risk profiles wearing the same "the agent did it" label. Splitting by risk tier instead of by agent identity is what makes autonomy safe rather than reckless:

| Action | Blast radius if wrong | Autonomy level |
|---|---|---|
| Restart a single crashed worker process | Self-heals in seconds, no data loss | Fully autonomous |
| Clear a cache namespace | Slower responses for a few minutes | Fully autonomous |
| Scale a service up/down within preset bounds | Cost delta, reversible | Fully autonomous |
| Roll out a config change to production | Can break the service for all users | Gated |
| Run a database migration | Can be irreversible | Gated |
| Rotate or revoke a credential | Can lock out legitimate systems | Gated |

The bottom three rows are where an approval gate belongs. The top three don't need one — adding friction there just trains the on-call engineer to rubber-stamp everything, which defeats the point.

## Wrapping the risky calls, not the whole agent

The gate has to sit on the executor the agent actually calls, not on the agent's reasoning loop — otherwise a differently-phrased plan slips past it. Here's a minimal wrapper around a deploy tool in an ops agent built with the Claude Agent SDK, using Impri's MCP server so the agent handles the approval flow as tool calls:

```typescript
import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const deployToProduction = tool(
  "deploy_to_production",
  "Deploy a build to the production environment. Requires human approval.",
  { service: z.string(), version: z.string(), changelog: z.string() },
  async ({ service, version, changelog }) => {
    // The agent cannot reach runDeploy() directly — impri_push_action and
    // impri_await_decision are separate MCP tools the model must call first,
    // and this function is the only place runDeploy() is invoked.
    return {
      content: [{
        type: "text",
        text: `Ready to gate deploy of ${service}@${version} through Impri, ` +
              `then call runDeploy() only on approval.\n\nChangelog:\n${changelog}`,
      }],
    };
  }
);

const result = query({
  prompt: `Deploy checkout-service 2.4.1 after tests passed. Changelog: ${changelog}`,
  options: {
    mcpServers: {
      impri: { command: "npx", args: ["@impri/mcp"], env: { IMPRI_API_KEY: process.env.IMPRI_API_KEY! } },
    },
    allowedTools: ["deploy_to_production", "mcp__impri__impri_push_action",
                    "mcp__impri__impri_await_decision", "mcp__impri__impri_report_result"],
  },
});
```

In the agent's actual tool sequence, `impri_push_action` runs first with `kind: "deploy.production"` and the changelog as the preview body, then `impri_await_decision` blocks until an engineer approves or rejects from their phone, and only an `approved` result leads to the real `runDeploy()` call. The restart-a-worker and clear-a-cache tools from the table above stay ungated — they're just regular tool calls with no Impri step at all.

## What "blindly" looks like without a gate

Without this split, teams tend to land on one of two failure modes: either every agent action requires sign-off (so engineers stop reading the approval requests carefully, and the gate becomes theater), or every action is autonomous (so a bad deploy decision or a hallucinated migration ships before anyone notices). Tiering by blast radius, and only wrapping the executor for the gated tier, keeps the human's attention on the handful of decisions that actually warrant it.

## Boundaries

Impri decides nothing about risk tiers itself — that classification is a decision you make in your own tool definitions, same as the table above. It stores the proposed deploy, notifies whoever's on call, and holds their decision; it does not run the deploy, roll it back, or evaluate whether the changelog looks safe. And the gate only holds if `runDeploy()` genuinely has no other caller — see [integrations](integrations.md) for patterns on confining the credential to the wrapped tool. If you want per-service or per-environment rules about who gets notified, [rules](rules.md) covers routing; the [MCP doc](mcp.md) covers the server setup in more depth than the snippet above.

## Next step

The [TypeScript SDK](sdk-typescript.md) covers the REST calls directly if you'd rather not go through MCP. Either way, start with the [quickstart](quickstart.md) to provision a key.
