# TypeScript SDK

> **Status — v0.1, pre-release.** The SDK lives at `sdk/typescript/` in this repository. It is not yet published to npm. Install it from the local source while the package matures. The REST API it wraps is stable and works the same against the hosted cloud (`api.impri.dev`, early beta) or a self-hosted instance.

```bash
# From the repo root
npm install ./sdk/typescript
# or: pnpm add ./sdk/typescript
```

Requires **Node 18+** (uses native `fetch`). No runtime dependencies beyond the Node stdlib.

---

## Setup

```typescript
import { ImpriClient } from '@impri/sdk'

const client = new ImpriClient({
  apiKey: 'im_...',                    // or set IMPRI_API_KEY env var
  baseUrl: 'http://localhost:8484',    // or set IMPRI_BASE_URL; default is localhost:8484
})

// Cloud:
// const client = new ImpriClient({ apiKey: 'im_...', baseUrl: 'https://api.impri.dev' })
```

The constructor throws `ImpriConfigError` if neither `apiKey` nor `IMPRI_API_KEY` is set. `baseUrl` defaults to `http://localhost:8484` (self-hosted). Trailing slashes are stripped internally. The client appends `/v1` before every path; callers never include it.

---

## Types

All types are exported from `@impri/sdk`:

```typescript
import type {
  Preview,
  ActionStatus,
  Action,
  ActionCreated,
  Decision,
  DecisionResult,
  ResultAck,
  PagedResult,
  Watcher,
  WatcherKind,
  WatcherConfig,
  WatcherSchedule,
  ScoringRule,
  ApiKey,
  ApiKeyCreated,
  Project,
  CreateActionParams,
  ApprovalGateResult,
} from '@impri/sdk'
```

Key types:

```typescript
type Preview = { format: 'markdown' | 'plain' | 'diff'; body: string }
// body max 256 KB

type ActionStatus =
  | 'pending' | 'approved' | 'rejected'
  | 'expired' | 'executed' | 'execute_failed'

interface Action {
  id: string
  kind: string
  title: string
  status: ActionStatus
  preview: Preview
  payload: unknown | null
  target_url: string | null
  callback_url: string | null
  expires_at: number        // Unix timestamp
  idempotency_key: string | null
  editable: string[]
  created_at: number
  updated_at: number
  webhook_delivery: WebhookDelivery | null
  decision: Decision | null  // null while pending
  is_untrusted: boolean      // true when delivered by a Watcher
}

interface Decision {
  verdict: 'approve' | 'reject'
  decided_at: number
  channel: string | null
  final_preview: Preview | null  // use for execution; may be human-edited
  diff: string | null            // unified patch if reviewer changed preview.body
}
```

---

## Approval Inbox

### `createAction`

```typescript
const action = await client.createAction({
  kind: 'email.send',
  title: 'Outreach: partnership proposal to acme.com',
  preview: { format: 'markdown', body: 'Hi Alice, ...' },
  payload: { to: 'alice@acme.com', threadId: 't_123' },
  targetUrl: 'https://mail.acme.com/thread/123',
  callbackUrl: 'https://your-agent.example.com/webhook',
  expiresIn: 86400,              // seconds; min 300, max 2_592_000 (30 days), default 259_200 (72 h)
  idempotencyKey: 'batch-2026-07-11-acme',
  editable: ['preview.body'],
})
// action.id, action.status === 'pending', action.inboxUrl, action.expiresAt
```

Requires `actions` scope. Rate-limited to **60 POST/min per key**.

Returns `201` on a new action and `200` when an existing one is found via `idempotencyKey` or a soft-duplicate (same `kind` + `title` + preview hash, already pending). Check `action.duplicateOf` to distinguish — if set, it holds the original action's id.

### `getAction`

```typescript
const action = await client.getAction('act_abc123')

if (action.decision) {
  console.log(action.decision.verdict)         // 'approve' | 'reject'
  console.log(action.decision.finalPreview)    // use this for execution
  console.log(action.decision.diff)            // present if reviewer edited
}
```

Throws `ImpriNotFound` (404) if unknown or belonging to a different project.

### `listActions`

```typescript
const page = await client.listActions({
  status: 'pending',           // ActionStatus
  kind: 'email.send',
  since: 1720000000,           // Unix timestamp
  limit: 50,                   // max 100
  cursor: page.nextCursor,
})

for (const action of page.items) {
  console.log(action.id, action.status)
}

if (page.hasMore) {
  const next = await client.listActions({ cursor: page.nextCursor })
}
```

Pass `autoPaginate: true` to receive an async generator:

```typescript
for await (const action of client.listActions({ status: 'approved', autoPaginate: true })) {
  console.log(action.id)
}
```

