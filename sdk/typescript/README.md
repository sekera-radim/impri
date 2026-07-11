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
| `listActions(params?)` | Paginated list; supports `autoPaginate: true` |
| `decide(id, verdict, opts?)` | Programmatic approve/reject |
| `reportResult(id, status, opts?)` | Report execution outcome after approval |
| `awaitDecision(id, opts?)` | Long-poll until decided (throws `ImpriRejected` / `ImpriExpired` / `ImpriTimeout`) |
| `approvalGate(opts)` | Inline gate — returns `{ actionId, decision, finalPreview }` |
| `requiresApproval(fn, opts)` | Wrap any async function behind an approval gate |
| `createWatcher(params)` | Create an RSS / Reddit / URL-diff watcher |
| `listWatchers(params?)` | Paginated list of watchers |
| `getWatcher(id)` | Watcher detail including `item_count` |
| `updateWatcher(id, params)` | Partial update (set `status: 'active'` to reactivate) |
| `deleteWatcher(id)` | Delete watcher and its dedup state |
| `createKey(name, scopes)` | Create an API key (raw value returned once — store it) |
| `listKeys()` | List all keys including revoked |
| `revokeKey(id)` | Revoke a key |
| `getProject()` | Project metadata (includes `webhook_secret`) |
| `updateProject(params)` | Update name / IANA timezone |
| `rotateWebhookSecret()` | Rotate webhook signing secret |
| `exportProject()` | GDPR export |
| `eraseProjectData()` | Irreversible GDPR erasure |

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

## Build

```bash
npm install
npm run build    # tsup → dist/{index.js,index.cjs,index.d.ts}
npm test         # vitest
npm run typecheck
```
