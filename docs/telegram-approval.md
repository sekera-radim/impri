# Telegram Approval Bot

Impri can send pending-action notifications to a Telegram chat with
**Approve** and **Reject** buttons that let your team decide without
ever opening a browser. The decision is recorded in Impri with the same
integrity guarantees as a web-inbox decision.

This is an extension of the existing `telegram` notification channel
(see [Notification channels](notifications.md)). When `approval_mode`
is `false` (the default), the channel behaves exactly as before —
a plain HTML notification with a "Review in Impri" link. Setting
`approval_mode: true` enables the inline-keyboard approval flow
described here.

---

## How it works

1. An action lands in Impri as `pending`.
2. Impri sends a Telegram message to the configured chat or group with
   two inline buttons: **✅ Approve** and **❌ Reject** (plus an optional
   **🔗 View in inbox** link if `BASE_URL` is set).
3. An authorized team member taps a button. Telegram delivers a
   `callback_query` to Impri's webhook endpoint.
4. Impri verifies the webhook secret, the HMAC signature on the button
   payload, and the tapper's Telegram user ID against the allow-list.
5. If all checks pass, Impri records the decision (same transaction as
   `POST /v1/actions/:id/decision`), fires any `callback_url` webhook,
   and edits the Telegram message to show the outcome and remove the
   buttons.

Digest batches (multiple actions coalesced into one message) fall back
to the plain notification with a "View inbox" link — inline buttons are
only meaningful for a single action.

---

## Setup (one-time, ~10 minutes)

### Step 1 — Create a Telegram bot

Open Telegram, start a chat with **@BotFather**, send `/newbot`, and
follow the prompts. BotFather returns a **bot token** in the form
`1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Save it — it is not
shown again.

### Step 2 — Get the chat ID

**Group chat:** Add the bot to the group as a member. Post any message
in the group. Call:

```
GET https://api.telegram.org/bot{token}/getUpdates
```

Look for `message.chat.id` in the response. Group IDs are negative
integers (e.g. `-1001234567890`).

**Direct message:** Send `/start` to the bot. Call `getUpdates` and look
for `message.chat.id` (a positive integer — your personal ID).

**Channel:** Add the bot as an admin, post anything, and look for
`channel_post.chat.id` in `getUpdates`.

### Step 3 — Collect authorized Telegram user IDs

Each team member who should be able to tap the buttons needs their
**numeric Telegram user ID** added to `allowed_approver_user_ids`.

The easiest method: each person messages **@userinfobot** and it replies
with their `Id:` (a positive integer like `123456789`).

Alternatively, after any message is sent in the group, `getUpdates`
returns `message.from.id` for each sender — that is the same ID.

Collect all IDs you want to authorize.

### Step 4 — Create the approval channel via the Impri API

```bash
curl -X POST https://api.impri.dev/v1/notification-channels \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ops approvals (Telegram)",
    "type": "telegram",
    "config": {
      "bot_token":  "1234567890:AAFxxx",
      "chat_id":    "-1001234567890",
      "approval_mode": true,
      "allowed_approver_user_ids": [123456789, 987654321]
    },
    "enabled": true
  }'
```

**Omit `hmac_secret`** — Impri generates a 64-character hex secret
automatically and stores it. The response shows it masked (`****xxxx`).
You never need to know its value unless you want to supply your own
(16–256 characters).

### Step 5 — Webhook registration

**Automatic (public HTTPS server):** If `BASE_URL` is set to a public
`https://` URL, Impri calls Telegram's `setWebhook` automatically on
channel creation. Look for a log line:

```
[telegram-approval] setWebhook ok {"channelId":"chan_...","url":"https://..."}
```

No further action is needed.

**Local dev / self-host behind NAT:** When `BASE_URL` is absent,
`localhost`, or an RFC 1918 address, `setWebhook` is skipped. To
register manually:

1. Expose your local server with a tunnel:
   ```bash
   ngrok http 8484
   # or: cloudflared tunnel --url http://localhost:8484
   ```
2. Set `BASE_URL=https://<tunnel-hostname>` in your `.env` and restart
   the server.
3. Trigger webhook registration:
   ```bash
   curl -X POST http://localhost:8484/v1/notification-channels/{channelId}/setup-webhook \
     -H "Authorization: Bearer im_..."
   ```
   Response on success:
   ```json
   { "ok": true, "url": "https://..." }
   ```

You can also skip the tunnel for local testing and use the
`/test` endpoint to verify the notification format (the test buttons are
harmless — they reference a synthetic action ID that does not exist in
the DB, so the webhook handler returns "Action not found" gracefully).

