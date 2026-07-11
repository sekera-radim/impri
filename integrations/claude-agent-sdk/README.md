# @impri/claude-agent-sdk

Human-in-the-loop approval gate for [Claude Agent SDK](https://docs.anthropic.com/en/api/tool-use) tool calls via [Impri](https://impri.dev).

Before Claude executes a tool, this integration submits the proposed call to the Impri human inbox for approval. The operator sees a card with a preview of what the agent wants to do, approves or rejects it (optionally editing the content first), and only then does the agent proceed.

```
Agent proposes tool call
  → ImpriClient.createAction()   → pending in human inbox
  ← human approves / rejects
  → execute only if approved
  → ImpriClient.reportResult()   → audit trail closed
```

## Installation

```bash
npm install @impri/claude-agent-sdk
# peer dep (optional — you likely already have it)
npm install @anthropic-ai/sdk
```

Requires Node 18+ (uses native `fetch` and `node:crypto`).

## Quick start

```typescript
import Anthropic from "@anthropic-ai/sdk";
import {
  ImpriClient,
  makeToolResult,
  withImpriApproval,
  ImpriRejected,
  ImpriTimeout,
} from "@impri/claude-agent-sdk";

// ── 1. Set up clients ─────────────────────────────────────────────────────────

const impri = new ImpriClient({
  apiKey: process.env.IMPRI_API_KEY,     // required; or set IMPRI_API_KEY env var
  baseUrl: "https://api.impri.dev",      // cloud; default: http://localhost:8484
});

const anthropic = new Anthropic();

// ── 2. Define a tool and gate it behind Impri approval ────────────────────────

const sendEmailGated = withImpriApproval({
  // Original Anthropic tool definition — passed to Claude unchanged.
  toolDef: {
    name: "send_email",
    description: "Send an email to a recipient.",
    input_schema: {
      type: "object" as const,
      properties: {
        to:   { type: "string", description: "Recipient email address" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "body"],
    },
  },

  // The actual implementation — only called after human approval.
  execute: async ({ to, body }) => {
    await emailService.send({ to: String(to), body: String(body) });
    return `Email sent to ${to}.`;
  },

  impriClient: impri,

  // How the action appears in the Impri inbox.
  kind: "email.send",
  title: ({ to }) => `Send email to ${to as string}`,
  preview: ({ body }) => ({ format: "plain" as const, body: String(body) }),

  // Let the reviewer edit the body before approving.
  editable: ["preview.body"],

  // Wait up to 10 minutes for a human decision (default: 300 s).
  timeoutS: 600,
});

// ── 3. Run the agent loop ─────────────────────────────────────────────────────

const messages: Anthropic.MessageParam[] = [
  {
    role: "user",
    content: "Please send a welcome email to alice@example.com.",
  },
];

while (true) {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    tools: [sendEmailGated.toolDef],     // pass the original tool def
    messages,
  });

  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason === "end_turn") break;

  if (response.stop_reason === "tool_use") {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "send_email") {
        try {
          // handle() gates the call through Impri and executes it on approval.
          const content = await sendEmailGated.handle(block);
          toolResults.push(makeToolResult(block.id, content));
        } catch (err) {
          if (err instanceof ImpriRejected) {
            // Human said no — feed the rejection back to Claude so it can
            // explain to the user or try a different approach.
            toolResults.push(
              makeToolResult(
                block.id,
                `Action rejected: the human reviewer did not approve this email.`,
                true,
              ),
            );
          } else if (err instanceof ImpriTimeout) {
            toolResults.push(
              makeToolResult(block.id, "Approval timed out — inbox may be backed up.", true),
            );
          } else {
            throw err;
          }
        }
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}
```

## API reference

### `ImpriClient`

```typescript
const client = new ImpriClient({
  apiKey?: string,   // defaults to IMPRI_API_KEY env var
  baseUrl?: string,  // defaults to IMPRI_BASE_URL env var, then http://localhost:8484
});
```

#### Actions

| Method | Description |
|--------|-------------|
| `createAction(params)` | POST /v1/actions — submit for approval |
| `getAction(id)` | GET /v1/actions/:id |
| `listActions(params?)` | GET /v1/actions — cursor-paginated |
| `decide(id, params)` | POST /v1/actions/:id/decision |
| `reportResult(id, params)` | POST /v1/actions/:id/result |
| `awaitDecision(id, opts?)` | Polls until decided; throws ImpriRejected / ImpriExpired / ImpriTimeout |
| `approvalGate(opts)` | Creates + awaits in one call; you report result manually |
| `requiresApproval(fn, opts)` | HOF: wraps any async function with full approval flow |

#### Watchers

| Method | Description |
|--------|-------------|
| `createWatcher(params)` | POST /v1/watchers |
| `listWatchers(params?)` | GET /v1/watchers — cursor-paginated |
| `getWatcher(id)` | GET /v1/watchers/:id (includes item_count) |
| `updateWatcher(id, params)` | PATCH /v1/watchers/:id |
| `deleteWatcher(id)` | DELETE /v1/watchers/:id |

#### Keys & project

| Method | Description |
|--------|-------------|
| `createKey(name, scopes)` | POST /v1/keys — raw key returned once |
| `listKeys()` | GET /v1/keys |
| `revokeKey(id)` | DELETE /v1/keys/:id |
| `getProject()` | GET /v1/project |
| `updateProject(params)` | PATCH /v1/project |
| `rotateWebhookSecret()` | POST /v1/project/rotate-webhook-secret |
| `exportProject()` | GET /v1/project/export |
| `eraseProjectData()` | DELETE /v1/project/data |

### `withImpriApproval(opts)`

Wraps a Claude Agent SDK tool call with an Impri approval gate.

```typescript
const gated = withImpriApproval({
  toolDef:      AnthropicTool,              // passed to Claude unchanged
  execute:      (input) => Promise<T>,      // only called after approval
  impriClient:  ImpriClient,
  kind:         string,                     // e.g. 'email.send'
  title:        string | (input) => string,
  preview?:     Preview | (input) => Preview,   // defaults to JSON of input
  editable?:    string[],                   // e.g. ['preview.body']
  timeoutS?:    number,                     // default 300
  onRejected?:  (err: ImpriRejected) => string, // custom rejection message
});

// gated.toolDef  — original tool def (pass to Anthropic client.messages.create)
// gated.handle   — (ToolUseBlock) => Promise<string>  (call in agent loop)
// gated.execute  — the raw executor (for testing)
```

### `client.requiresApproval(fn, opts)`

Higher-order wrapper for plain async functions (no Anthropic tool shape needed).

```typescript
const safeSend = client.requiresApproval(
  async (to: string, body: string) => sendEmail({ to, body }),
  {
    kind: "email.send",
    title: (to) => `Send email to ${to}`,
    preview: (_to, body) => ({ format: "plain" as const, body }),
    editable: ["preview.body"],
  },
);
await safeSend("alice@example.com", "Hello!");
```

The wrapper:
1. Creates an Impri action.
2. Blocks until a human approves or rejects.
3. On approval: calls the original function (injecting human-edited `body` when the reviewer changed it).
4. Reports the result.
5. On rejection: throws `ImpriRejected` without calling the function.

### `client.approvalGate(opts)`

Lower-level inline gate — use when the gated work is not a single function call.

```typescript
const { actionId, finalPreview } = await client.approvalGate({
  kind: "db.exec",
  title: "DROP TABLE users",
  preview: { format: "plain", body: sql },
  editable: ["preview.body"],
});

try {
  await db.execute(finalPreview.body); // use finalPreview — human may have edited it
  await client.reportResult(actionId, { status: "executed" });
} catch (err) {
  await client.reportResult(actionId, {
    status: "execute_failed",
    detail: String(err),
  });
  throw err;
}
```

### `verifyWebhook(params)`

Standalone HMAC-SHA256 signature verification — no client instance needed.

```typescript
import { verifyWebhook, ImpriWebhookSignatureError } from "@impri/claude-agent-sdk";

app.post("/impri-webhook", (req, res) => {
  try {
    verifyWebhook({
      rawBody:   req.rawBody,                              // unparsed Buffer or string
      secret:    process.env.IMPRI_WEBHOOK_SECRET!,
      timestamp: req.headers["x-impri-timestamp"] as string,
      nonce:     req.headers["x-impri-nonce"] as string,
      signature: req.headers["x-impri-signature"] as string,
    });
  } catch (err) {
    if (err instanceof ImpriWebhookSignatureError) {
      return res.status(401).send("Bad signature");
    }
    throw err;
  }
  // Signature valid — process the webhook payload.
  const event = req.body;
  // ...
  res.sendStatus(200);
});
```

### Error classes

All errors extend `ImpriError`.

| Class | When |
|-------|------|
| `ImpriConfigError` | API key missing at construction time |
| `ImpriUnauthorized` | 401 / 403 — wrong key or missing scope |
| `ImpriNotFound` | 404 — action / watcher not found |
| `ImpriConflict` | 409 — already decided or result on non-approved action |
| `ImpriExpired` | 410 — approval window closed |
| `ImpriRateLimited` | 429 — rate limit; carries `.retryAfter` (seconds) |
| `ImpriQuotaExceeded` | 402 — monthly limit reached (cloud tiers) |
| `ImpriValidationError` | 400 / 422 — request schema error; carries `.issues` |
| `ImpriApiError` | other 4xx / 5xx |
| `ImpriRejected` | Human rejected the action (not an HTTP error) — handle as normal flow |
| `ImpriTimeout` | `awaitDecision` timeout elapsed — action is still pending |
| `ImpriWebhookSignatureError` | Webhook signature mismatch |

`ImpriRejected` is a normal workflow outcome — the human said no. Catch it separately and do not treat it as an unexpected error.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IMPRI_API_KEY` | — | Bearer token (`im_...`). Required unless passed to constructor. |
| `IMPRI_BASE_URL` | `http://localhost:8484` | Base URL (no trailing slash, no `/v1`). |

## Self-hosting

Point `baseUrl` at your self-hosted Impri instance:

```typescript
const impri = new ImpriClient({
  apiKey: process.env.IMPRI_API_KEY,
  baseUrl: "http://your-impri-host:8484",
});
```

Cloud: `https://api.impri.dev`. See [impri.dev/docs](https://impri.dev/docs) for self-hosting instructions.

## License

MIT