Rate-limited to **300 GET/min per key**.

### `awaitDecision`

Push an action and block until decided:

```typescript
import { ImpriRejected, ImpriExpired, ImpriTimeout } from '@impri/sdk'

const created = await client.createAction({
  kind: 'db.exec',
  title: 'DROP TABLE sessions',
  preview: { format: 'plain', body: sql },
  editable: ['preview.body'],
})

try {
  const action = await client.awaitDecision(created.id, {
    timeoutS: 300,          // throw ImpriTimeout after this; action stays pending server-side
    pollIntervalS: 5,       // minimum recommended is 5 s
  })
  // action.status === 'approved'
  const sqlToRun = action.decision!.finalPreview!.body

} catch (e) {
  if (e instanceof ImpriRejected) {
    // Human said no — normal flow, not an error.
    // e.actionId, e.decision, e.finalPreview
    console.log('Rejected.')
  } else if (e instanceof ImpriExpired) {
    console.log('Approval window closed.')
  } else if (e instanceof ImpriTimeout) {
    // timeout elapsed; action is still pending server-side
    console.log('Timed out.')
  } else {
    throw e
  }
}
```

`awaitDecision` polls `GET /v1/actions/:id` internally. Do not set `pollIntervalS` below 5 s; the rate limit is 300 req/min.

### `decide`

Used primarily by the web inbox. Expose it in scripts that programmatically approve or reject:

```typescript
const result = await client.decide('act_abc123', 'approve', {
  edited: { 'preview.body': 'Edited copy.' },  // restricted to action.editable
  channel: 'bot-script',
})
```

Throws `ImpriConflict` (409) if already decided or two writers race. Only call on pending actions.

### `bulkDecide`

Approve or reject up to 50 actions in one request.

```typescript
const { results, succeeded, failed } = await client.bulkDecide(
  ['act_aaa', 'act_bbb', 'act_ccc'],
  'approve',
  { comment: 'Batch approved after review' },
)
console.log(`Succeeded: ${succeeded}, Failed: ${failed}`)
const errors = results.filter(r => !r.ok)
```

Rate-limited to **10 requests/min per key** (net: 500 decisions/min). Each item is processed independently — a failure on one ID does not roll back successes on others. HTTP 200 is always returned; inspect each `result.ok`.

Per-item `error` values: `"not_found"`, `"already_decided"` (with `currentStatus`), or `"internal"`.

Actions with `editable.length > 0` must be decided via `decide()` so per-item field edits can be validated. The bulk endpoint intentionally omits the `edited` field.

### `reportResult`

Call after executing an approved action:

```typescript
try {
  await sendEmail(recipient, finalBody)
  await client.reportResult(action.id, 'executed')
} catch (err) {
  await client.reportResult(action.id, 'execute_failed', { detail: String(err) })
  throw err
}
```

Throws `ImpriConflict` (409) if the action is not in `approved` state.

---

## Ergonomic helpers

### `client.requiresApproval` higher-order wrapper

Wraps an async function so every call is gated through an Impri approval. On rejection it throws `ImpriRejected` without calling the underlying function.

```typescript
async function sendEmail(to: string, body: string): Promise<void> {
  await mailer.send({ to, subject: 'Hello', body })
}

const safeSend = client.requiresApproval(sendEmail, {
  kind: 'email.send',
  title: (to, _body) => `Send email to ${to}`,
  preview: (_to, body) => ({ format: 'plain' as const, body }),
  editable: ['preview.body'],
  timeoutS: 300,
})

await safeSend('alice@example.com', 'Hello!')
```

When `preview.body` was edited by the reviewer, the wrapper injects the edited body into the function's arguments before calling it. Extra keys (`expiresIn`, `idempotencyKey`, `payload`, etc.) are forwarded to `createAction`.

`title` and `preview` accept either a plain value or a function that receives the wrapped function's arguments at call time — use functions to build the title from runtime data.

### `client.approvalGate` inline helper

For cases where no single function wrapper exists or you need the decision object directly:

```typescript
const { actionId, decision, finalPreview } = await client.approvalGate({
  kind: 'db.exec',
  title: 'DROP TABLE users',
  preview: { format: 'plain', body: sql },
  editable: ['preview.body'],
  timeoutS: 120,
})

// On rejection approvalGate throws ImpriRejected automatically.

try {
  await db.execute(finalPreview.body)
  await client.reportResult(actionId, 'executed')
} catch (err) {
  await client.reportResult(actionId, 'execute_failed', { detail: String(err) })
  throw err
}
```

