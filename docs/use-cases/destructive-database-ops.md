<!-- title: Gate destructive database operations from an AI agent -->
<!-- description: Put human approval in front of every INSERT, UPDATE, DELETE or schema change a text-to-SQL or coding agent generates, before it touches production. -->
<!-- screenshot: action-detail.png | The Impri action detail view showing a proposed SQL diff awaiting a decision -->
# Gate destructive database operations from an AI agent

A text-to-SQL agent's query is a guess at intent. A guess that's slightly too broad — a missing `WHERE`, a join that fans out rows, a `LIKE` that matches more than meant — turns "mark these five invoices as void" into a write that touches thousands of rows.

## Problem

Read-only queries don't need a gate. Writes do, and `DELETE` / `TRUNCATE` / schema changes need one the most, because there's often no undo once they run against production. Reviewing every query by hand defeats the point of letting an agent handle routine data work — you need the gate on the write path itself, not on every keystroke the agent takes getting there.

## Workflow

1. The agent's query executor calls `impri_push_action` with the SQL, the affected table, and an estimate of rows touched — the model can draft as many candidate queries as it likes, only the executor is gated.
2. Impri routes the action by severity: a single-row `UPDATE` might auto-route to a fast Slack approval, while a `DELETE` or `DROP` can be pinned to require an admin-scoped decision (configure this with a [rule](/docs/rules)).
3. A human reads the SQL diff and the row estimate in the inbox, and approves, rejects, or edits the query text before it runs (editable fields are listed in `editable`).
4. `impri_await_decision` returns the outcome; the executor runs the (possibly edited) query only on `approved`, and calls `impri_report_result` with the actual row count affected.
5. Every decision — who approved, what the query looked like before and after editing, when — is in the [audit log](/docs/audit-log), which is what you pull up when someone asks "who deleted these rows."

## MCP example

```
impri_push_action({
  kind: "db.exec",
  title: "DELETE 12 rows from invoices where status = 'void' and created_at < 2024-01-01",
  preview: {
    format: "diff",
    body: "DELETE FROM invoices\nWHERE status = 'void' AND created_at < '2024-01-01'\n-- estimated rows: 12"
  },
  payload: { affected_table: "invoices", estimated_row_count: 12 },
  editable: ["preview.body"]
})
// -> { action_id: "act_4mq1...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_4mq1..." }

impri_await_decision({ action_id: "act_4mq1...", timeout_s: 600 })
// -> { action_id: "act_4mq1...", status: "approved", decision_at: 1757830200, preview: { format: "diff", body: "..." }, edited_by_human: false }

impri_report_result({
  action_id: "act_4mq1...",
  status: "executed",
  detail: "12 rows deleted"
})
```

## Result

`SELECT`s keep flowing without friction; every `INSERT`/`UPDATE`/`DELETE`/DDL statement waits for a human who can read SQL before it commits. The blast radius of a bad text-to-SQL guess is capped at "a person saw this exact query and said yes," not "found out after the fact."

## CTA

See the full pattern in [Gate database writes from an AI agent](/docs/approve-database-writes-from-an-ai-agent), or [try Impri free](https://app.impri.dev).