### Step 6 — Verify

```bash
# Send a test message to the chat
curl -X POST http://localhost:8484/v1/notification-channels/{channelId}/test \
  -H "Authorization: Bearer im_..."
```

The bot posts a message with Approve / Reject buttons to the chat. You
can tap them — the response "Action not found" is correct and expected.
For a real end-to-end test, create a pending action via your agent and
tap the button; check `GET /v1/actions/{actionId}` to confirm the
decision landed.

---

## Configuration reference

All fields live inside the `config` object of a `telegram` channel. The
three new fields are optional and default to off so existing channels
are unaffected.

| Field | Type | Default | Description |
|---|---|---|---|
| `bot_token` | string | required | Telegram Bot API token (`\d+:[A-Za-z0-9_-]+`). |
| `chat_id` | string | required | Destination chat, group, or channel ID. |
| `approval_mode` | boolean | `false` | When `true`, single-action sends use inline Approve/Reject buttons. Digest batches always use plain text. |
| `allowed_approver_user_ids` | integer[] | `[]` | Telegram numeric user IDs permitted to tap the buttons. Max 50. An empty list means no one can approve via Telegram (a validation warning is raised if `approval_mode` is `true` and the list is empty). |
| `hmac_secret` | string | auto-generated | 16–256 character secret used to sign button payloads and derive the Telegram webhook token. Auto-generated if omitted at creation time. Masked (`****{last4}`) in all API responses. Rotate via `PATCH config.hmac_secret`. |

**Masking in API responses:**

| Field | Behavior |
|---|---|
| `bot_token` | `****{last4}` |
| `hmac_secret` | `****{last4}` (when present) |
| `chat_id` | returned as-is |
| `approval_mode` | returned as-is |
| `allowed_approver_user_ids` | returned as-is |

---

## Managing the channel

**Add or remove approvers** without re-creating the channel:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{"config": {"allowed_approver_user_ids": [123456789]}}'
```

Config fields are shallow-merged — you only need to send what changes.

**Disable the approval flow** (revert to plain notifications):

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"config": {"approval_mode": false}}'
```

Impri calls `deleteWebhook` for the bot automatically when
`approval_mode` transitions to `false` or when `enabled` is set to
`false`.

**Rotate `hmac_secret`:** Send a new value in a PATCH. Impri
re-derives the webhook secret, calls `setWebhook` with the updated
`secret_token`, and saves the new value. Old inline buttons in chat
history return "Invalid approval link" — safe and harmless.

**Delete the channel:** `DELETE /v1/notification-channels/{channelId}`
calls `deleteWebhook` first, then removes the row.

---

## Webhook endpoint

Telegram posts `callback_query` updates to:

```
POST /v1/integrations/telegram/webhook/:channelId
```

This endpoint is **public** (no Bearer token). Authentication happens
entirely via the `X-Telegram-Bot-Api-Secret-Token` header verified
against the derived webhook secret before the request body is parsed.
Operators do not call this endpoint directly — Telegram does.

Rate limit: 100 requests per minute per `channelId` (fixed window,
keyed on `channelId + IP`). Legitimate Telegram traffic peaks at a
handful of requests per second; this limit stops scanner abuse.

---

## Security model

### Four independent defenses

An attacker must bypass **all four** simultaneously to forge an approval.

**1. Webhook secret header**

Every `callback_query` from Telegram carries
`X-Telegram-Bot-Api-Secret-Token`. The value Impri registered at
`setWebhook` time is derived as:

```
HMAC-SHA256(hmac_secret, "tg-webhook-secret").slice(0, 32).hex()
```

Impri re-derives and compares it with `crypto.timingSafeEqual()` before
parsing the request body. A missing or wrong header gets 403 immediately.
Without `hmac_secret`, no scanner or forger can produce a valid header.

**2. Button payload HMAC**

Each Approve / Reject button carries a signature in its `callback_data`:

```
{v}:{actionId}:{sig}
```

`sig` is the first 6 bytes (48 bits) of
`HMAC-SHA256(hmac_secret, "tg:" + v + ":" + actionId)` encoded as
base64url (8 chars). Total payload: 37 bytes, well within Telegram's
64-byte `callback_data` limit.

Without `hmac_secret`, an attacker in the Telegram chat cannot fabricate
valid `callback_data` for any action ID. A 48-bit HMAC requires 2^47
guesses on average — each requiring a real Telegram account to press a
real button, observable in chat, rate-limited by Telegram itself.
Comparison uses `timingSafeEqual` to prevent timing attacks.

