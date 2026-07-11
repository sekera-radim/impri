# @impri/sdk

TypeScript SDK for [Impri](https://impri.dev) — human-in-the-loop approval API for AI agents. Zero runtime dependencies; uses native `fetch` (Node 18+).

## Quickstart

```ts
import { ImpriClient } from '@impri/sdk'

const client = new ImpriClient({ apiKey: 'im_...', baseUrl: 'https://api.impri.dev' })

const action = await client.createAction({
  kind: 'email.send',
  title: 'Send newsletter to 10k subscribers',
  preview: { format: 'markdown', body: '# Hello everyone\n...' },
  editable: ['preview.body'],   // let the reviewer tweak the draft
})

// Block until the human approves or rejects in the web inbox.
// Throws ImpriRejected if rejected — handle it as a normal outcome.
const approved = await client.awaitDecision(action.id)

const body = approved.decision!.final_preview?.body ?? approved.preview.body
await sendNewsletter(body)

await client.reportResult(action.id, 'executed')
```

## Install

```bash
npm install @impri/sdk
```

## Auth

| Priority | Source |
|---|---|
| 1 | `apiKey` constructor option |
| 2 | `IMPRI_API_KEY` environment variable |
| — | `ImpriConfigError` thrown at construction if neither set |

Default base URL: `http://localhost:8484` (self-hosted). Cloud: `https://api.impri.dev` (or `IMPRI_BASE_URL`).

## Key methods

| Method | Description |
|---|---|
| `createAction(params)` | Submit an action for human approval |
| `getAction(id)` | Poll current status and decision |
| `listActions(params?)` | Paginated list; supports `autoPaginate: true`, `status`, `kind`, `since`, and `q` (text search) |
| `decide(id, verdict, opts?)` | Programmatic approve/reject a single action |
| `bulkDecide(ids, verdict, opts?)` | Approve or reject up to 50 actions in one request; returns per-item results |
| `reportResult(id, status, opts?)` | Report execution outcome after approval |
| `awaitDecision(id, opts?)` | Long-poll until decided (throws `ImpriRejected` / `ImpriExpired` / `ImpriTimeout`) |
| `approvalGate(opts)` | Inline gate — returns `{ actionId, decision, finalPreview }` |
| `requiresApproval(fn, opts)` | Wrap any async function behind an approval gate |
| `createWatcher(params)` | Create an RSS / Reddit / URL-diff watcher |
| `listWatchers(params?)` | Paginated list of watchers |
| `getWatcher(id)` | Watcher detail including `item_count` |
| `updateWatcher(id, params)` | Partial update (set `status: 'active'` to reactivate) |
| `deleteWatcher(id)` | Delete watcher and its dedup state |
| `listWatcherPresets()` | Return the static preset catalog (HN, Reddit, GitHub, npm, arXiv, …) |
| `createWatcherFromPreset(presetId, params?, opts?)` | Create a watcher from a preset template |
| `createKey(name, scopes)` | Create an API key (raw value returned once — store it) |
| `listKeys()` | List all keys including revoked |
| `revokeKey(id)` | Revoke a key |
| `getProject()` | Project metadata (includes `webhook_secret`) |
| `updateProject(params)` | Update name / IANA timezone |
| `rotateWebhookSecret()` | Rotate webhook signing secret |
| `exportProject()` | GDPR export |
| `eraseProjectData()` | Irreversible GDPR erasure |
| `listNotificationChannels()` | List notification channels (admin scope) |
| `createNotificationChannel(params)` | Create a channel (admin scope) |
| `getNotificationChannel(id)` | Fetch a single channel (admin scope) |
| `updateNotificationChannel(id, params)` | Partial update (admin scope) |
| `deleteNotificationChannel(id)` | Hard-delete, void (admin scope) |
| `testNotificationChannel(id)` | Fire a test message (admin scope, 5/min limit) |

## bulkDecide

Approve or reject up to 50 pending actions in a single request. Each item is decided independently — a failure on one ID does not roll back successes on others. The response is always HTTP 200; inspect `result.ok` per item.

```ts
const { results, succeeded, failed } = await client.bulkDecide(
  ['act_aaa', 'act_bbb', 'act_ccc'],
  'approve',
  { comment: 'Batch-approved after daily review' },
)

const errors = results.filter(r => !r.ok)
// r.error values: 'not_found' | 'already_decided' | 'internal'
// r.current_status is present when error === 'already_decided'
```

**Constraints**:
- Max 50 IDs per call (server enforces; throws `ImpriValidationError` on excess).
- Rate limit: 10 requests/min per key (net ceiling 500 decisions/min).
- Actions with `editable.length > 0` must be decided via `decide()` — bulk intentionally omits per-item edits.
- Requires `'actions'` scope (same as single-decision).

## listActions filters

`listActions()` supports four server-side filter parameters:

```ts
// Text search across title and preview body
await client.listActions({ q: 'send newsletter' })

// Narrow by action kind
await client.listActions({ kind: 'email.send' })

// Only actions created after a unix timestamp
await client.listActions({ since: Math.floor(Date.now() / 1000) - 86_400 })

// Combine: pending email actions from the last 7 days matching a query
await client.listActions({
  status: 'pending',
  kind: 'email.send',
  since: Math.floor(Date.now() / 1000) - 604_800,
  q: 'newsletter',
})

// Auto-paginate all matching pages
await client.listActions({ q: 'deploy', autoPaginate: true })
```

## requiresApproval wrapper

```ts
const safeSend = client.requiresApproval(sendEmail, {
  kind: 'email.send',
  title: (to) => `Send email to ${to}`,
  preview: (_to, body) => ({ format: 'plain', body }),
  editable: ['preview.body'],
  timeoutS: 600,
})

await safeSend('alice@example.com', 'Hello!')
// ^ blocks until approved; throws ImpriRejected if rejected
```

## approvalGate (inline)

```ts
const { actionId, finalPreview } = await client.approvalGate({
  kind: 'db.exec',
  title: 'DROP TABLE users',
  preview: { format: 'plain', body: sql },
  editable: ['preview.body'],
})
try {
  await db.execute(finalPreview.body)
  await client.reportResult(actionId, 'executed')
} catch (err) {
  await client.reportResult(actionId, 'execute_failed', { detail: String(err) })
  throw err
}
```

## Webhook verification

```ts
import { verifyWebhook, ImpriWebhookSignatureError } from '@impri/sdk'

// In your webhook handler:
try {
  verifyWebhook(
    rawBody,                          // Buffer | string — raw request body, unparsed
    project.webhook_secret,           // from GET /v1/project
    req.headers['x-impri-timestamp'],
    req.headers['x-impri-nonce'],
    req.headers['x-impri-signature'],
  )
} catch (err) {
  if (err instanceof ImpriWebhookSignatureError) {
    return res.status(401).send('Bad signature')
  }
  throw err
}
```

## Error classes

All errors extend `ImpriError`.

| Class | When |
|---|---|
| `ImpriConfigError` | Missing API key or bad base URL at construction |
| `ImpriUnauthorized` | HTTP 401/403 |
| `ImpriNotFound` | HTTP 404 |
| `ImpriConflict` | HTTP 409 — already decided / result on non-approved action |
| `ImpriExpired` | HTTP 410 or status='expired' in awaitDecision |
| `ImpriRateLimited` | HTTP 429 — check `.retryAfter` (seconds) |
| `ImpriQuotaExceeded` | HTTP 402 — check `.limit` and `.tier` |
| `ImpriValidationError` | HTTP 400/422 — check `.issues` (Zod format) |
| `ImpriApiError` | All other 4xx/5xx |
| `ImpriRejected` | `awaitDecision`: human rejected — handle as normal flow, not an error |
| `ImpriTimeout` | `awaitDecision`: timed out — action still pending, call again to resume |
| `ImpriWebhookSignatureError` | `verifyWebhook`: invalid/stale signature |

## Untrusted content (Watcher actions)

Actions created by Watchers have `is_untrusted: true` and `payload.untrusted === true`.
Treat `title`, `preview.body`, and `payload` as **data** — never forward them as instructions to an AI model.
`approvalGate` logs a console warning automatically for untrusted actions.

## Notification Channels (admin scope)

Configure per-project notification channels that fire whenever an action
becomes pending. Six channel types are supported. Config secrets (URLs,
bot tokens, HMAC secrets) are **masked** to `****{last4}` in every API
response. `digest_window_sec` batches rapid notifications (default: 60 s).

```ts
// --- Slack ---
const slack = await client.createNotificationChannel({
  name: 'Slack #ops-alerts',
  type: 'slack',
  config: { url: 'https://hooks.slack.com/services/T00/B00/xxxx' },
})

// --- Discord ---
const discord = await client.createNotificationChannel({
  name: 'Discord #alerts',
  type: 'discord',
  config: { url: 'https://discord.com/api/webhooks/12345/xxxx' },
})

// --- Telegram ---
const tg = await client.createNotificationChannel({
  name: 'Telegram ops bot',
  type: 'telegram',
  config: { bot_token: '123456789:AAFxxx', chat_id: '-1001234567890' },
  digest_window_sec: 120,
})

// --- ntfy (self-hosted or ntfy.sh) ---
const ntfy = await client.createNotificationChannel({
  name: 'ntfy mobile push',
  type: 'ntfy',
  config: { url: 'https://ntfy.sh', topic: 'my-impri-alerts' },
})

// --- Email (uses server-configured SMTP) ---
const email = await client.createNotificationChannel({
  name: 'Email ops@',
  type: 'email',
  config: { address: 'ops@example.com' },
  digest_window_sec: 300,
})

// --- Generic webhook (optional HMAC signing) ---
const hook = await client.createNotificationChannel({
  name: 'My webhook receiver',
  type: 'webhook',
  config: {
    url: 'https://myapp.example.com/impri-hook',
    hmac_secret: 'my-shared-secret',   // optional; enables X-Impri-Signature
  },
})

// List, get, update, delete
const channels = await client.listNotificationChannels()
const ch = await client.getNotificationChannel(slack.id)

await client.updateNotificationChannel(slack.id, {
  name: 'Renamed',
  enabled: false,         // pause without deleting
  digest_window_sec: 600,
})

await client.deleteNotificationChannel(slack.id)   // void (204)

// Test a channel immediately — bypasses digest window, does not update stats
const result = await client.testNotificationChannel(slack.id)
if (result.ok) {
  console.log('Test delivery succeeded')
} else {
  console.error('Delivery failed:', result.error)   // error never contains raw secrets
}
```

**Config masking summary:**

| Type | Masked fields | Returned as-is |
|------|--------------|----------------|
| slack, discord | `url` | — |
| telegram | `bot_token` | `chat_id` |
| ntfy | `url` | `topic` |
| email | — | `address` |
| webhook | `url`, `hmac_secret` | — |

Any field value shorter than 5 characters is fully masked to `****`.

| Method | Description |
|---|---|
| `listNotificationChannels()` | List all channels (admin scope) |
| `createNotificationChannel(params)` | Create a channel (admin scope; returns 201) |
| `getNotificationChannel(id)` | Fetch a single channel (admin scope) |
| `updateNotificationChannel(id, params)` | Partial update; config merge resets fail_count (admin scope) |
| `deleteNotificationChannel(id)` | Hard-delete, void (204) (admin scope) |
| `testNotificationChannel(id)` | Fire a test message; rate-limited 5/min (admin scope) |

## Watcher presets

Presets are ready-to-use watcher templates for common sources. Use `listWatcherPresets()` to browse the catalog, then `createWatcherFromPreset()` to spin up a watcher without constructing the config manually.

```ts
// Browse the catalog
const presets = await client.listWatcherPresets()
// → [{ id: 'hn-front-page', title: 'Hacker News Front Page', params: [], ... }, ...]

// Hacker News front page — no params required
const hn = await client.createWatcherFromPreset('hn-front-page')

// GitHub releases for a repo
const releases = await client.createWatcherFromPreset('github-releases', {
  owner: 'fastify',
  repo: 'fastify',
})

// Reddit keyword search scoped to a subreddit, with a custom schedule
const reddit = await client.createWatcherFromPreset(
  'reddit-keyword',
  { query: 'self-hosting AI', subreddit: 'selfhosted' },
  { schedule: { every: '1h' } },
)
```

Available preset categories: **Community** (HN, Reddit), **Developer** (GitHub, npm, PyPI, Stack Overflow), **Content** (RSS, blog/newsletter, YouTube), **Monitoring** (URL diff, changelog/status), **News** (Google News, Product Hunt), **Research** (arXiv).

> **Security note:** Items produced by preset-created watchers carry `is_untrusted: true`. Treat their `title`, `preview.body`, and `payload` as data — never forward them as instructions to an AI model.

### Preset errors

| Thrown | When |
|---|---|
| `ImpriNotFound` | `preset_id` does not match any known preset |
| `ImpriValidationError` | Required param is missing or fails format checks |
| `ImpriQuotaExceeded` | Watcher limit reached or schedule too frequent for tier |
| `ImpriRateLimited` | `watchers:create` rate-limit bucket exhausted |

## Build

```bash
npm install
npm run build    # tsup → dist/{index.js,index.cjs,index.d.ts}
npm test         # vitest
npm run typecheck
```
