# An MCP Approval Server for AI Agents

Impri's MCP approval server (`npx @impri/mcp`) gives Claude Code and other MCP clients a real tool call to pause an agent and wait on a human's decision.

---

## The problem with "just ask the user" in a prompt

If your agent runs inside an MCP client, it already has tools: file access, shell, GitHub, a database driver. Telling it in the system prompt to "pause and ask before doing anything destructive" is not a tool call — it's a suggestion the model can forget, rationalize past, or skip entirely under prompt injection from a fetched file or issue body. There's also no record of what was asked or who answered. An MCP **approval-gate server** turns that suggestion into a real dependency: the agent calls a tool, gets back a pending action, and the code path that does the actual work simply isn't reached until that tool returns `approved`.

---

## The three tools, and what each one is for

Impri's MCP server exposes exactly three tools — nothing more:

- `impri_push_action(kind, title, preview, expires_in, editable)` — creates the pending action and notifies a human. Returns an `action_id`.
- `impri_await_decision(action_id, timeout_s)` — blocks (polling internally every few seconds) until the action is `approved`, `rejected`, or `expired`, or the timeout elapses.
- `impri_report_result(action_id, status)` — tells Impri whether the agent's subsequent execution succeeded (`executed`) or failed (`execute_failed`), so the audit trail is complete.

That's the entire surface. There's no fourth tool for "auto-approve" or "cancel" — the state machine is deliberately small.

---

## Wiring it up

Add the server to your MCP client config, pointing `IMPRI_BASE_URL` at either the cloud API or a self-hosted instance:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "http://localhost:8484"
      }
    }
  }
}
```

Drop `IMPRI_BASE_URL` to use the cloud default, or point it at a self-hosted instance. Once configured, `impri_push_action`, `impri_await_decision`, and `impri_report_result` show up as ordinary tools in the client's tool list, right next to whatever else the agent can call.

---

## Walkthrough: an agent that triages and closes GitHub issues

Say the agent has a `github` MCP server too, with tools to close issues and post comments. Without a gate, a triage agent that decides an issue is stale will just close it. With Impri in front of that decision, the close is proposed, not executed:

```typescript
// Wrapper the agent calls instead of the raw GitHub "close issue" tool.
async function closeIssueWithApproval(issue: {
  repo: string; // "owner/repo"
  number: number;
  reason: string;
}) {
  const pushed = await mcp.call("impri_push_action", {
    kind: "github.issue.close",
    title: `Close ${issue.repo}#${issue.number}: ${issue.reason}`,
    preview: {
      format: "markdown",
      body: `Closing **${issue.repo}#${issue.number}**.\n\nReason: ${issue.reason}\n\nComment to post: "Closing as stale — no activity in 90 days."`,
    },
    expires_in: 3600, // 1 hour to review
    editable: ["preview.body"], // reviewer can rewrite the comment text
  });

  const decision = await mcp.call("impri_await_decision", {
    action_id: pushed.action_id,
    timeout_s: 1800,
  });

  if (decision.status !== "approved") {
    return { closed: false, status: decision.status };
  }

  // Only reached after a human approved — this is the actual GitHub call.
  const [owner, repo] = issue.repo.split("/");
  await github.issues.createComment({ owner, repo, issue_number: issue.number, body: decision.preview.body });
  await github.issues.update({ owner, repo, issue_number: issue.number, state: "closed" });

  await mcp.call("impri_report_result", { action_id: pushed.action_id, status: "executed" });
  return { closed: true };
}
```

If the reviewer rejects it, or 30 minutes pass without a decision, `closeIssueWithApproval` returns without ever calling `github.issues.update`. That's the whole mechanism — no branch of the agent's code that touches GitHub runs before `impri_await_decision` resolves to `approved`.

---

## Where the gate actually lives

The gate is the `closeIssueWithApproval` wrapper, not Impri itself. Impri stores the proposed action, notifies a reviewer, and holds the decision — it doesn't know what "closing a GitHub issue" means and doesn't call the GitHub API for you. The protection only holds if the wrapper above is the agent's **only** route to closing issues. If the same agent session also has the raw `github` MCP server's close-issue tool available unwrapped, it can call that directly and skip Impri entirely — the approval tool becomes decoration, not a gate. Confine the agent to the wrapped tool (remove or don't register the raw one) for the dependency to be real. This is the MCP-specific version of the same rule that applies to the [REST integration](how-to-add-human-approval-to-an-ai-agent.md): a gate is only as strong as the absence of a bypass.

---

## What this MCP server is, and isn't

`@impri/mcp` is three tools and nothing else. It doesn't decide what counts as risky, doesn't generate the close-comment text, and doesn't retry failed GitHub calls for you — `impri_report_result` just records what happened so the audit log is accurate. If you need branching logic across many tools and services, that's an orchestration layer like n8n or Temporal sitting above this, not something Impri adds. For a broader look at wiring Impri into an SDK-based agent rather than an MCP client, see [the MCP integration guide](mcp.md) and [the Claude Agent SDK guide](claude-agent-sdk.md).

---

Ready to wire it up. Start with [quickstart](quickstart.md) to get an API key, then point your MCP client config at it.
