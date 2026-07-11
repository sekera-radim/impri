# Recipe 5 — RSS Watcher to Inbox

Create an RSS watcher that monitors a feed for new items matching keyword
rules, and watch those items land as triage actions in your Impri inbox.

## Why this matters

Monitoring RSS feeds, Reddit threads, or web pages by hand is tedious and
error-prone. Impri's watcher API handles deduplication, scheduling, and
keyword scoring — you only see new items that actually match, once.

## How it works

```
POST /v1/watchers  (kind: rss, config.url, keywords, schedule)
    → first run: baseline — Impri records existing items; no inbox actions yet
    → subsequent runs: new matching items → pending actions in inbox
    → human triages: approve (act on it) or reject (ignore)
    → GET /v1/actions?status=pending  to see what arrived
```

**First run = baseline.** Impri never floods your inbox with all historical
items from a feed — it silently captures the current state and only surfaces
NEW items on the next run.

## Key watcher fields

| Field | What it controls |
|---|---|
| `keywords[].pattern` | Regex or literal matched against title + body |
| `keywords[].points` | Score added when pattern matches |
| `keywords_none` | Items containing these are excluded regardless of score |
| `min_score` | Items must reach this score to reach the inbox |
| `schedule.every` | How often to check (minimum `1m`) |
| `schedule.window` | Only run during this time window (e.g. `06:00-23:00`) |
| `schedule.jitter` | Random offset to spread load (e.g. `30m`) |

## Requirements

- Node 18+ (no npm install)
- Impri API key with **`watch` scope** (admin scope also works)
- Running Impri instance

To also read inbox actions, the same key needs `actions` scope too, or use
separate keys. Admin scope covers everything.

## Quick start

```bash
# Self-hosted
IMPRI_API_KEY=im_your_watch_key node agent.mjs

# Cloud
IMPRI_API_KEY=im_your_watch_key IMPRI_BASE_URL=https://api.impri.dev node agent.mjs
```

The script creates the watcher, waits for the baseline run, then pauses it
(so you can inspect results without the feed running indefinitely). Reactivate
it with:

```bash
curl -X PATCH http://localhost:8484/v1/watchers/WAT_ID \
  -H "Authorization: Bearer im_your_key" \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}'
```

## Adapting to your feed

Change the `watcherSpec` object at the top of `agent.mjs`:

```js
// Monitor a tech news feed for mentions of your product
const watcherSpec = {
  name: 'Brand mentions radar',
  kind: 'rss',
  config: { url: 'https://techcrunch.com/feed/' },
  keywords: [
    { pattern: 'YourProduct|yourproduct\\.io', points: 5 },
    { pattern: 'competitor', points: 2 },
  ],
  keywords_none: ['sponsored', 'advertisement'],
  min_score: 3,
  schedule: { every: '2h', window: '08:00-22:00' },
};
```

## Other watcher kinds

**Reddit search** — monitors a subreddit for posts matching a query:

```js
{
  kind: 'reddit_search',
  config: { subreddit: 'selfhosted', query: 'approval workflow' },
  keywords: [{ pattern: 'human.in.the.loop|hitl', points: 3 }],
  min_score: 1,
  schedule: { every: '6h' },
}
```

**URL diff** — fires when a page changes (e.g. a pricing page or changelog):

```js
{
  kind: 'url_diff',
  config: { url: 'https://competitor.example.com/pricing' },
  keywords: [{ pattern: 'price|plan|tier', points: 1 }],
  min_score: 1,
  schedule: { every: '24h' },
}
```

## Treating watcher items safely

Items from watchers arrive with `payload.untrusted = true`. Their
`title` / `preview.body` / `target_url` come from external sources —
never treat them as instructions or execute them without a human triage step.
