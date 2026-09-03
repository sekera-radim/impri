# What Is an MCP Approval Server?

An MCP approval server is a Model Context Protocol server whose tools don't perform actions themselves — they ask a human first, then hand back the decision for your agent to act on.

---

## MCP tools normally just... run

The Model Context Protocol lets an agent runtime (Claude Code, Claude Desktop, Cursor) call tools exposed by a server: read a file, query a database, hit an API. When the model decides to call a tool, the server executes it and returns the result. There's no pause built into the protocol itself — if the tool is `send_email`, the email goes out the moment the model calls it.

That's fine for read-only tools. It's a problem for tools with real-world side effects: sending messages, pushing code, spending money, deleting data. An **MCP approval server** is a specific pattern for that case — instead of exposing `send_email` directly, it exposes tools like `impri_push_action`, `impri_await_decision`, and `impri_report_result` that split "propose" from "execute" and put a human decision in between.

---

## The three tools, and what each one actually does

```
impri_push_action(kind, title, preview, expires_in, editable)
  → creates a pending action, notifies a human, returns { action_id }

impri_await_decision(action_id, timeout_s)
  → blocks (polling every 5s internally) until a human decides
  → returns { status: "approved" | "rejected" | "expired", preview, edited_by_human }

impri_report_result(action_id, status)
  → status: "executed" | "execute_failed"
  → closes the loop so the audit trail shows what actually happened
```

Crucially, none of these three tools performs the underlying action. `impri_push_action` doesn't send anything — it stores a proposal. The agent (or the code wrapping the agent) is still the one that calls the real `send_email` or `git push`, and it only does so after `impri_await_decision` returns `"approved"`. The approval server's job ends at the decision; execution is always the caller's responsibility.

---

## Example: gating a coding agent's git push

Say you're running an autonomous coding agent via the [Claude Agent SDK](claude-agent-sdk.md) that can commit and push to a repo. You don't want it pushing to `main` unattended. Wrap the push tool so the approval server's tools sit in front of it:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execSync } from "node:child_process";

async function gatedPush(mcp: Client, branch: string, commitLog: string) {
  const pushAction = await mcp.callTool({
    name: "impri_push_action",
    arguments: {
      kind: "git.push",
      title: `Push ${branch} to origin`,
      preview: { format: "diff", body: commitLog },
      expires_in: 1800, // 30 minutes — a stale push isn't worth approving
    },
  });

  const { action_id } = JSON.parse(pushAction.content[0].text);

  const decision = await mcp.callTool({
    name: "impri_await_decision",
    arguments: { action_id, timeout_s: 900 },
  });

  const { status } = JSON.parse(decision.content[0].text);

  if (status !== "approved") {
    console.log(`Push blocked: ${status}`);
    return;
  }

  execSync(`git push origin ${branch}`, { stdio: "inherit" });

  await mcp.callTool({
    name: "impri_report_result",
    arguments: { action_id, status: "executed" },
  });
}
```

The reviewer sees the commit log as a diff-formatted preview in their [inbox](inbox.md) — on their phone, if they've set up [Telegram or Slack approvals](telegram-approval.md) — and approves or rejects without touching a terminal. The agent's `execSync` line only runs after `status === "approved"` comes back from the protocol call, not from anything the model decided on its own.

---

## Where the real gate is — and where it isn't

This is the part worth being precise about. The approval server gates what *goes through it*. In the example above, the agent still has a shell and could technically run `git push` directly, bypassing the wrapper entirely, if nothing stops it. The MCP approval tools are not a network firewall or a sandbox — they're an API contract that your integration code chooses to honor.

The gate is only real when the wrapped path is the agent's *only* route to the side effect: no raw API key in the agent's environment for the thing being gated, no unrestricted shell next to a "please ask first" instruction in the system prompt. Design the surrounding harness — restricted tool permissions, no direct credentials — so `gatedPush` above is genuinely the only way code reaches `origin`.

---

## Setting one up

Point any MCP-compatible client at the Impri MCP server — see [the MCP reference](mcp.md) for the full tool schema and client configs (Claude Code, Claude Desktop, Cursor). It requires an API key from the [quickstart](quickstart.md) and nothing else; there's no separate approval-server deployment, since `@impri/mcp` talks to the same hosted or self-hosted Impri API as the REST integration.

An MCP approval server is not a replacement for scoping what your agent can touch — it's the mechanism for the actions you've decided need a second pair of eyes. For the underlying request/response shapes it wraps, see [the full integration guide](how-to-add-human-approval-to-an-ai-agent.md).
