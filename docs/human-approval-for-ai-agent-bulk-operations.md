# Human Approval for AI Agent Bulk Operations and Mass Updates

Human approval for AI agent bulk operations: gate a mass update as one reviewable action with a count, a sample and a scope, not 5,000 separate approvals.

An agent that touches one record is a small risk. An agent that touches 12,000 records in one run is a different problem: a wrong filter, a misread column or a bad prompt multiplies instantly. This page shows how to put a human in front of the whole batch without turning review into a click-fest.

---

## Approve the batch, not each row

The first instinct is to push one approval per record. Don't. A reviewer asked to approve 5,000 cards will approve all of them without reading, and you will also hit the `POST /v1/actions` limit of 60 requests per minute per key.

Instead, the agent does a dry run, then proposes **one action that describes the batch**. The human approves or rejects the scope; the agent executes only after that.

A useful batch card answers four questions:

| Question | What to put in the preview |
|----------|----------------------------|
| What will change? | The exact operation, in one sentence |
| How many things? | Row count from the dry run, not an estimate |
| Which things? | The filter or query, plus 5–10 sample rows before and after |
| How do I undo it? | The `undo` field, filled in honestly |

---

## Example: deactivate stale accounts

An agent decides that accounts with no login in 18 months should be deactivated. It runs the query as a `SELECT COUNT(*)` plus a sample, and only then proposes the action:

```python
import os, time, requests

BASE = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

# 1. Dry run — nothing is modified here
ids, sample = dry_run_stale_accounts(months=18)   # your code, read-only
preview = f"""**Deactivate {len(ids)} accounts** with no login in 18 months.

Filter: `last_login < now() - interval '18 months' AND plan = 'free'`

Sample (first 5 of {len(ids)}):

| id | email domain | last login |
|----|--------------|------------|
""" + "\n".join(f"| {r.id} | {r.domain} | {r.last_login} |" for r in sample[:5])

action = requests.post(f"{BASE}/v1/actions", headers=H, json={
    "kind": "accounts.bulk_deactivate",
    "title": f"Deactivate {len(ids)} stale free accounts",
    "preview": {"format": "markdown", "body": preview},
    "expires_in": 3600,
    "idempotent": True,
    "undo": "UPDATE accounts SET active = true WHERE id = ANY(<ids from the audit receipt>)",
}).json()

# 2. Wait for the human
while True:
    r = requests.get(f"{BASE}/v1/actions/{action['id']}", headers=H).json()
    if r["status"] != "pending":
        break
    time.sleep(10)

# 3. Execute only on approval, against the SAME ids that were reviewed
if r["status"] == "approved":
    deactivate(ids)                                # your code
    requests.post(f"{BASE}/v1/actions/{action['id']}/result", headers=H,
                  json={"status": "executed"})
```

The important line is the last comment: execute against the frozen `ids` list the reviewer saw, never re-run the query after approval.

---

## The classic bulk failure: the scope drifts

Between the dry run and the approval, data changes. If the agent re-evaluates "all stale accounts" after the human said yes, it may now match 14,000 rows instead of 12,000. The approval no longer describes what runs.

Three habits prevent this:

- **Freeze the target set.** Persist the list of IDs (or a snapshot) at proposal time and execute exactly that list.
- **Put the count in the title.** The inbox card and any notification show it at a glance, so a "2,000 became 200,000" mistake is obvious.
- **Short expiry.** A batch approved two days ago was approved against two-day-old data. Use a small `expires_in` (the minimum is 300 seconds) and treat `expired` like `rejected` — re-propose with a fresh dry run.

---

## Let the human narrow it, not just accept it

Sometimes the reviewer agrees with the idea but not the scope. Mark the filter as editable:

```json
{
  "kind": "accounts.bulk_deactivate",
  "title": "Deactivate 12,040 stale free accounts",
  "preview": { "format": "markdown", "body": "Filter: last_login < 2025-04-01 AND plan = 'free'" },
  "editable": ["preview.body"]
}
```

If the reviewer tightens the filter, `decision.final_preview` carries their version and `decision.diff` shows what changed. Your agent must then **re-run the dry run with the edited filter** and, if the count changed, propose again. Impri does not parse your filter or recompute anything; it hands back the text the human approved.

---

## Batches in the inbox

If you do end up with several batch actions (for example one per customer segment), the inbox supports deciding them together via `POST /v1/actions/bulk-decision`. That is a reviewer convenience for many small, similar, low-risk actions — it is not a substitute for a count and a sample on a destructive batch.

For single destructive operations, see [approving database writes](approve-database-writes-from-an-ai-agent.md) and [approval before an agent deletes data](human-approval-before-an-agent-deletes-data.md). Every decision lands in the [audit log](audit-log.md), which is where you prove which scope was approved.

---

## What Impri does and doesn't do here

Impri is the approval gate only. It stores the proposed batch, notifies the reviewer, and holds the decision. It does **not** run your query, count rows, validate that the sample is representative, or execute the update.

Two limits to be honest about:

- **The preview is only as good as the agent's dry run.** If the agent writes a misleading summary, the human approves a misleading summary. Generate the count and sample from the real query result, in code, not from the model's prose.
- **It is a real gate only if the approved path is the only path.** If the agent also holds a database credential with write access, it can bypass the gate. Give the agent a tool that executes only a frozen, approved ID list.

Impri is not a workflow engine, a batch scheduler or a rollback system. For retries, throttling and chunked execution, use your own job runner and call Impri once per batch.

---

## Next step

Get a key and push your first batch action with the [quickstart](quickstart.md), or read the general pattern in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).