**3. Authorized-user check**

Telegram sets `callback_query.from.id` in its own infrastructure — other
Telegram users cannot spoof this integer. Impri checks it against
`allowed_approver_user_ids` before recording any decision. If the user
ID is not in the list, the handler answers "Not authorized" with
`show_alert: true` and returns without reading the action from the DB —
no information about the action is revealed to unauthorized users.

Authorized taps are recorded in `audit_log` with
`decided_by = "tg:{telegram_user_id}"` and `channel = "telegram"`.
First names (`cq.from.first_name`) are used only in the ephemeral
in-chat confirmation message and are never stored.

**4. Idempotency via UNIQUE constraint**

`decisions(action_id)` has a DB UNIQUE constraint. The first writer wins.
A concurrent second tap (two team members pressing simultaneously) is
caught by the constraint violation, answered with "Already decided," and
returns 200 to Telegram. Replaying a pressed button is a safe no-op.

### Project isolation

The action is loaded with `WHERE id = ? AND project_id = channel.project_id`.
An action from project A cannot be approved via a channel belonging to
project B, even if an attacker reconstructs a valid HMAC for a foreign
action ID — the lookup returns not-found.

### Bot token protection

`bot_token` appears only in outbound Telegram API URLs assembled
server-side. It is masked in all API responses (`****{last4}`), stripped
from error messages by `sanitizeError()` in `notify.ts`, never stored in
logs or `audit_log`, and never included in webhook request or response
bodies. All outbound Telegram calls go through `fetchGuarded()` with the
`api.telegram.org` domain hardcoded — not user-supplied.

### Threat model summary

| Attack | Blocked by |
|---|---|
| Forge a button press without being in the chat | Webhook secret header (Layer 1) |
| Craft valid `callback_data` without `hmac_secret` | Button payload HMAC (Layer 2) |
| Press buttons but not in `allowed_approver_user_ids` | Authorized-user check (Layer 3) |
| Press the same button twice / race two team members | UNIQUE constraint (Layer 4) |
| Approve an action from a different project | `project_id` binding in SQL query |
| Extract `bot_token` from logs or API | `maskConfig()` + `sanitizeError()` |
| SSRF via `api.telegram.org` URL | Hardcoded domain in `fetchGuarded()` |

---

## Environment variables

| Variable | Effect |
|---|---|
| `BASE_URL` | Must be a publicly reachable URL for `setWebhook` to be called automatically. Absent or `localhost` = webhook registration skipped. |

---

## Troubleshooting

**The bot sends a message but buttons do nothing.**

The webhook is not registered or is pointing to an unreachable URL.
Check the server logs for a `setWebhook` call on channel creation.
If `BASE_URL` was a tunnel URL that has since expired, update `.env`
with the new tunnel URL, restart, and call
`POST /v1/notification-channels/{channelId}/setup-webhook`.

**"Not authorized to approve in this project" when tapping a button.**

The Telegram user ID of the person tapping is not in
`allowed_approver_user_ids`. Find their ID via @userinfobot or
`getUpdates` and add it with a PATCH.

**"Invalid or expired approval link" when tapping a button.**

The `hmac_secret` was rotated since the message was sent, or the
`callback_data` was tampered with. Old buttons become invalid after
rotation — this is intentional and safe. The action is still decidable
from the web inbox or CLI.

**"Action not found".**

The action expired, was already decided via a different path, or the
button belongs to a test message. Check
`GET /v1/actions/{actionId}` to see current status.

**"Already decided".**

Another approver (or a concurrent tap from the same person) beat this
one to it. The decision is idempotent — nothing went wrong.

**Buttons still appear after a decision.**

The `editMessageReplyMarkup` call to Telegram failed (network error or
the message was too old). The decision was still recorded in Impri.
The buttons are cosmetically stale; any additional tap is answered with
"Already decided" and is a no-op.

**`setup-webhook` returns an error from Telegram.**

Telegram requires the webhook URL to be reachable from the internet over
HTTPS. Verify that `BASE_URL` resolves publicly and serves a valid TLS
certificate. A self-signed cert is rejected by Telegram unless it is
uploaded as a `certificate` parameter to `setWebhook` (not currently
automated — use a CA-signed cert or a tunnel service).

**The channel was auto-disabled (fail_count reached 5).**

Fix the underlying issue (e.g. incorrect `bot_token` or `chat_id`), then:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"enabled": true}'
```

This resets `fail_count` to 0 and re-enables delivery.
