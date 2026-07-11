# Watcher Presets

Presets are named, parameterized templates for the most common watcher
configurations. Instead of hand-crafting a `config` object and choosing a
schedule, you pick a preset, supply a handful of params, and the server builds
the watcher for you.

> **Honest framing.** A preset is a UI convenience, not a separate watcher
> kind. Under the hood every preset resolves to one of the three watcher kinds:
> `rss`, `reddit_search`, or `url_diff`. The `POST /v1/watchers/from-preset`
> endpoint builds the `CreateWatcherBody`, runs the same validation pipeline as
> `POST /v1/watchers`, and inserts the same row. Billing limits, scheduling
> minimums, and SSRF guards all apply identically.

---

## Endpoints

### List the preset catalog

```
GET /v1/watcher-presets
Authorization: Bearer im_<key>   (scope: watch)
```

Returns the static preset catalog — no DB read, safe to cache aggressively.

```json
{
  "presets": [
    {
      "id": "hn-front-page",
      "title": "Hacker News Front Page",
      "description": "New posts as they appear on the HN front page",
      "category": "Community",
      "kind": "rss",
      "params": [],
      "defaultScheduleEvery": "30m"
    }
    // …
  ]
}
```

### Create a watcher from a preset

```
POST /v1/watchers/from-preset
Authorization: Bearer im_<key>   (scope: watch)
Content-Type: application/json
```

Request body:

```json
{
  "preset_id": "github-releases",
  "params": {
    "owner": "fastify",
    "repo": "fastify"
  },
  "name": "fastify releases",
  "schedule": {
    "every": "2h"
  }
}
```

- `preset_id` — required; must match a known preset id.
- `params` — required; key/value map of the preset's declared params.
- `name` — optional; defaults to `"<preset title>: <primary param value>"`.
- `schedule` — optional; defaults to the preset's `defaultScheduleEvery`.

Successful response: `201` with the same watcher object as `POST /v1/watchers`.

**Errors:**

| Status | Error | When |
|--------|-------|------|
| 400 | `preset_not_found` | Unknown `preset_id` |
| 400 | `Bad Request` + `issues` | Missing or invalid param, or body fails validation |
| 402 | `Payment Required` | Watcher count limit or schedule too frequent for tier |
| 403 | `Forbidden` | Key missing `watch` scope |
| 429 | `Too Many Requests` | `watchers:create` rate-limit (30 req/min per key) |

---

## How to create a watcher from a preset

### Web UI

Open the **Watchers** page in the inbox, click **Add Watcher**, and choose
**From preset** to see the picker. Select a preset, fill in the param fields,
optionally change the name and schedule, and click **Create**.

### REST (curl)

```bash
curl -s -X POST https://api.impri.dev/v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "reddit-keyword",
    "params": {
      "query": "self-hosting AI",
      "subreddit": "selfhosted"
    },
    "schedule": { "every": "30m" }
  }'
```

### Python

```python
from impri import ImpriClient

client = ImpriClient()  # reads IMPRI_API_KEY from env

# Browse the preset catalog
catalog = client.list_watcher_presets()
for p in catalog["presets"]:
    print(p["id"], "-", p["title"])

# Create a watcher from a preset
watcher = client.create_watcher_from_preset(
    "github-releases",
    params={"owner": "fastify", "repo": "fastify"},
)
print(watcher["id"], watcher["status"])

# With a custom schedule and explicit name
reddit = client.create_watcher_from_preset(
    "reddit-keyword",
    params={"query": "self-hosting AI", "subreddit": "selfhosted"},
    schedule={"every": "30m"},
    name="Self-hosting AI on Reddit",
)
```

### TypeScript

```ts
import { ImpriClient } from '@impri/sdk'

const client = new ImpriClient()  // reads IMPRI_API_KEY from env

// Browse the preset catalog
const presets = await client.listWatcherPresets()
presets.forEach(p => console.log(p.id, '-', p.title))

// Create a watcher from a preset (no params required)
const hn = await client.createWatcherFromPreset('hn-front-page')
console.log(hn.id, hn.status)

// With params
const arxiv = await client.createWatcherFromPreset('arxiv-papers', {
  category: 'cs.AI',
  query: 'large language models',
})
console.log(arxiv.id, arxiv.status)

// With a custom schedule and name override
const reddit = await client.createWatcherFromPreset(
  'reddit-keyword',
  { query: 'self-hosting AI', subreddit: 'selfhosted' },
  { schedule: { every: '30m' }, name: 'Self-hosting AI on Reddit' },
)
```

