# Human-in-the-Loop for AI in SaaS Operations

Human-in-the-loop for AI in SaaS operations means gating tenant-level admin actions — plan overrides, quota bumps, account suspensions — behind a human tap before an ops agent touches a customer's account.

---

## Ops agents have root, not just an opinion

A support or growth agent that triages tickets and drafts replies is annoying when wrong. An ops agent wired into your admin panel is dangerous when wrong, because the actions it can take are structural: extend a trial, raise a rate limit, change a billing plan, suspend or delete a tenant. These aren't content a customer reads and can shrug off — they're state changes to a paying account, and some of them (deleting a tenant, dropping a plan tier mid-cycle) aren't cleanly reversible.

The pattern that works isn't "trust the agent less" — it's "make the handful of high-blast-radius calls unreachable without an approved decision first." Everything else the agent already does unattended keeps running unattended.

## Sorting ops actions by blast radius

| Action | Reversible? | Gate it? |
|---|---|---|
| Answer "what plan am I on" from account data | n/a | No |
| Apply a pre-approved dunning email retry | Yes | No |
| Extend a trial by N days | Yes, easily | No, if capped (e.g. ≤14 days) |
| Override a plan's seat or rate limit | Yes, but changes billing | Yes |
| Suspend a tenant for abuse/non-payment | Yes | Yes |
| Delete a tenant or purge its data | No | Yes |

The bottom three go through Impri as pending actions. A capped, self-service trial extension can stay automated — the moment "N days" is unbounded or touches an invoice, it moves up a row.

## Gating a plan override from a TypeScript ops bot

The agent still decides what change is warranted; Impri sits between that decision and the admin API call that makes it real.

```typescript
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.impri.dev/v1";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function proposePlanOverride(
  tenantId: string,
  field: "seat_limit" | "rate_limit_rpm",
  from: number,
  to: number,
  reason: string,
) {
  const res = await fetch(`${API}/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "tenant.plan_override",
      title: `Override ${field} for tenant ${tenantId}: ${from} → ${to}`,
      preview: {
        format: "markdown",
        body: `**Tenant:** ${tenantId}\n**Field:** ${field}\n**From → To:** ${from} → ${to}\n**Reason:** ${reason}`,
      },
      editable: ["preview.body"],
      idempotent: false, // re-applying the same override could double-count usage credits
      undo: `PATCH tenant ${tenantId} ${field} back to ${from} via admin API`,
      expires_in: 21600, // 6h — ops requests go stale once the underlying ticket is resolved elsewhere
    }),
  });
  const { id } = await res.json();

  let decision;
  while (true) {
    const poll = await fetch(`${API}/actions/${id}`, { headers: HEADERS });
    decision = await poll.json();
    if (decision.status !== "pending") break;
    await sleep(5000);
  }

  if (decision.status !== "approved") return null; // rejected or expired — nothing changes

  const finalBody = decision.decision.final_preview.body;
  await applyPlanOverrideInAdmin(tenantId, field, to); // your internal admin API call

  await fetch(`${API}/actions/${id}/result`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ status: "executed", payload: { tenantId, field, to } }),
  });
  return finalBody;
}
```

Tenant suspension and deletion use the same three-call shape with `kind: "tenant.suspend"` or `"tenant.delete"` — the preview should show current MRR, seat count, and last-login so whoever's on call isn't approving a delete blind.

## Why the `undo` field matters more here than anywhere else

Most ops mistakes are fixable if someone knows how fast. A wrong plan override is a two-minute PATCH; a wrong tenant deletion, without a backup step described somewhere, is not. Writing the `undo` string at proposal time forces the agent's author to have already thought through reversibility before the human is asked to trust the change — see [handling edits and the undo field](how-to-add-human-approval-to-an-ai-agent.md) for the full field reference.

## What Impri does not do here

Impri stores the proposed override or suspension, notifies whoever's on ops duty, and holds the decision — it doesn't know your pricing rules, doesn't call your admin API, and doesn't decide whether a 3x rate-limit bump for a customer is generous or reasonable. That judgment stays with the human, and `applyPlanOverrideInAdmin` is still your code to write and to wrap so it's unreachable without the approved decision. Every approved and rejected override is still worth checking against [the audit log](audit-log.md) later, especially for tenants that file a dispute months after a plan change.

---

Next: [approve database writes from an AI agent](approve-database-writes-from-an-ai-agent.md) if your ops agent is closer to the data layer than the admin panel, and [the propose-approve-execute pattern](the-propose-approve-execute-pattern.md) for the underlying design this is built on.