Unlike the Python `approval_gate` context manager, this is a plain `async` function — you are responsible for calling `reportResult` yourself. The Python ergonomics handle cleanup automatically; the TypeScript approach trades that convenience for a simpler mental model in a language without async context managers.

---

## Watchers

Monitor external sources and deliver matching items as actions with `is_untrusted: true`. Requires `watch` scope.

### `createWatcher`

```typescript
const watcher = await client.createWatcher({
  name: 'Impri mentions on Reddit',
  kind: 'reddit_search',
  config: { query: 'impri approval', subreddit: 'selfhosted' },
  schedule: { every: '1h', window: '08:00-22:00' },
  keywords: [
    { pattern: 'impri', points: 10 },
    { pattern: 'human-in-the-loop', points: 5 },
  ],
  keywordsNone: ['spam', 'advertisement'],
  minScore: 5,
})
```

`kind` options:
- `'rss'` — requires `config.url`
- `'reddit_search'` — requires `config.query`; optionally `config.subreddit`
- `'url_diff'` — requires `config.url`; fires when page content changes

`schedule.every` accepts `'30m'`, `'8h'`, `'1d'` (minimum 60 s). `schedule.window` is `'HH:MM-HH:MM'` in the project's IANA timezone.

### `listWatchers`

```typescript
const page = await client.listWatchers({
  status: 'degraded',  // active | paused | degraded
  kind: 'rss',
})
```

### `getWatcher`

```typescript
const watcher = await client.getWatcher('wat_abc123')
console.log(watcher.itemCount)  // total deduplicated items seen
```

### `updateWatcher`

```typescript
// Reactivate a degraded watcher
const watcher = await client.updateWatcher('wat_abc123', {
  status: 'active',  // resets failCount; schedules immediate run
})

// Pause without losing dedup state
await client.updateWatcher('wat_abc123', { status: 'paused' })
```

### `deleteWatcher`

```typescript
await client.deleteWatcher('wat_abc123')  // void; 204 No Content
```

### `listWatcherPresets`

```typescript
const presets = await client.listWatcherPresets()
for (const p of presets) {
  console.log(p.id, p.title, p.category)
  for (const param of p.params) {
    console.log(`  ${param.name} (${param.required ? 'required' : 'optional'})`)
  }
}
```

Returns the full preset catalog (18 presets) from an in-process constant — no DB read; safe to cache. Use `createWatcherFromPreset()` to instantiate.

Items delivered by preset-based watchers have `is_untrusted: true` — treat their content as data, not instructions.

### `createWatcherFromPreset`

```typescript
// Hacker News front page — no params required
const hn = await client.createWatcherFromPreset('hn-front-page')

// GitHub releases for a specific repo
const gh = await client.createWatcherFromPreset(
  'github-releases',
  { owner: 'fastify', repo: 'fastify' },
  { name: 'Fastify releases', schedule: { every: '1h' } },
)

// Reddit keyword search
const reddit = await client.createWatcherFromPreset(
  'reddit-keyword',
  { query: 'self-hosting AI', subreddit: 'selfhosted' },
)
```

Applies all standard guards: rate limit, tier watcher-count quota, SSRF validation, minimum schedule interval. Throws `ImpriQuotaExceeded` (402) when a tier limit would be breached.

---

## API keys (admin scope)

```typescript
// Create a key
const created = await client.createKey({
  name: 'my-agent',
  scopes: ['actions'],  // 'actions' | 'watch' | 'admin' (admin implies others)
})
console.log(created.key)  // raw im_... value — returned ONCE, store immediately

// List keys (raw values never returned after creation)
const keys = await client.listKeys()
for (const k of keys) {
  console.log(k.prefix, k.name, k.revoked)
}

// Revoke a key
await client.revokeKey('key_abc123')  // void; 204 No Content
```

---

## Project (admin scope)

```typescript
const project = await client.getProject()
console.log(project.webhookSecret)  // use for webhook signature verification

await client.updateProject({
  name: 'My Agent Project',
  timezone: 'America/New_York',  // IANA timezone
})

const { webhookSecret } = await client.rotateWebhookSecret()
// Update your webhook verifier with the new value immediately.

const exportData = await client.exportProject()
const ack = await client.eraseProjectData()
```

---

## Notification channels (admin scope)