### MCP (Claude Code / agents)

The MCP server (`npx @impri/mcp`) exposes two dedicated tools for working
with presets.

**`impri_list_watcher_presets`** — no inputs required; returns the full preset
catalog grouped by category, including each preset's id, required and optional
params, and default schedule. Call this first to discover which preset fits
your monitoring goal.

**`impri_create_watcher_from_preset`** — creates a watcher by supplying the
preset id and param values. Example for GitHub releases with a custom schedule:

```json
{
  "preset_id": "github-releases",
  "params": { "owner": "fastify", "repo": "fastify" },
  "schedule": { "every": "2h" }
}
```

Example for Hacker News keyword watch (no schedule override needed):

```json
{
  "preset_id": "hn-keyword",
  "params": { "keyword": "rust programming", "min_points": "25" }
}
```

The `name` field is optional in both tools; when omitted the server defaults to
`"{preset title}: {primary param value}"`.

---

## Security note on watcher payloads

Regardless of how a watcher is created, every item it discovers comes from an
external source (HN, Reddit, GitHub, arXiv, …). These items arrive in the
inbox with `payload.untrusted = true`. Treat their `title`, `url`, and
`preview` as external data — **never inject them into LLM instructions or
system prompts without sanitization.** This applies to preset-based watchers
the same as to hand-crafted ones.

Python: `action.is_untrusted`. TypeScript: `action.isUntrusted`.

---

## Preset catalog

### Community

---

#### `hn-front-page` — Hacker News Front Page

Delivers every new post that appears on the HN front page via the official RSS
feed. No filtering is applied by default; add ScoringRules after creation to
surface topics you care about.

**Params:** none  
**Default schedule:** `30m`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "hn-front-page", "params": {}}'
```

---

#### `hn-keyword` — Hacker News – Keyword

HN posts whose title or text mention a keyword, pre-filtered server-side by
minimum upvote points via [hnrss.org](https://hnrss.org).

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `keyword` | yes | Word or phrase to search for in HN posts | `rust programming` |
| `min_points` | no | Minimum upvote points; defaults to 10 | `25` |

**Default schedule:** `30m`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "hn-keyword",
    "params": { "keyword": "rust programming", "min_points": "25" }
  }'
```

---

#### `hn-show-ask` — Hacker News – Show/Ask HN

Show HN or Ask HN posts from Hacker News.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `type` | yes | `"show"` for Show HN posts, `"ask"` for Ask HN posts | `show` |

**Default schedule:** `1h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "hn-show-ask", "params": {"type": "show"}}'
```

---

#### `reddit-subreddit` — Reddit – Subreddit New Posts

New posts from a subreddit sorted by new, via Reddit's public RSS feed.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `subreddit` | yes | Subreddit name without the `r/` prefix | `MachineLearning` |

**Default schedule:** `30m`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "reddit-subreddit", "params": {"subreddit": "MachineLearning"}}'
```

---

#### `reddit-keyword` — Reddit – Keyword Search

Reddit posts matching a search query, optionally scoped to a single subreddit.
Supports Reddit search operators such as `title:`, `flair:`, and boolean `AND`/`OR`.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `query` | yes | Search query; supports Reddit operators | `self-hosting AI` |
| `subreddit` | no | Limit search to this subreddit; omit or use `"all"` for all of Reddit | `selfhosted` |

**Default schedule:** `30m`  
**Kind:** `reddit_search`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "reddit-keyword",
    "params": { "query": "self-hosting AI", "subreddit": "selfhosted" }
  }'
```

---

### Developer

---

#### `github-releases` — GitHub – Repository Releases

New releases published to a public GitHub repository via the Atom releases
feed. No auth required.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `owner` | yes | GitHub username or org | `fastify` |
| `repo` | yes | Repository name | `fastify` |

**Default schedule:** `1h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "github-releases", "params": {"owner": "fastify", "repo": "fastify"}}'
```

