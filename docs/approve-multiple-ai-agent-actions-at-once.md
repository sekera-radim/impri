# How to Approve Multiple Pending AI Agent Actions at Once

Clicking through dozens of near-identical pending actions wastes attention — Impri bulk-decision approves or rejects up to 50 actions in one call.

---

## When this is the right tool

This is for reviewing a pile of separate, already-pending actions together — not for turning one mass update into a single approval. If an agent wants to deactivate 12,000 accounts, that's one action with a count and a sample; see [human approval for bulk operations](human-approval-for-ai-agent-bulk-operations.md) for that case. Bulk-decision is for the opposite situation: your inbox has 30 individually small, individually low-risk actions — one per customer segment, one per scheduled post, one per routine sync — and reading each one's confirmation dialog separately adds no safety, only fatigue.

---

## Calling the endpoint

```bash
curl -X POST https://api.impri.dev/v1/actions/bulk-decision \
  -H "Authorization: Bearer $REVIEWER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["act_a1", "act_a2", "act_a3"],
    "verdict": "approve",
    "comment": "Weekly batch, reviewed against the segment list"
  }'
```

`ids` takes 1–50 action IDs, `verdict` is `approve` or `reject` for the whole set — there's no mixing verdicts within one call, and no per-item edits (editing a preview before approval still requires the single-action `POST /v1/actions/:id/decision` endpoint). The response reports each ID's outcome individually:

```json
{
  "results": [
    { "id": "act_a1", "ok": true,  "status": "approved" },
    { "id": "act_a2", "ok": false, "error": "already_decided", "current_status": "expired" },
    { "id": "act_a3", "ok": true,  "status": "approved" }
  ],
  "succeeded": 2,
  "failed": 1
}
```

The call always returns HTTP 200 if the request itself was valid — a partial failure inside the batch is not an HTTP error, it's a `failed` count you have to check. `act_a2` above expired between when the reviewer opened the inbox and when they clicked approve; the other two still went through. Always inspect `results[]` rather than trusting `succeeded === ids.length`.

---

## What happens per item

Each ID is decided in its own transaction, so one failure doesn't roll back the others:

| Case | Result |
|---|---|
| Action exists, still `pending` | Decided; `ok: true` |
| Action doesn't exist, or belongs to another project | `ok: false`, `error: "not_found"` |
| Action already decided (approved/rejected/expired) | `ok: false`, `error: "already_decided"`, with `current_status` |
| Two requests race for the same ID | The loser gets `already_decided` — `decisions` has a `UNIQUE(action_id)` constraint, so only one verdict is ever stored |
| Same ID sent twice in one request | Deduplicated server-side before processing — decided once, not twice |

A webhook fires for every item that has a `callback_url`, same as a single decision — your agent's poll or webhook listener doesn't need to know the decision arrived via bulk.

---

## From the dashboard, not just the API

The web inbox has a bulk-select mode: check the pending items you want to clear, pick approve or reject from the bar that appears, confirm in the dialog, and the same `bulk-decision` call runs underneath with a result summary once it's done. That UI calls the endpoint with everything you selected in one request — if you select more than 50, the call fails validation, so clear a filtered view (one `kind`, one time window) in batches rather than selecting your entire pending list at once.

---

## Rate limit and when to chunk your own script

`POST /v1/actions/bulk-decision` is capped at 10 requests/minute per key — lower than the 60/min on single decisions, because each request can carry up to 50 items (10 × 50 = 500 decisions/minute, the same ceiling expressed per-item). If you're clearing a backlog larger than 500 from a script, pace your requests rather than firing them all at once; the 429 response includes the usual retry signal.

---

## What this doesn't give you

Bulk-decision does not look at the actions' content and decide for you — it still takes an explicit `approve` or `reject` from a human (or a script a human runs), applied uniformly to every ID in the request. It is not a filter or a rule engine; if you want "auto-approve anything under $50," that's [approval rules](rules.md), evaluated at creation time, not a bulk decision after the fact. And because bulk decisions skip edits entirely, any action in the batch that genuinely needs a human to tweak the preview before approving should be pulled out and decided individually.

---

## Next step

Get a key with the `actions` scope from the [quickstart](quickstart.md), then try bulk-decision against a few test actions before pointing a script at a real backlog.
