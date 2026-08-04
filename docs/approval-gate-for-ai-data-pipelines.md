# An Approval Gate for AI Data Pipelines

When an AI ops agent proposes rerunning a DAG, backfilling a table, or dropping a corrupted partition, this shows how to hold that action for a human decision before it touches production data.

---

## The scenario

An agent watches your orchestrator (Airflow, Dagster, whatever runs the DAGs) for failures and data-quality alerts. When it finds one, it doesn't just page someone — it proposes a fix: rerun task X with a given date range, delete the partition that has duplicate rows, or roll back a migration that broke a downstream join. That's useful. It's also exactly the kind of action that's cheap to propose and expensive to get wrong: a backfill over the wrong date range reprocesses a week of billing events; a deleted partition that turns out not to be corrupted is a restore-from-backup afternoon.

The agent should keep doing the diagnosis — that's the hard part it's actually good at. The remediation step is where a human belongs, because "is this the right fix" requires context the agent doesn't have: is this table being read by a live dashboard right now, did someone already start a manual fix, is this the third time this week this DAG has failed for an unrelated reason.

---

## Where the gate sits

```
Orchestrator alert ──▶ Agent diagnoses ──▶ Impri holds proposed fix ──▶ Data engineer decides
                                                    │
                                       reject/expire │ approve
                                                    ▼         ▼
                                            nothing runs   agent executes fix,
                                                            reports result
```

The agent never calls the orchestrator's rerun/delete API directly — it calls it from behind the approval check, so there's no code path where a diagnosis becomes a data mutation without a decision in between.

---

## Wiring it up (TypeScript)

```typescript
const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const BASE = "https://api.impri.dev";

interface RemediationProposal {
  dagId: string;
  task: string;
  action: "rerun" | "delete_partition" | "rollback_migration";
  reason: string;
  target: string; // partition name, date range, or migration id
}

async function proposeRemediation(p: RemediationProposal): Promise<string> {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: `pipeline.${p.action}`,
      title: `${p.action} — ${p.dagId}/${p.task}`,
      preview: {
        format: "markdown",
        body: `**Reason:** ${p.reason}\n**Target:** \`${p.target}\`\n**Task:** ${p.dagId} / ${p.task}`,
      },
      expires_in: 3600, // 1h — a stale remediation may no longer match reality
      idempotent: p.action === "rerun",
      undo:
        p.action === "delete_partition"
          ? `Restore partition ${p.target} from the last snapshot before this run`
          : undefined,
    }),
  });
  const { id } = await res.json();
  return id;
}

async function awaitDecision(actionId: string, timeoutS = 1800): Promise<any> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    }).then((r) => r.json());
    if (r.status !== "pending") return r;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return { status: "expired" };
}

const actionId = await proposeRemediation({
  dagId: "billing_daily_rollup",
  task: "aggregate_partitions",
  action: "delete_partition",
  reason: "Duplicate rows detected from a retried upstream write on 2026-08-02",
  target: "billing_events/dt=2026-08-02",
});

const decision = await awaitDecision(actionId);

if (decision.status === "approved") {
  await orchestrator.deletePartition(decision.decision.final_preview.body);
  await fetch(`${BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IMPRI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "executed", payload: { target: "billing_events/dt=2026-08-02" } }),
  });
}
```

Note `idempotent` and `undo` doing real work here: a rerun is usually safe to retry so it's flagged `idempotent: true`, while a partition delete is flagged `false` with an `undo` note — the reviewer sees the escape hatch before they approve, not after something's already gone.

---

## What this does and doesn't cover

| It gates | It doesn't do |
|---|---|
| Whether a proposed rerun/delete/rollback executes | Diagnosing the underlying data issue |
| Giving the reviewer the exact target (partition, date range, task) | Validating that target is actually correct |
| An audit trail of who approved which remediation, and when | Scheduling or orchestrating the DAG itself |

Impri is the gate, not the orchestrator and not the data-quality checker. It won't tell you the partition is actually corrupted — your monitoring does that. It also isn't a replacement for [Airflow's own retry logic](integrations.md) for transient failures; reserve the approval gate for remediations that mutate or delete data, not every automatic retry.

---

## Audit trail matters here more than usual

Data incidents get post-mortems. Because every proposed remediation and its decision live in Impri, "who approved deleting that partition, and what did the agent say the reason was" is answered by the [audit log](audit-log.md) instead of by someone's memory of a Slack thread three weeks later.

Next: the [quickstart](quickstart.md) covers getting an API key for cloud or self-hosted use; see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying request/poll/execute pattern this builds on.
