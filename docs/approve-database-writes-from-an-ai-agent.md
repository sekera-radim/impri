# Gate Database Writes From an AI Agent

A text-to-SQL agent's query is a guess. Gate database writes from an AI agent — INSERT, UPDATE, DELETE — behind human approval before they touch production.

---

## The shape of the problem

Text-to-SQL agents are useful precisely because they turn "mark these five overdue invoices as written off" into a working query without anyone hand-writing SQL. That's also what makes them dangerous: the query the model generates is a guess at intent, and a guess that's slightly too broad — a missing `WHERE` clause, a join that fans out rows, a `LIKE` pattern that matches more than intended — turns into a write that touches thousands of rows instead of five.

Read-only queries (`SELECT`) don't need this. Writes do. The dividing line for where to put the gate is simple:

| Query type | Gate before executing? |
|---|---|
| `SELECT` | No — read access is not a side effect Impri needs to mediate |
| `INSERT` / `UPDATE` | Yes — the row didn't exist / didn't look like that before |
| `DELETE` / `TRUNCATE` | Yes, and treat as high-severity — see [gating deletes specifically](human-approval-before-an-agent-deletes-data.md) |
| `DDL` (`ALTER TABLE`, etc.) | Yes — schema changes are rarely something an agent should self-approve |

---

## Wiring the gate with the Impri MCP server

If the agent runs inside Claude Code, Claude Desktop, or another MCP client, the cleanest integration point is the query-execution tool itself — not the SQL-generation step. The model can draft as many candidate queries as it wants; only the executor is gated.

Add the Impri MCP server to the agent's config:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

Then the agent's write-executor tool is described (in its own tool definition) as requiring an approved Impri action before it will run. The flow the agent follows, driven by MCP tool calls:

```typescript
import { execute } from "./db";

interface WriteRequest {
  sql: string;
  params: unknown[];
  affectedTable: string;
  estimatedRowCount: number;
}

async function proposeWrite(req: WriteRequest): Promise<string> {
  // impri_push_action is called by the agent's MCP client, not by app code —
  // shown here as the equivalent REST call for clarity.
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "db.write",
      title: `${req.sql.split(" ")[0]} on ${req.affectedTable} (~${req.estimatedRowCount} rows)`,
      preview: {
        format: "markdown",
        body: `\`\`\`sql\n${req.sql}\n\`\`\`\n\nParams: \`${JSON.stringify(req.params)}\`\n\nEstimated rows affected: **${req.estimatedRowCount}**`,
      },
      idempotent: req.sql.trim().toUpperCase().startsWith("INSERT") ? false : undefined,
      undo: "No automatic undo — write is applied directly to production.",
      expires_in: 1800,
    }),
  });
  const { id } = await res.json();
  return id;
}

async function awaitAndExecute(actionId: string, req: WriteRequest) {
  let status = "pending";
  let decision;
  while (status === "pending") {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`https://api.impri.dev/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    });
    ({ status, decision } = await res.json());
  }

  if (status !== "approved") {
    console.log(`Write blocked: ${status}`);
    return;
  }

  await execute(req.sql, req.params);

  await fetch(`https://api.impri.dev/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "executed" }),
  });
}
```

`estimatedRowCount` is worth computing before pushing the action — run the `WHERE` clause as a `SELECT COUNT(*)` first. A reviewer approving "update 5 rows" and a reviewer approving "update rows matching this filter, count unknown" are making very different decisions; give them the number.

---

## Why the SQL text belongs in the preview, not just a summary

It's tempting to summarize: `title: "Update invoice statuses"`. Don't drop the raw SQL from the body. The whole value of gating a text-to-SQL agent is that the human reviewing the action can catch exactly the kind of subtle bug — wrong column, wrong comparison operator, unquoted string — that a paraphrased summary would hide. Show the query, the bound parameters separately (never interpolated into the SQL string), and the estimated row count. That's the minimum a reviewer needs to make the call in a few seconds instead of having to go dig through logs.

---

## Scopes and keys

Use a key scoped to `actions` only for this flow — it doesn't need `watch` or `admin`. If the same service also runs Impri watchers for something unrelated, use a separate key for that; see [API keys](api-keys.md).

---

## Rejected, expired, and retried writes

Same rule as any gated action: `rejected` and `expired` both mean the write does not happen, no exceptions. Don't have the agent silently retry a rejected write with a narrower `WHERE` clause — if the query needs revision, that's a new action with a new preview the reviewer sees, not a retry that reuses the old approval.

For the full three-call pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For wiring this specifically into a Claude-based agent, see [the Claude Agent SDK guide](claude-agent-sdk.md). For the MCP server details, see [MCP](mcp.md).