---

#### `github-commits` — GitHub – Repository Commits

New commits pushed to the default branch of a public GitHub repository. On
active repos this feed can be high-frequency; consider adding keyword filters
after creation to match specific commit message patterns.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `owner` | yes | GitHub username or org | `torvalds` |
| `repo` | yes | Repository name | `linux` |
| `feed` | no | `"commits"` (default) for commit history, `"tags"` for new tags | `commits` |

**Default schedule:** `1h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "github-commits",
    "params": {"owner": "torvalds", "repo": "linux"},
    "schedule": {"every": "6h"}
  }'
```

---

#### `npm-package` — npm – Package New Version

Watches for new versions of an npm package by polling the registry's
`/latest` endpoint. The endpoint returns stable metadata that changes only
when a new version is published, making it a reliable `url_diff` trigger.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `package` | yes | Package name; include the full scope for scoped packages | `@types/react` |

**Default schedule:** `6h`  
**Kind:** `url_diff`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "npm-package", "params": {"package": "@types/react"}}'
```

---

#### `pypi-package` — PyPI – Package New Release

New releases of a Python package on PyPI, via the official per-project RSS
feed.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `package` | yes | PyPI package name (normalized to lowercase) | `requests` |

**Default schedule:** `6h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "pypi-package", "params": {"package": "requests"}}'
```

---

#### `stackoverflow-tag` — Stack Overflow – Tag Questions

New questions tagged with a specific Stack Overflow tag. The same URL pattern
works for other Stack Exchange sites by changing the `name` and `schedule`
after creation.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `tag` | yes | Tag name (lowercase, max 35 chars) | `typescript` |

**Default schedule:** `30m`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "stackoverflow-tag", "params": {"tag": "typescript"}}'
```

---

### Content

---

#### `rss-feed` — Generic RSS / Atom Feed

Follow any publicly accessible RSS 2.0 or Atom feed by URL. Both formats are
supported. The URL is passed through the existing SSRF guard; private-IP
addresses are blocked at both parse time and fetch time.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `url` | yes | Full http/https URL of the feed | `https://martinfowler.com/feed.atom` |

**Default schedule:** `1h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "rss-feed", "params": {"url": "https://martinfowler.com/feed.atom"}}'
```

---

#### `blog-newsletter` — Blog / Newsletter

Follow a blog or newsletter RSS/Atom feed. When `keywords` is supplied, only
posts matching at least one keyword are delivered; omit it to receive all
posts. Scored at `min_score = 10` when keywords are active, `0` otherwise.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `url` | yes | RSS or Atom feed URL | `https://newsletter.pragmaticengineer.com/feed` |
| `keywords` | no | Comma-separated list of topic keywords | `AI, LLM, architecture` |

**Default schedule:** `12h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "blog-newsletter",
    "params": {
      "url": "https://newsletter.pragmaticengineer.com/feed",
      "keywords": "AI, LLM, architecture"
    }
  }'
```

---

#### `youtube-channel` — YouTube Channel – New Videos

New video uploads from a YouTube channel via YouTube's official public Atom
feed. No API key or auth required.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `channel_id` | yes | Channel ID starting with `UC`, 24 characters total. Find it at `youtube.com/channel/UC…` or on the channel's About page. | `UCnUYZLuoy1rq1aVMwx4aTzw` |

**Default schedule:** `6h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "youtube-channel", "params": {"channel_id": "UCnUYZLuoy1rq1aVMwx4aTzw"}}'
```

---

### Research

---

#### `arxiv-papers` — arXiv – New Papers

New preprints on arXiv by subject category, keyword query, or both. At least
one of `category` or `query` is required.

When both are provided the category RSS feed is used and keyword scoring is
applied in-process. When only `query` is provided the arXiv search API
(Atom) is used. When only `category` is provided all new submissions in that
category are delivered without keyword filtering.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `category` | if no `query` | arXiv subject category code | `cs.AI` |
| `query` | if no `category` | Keyword or phrase to search across all arXiv metadata | `large language models` |

**Default schedule:** `6h`  
**Kind:** `rss`

```bash
# Category only
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "arxiv-papers", "params": {"category": "cs.AI"}}'

# Category + keyword filter
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "arxiv-papers",
    "params": {"category": "cs.AI", "query": "large language models"}
  }'
```

