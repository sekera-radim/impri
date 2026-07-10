# Webhooks

When a human approves or rejects an action in the Impri inbox, you can receive the decision in two ways: a webhook pushed to your server, or polling from your agent. Both are always available — they are not mutually exclusive.

---

## Overview

**Webhook**: Impri makes a POST request to your `callback_url` when a decision is recorded. Useful when your agent has a public URL and you want near-instant notification.

**Polling**: Your agent calls `GET /v1/actions/:id` in a loop until `status` changes from `pending`. Always works — no public URL required. The MCP tool `impri_await_decision` implements this automatically.

The source of truth is always the database. If a webhook delivery fails, polling still returns the correct state.

---

## Setting up a webhook

Pass `callback_url` when creating an action:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "email.send",
    "title": "Outreach: partnership proposal",
    "preview": { "format": "markdown", "body": "..." },
    "callback_url": "https://your-agent.example.com/impri/webhook",
    "expires_in": 86400
  }'
```

When the human makes a decision, Impri POSTs to `https://your-agent.example.com/impri/webhook`.

### Restrictions on callback URLs

For security, `callback_url` must be an `http://` or `https://` URL. `javascript:` and `data:` schemes are rejected. By default the SSRF guard also blocks URLs that resolve to private IP ranges (RFC 1918, loopback, link-local) — this protects against an agent being manipulated into sending secrets to an internal service. On an isolated intranet deployment you can opt out by setting `IMPRI_ALLOW_PRIVATE_TARGETS=1` in the server environment.

---

## Webhook payload

Impri sends a POST with `Content-Type: application/json`. The body is always a JSON object:

```json
{
  "event": "action.updated",
  "action_id": "act_abc123",
  "status": "approved",
  "decided_at": 1720000000,
  "verdict": "approve",
  "final_preview": {
    "format": "markdown",
    "body": "The advice conflicts because different advisors optimise..."
  },
  "diff": null
}
```

| Field | Type | Present when |
|-------|------|-------------|
| `event` | string | Always (`"action.updated"`) |
| `action_id` | string | Always |
| `status` | string | Always (`approved`, `rejected`, `expired`) |
| `decided_at` | number (unix) | When a human decision was recorded |
| `verdict` | string | When a human decision was recorded (`"approve"` or `"reject"`) |
| `final_preview` | object | When approved (carries human-edited content if editable fields were changed) |
| `diff` | string or null | When approved and the reviewer modified an editable field; a unified-style diff against the original |

When `diff` is present, `final_preview` contains the edited content. **Always use `final_preview.body` for execution — never the original** — because the reviewer may have changed it.

On rejection or expiry, `final_preview` and `diff` are absent. On expiry, `verdict` is absent; `status` is `"expired"`.

---

## Verifying the signature

Every webhook request carries three headers you should verify before processing:

| Header | Example | Description |
|--------|---------|-------------|
| `X-Impri-Signature` | `sha256=a3f...9c1` | HMAC-SHA256 of the raw request body |
| `X-Impri-Timestamp` | `1720000000` | Unix timestamp when the request was sent |
| `X-Impri-Nonce` | `a1b2c3d4e5f6a7b8` | Random hex string, unique per request |

The signature is computed over the concatenation `${timestamp}.${nonce}.${body}` using the shared `WEBHOOK_SECRET` you set in the server environment.

### Verification algorithm

```
expected = HMAC-SHA256(secret, "${timestamp}.${nonce}.${rawBody}")
signature = "sha256=" + hex(expected)
```

Compare `signature` to `X-Impri-Signature` using a constant-time comparison to avoid timing attacks.

**Python example:**

```python
import hashlib, hmac, time

def verify_impri_webhook(body: bytes, headers: dict, secret: str) -> bool:
    timestamp = headers.get("X-Impri-Timestamp", "")
    nonce = headers.get("X-Impri-Nonce", "")
    received_sig = headers.get("X-Impri-Signature", "")

    # Reject requests with a timestamp more than 5 minutes old
    if abs(time.time() - int(timestamp)) > 300:
        return False

    payload = f"{timestamp}.{nonce}.".encode() + body
    expected = "sha256=" + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected, received_sig)
```

**Node.js example:**

```javascript
import crypto from 'node:crypto';

function verifyImpriWebhook(rawBody, headers, secret) {
  const timestamp = headers['x-impri-timestamp'];
  const nonce = headers['x-impri-nonce'];
  const receivedSig = headers['x-impri-signature'];

  // Reject stale requests (>5 minutes clock skew)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const payload = `${timestamp}.${nonce}.${rawBody}`;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSig));
}
```

Each project has its own webhook signing secret. Fetch it with `GET /v1/project`
(admin scope) as `webhook_secret`, and use that value in the verification above.
Rotate it any time with `POST /v1/project/rotate-webhook-secret` — update your
verifier with the new value afterward. The server-level `WEBHOOK_SECRET` env var
is only a fallback for actions created before a project secret existed.

The `@impri/mcp` package ships a ready-made verifier — `import { verifyWebhookSignature } from '@impri/mcp/webhook'` — so you don't have to hand-roll the HMAC check.

---

## Retry schedule

If your endpoint does not return a 2xx response, Impri retries up to 5 times:

| Attempt | Delay after previous attempt |
|---------|------------------------------|
| 1 (initial) | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 25 minutes |
| 5 | 2 hours |
| 6 | 12 hours |

After the 6th attempt without a 2xx response, the delivery is moved to the **dead-letter queue (DLQ)**. The action remains in its final state in the database and can still be retrieved by polling. You will see the delivery status ("not delivered to agent") in the web UI.

The retry scheduler runs every 60 seconds inside the server process.

---

## Special response codes

Your webhook endpoint can return specific status codes to signal intent to Impri:

**`410 Gone`**: tells Impri the endpoint has been deregistered. Impri removes the `callback_url` from the action and stops all further delivery attempts. Use this to cleanly deregister a webhook when tearing down an agent.

**Any 2xx**: delivery confirmed. Impri marks the delivery as `delivered`.

**Anything else** (3xx, 4xx, 5xx, connection errors): delivery failed — Impri schedules a retry.

---

## Polling as the always-on fallback

Polling does not require a public URL and is always available regardless of whether you provided a `callback_url`.

```bash
# Poll until status is no longer "pending"
while true; do
  STATUS=$(curl -s https://api.impri.dev/v1/actions/$ACTION_ID \
    -H "Authorization: Bearer $IMPRI_API_KEY" | jq -r .status)
  [ "$STATUS" = "pending" ] || break
  sleep 10
done
```

The MCP tool `impri_await_decision` does this internally, polling every 5 seconds with a configurable timeout (default 300 seconds).

For list-based polling (e.g. an agent that processes all newly-approved actions on a schedule):

```bash
curl "https://api.impri.dev/v1/actions?status=approved&since=1719990000" \
  -H "Authorization: Bearer $IMPRI_API_KEY"
```

`since` is a Unix timestamp. The response is paginated with `has_more` and `next_cursor` for large result sets.

---

## Delivery status in the UI

The web inbox shows the webhook delivery status on each action card: `delivered`, `retry (attempt N/6)`, `dlq`, or `gone`. This makes it visible when an agent is not receiving decisions, without requiring you to check server logs.
