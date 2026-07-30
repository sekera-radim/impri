# Build an Audit Trail for AI Agent Actions

When an agent sends emails or publishes content on its own, "what did it do and who signed off" needs a real answer — here's how to build an audit trail for AI agent actions without writing your own logging layer.

---

## The question that shows up after the fact

Nobody asks for an audit trail before something goes wrong. They ask afterward: a customer says they never approved a refund email, a teammate wants to know why a blog post went live at 2 a.m., or a compliance review needs proof that every agent-initiated action had a named human behind it. If the only record is scattered application logs — or worse, nothing — there's no good answer.

An audit trail for agent actions needs three things to actually hold up: it has to record the *proposal* separately from the *decision*, it has to know *who* decided (not just that someone did), and it has to be tamper-resistant enough that nobody can quietly edit history after the fact.

## What gets logged, automatically, just by using the gate

If your agent already routes side-effecting actions through an approval gate, the audit trail is a side effect of that gate rather than something you build separately. Every action pushed through Impri writes an append-only row for its full lifecycle — created, rule-applied, approved or rejected, expired, executed or failed — with no route to edit or delete an individual entry after the fact. See [audit-log](audit-log.md) for the full schema.

The part that matters for accountability: decisions made through chat approval channels record a human-readable actor, not just a key ID.

| Channel | `actor` value example |
|---|---|
| REST API | the calling API key's ID |
| Web inbox | the calling API key's ID |
| Slack button | `radim (Slack)` |
| Discord button | `Radim (Discord)` |
| Telegram button | `@radim (Telegram)` |

That's the difference between "an API call approved this" and "Radim approved this at 14:32 from Slack" — the second one is what survives a real incident review.

## Querying the trail for a specific action

Given an `action_id`, filter the audit query to just that action's lifecycle:

```typescript
import fetch from "node-fetch";

async function getActionHistory(actionId: string) {
  const res = await fetch(
    `https://api.impri.dev/v1/audit?entity_id=${actionId}`,
    { headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` } }
  );
  const { items } = await res.json();
  return items; // ordered newest-first: created, rule_applied, approved/rejected, executed
}

const history = await getActionHistory("act_8f2b1c");
for (const row of history) {
  console.log(`${new Date(row.created_at * 1000).toISOString()}  ${row.event}  actor=${row.actor ?? "system"}`);
}
```

A typical result for one agent-initiated email:

```text
2026-07-29T09:12:04Z  action.created       actor=key_prod_agent
2026-07-29T09:12:04Z  action.rule_applied  actor=null
2026-07-29T09:14:51Z  action.approved      actor=radim (Slack)
2026-07-29T09:15:02Z  action.executed      actor=null
```

That's a complete, ordered story of one agent action — proposed by which key, matched against which rule, approved by which named human, and confirmed executed — without any custom logging code in the agent itself. `GET /v1/audit` requires `admin` scope and is always scoped to the authenticated key's project, so one project's history can't leak into another's query results.

## Exporting for a compliance review

For a periodic review rather than a single incident, `GET /v1/audit/export` streams the full filtered history as NDJSON or CSV instead of paging through the query endpoint:

```bash
curl -s "https://api.impri.dev/v1/audit/export?since=1719792000&format=csv" \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -o agent-actions-q3.csv
```

This is rate-limited to 5 requests/minute per key — it's built for periodic pulls, not for polling in a loop. If you need per-request retention limits for a compliance framework (e.g., "keep 180 days, no more"), that's a `AUDIT_RETENTION_DAYS` setting on the instance, not something the export call itself controls.

## What this doesn't give you

The audit trail records that an action happened and who decided it — it does not evaluate whether the decision was *correct*. If a human approves a bad draft, that approval is logged faithfully; Impri does not second-guess a human reviewer's judgment, and it's not a content moderation system. It also only covers actions that actually went through the gate: if your agent has a side channel to the same service (a raw API key it can call directly instead of going through the wrapped executor), that path leaves no row here at all. The trail is only as complete as the chokepoint is real — see [the SDK integrations](integrations.md) for wrapping the executor so there is no second path.

## Getting a key and pushing your first action

If you haven't wired up the push/poll/execute pattern yet, [How to Add Human Approval to an AI Agent](how-to-add-human-approval-to-an-ai-agent.md) covers the three calls end to end, and [quickstart](quickstart.md) walks through getting an API key on cloud or self-host.