---

### News

---

#### `google-news` — Google News – Keyword

News articles matching a search query from the Google News RSS feed. Supports
boolean operators (`AND`, `OR`), `site:`, and exact phrase quoting.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `query` | yes | News search query (max 500 chars) | `AI regulation Europe` |
| `language` | no | Language and region in `hl-gl` format; defaults to `en-US` | `de-DE` |

**Default schedule:** `1h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "google-news",
    "params": {"query": "AI regulation Europe"}
  }'
```

---

#### `product-hunt` — Product Hunt – Daily Posts

New products launched on Product Hunt via the public RSS feed. The feed is
high-volume; add ScoringRule keywords after creation (e.g. `"developer"`,
`"open source"`) to surface launches relevant to you.

**Params:** none  
**Default schedule:** `6h`  
**Kind:** `rss`

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "product-hunt", "params": {}}'
```

---

### Monitoring

---

#### `url-changed` — Website Page Changed

Delivers a notification whenever the full content of any web page changes.
Uses SHA-256 of the fetched page text; any change triggers a `watcher.triage`
action regardless of keyword scoring.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `url` | yes | Full http/https URL of the page to monitor | `https://example.com/pricing` |

**Default schedule:** `6h`  
**Kind:** `url_diff`

Note: the scheduler respects `robots.txt`. If the `Impri-Watcher` user-agent
is disallowed, the watcher is degraded with `error: robots_disallowed` rather
than crawling.

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "url-changed", "params": {"url": "https://example.com/pricing"}}'
```

---

#### `changelog-status` — Changelog / Status Page

Watch a changelog or incident/status page for updates. Identical to
`url-changed` in construction but uses a `1h` default schedule (vs `6h`)
to reflect the operational urgency of status pages.

**Params:**

| Name | Required | Description | Example |
|------|----------|-------------|---------|
| `url` | yes | URL of the changelog or status page | `https://www.githubstatus.com/` |

**Default schedule:** `1h`  
**Kind:** `url_diff`

Note: status pages that render dynamic content may fire on non-meaningful JS
bundle hash changes. Consider adding keywords such as `"incident"`,
`"degraded"`, or `"version"` after creation to filter for genuine signal.

```bash
curl -s -X POST .../v1/watchers/from-preset \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"preset_id": "changelog-status", "params": {"url": "https://www.githubstatus.com/"}}'
```

---

## Quick-reference index

| ID | Title | Kind | Default schedule | Params |
|----|-------|------|-----------------|--------|
| `hn-front-page` | Hacker News Front Page | rss | 30m | — |
| `hn-keyword` | Hacker News – Keyword | rss | 30m | `keyword`, `min_points` |
| `hn-show-ask` | Hacker News – Show/Ask HN | rss | 1h | `type` |
| `reddit-subreddit` | Reddit – Subreddit New Posts | rss | 30m | `subreddit` |
| `reddit-keyword` | Reddit – Keyword Search | reddit_search | 30m | `query`, `subreddit` |
| `github-releases` | GitHub – Repository Releases | rss | 1h | `owner`, `repo` |
| `github-commits` | GitHub – Repository Commits | rss | 1h | `owner`, `repo`, `feed` |
| `npm-package` | npm – Package New Version | url_diff | 6h | `package` |
| `pypi-package` | PyPI – Package New Release | rss | 6h | `package` |
| `stackoverflow-tag` | Stack Overflow – Tag Questions | rss | 30m | `tag` |
| `rss-feed` | Generic RSS / Atom Feed | rss | 1h | `url` |
| `blog-newsletter` | Blog / Newsletter | rss | 12h | `url`, `keywords` |
| `youtube-channel` | YouTube Channel – New Videos | rss | 6h | `channel_id` |
| `arxiv-papers` | arXiv – New Papers | rss | 6h | `category`, `query` |
| `google-news` | Google News – Keyword | rss | 1h | `query`, `language` |
| `product-hunt` | Product Hunt – Daily Posts | rss | 6h | — |
| `url-changed` | Website Page Changed | url_diff | 6h | `url` |
| `changelog-status` | Changelog / Status Page | url_diff | 1h | `url` |
