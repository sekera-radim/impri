# Alternatives to Building Your Own Agent Approval System

Before you write a `pending_actions` table and a Slack bot, see the four real alternatives to a custom AI agent approval system and when each one actually beats rolling your own.

---

## Why teams end up building one

The trigger is almost always the same: an agent got far enough to be useful, then did something (sent an email, posted a comment, wrote a row) that nobody had reviewed first. The fix people reach for first is a bespoke approval system — a database table, a status column, a Slack webhook, a cron job that pings the agent for the answer. It works for a weekend demo. Then someone needs it on their phone, someone else needs an audit log, and the "just a table and a webhook" system has grown a UI, a notification layer, and an expiry policy nobody remembers writing.

That's the point to stop and look at what already exists, instead of continuing to build.

---

## Option 1: a workflow engine's human-in-the-loop node

Tools like n8n, Temporal, and Inngest have first-class "wait for human input" primitives — n8n's Wait node with a webhook resume, Temporal's signal-based approval workflows. If your agent already lives inside one of these, this is often the path of least resistance: no new service to run, the approval step is just another node.

The tradeoff: these are workflow engines first. You get a pause-and-resume primitive, not a purpose-built inbox — no mobile-friendly approve/reject cards, no diff view for an edited draft, no dedicated audit trail of *decisions* (as opposed to workflow runs). Adopting one just for the approval step is a heavier dependency than the problem calls for.

## Option 2: roll your own (the DIY path)

The minimal version is genuinely simple to prototype:

```python
# db: actions(id, kind, title, body, status, created_at)
import sqlite3, time, uuid

def push_action(kind: str, title: str, body: str) -> str:
    action_id = str(uuid.uuid4())
    db.execute(
        "INSERT INTO actions (id, kind, title, body, status) VALUES (?, ?, ?, ?, 'pending')",
        (action_id, kind, title, body),
    )
    notify_slack(f"New action pending: {title} — {action_id}")
    return action_id

def await_decision(action_id: str, timeout_s: int = 3600) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        row = db.execute("SELECT status FROM actions WHERE id = ?", (action_id,)).fetchone()
        if row[0] != "pending":
            return row[0]
        time.sleep(10)
    return "expired"
```

This is real code you could ship today. The cost shows up later: a reviewer's phone needs a UI, not a database row, so you build one. Someone approves the same batch of emails every morning, so you build bulk-decide. Legal asks who approved what and when, so you build an audit log. Each of those is a normal, boring feature — and each one is a week you didn't spend on the agent itself. Roll-your-own is the right call when the surface is genuinely tiny (one action kind, one reviewer, no compliance requirement) and staying that way.

## Option 3: repurpose existing approval/ticketing software

Some teams point agent actions at a system already in place for other approvals — a ticketing tool, a lightweight BPM product, even a shared spreadsheet with a manual review column. This avoids new infrastructure, but these tools weren't built for the agent loop: no `GET status` endpoint an agent can poll cleanly, no concept of "here is the edited version, execute *this* text," no expiry that maps to "this draft is stale, don't send it." You end up gluing scripts around a tool that wasn't designed for this shape of problem, which is its own maintenance burden.

## Option 4: a dedicated approval-gate service

The fourth option is a service built specifically for this loop: agent proposes, human decides, agent executes only on approval — nothing else. Impri is this option. It exists so you don't build the table, the Slack bot, the diff view, and the audit log yourself:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -d '{
    "kind": "email.send",
    "title": "Reply to support ticket #4821",
    "preview": { "format": "markdown", "body": "Hi Jordan, thanks for..." },
    "editable": ["preview.body"],
    "expires_in": 3600
  }'
```

Three calls — push, poll, report — and you get a mobile-friendly inbox, human edits with a diff, notification channels (Slack, Telegram, Discord, email, push), and an audit trail, without owning that surface yourself. It's honestly narrow, though: Impri is only the gate. It does not generate the draft or orchestrate multi-step workflows — pair it with n8n or your own agent code for that, the same way you would with a DIY table.

---

## Which one to pick

| Situation | Alternative |
|---|---|
| Already orchestrating agent steps in n8n/Temporal | Use the engine's HITL node |
| One action kind, one reviewer, prototype only | Roll your own — but budget for it to grow |
| Existing approval tooling with spare capacity | Repurpose it, expect glue code |
| Need mobile approve/reject, audit log, human edits, multiple channels | Dedicated gate — see the [minimal integration](how-to-add-human-approval-to-an-ai-agent.md) |

If you're weighing this decision in more depth — including the actual engineering-hours math — see [build vs. buy for an AI agent approval queue](build-vs-buy-ai-agent-approval-queue.md). For the mechanics of wiring a gate into your agent once you've picked one, the [MCP integration](mcp.md) is the fastest path if your agent already runs inside an MCP client.
