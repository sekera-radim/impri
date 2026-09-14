# Human-in-the-Loop for AI Agent Incident Response

Let an on-call agent diagnose and propose the fix at 3am, but require a human tap before it restarts a service, rolls back a deploy, or pages a second responder.

---

## Why incident-response agents need a checkpoint

An agent wired into your alerting pipeline can read logs, correlate a spike with a recent deploy, and draft a remediation in seconds — faster than a sleepy human could. That speed is exactly why it needs a gate. Diagnosis errors are recoverable; a wrong *action* during an incident — rolling back the wrong service, restarting a stateful pod mid-write, scaling down the one replica actually serving traffic — turns a small incident into a bigger one, and it happens while the humans who'd normally sanity-check it are asleep or in a different channel.

The agent should be free to investigate on its own. It should not be free to act on its own.

## Not every action needs the same gate

Some remediation steps are safe to automate outright; others should always wait for a person. A rough split:

| Action | Reversible? | Gate it? |
|---|---|---|
| Restart a stateless pod | Yes, cheap | Usually auto-OK |
| Roll back to previous deploy | Yes, but drops recent changes | Gate |
| Scale replica count | Yes | Gate if scaling down |
| Revoke a leaked credential | No (by design) | Gate, high urgency |
| Page a second on-call engineer | N/A, social cost | Gate |
| Run a DB migration to "fix" data | Often no | Always gate |

The `idempotent` and `undo` fields exist for exactly this table — mark the rollback as `idempotent: false` if repeating it would compound the problem, and fill `undo` with the one-line recovery so the approver isn't trusting the agent's judgment blind.

## Implementation: gating a deploy rollback

```typescript
import { setTimeout as sleep } from "node:timers/promises";

const IMPRI_BASE = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface RollbackProposal {
  service: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
}

async function proposeRollback(p: RollbackProposal): Promise<string> {
  const body = [
    `**Service:** ${p.service}`,
    `**Rollback:** ${p.fromVersion} → ${p.toVersion}`,
    `**Trigger:** ${p.reason}`,
  ].join("\n\n");

  const res = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "incident.rollback",
      title: `Rollback ${p.service} to ${p.toVersion}`,
      preview: { format: "markdown", body },
      idempotent: false,
      undo: `Redeploy ${p.fromVersion} to ${p.service} via the same pipeline`,
      expires_in: 900, // 15 minutes — an incident decision that's stale in 15 min is a new incident
    }),
  });
  const { id } = await res.json();
  return id;
}

async function waitForDecision(actionId: string) {
  while (true) {
    const res = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, {
      headers: HEADERS,
    });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await sleep(5000); // tight poll — incidents don't tolerate a lazy interval
  }
}

async function runRollback(p: RollbackProposal) {
  const actionId = await proposeRollback(p);
  const decision = await waitForDecision(actionId);

  if (decision.status !== "approved") {
    console.log(`Rollback not approved (${decision.status}) — holding, paging human directly`);
    return;
  }

  await executeRollback(p.service, p.toVersion); // your deploy tooling
  await fetch(`${IMPRI_BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

Note the short `expires_in` and the 5-second poll interval — both tuned tighter than a typical approval flow. An incident-response gate that takes as long to decide as the incident itself defeats the point; if nobody has responded within 15 minutes, the agent should stop waiting and escalate through your paging tool instead of leaving the rollback in limbo.

## Routing the approval to whoever is actually on call

A pending action sitting in an inbox nobody is watching at 3am is worse than no gate at all. Send it where the on-call engineer already is — [Slack](slack-approval.md) or [Telegram](telegram-approval.md) approval channels turn the action into a message they can approve from their phone without opening a dashboard, which matters when they're already awake for the alert itself.

## The audit trail doubles as your postmortem input

Every approved or rejected rollback is a timestamped record: who decided, what the proposed action said, whether it was edited first. Pull this from the [audit log](audit-log.md) when writing the postmortem instead of reconstructing the decision from Slack scrollback — "who approved the rollback and when" is usually the first timeline question in an incident review.

## What this is not

This isn't an incident-management platform — it doesn't detect the incident, run your runbook, or replace PagerDuty/Opsgenie. It's the single checkpoint between "agent decided to act" and "action happened." Detection, diagnosis, and paging stay in your existing tooling; Impri only holds the line at the moment something changes production state.

Next step: start with the [quickstart](quickstart.md) to get a key, then wrap just your riskiest remediation action first — a full rollback — before gating the lower-risk ones from the table above.
