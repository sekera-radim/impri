# Approve AI Agent Actions From Discord

Route your AI agent's pending actions straight into the Discord server your team already lives in, and approve or reject them with a single button click.

---

## Why Discord instead of a separate inbox

If your team runs a dev-ops or coding agent overnight — merging branches, triggering deploys, filing issues — the last place you want a decision to sit is an email you check once a day. Most dev teams already have Discord open all day in a `#ops` or `#deploys` channel. Impri's Discord integration puts the approve/reject decision exactly there: the agent proposes an action, a rich embed with **✅ Approve** / **❌ Reject** buttons shows up in the channel, and anyone with permission can decide without switching tools.

This is not a separate product — it's the same [approval gate](how-to-add-human-approval-to-an-ai-agent.md) Impri always runs, just delivered over a different notification channel.

## The flow

```
Agent               Impri                    Discord channel
  │                    │                            │
  ├─ POST /v1/actions ─▶ stores action, notifies ───▶ embed + buttons
  │                    │                            │
  │                    │◀── button click (Approve) ──┤
  │                    │   Ed25519-verified,          
  │                    │   custom_id HMAC-checked,     
  │                    │   clicker checked vs allow-list
  │                    │
  ├─ GET /v1/actions/:id (poll) ─▶ status: approved
  │
  ├─ execute with decision.final_preview
  └─ POST /v1/actions/:id/result
```

Discord delivers the button click as an interaction to Impri's endpoint. Impri verifies the request signature, checks the `custom_id` HMAC, and confirms the clicking user is on the channel's allow-list before it ever records a decision — a teammate cannot approve just by seeing the embed, they have to be an authorized reviewer.

## Setting up the channel

The Discord bot setup (invite the bot, get the channel ID, turn on `approval_mode`) is covered in full in [Discord Approval Bot](discord-approval.md). Once `approval_mode: true` is set for the channel, every action routed there gets buttons automatically — no per-action flag needed on the agent side.

## Wiring the agent

Here's a Node/TypeScript agent that watches a repo for stale PRs and asks a human to approve auto-merging them, using the Impri MCP server so the agent doesn't touch raw HTTP:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function proposeMerge(client: Client, pr: { number: number; title: string; diffSummary: string }) {
  const pushed = await client.callTool({
    name: "impri_push_action",
    arguments: {
      kind: "github.merge",
      title: `Auto-merge PR #${pr.number}: ${pr.title}`,
      preview: {
        format: "markdown",
        body: `**PR #${pr.number}** has been open 5 days with passing CI.\n\n${pr.diffSummary}`,
      },
      expires_in: 43200, // 12h — stale by tomorrow's standup otherwise
    },
  });

  const actionId = (pushed as { action_id: string }).action_id;

  const decision = await client.callTool({
    name: "impri_await_decision",
    arguments: { action_id: actionId, timeout_s: 39600 },
  });

  const { status } = decision as { status: string };
  if (status !== "approved") {
    console.log(`PR #${pr.number}: ${status}, skipping merge`);
    return;
  }

  await mergePullRequest(pr.number); // your GitHub API call
  await client.callTool({
    name: "impri_report_result",
    arguments: { action_id: actionId, status: "executed" },
  });
}
```

The agent code never mentions Discord — it just calls the three MCP tools. Which channel the notification lands on is configuration on the Impri side, set once when you wire up the Discord bot.

## What a reviewer sees and does

The embed shows the title, the markdown preview rendered inline, and an expiry countdown. A click on **Approve** or **Reject** updates the message in place (so there's no race between two people clicking at once — the first click wins, the embed updates to show who decided and when) and the agent's `impri_await_decision` call returns within its next poll cycle.

## Boundaries

Impri's Discord channel is a notification and decision-capture surface — it does not run your merge, does not inspect the diff for correctness, and does not replace CI. The actual gate is still the pattern from [the integration guide](how-to-add-human-approval-to-an-ai-agent.md): your agent's execution code must only run after `status: "approved"` comes back, and the wrapper around `mergePullRequest` needs to be the agent's only path to actually merging — otherwise a determined agent (or a bug) can route around the approval entirely.

## Next step

If you haven't set up an API key yet, start with the [quickstart](quickstart.md), then follow [Discord Approval Bot](discord-approval.md) to invite the bot and flip on `approval_mode` for your channel.