```typescript
// List channels — config secrets masked to '****{last4}'
const channels = await client.listNotificationChannels()

// Create a channel
const channel = await client.createNotificationChannel({
  name: 'Ops Slack',
  type: 'slack',
  config: { url: 'https://hooks.slack.com/services/...' },
  enabled: true,
  digest_window_sec: 60,
})

// Available types and config shapes:
// 'slack'    { url }
// 'discord'  { url }
// 'telegram' { bot_token, chat_id }
// 'ntfy'     { url, topic }
// 'email'    { address }
// 'webhook'  { url, hmac_secret? }

// Get a single channel
const ch = await client.getNotificationChannel('ch_abc123')

// Partial update
const updated = await client.updateNotificationChannel('ch_abc123', {
  enabled: false,
  digest_window_sec: 300,
})

// Delete (hard delete; no cascade)
await client.deleteNotificationChannel('ch_abc123')   // void; 204

// Test — bypasses digest window; 5 req/min rate limit
const result = await client.testNotificationChannel('ch_abc123')
// { ok: true } or { ok: false, error: '...' }
```

---

## Audit log (admin scope)

```typescript
// Paginated query
const page = await client.listAudit({
  type: 'action.',        // dot-prefix filters all action.* events
  since: 1720000000,
  until: 1720100000,
  limit: 50,
})
for (const event of page.items) {
  console.log(event.event, event.actor, event.created_at)
}

// Auto-paginate all matching entries
const allRuleEvents = await client.listAudit({
  type: 'rule.',
  autoPaginate: true,
})

// Stream-export as ndjson or CSV (returns raw string)
const csv = await client.exportAudit({ format: 'csv', since: 1720000000 })
fs.writeFileSync('audit.csv', csv)
```

Audit filter params: `type` (exact event name or dot-prefix), `actor` (key ID), `entity_id` (action/rule/channel ID), `since` / `until` (Unix timestamps), `limit` (1–200, default 50), `cursor`, `autoPaginate`.

`exportAudit` is rate-limited to **5 requests/min**. The ip column is never included. See [Audit log](audit-log.md) for all event types.

---

## Webhook verification

```typescript
import { verifyWebhook, ImpriWebhookSignatureError } from '@impri/sdk'

app.post('/webhook', async (req, res) => {
  try {
    verifyWebhook(
      req.rawBody,                          // Buffer | string
      project.webhookSecret,
      req.headers['x-impri-timestamp'] as string,
      req.headers['x-impri-nonce'] as string,
      req.headers['x-impri-signature'] as string,
    )
  } catch (e) {
    if (e instanceof ImpriWebhookSignatureError) return res.status(400).end()
    throw e
  }

  const payload = req.body
  if (payload.status === 'approved') {
    const body = payload.final_preview?.body
    // enqueue execution
  }
  res.status(200).end()
})
```

`verifyWebhook` is a standalone export — it does not require a client instance and has no side effects. Algorithm: `sha256=HMAC-SHA256(secret, "${timestamp}.${nonce}.${rawBody}")`. Requests older than 5 minutes are rejected.

---

## Error handling

All typed exceptions extend `ImpriError extends Error`. Every exception carries `statusCode: number | undefined` and `responseBody: unknown`.

```typescript
import {
  ImpriError,
  ImpriConfigError,       // missing apiKey at construction
  ImpriUnauthorized,      // 401 / 403 — wrong key or missing scope
  ImpriNotFound,          // 404
  ImpriConflict,          // 409 — already decided; idempotency race
  ImpriExpired,           // 410 — approval window closed
  ImpriRateLimited,       // 429 — rate limit; check .retryAfter (seconds)
  ImpriQuotaExceeded,     // 402 — monthly quota; .limit, .tier
  ImpriRejected,          // not HTTP — thrown by awaitDecision on rejection
  ImpriTimeout,           // not HTTP — thrown by awaitDecision on timeout
  ImpriValidationError,   // 400 / 422 — schema error; .issues[]
  ImpriApiError,          // catch-all for other 4xx / 5xx
  ImpriWebhookSignatureError,
} from '@impri/sdk'

try {
  await client.createAction(...)
} catch (e) {
  if (e instanceof ImpriRateLimited) {
    await sleep((e.retryAfter ?? 1) * 1000)
    // retry
  } else if (e instanceof ImpriRejected) {
    // Normal outcome — handle, do not re-throw as an error.
  } else {
    throw e
  }
}
```

`ImpriRejected` is not an error to log — it is a valid human outcome and the core value of Impri.

---

## Untrusted payload flag

Actions delivered by a Watcher have `action.isUntrusted === true`. The ergonomic helpers (`requiresApproval`, `approvalGate`) emit a visible warning at runtime when this flag is set and do not inline the preview body into any field an LLM might interpret as an instruction.

---

## Reference

Full type declarations are in `sdk/typescript/src/index.ts`. The REST API contract is in `docs/llms.txt` and `server/src/openapi.ts`. The MCP client at `mcp/src/client.ts` is the reference implementation of the HTTP layer (native `fetch`, same error-handling switch) that both SDKs mirror.
