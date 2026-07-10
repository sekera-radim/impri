# @impri/mcp

MCP server for [Impri](https://impri.dev) — human-in-the-loop approval inbox for AI agents.

Agents submit actions for human review (approve/reject/edit) and poll for the decision before executing anything with side effects. Full audit trail in the Impri web and mobile inbox.

## Quickstart (Claude Code)

**1. Get an API key** at [impri.dev](https://impri.dev) or spin up the self-hosted server:

```bash
# self-host
docker compose up -d   # starts on http://localhost:8484
export IMPRI_API_KEY=im_your_key_here
```

**2. Register the MCP server in Claude Code:**

```bash
claude mcp add impri \
  -e IMPRI_API_KEY=im_your_key_here \
  -- npx @impri/mcp
```

For self-hosted with a custom URL:

```bash
claude mcp add impri \
  -e IMPRI_API_KEY=im_your_key_here \
  -e IMPRI_BASE_URL=http://localhost:8484 \
  -- npx @impri/mcp
```

Or add to `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "http://localhost:8484"
      }
    }
  }
}
```

**3. Verify it loaded:**

```
/mcp
```

You should see `impri` listed with 6 tools.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMPRI_API_KEY` | Yes | — | API key (`im_...`). Obtain from the Impri dashboard. |
| `IMPRI_BASE_URL` | No | `http://localhost:8484` | Base URL without `/v1`. Use `https://api.impri.dev` for the cloud. |

## Tools

### `impri_push_action`

Submit an action to the human approval inbox. Returns an `action_id` to use in follow-up calls.

```
kind: "reddit.comment"
title: "Reply: Why is resume advice so conflicting?"
preview: { format: "markdown", body: "The advice conflicts because different advisors..." }
target_url: "https://reddit.com/r/cscareerquestions/comments/..."
editable: ["preview.body"]
```

### `impri_await_decision`

Poll until the human decides (approve/reject) or the timeout elapses. Polls every 5 seconds.

```
action_id: "act_abc123"
timeout_s: 300       # default: 5 minutes
```

Decision statuses:
- `approved` — proceed with the action
- `rejected` — abort; the operator said no
- `expired` — approval window closed; create a new action if still needed

### `impri_report_result`

Report back whether you executed the approved action. Closes the audit loop.

```
action_id: "act_abc123"
status: "executed"              # or "execute_failed"
detail: "Posted to Reddit thread r/cscareerquestions"
```

### `impri_inbox_status`

Check how many actions are waiting for human decisions. Use before starting a batch to avoid overloading the reviewer.

### `impri_create_watcher` / `impri_list_watchers`

Phase 2 — not yet available. These tools are declared now so integrations can reference them without API changes when watchers ship.

## Full example loop (Claude Code system prompt)

```
You are a Reddit engagement agent. Before posting any comment or reply:
1. Call impri_inbox_status — if more than 5 actions are pending, pause.
2. Draft your reply.
3. Call impri_push_action with kind "reddit.comment", your draft in preview.body,
   the thread URL in target_url, and editable: ["preview.body"] so I can tweak it.
4. Call impri_await_decision(action_id, timeout_s=600).
5. If approved: post the (possibly edited) preview.body to Reddit, then
   call impri_report_result(action_id, "executed").
   If rejected: discard the draft and move on.
   If expired: log a note and skip this reply.
```

## Verifying webhooks

When Impri delivers a webhook to your `callback_url`, every request is signed with HMAC-SHA256 to prevent replay attacks and forgery. The `@impri/mcp` package exports a ready-made helper:

```typescript
import { verifyWebhookSignature } from "@impri/mcp/webhook";
```

Three headers carry the signing material:

| Header | Example | Description |
|---|---|---|
| `X-Impri-Signature` | `sha256=abc123…` | HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}` |
| `X-Impri-Timestamp` | `1752134400` | Unix epoch seconds (used to reject stale replays) |
| `X-Impri-Nonce` | `a1b2c3d4…` | Random hex string — unique per delivery |

### Express middleware

```typescript
import express from "express";
import { verifyWebhookSignature } from "@impri/mcp/webhook";

const app = express();

app.post(
  "/impri/webhook",
  express.raw({ type: "application/json" }),   // rawBody must be a string or Buffer
  (req, res) => {
    const rawBody =
      Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);

    const ok = verifyWebhookSignature({
      secret: process.env.IMPRI_WEBHOOK_SECRET!,
      rawBody,
      signatureHeader: req.headers["x-impri-signature"] as string,
      timestampHeader: req.headers["x-impri-timestamp"] as string,
      nonceHeader:     req.headers["x-impri-nonce"] as string,
      // toleranceSec: 300  ← default; increase for slow networks
    });

    if (!ok) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    console.log("Impri event:", event.event, event.action_id, event.status);
    res.sendStatus(200);
  },
);
```

### Fastify middleware

```typescript
import Fastify from "fastify";
import { verifyWebhookSignature } from "@impri/mcp/webhook";

const app = Fastify();

app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  done(null, body);
});

app.post("/impri/webhook", (request, reply) => {
  const rawBody = request.body as string;

  const ok = verifyWebhookSignature({
    secret: process.env.IMPRI_WEBHOOK_SECRET!,
    rawBody,
    signatureHeader: request.headers["x-impri-signature"] as string,
    timestampHeader: request.headers["x-impri-timestamp"] as string,
    nonceHeader:     request.headers["x-impri-nonce"] as string,
  });

  if (!ok) {
    return reply.status(401).send({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody);
  console.log("Impri event:", event.event, event.action_id);
  reply.send({ ok: true });
});
```

> **Important:** parse the body as a raw string **before** passing it to the helper. JSON-parsing and re-stringifying the body will change whitespace and field ordering, causing the HMAC to not match.

## Development

```bash
cd mcp
npm install
npm run typecheck    # TypeScript check
npm run lint         # ESLint
npm run test         # Vitest (16 tests)
npm run check        # all three
npm run build        # compile to dist/
```

Running the server locally for development:

```bash
IMPRI_API_KEY=im_dev_key node dist/index.js
```
