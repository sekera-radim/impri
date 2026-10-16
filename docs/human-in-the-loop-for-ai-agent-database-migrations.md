# Human-in-the-Loop for AI Agent Database Migrations

Gate AI agent database migrations with human approval: the reviewer sees the exact SQL, the dry-run plan and the rollback before anything touches your schema.

---

## Why migrations are not just "database writes"

A row-level write affects the rows it names. A migration changes the shape every other query depends on, often takes locks on hot tables, and is frequently impossible to reverse once data has been rewritten. `ALTER TABLE ... DROP COLUMN` does not come back with a `git revert`.

Agents are increasingly asked to produce migrations: a coding agent adds a feature and generates the Prisma, Alembic or Drizzle file; an ops agent "cleans up" unused indexes. Generating the file is fine. **Applying it** is the step that needs a human, because the person on call is the one who knows that `orders` has 400M rows and that Friday 17:00 is a bad time for an `ACCESS EXCLUSIVE` lock.

This page is about gating the *apply* step. For ordinary inserts and updates see [Gate Database Writes From an AI Agent](approve-database-writes-from-an-ai-agent.md).

---

## What the reviewer needs on the card

The approval card is only as good as the preview your agent builds. For a migration, put four things in `preview.body`:

| Section | Why the reviewer needs it |
|---|---|
| Target (environment, database, migration id) | So "staging" is never mistaken for "prod" |
| The SQL, verbatim | The decision is about the SQL, not a summary of it |
| Dry-run output (statements, estimated rows, lock level) | Turns "looks fine" into evidence |
| Rollback / down migration | Tells the reviewer the escape hatch before they approve |

Impri does not run or interpret any of this. Your agent computes the dry-run and the lock analysis with your own tooling and pastes the result into the preview.

---

## Gating the apply step

The wrapper below is the **only** code path in the agent that can run migrations. It pushes the action, polls, and applies the SQL from `decision.final_preview` only when the status is `approved`.

```python
import os, time, requests

API = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def apply_migration(migration_id: str, sql: str, dry_run_report: str, down_sql: str, env: str):
    body = (
        f"**Target:** `{env}` / migration `{migration_id}`\n\n"
        f"### SQL\n```sql\n{sql}\n```\n\n"
        f"### Dry run\n{dry_run_report}\n\n"
        f"### Rollback\n```sql\n{down_sql}\n```"
    )
    action = requests.post(f"{API}/v1/actions", headers=H, json={
        "kind": "db.migrate",
        "title": f"Apply migration {migration_id} to {env}",
        "preview": {"format": "markdown", "body": body},
        "expires_in": 3600,          # a stale migration plan is not worth applying
        "idempotent": False,
        "undo": f"Run the down migration for {migration_id}",
    }).json()

    while True:
        r = requests.get(f"{API}/v1/actions/{action['id']}", headers=H).json()
        if r["status"] != "pending":
            break
        time.sleep(10)

    if r["status"] != "approved":
        return r["status"]           # rejected or expired: nothing runs

    try:
        run_sql(env, sql)            # your own executor, the only path to the DB
        status = "executed"
    except Exception:
        status = "execute_failed"
    requests.post(f"{API}/v1/actions/{action['id']}/result", headers=H, json={"status": status})
    return status
```

Note `expires_in: 3600`. A migration plan was validated against the schema as it was when the agent generated it. If it sits for three days, other migrations may have landed and the dry-run no longer describes reality. Let it expire and have the agent re-plan.

---

## Reviewing what you actually approve

If you do not make the SQL editable, the approved text is exactly the text the reviewer read, which is usually what you want for DDL. Making a migration editable is a deliberate choice: when you set `editable: ["preview.body"]`, always apply from `decision.final_preview`, and treat `decision.diff` as a signal to re-run your own dry run before executing.

For multi-statement migrations, keep one action per migration file, not one per statement. The reviewer approves a unit that can be rolled back as a unit.

---

## Boundaries worth stating plainly

- **Impri is only the gate.** It stores the proposed action, notifies a human and holds the decision. It does not analyse SQL, detect destructive statements or run the migration.
- **It is a real gate only if the wrapper is the agent's only path to the database.** If the agent also holds a superuser connection string, it can bypass the gate. Give the agent credentials that cannot alter schema, and give the executor behind the approval the credentials that can.
- **It is not a migration tool.** Ordering, locking strategy, zero-downtime patterns and rollbacks are still yours; use Flyway, Alembic, Atlas or whatever you run today.
- **Production rows and schema belong to humans.** Keep the approval on a channel the on-call person actually sees: [Slack](slack-approval.md) or [phone notifications](notifications.md).

---

## Next step

Get a key and push your first action in the [quickstart](quickstart.md), or let a coding agent call the gate directly through the [MCP server](mcp.md). The pattern is the same as in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md): the agent proposes, a human decides, and only then does anything execute.
