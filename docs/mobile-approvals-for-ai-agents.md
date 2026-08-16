# Mobile Approvals for AI Agents

Turn the Impri inbox into a phone-first approval queue for AI agents — install it as an app and clear a night's worth of pending decisions before coffee.

---

## The queue that builds up overnight

A watcher-driven agent doesn't work business hours. Point an `rss` or `reddit_search` watcher at a set of keywords and it runs on its own schedule; every match it decides is worth a response becomes a pending action — a drafted reply, not a posted one. Run that overnight and you can wake up to a dozen pending cards instead of one. Reviewing all of them from a laptop before you've left the house isn't realistic. Reviewing them from your phone while the kettle boils is.

## Install it once

The web inbox at `app.impri.dev` is an installable web app — open it in your phone's browser and use "Add to Home Screen" (iOS Safari) or the install prompt (Android Chrome). From then on it opens like any other app, no App Store listing required. Combined with browser push notifications, a new pending action reaches your lock screen the same way a text message would, without a chat app in the middle.

## Two ways to clear the queue

For a handful of actions, open each card, read the draft, tap approve or reject. For a dozen similar ones — say, eight reply drafts from a single overnight watcher run where six are obviously fine and two need a closer look — opening and closing twelve cards individually is the slow path. The inbox supports multi-select for exactly this: check the ones you trust, then approve or reject the whole selection in one tap, which calls the same `POST /v1/actions/bulk-decision` endpoint under the hood.

| | Single decision | Bulk decision |
|---|---|---|
| Endpoint | `POST /v1/actions/:id/decision` | `POST /v1/actions/bulk-decision` |
| Max items per request | 1 | 50 |
| Can edit the draft first | Yes, if `editable` is set | No — bulk skips editable actions entirely |
| Best for | The two that need a closer look | The six that are obviously fine |

If you'd rather trigger a batch decision from a shortcut than tap through the UI — an iOS Shortcut, a Termux script, whatever your phone can fire a request from — the same endpoint is reachable directly:

```typescript
async function approveAll(ids: string[], apiKey: string) {
  const res = await fetch("https://api.impri.dev/v1/actions/bulk-decision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ids,
      verdict: "approve",
      comment: "Morning triage - batch approved",
    }),
  });
  return res.json(); // 200 even on partial failure - check per-item results
}
```

This is rate-limited to 10 requests/minute per key, but each request covers up to 50 actions — 500 decisions/minute of effective throughput, more than any morning queue will need.

## What doesn't fit in a bulk tap

Bulk decision intentionally has no field for edits — it's approve-or-reject on the draft exactly as the agent wrote it. Any action created with `editable: ["preview.body"]` has to go through the single-item flow if you want to change anything before approving. In practice that means: bulk-clear the routine ones from your phone, and open the one or two that actually need a rewrite as their own card. That split is deliberate — it keeps the fast path fast without pretending you can meaningfully edit text on a six-inch screen while walking to the kitchen.

## The gate is still just a gate

None of this changes what Impri actually does: it stores the proposed action, notifies you, and holds the decision until you make it. Approving from a phone doesn't make the check any less real than approving from a laptop — the agent still can't execute without `status: "approved"` coming back from the API, regardless of which device you happened to be holding when you sent it.

---

## Next step

Set up your first channel and API key in [the quickstart](quickstart.md), see the full bulk-decision and keyboard feature set in [the inbox reference](inbox.md), or configure which channels notify you at all in [notification channels](notifications.md).
