# Notification Channels

Impri can push a notification to your team's tools the moment an action
lands in the inbox. Notification channels are per-project, configurable
via the Settings screen in the web inbox or via the REST API, and require
an **admin-scope** API key.

---

## Overview

| Channel type | What you need |
|---|---|
| `slack` | Slack Incoming Webhook URL |
| `discord` | Discord Webhook URL |
| `telegram` | Telegram Bot token + chat/channel ID |
| `ntfy` | ntfy server URL + topic name |
| `email` | Recipient e-mail address — confirmed via a link before anything is delivered (SMTP configured server-side) |
| `webhook` | Any HTTPS endpoint; optional HMAC signing |

Each channel has a **digest window** (`digest_window_sec`, default 60 s).
If several actions arrive within that window, they are batched into a
single message instead of flooding the channel. A single action always
sends immediately.

A channel that fails delivery five times in a row is automatically
disabled. You can re-enable it from Settings after fixing the config.

---

## Configuring channels

### Web inbox (Settings > Notifications)

Open the web inbox, go to **Settings → Notifications**, and click
**Add channel**. Pick a type, fill in the fields, and click **Save**.
Use the **Send test** button to verify delivery before going live.
The URL and token fields show the last four characters only — the full
secret is never echoed back.

### REST API

All channel routes require `Authorization: Bearer im_<admin-key>`.

```
GET    /v1/notification-channels           List channels (masked secrets)
POST   /v1/notification-channels           Create a channel
GET    /v1/notification-channels/:id       Get a channel (masked secrets)
PATCH  /v1/notification-channels/:id       Update name / config / enabled / window
DELETE /v1/notification-channels/:id       Delete a channel
POST   /v1/notification-channels/:id/test  Send a test message now
POST   /v1/notification-channels/:id/resend-verification  Resend the confirmation email (email channels)
```

Rate limits: 30 req/min per key on write routes; 5 req/min per key on
the `/test` endpoint.

Every channel in a response carries `verified` — always `true` except
for an email channel whose address has not been confirmed yet (see
[Email address confirmation](#email-address-confirmation)).

**Create a channel (POST /v1/notification-channels):**

```json
{
  "name": "My Slack workspace",
  "type": "slack",
  "config": {
    "url": "https://hooks.slack.com/services/T.../B.../..."
  },
  "enabled": true,
  "digest_window_sec": 60
}
```

`digest_window_sec` must be between 10 and 3600 (seconds). The response
echoes the created channel with secrets masked (see [Secrets](#secrets-and-masking)).

**Update a channel (PATCH /v1/notification-channels/:id):**

Send only the fields you want to change. Config fields are merged — you
do not have to resend the full config object. Updating any config field
resets the failure counter and re-enables automatic delivery.

---

## Channel types

### Slack

```json
{
  "type": "slack",
  "config": { "url": "https://hooks.slack.com/services/..." }
}
```

Sends a [Block Kit](https://api.slack.com/block-kit) message to the
provided Incoming Webhook URL. The message contains a brief description
of the pending action and a **Review** button that links to the inbox.

The webhook URL embeds the Slack authentication token in its path — no
separate token field is needed.

**Security:** `url` is validated as `http`/`https` and must not resolve
to a private IP address. The value is stored as a secret and masked in
all API responses.

#### Slack approval mode (optional)

Additional fields enable **in-channel Approve / Reject buttons** so
your team can decide without opening the web inbox:

```json
{
  "type": "slack",
  "config": {
    "bot_token":    "xoxb-...",
    "channel_id":   "C0XXXXXXXX",
    "signing_secret": "...",
    "approval_mode": true,
    "allowed_approver_slack_user_ids": ["U0XXXXXXXX"]
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `bot_token` | string | required | Bot User OAuth Token (`xoxb-...`). Masked (`****{last4}`) in responses. |
| `channel_id` | string | required | Slack channel or group ID (`C...` or `G...`). |
| `signing_secret` | string | required | Slack app Signing Secret used to verify the HMAC-SHA256 request signature on every interaction. Masked (`****{last4}`) in responses. |
| `approval_mode` | boolean | `false` | When `true`, single-action sends include interactive Approve / Reject buttons. Digest batches always fall back to a plain notification. |
| `allowed_approver_slack_user_ids` | string[] | `[]` | Slack user IDs (`U...`) allowed to click the buttons. Max 50. Must be non-empty when `approval_mode` is `true`. |

When `approval_mode` is `true`, Impri receives interaction payloads at:

```
POST /v1/integrations/slack/interactions/:channelId
```

Decisions recorded via this endpoint are equivalent to decisions made
through the web inbox: they run the same database transaction, fire
`callback_url` webhooks, and appear in the audit log with
`decided_by = "sl:{slack_user_id}"`.

See [docs/slack-approval.md](slack-approval.md) for full setup
instructions, config reference, security model, and troubleshooting.

---

### Discord

```json
{
  "type": "discord",
  "config": { "url": "https://discord.com/api/webhooks/..." }
}
```

Posts a rich embed to the Discord channel associated with the webhook.

The request uses `?wait=true` so that non-2xx responses from Discord
are surfaced as delivery failures (and counted toward the auto-disable
threshold).

**Security:** same URL validation as Slack.

#### Discord approval mode (optional)

Additional fields enable **in-channel Approve / Reject buttons** so
your team can decide without opening the web inbox:

```json
{
  "type": "discord",
  "config": {
    "bot_token":       "MT...",
    "application_id":  "123456789012345678",
    "public_key":      "aabbccdd...",
    "channel_id":      "987654321098765432",
    "approval_mode":   true,
    "allowed_approver_discord_user_ids": ["123456789012345678"]
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `bot_token` | string | required | Discord bot token. Masked (`****{last4}`) in responses. |
| `application_id` | string | required | Discord application snowflake ID. |
| `public_key` | string | required | 64-char hex Ed25519 public key from the Developer Portal. Used to verify every interaction's cryptographic signature. Masked (`****{last4}`) in responses. |
| `channel_id` | string | required | Discord channel snowflake ID. |
| `hmac_secret` | string | auto-generated | Signs button `custom_id` values. Auto-generated (32 random bytes hex) if omitted at creation. Masked (`****{last4}`) in responses. |
| `approval_mode` | boolean | `false` | When `true`, single-action sends include interactive Approve / Reject buttons. Digest batches always fall back to a plain embed. |
| `allowed_approver_discord_user_ids` | string[] | `[]` | Discord user snowflake IDs allowed to click the buttons. Max 50. Must be non-empty when `approval_mode` is `true`. |

When `approval_mode` is `true`, Impri receives interaction payloads at:

```
POST /v1/integrations/discord/interactions/:channelId
```

Discord uses Ed25519 asymmetric signatures — the platform holds the
private key; Impri verifies using `public_key` only. Decisions recorded
via this endpoint appear in the audit log with
`decided_by = "dc:{discord_user_id}"`.

See [docs/discord-approval.md](discord-approval.md) for full setup
instructions, config reference, security model, and troubleshooting.

---

### Telegram

```json
{
  "type": "telegram",
  "config": {
    "bot_token": "1234567890:AAF...",
    "chat_id": "-1001234567890"
  }
}
```

Sends an HTML-formatted message via the Telegram Bot API to the
specified chat or channel.

`bot_token` must match `/^\d+:[A-Za-z0-9_-]+$/` — this prevents URL
path injection when the token is assembled into
`https://api.telegram.org/bot{token}/sendMessage`. The base URL is
hardcoded server-side; no part of it comes from user input.

`chat_id` is a non-empty string up to 50 characters. It is returned
as-is in API responses because it is not a secret.

`bot_token` is treated as a secret and masked in API responses.

**Security:** `bot_token` format validated by Zod. The assembled API
URL goes through `fetchGuarded()` for defense in depth (the domain is
hardcoded, but DNS rebinding protection is applied regardless). Title,
kind, and the inbox URL are HTML-escaped before interpolation to prevent
markup injection.

#### Telegram approval mode (optional)

Three additional optional fields enable **in-chat Approve / Reject
buttons** so your team can decide without opening the web inbox:

```json
{
  "type": "telegram",
  "config": {
    "bot_token": "1234567890:AAF...",
    "chat_id":   "-1001234567890",
    "approval_mode": true,
    "allowed_approver_user_ids": [123456789, 987654321]
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `approval_mode` | boolean | `false` | When `true`, single-action sends include inline Approve / Reject buttons. Digest batches always fall back to a plain notification with a "View inbox" link. |
| `allowed_approver_user_ids` | integer[] | `[]` | Telegram numeric user IDs (the integer `from.id`) allowed to tap the buttons. Max 50. Must be non-empty when `approval_mode` is `true` — a validation error is raised otherwise. |
| `hmac_secret` | string | auto-generated | 16–256 character secret used to sign button payloads and derive the Telegram webhook verification token. Auto-generated on channel creation if omitted. Masked (`****{last4}`) in all responses. Rotate via PATCH. |

When `approval_mode` is `true` and `BASE_URL` is a publicly reachable
URL, Impri automatically registers a Telegram webhook at:

```
POST /v1/integrations/telegram/webhook/:channelId
```

Decisions recorded via this endpoint are equivalent to decisions made
through the web inbox: they run the same database transaction, fire
`callback_url` webhooks, and appear in the audit log with
`decided_by = "tg:{telegram_user_id}"`.

See [docs/telegram-approval.md](telegram-approval.md) for full setup
instructions, config reference, security model, and troubleshooting.

---

### ntfy

```json
{
  "type": "ntfy",
  "config": {
    "url": "https://ntfy.sh",
    "topic": "my-impri-alerts"
  }
}
```

Sends a notification to `{url}/{topic}` on any ntfy-compatible server.
This generalises the global `NTFY_URL` / `NTFY_TOPIC` environment
variables to per-project, per-channel configuration.

`topic` must match `/^[A-Za-z0-9_/-]{1,64}$/` to prevent path traversal
when the URL is assembled server-side.

`url` is treated as a secret (useful for self-hosted ntfy instances that
embed a token in the URL). `topic` is not a secret and is returned as-is.

**Security:** `url` validated as `http`/`https`, no private IPs.
Title and kind values are passed through the `headerSafe()` helper
(strips `\r` / `\n`) before being placed in `Title` and `Tags` HTTP
headers — identical to the global ntfy adapter in `notify.ts`.

---

### Email

```json
{
  "type": "email",
  "config": { "address": "team@example.com" }
}
```

Sends a plain-text email using the SMTP transport configured via
environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). On the hosted cloud this is
already set up; mail comes from `notifications@impri.dev`.

Without `SMTP_HOST`, creating an email channel (or changing its address)
returns `400 Email delivery is not configured on this server`, and a
send through an existing email channel fails with that error — the
`/test` endpoint reports `{"ok": false, ...}` instead of pretending the
email went out.

`address` is validated as an e-mail address by Zod. It is not a secret
and is returned as-is in API responses. **The address must be confirmed
before Impri sends it anything but the confirmation email** — see
[Email address confirmation](#email-address-confirmation).

The email subject is `[Impri] {title}` with CR/LF stripped (header
injection guard). The body is plain text only — no HTML — to avoid
template injection surface. It contains the action title, kind and a
link into the inbox, plus a footer saying why the email arrives and how
to stop it (disable or delete the channel).

### Email address confirmation

An Impri project does not need an email address, so an email channel's
address is unverified input. Creating an email channel therefore sends
one **confirmation email** (fixed text, nothing from your project in it)
with a link that is valid for 7 days. The limits below are checked
before the create responds; the email itself is sent right after the
response, so the API does not wait for the mail server. The create
response says whether it was queued:

```json
{ "id": "nchan_…", "type": "email", "verified": false,
  "verification_sent_at": 1792000000, "verification_queued": true, … }
```

or, when a limit applies, `"verification_queued": false` with a
`"verification_error"` explaining why. If the mail server then rejects
the email, the channel's `verification_sent_at` goes back to empty
(the dashboard shows that no confirmation email has gone out). The
channel is created either way; send the confirmation again with
`POST /v1/notification-channels/:id/resend-verification` (or
**Resend confirmation email** in the dashboard), which waits for the
mail server and reports a failed send.

Opening the link shows a page with a **Confirm email address** button.
Only that button (a `POST`) confirms the address — mail scanners that
prefetch links cannot confirm it for you. Each link works once. After
confirmation the channel reports `"verified": true` and notifications
start.

Until then the channel receives nothing: new actions do not notify it,
queued digests are not flushed to it, and `POST …/test` returns
`409 Conflict`. Changing the address with `PATCH` resets the channel to
unconfirmed and queues a new confirmation email (the response carries
`verification_queued` the same way); changing only letter case or
surrounding whitespace does not.

```
POST /v1/notification-channels/:id/resend-verification
```

Sends a new confirmation email (the previous link stops working).
Returns `{ "ok": true, "channel": {…} }`, `400` for a non-email channel,
`409` when the address is already confirmed, `429` when a limit applies,
`502` when the email could not be sent. Limits on confirmation emails:

| Limit | Value |
|---|---|
| Per channel | one email per 10 minutes |
| Per address, across all projects | 3 per rolling 24 h |
| Per project | 5 per rolling 24 h |

**Daily cap on notification emails:** a project sends at most
`IMPRI_EMAIL_DAILY_CAP` notification emails (default 100, test sends
included) per rolling 24 h. When the cap is reached, notifications stay
queued in the channel's digest and go out once the window frees up;
this does not count as a delivery failure and never auto-disables the
channel.

To enforce these limits the server keeps, for 2 days, a row per email
sent: project, channel, kind (`verify` / `notify`), a SHA-256 hash of
the lower-cased address and the time. The address itself is never
logged.

**Self-hosted upgrade note:** email channels that existed before this
change start unconfirmed. The server sends each of them one confirmation
email within a minute of starting (if SMTP is configured); notifications
resume once the link is opened.

---

### Webhook

```json
{
  "type": "webhook",
  "config": {
    "url": "https://your-service.example.com/impri-hook",
    "hmac_secret": "optional-signing-secret-min-16-chars"
  }
}
```

POSTs a JSON payload to `url` on every pending action:

```json
{
  "event": "action.pending",
  "action_id": "act_...",
  "title": "...",
  "kind": "...",
  "inbox_url": "https://app.impri.dev/inbox/act_...",
  "triggered_at": 1720003600,
  "escalate": false
}
```

`escalate` is `true` when the action matched a rule with
`rule_action: "escalate"`, letting receivers distinguish escalated
notifications from ordinary ones.

When `hmac_secret` is provided, the outbound request carries the same
HMAC-SHA256 signature headers used by the existing webhook delivery
system:

```
X-Impri-Signature: sha256={sig}
X-Impri-Timestamp: {unix-sec}
X-Impri-Nonce: {hex}
```

Signature is computed over `{timestamp}.{nonce}.{rawBody}` using
`signWebhookBody()` from `webhooks.ts` — so receivers can share the
same verification logic as for action-decision webhooks.

`hmac_secret` must be 16–256 characters. Both `url` and `hmac_secret`
are treated as secrets and masked in API responses.

**Security:** `url` validated as `http`/`https`, no private IPs,
routed through `fetchGuarded()`.

---

## Test endpoint

```
POST /v1/notification-channels/:id/test
```

Sends a test message through the channel immediately, bypassing the
digest window. The channel's `last_fired_at`, `digest_queue`, and
`fail_count` are not modified — a test send does not count as a delivery
attempt.

Rate limit: 5 req/min per key.

Response:

```json
{ "ok": true }
```

or on failure:

```json
{ "ok": false, "error": "connection refused" }
```

The error string is sanitised — it will not contain the secret from the
channel config.

For an email channel whose address is not confirmed yet the endpoint
returns `409 Conflict` without sending anything. Test emails count
toward the project's daily email cap.

---

## Digest window and deduplication

Each channel has a `digest_window_sec` (default 60 s). The window
governs two behaviours:

1. **First notification always fires immediately.** When
   `last_fired_at` is null (channel never fired) or the window has
   expired, the notification is sent straight away.

2. **Subsequent notifications within the window are queued.** They
   accumulate in `digest_queue` and are flushed by a background tick
   that runs approximately every 30 seconds. When the flush fires, all
   queued items plus the triggering item are combined into a single
   digest message:

   - 1 item → normal single-action message.
   - 2+ items → "N actions pending your approval: Title 1, Title 2 …
     (+N more)".

3. **Same `action_id` is never queued twice** for the same channel.
   This complements the existing soft-dedup in `POST /v1/actions`
   (identical preview hash + kind + pending = one row), so a burst of
   identical requests produces at most one notification.

---

## Triggers

A channel fires when:

- **An action becomes pending** — immediately after `POST /v1/actions`
  creates an action with `status = 'pending'`. This covers all rule
  outcomes that leave the action in pending state: no rule matched,
  `set_expiry`, `require_n_approvers`, and `escalate`. Auto-approved
  or auto-rejected actions (rule outcomes `auto_approve` /
  `auto_reject`) do not trigger channel notifications because no human
  review is needed.

- **Escalate rule matched** — the channel payload includes
  `"escalate": true`. The global escalate override (`escalateChannel`
  in `notify.ts`) still fires simultaneously; per-project channels fire
  in addition.

Both paths call `notifyChannels()` inside a `.catch(() => {})` wrapper,
so a failing channel never blocks action creation or the HTTP response.
One channel failing does not prevent the others from firing.

---

## Auto-disable on repeated failure

After **5 consecutive delivery failures**, a channel is automatically
set to `enabled = false` and a structured warning is logged
(`channelId`, `type`, `projectId`). This prevents a misconfigured
channel from silently absorbing notification attempts.

To re-enable, fix the config (via `PATCH /v1/notification-channels/:id`)
and then re-enable (`"enabled": true` in the same or a separate PATCH).
Updating the config resets `fail_count` to 0 automatically.

The threshold (default 5) will be configurable via
`IMPRI_CHANNEL_MAX_FAILS` in a future release.

---

## Secrets and masking

All fields that contain credentials are **masked** in every API response
— list, get, create, and update. The raw value is never returned after
creation. Masking rules:

| Channel | Field masked | Mask format |
|---|---|---|
| `slack` | `url` | `****{last4}` |
| `slack` | `bot_token` (approval mode) | `****{last4}` |
| `slack` | `signing_secret` (approval mode) | `****{last4}` |
| `slack` | `channel_id`, `approval_mode`, `allowed_approver_slack_user_ids` | returned as-is |
| `discord` | `url` | `****{last4}` |
| `discord` | `bot_token` (approval mode) | `****{last4}` |
| `discord` | `public_key` (approval mode) | `****{last4}` |
| `discord` | `hmac_secret` (approval mode, if set) | `****{last4}` |
| `discord` | `application_id`, `channel_id`, `approval_mode`, `allowed_approver_discord_user_ids` | returned as-is |
| `telegram` | `bot_token` | `****{last4}` |
| `telegram` | `chat_id` | returned as-is |
| `telegram` | `approval_mode` | returned as-is |
| `telegram` | `allowed_approver_user_ids` | returned as-is |
| `telegram` | `hmac_secret` (if set) | `****{last4}` |
| `ntfy` | `url` | `****{last4}` |
| `ntfy` | `topic` | returned as-is |
| `email` | `address` | returned as-is |
| `webhook` | `url` | `****{last4}` |
| `webhook` | `hmac_secret` (if set) | `****{last4}` |

Any config value shorter than 5 characters is replaced entirely with
`****`.

Secrets are stored as plaintext JSON in the SQLite `config` column. The
column is only reachable via admin-scope API keys. A future hardening
step will encrypt the config column at rest using AES-256-GCM with a
key from `IMPRI_CONFIG_KEY`.

Secrets are never interpolated into log messages. Structured error logs
record only `channelId`, `type`, `projectId`, and a sanitised error
message string.

---

## SSRF protection

Every outbound HTTP request to a user-supplied URL goes through
`fetchGuarded()` from `net-guard.ts`. This dispatcher:

- Rejects non-`http`/`https` protocols.
- Rejects literal private-IP addresses at connection time.
- Performs DNS resolution inside the same socket lookup, pinning the
  resolved IP at connect time so a DNS rebind cannot swap in a private
  address between validation and the actual connection.

Zod validation at write time provides an additional early-rejection
layer: private IP literals and invalid protocols are rejected before any
value reaches the database.

The `IMPRI_ALLOW_PRIVATE_TARGETS=1` opt-out (used by operators running
Impri on a private network) disables SSRF checks for all outbound
requests, including channel delivery.

---

## Database schema

The `notification_channels` table is added via the existing `migrate()`
pattern in `db.ts` (checks `sqlite_master`, creates if absent; never
touches existing tables or rows):

```sql
CREATE TABLE notification_channels (
  id                TEXT    PRIMARY KEY,
  project_id        TEXT    NOT NULL REFERENCES projects(id),
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL
                            CHECK(type IN ('slack','discord','telegram','ntfy','email','webhook')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  config            TEXT    NOT NULL DEFAULT '{}',
  digest_window_sec INTEGER NOT NULL DEFAULT 60,
  last_fired_at     INTEGER,
  digest_queue      TEXT    NOT NULL DEFAULT '[]',
  fail_count        INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  verified_at       INTEGER,  -- email channels: when the address was confirmed
  verify_token_hash TEXT,     -- sha256 of the pending confirmation token
  verify_sent_at    INTEGER   -- when the last confirmation email was sent
);

CREATE TABLE email_sends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT    NOT NULL,
  channel_id   TEXT,
  kind         TEXT    NOT NULL CHECK(kind IN ('verify','notify')),
  address_hash TEXT    NOT NULL,  -- sha256(lower-cased address)
  sent_at      INTEGER NOT NULL   -- rows older than 2 days are pruned
);
```

`digest_queue` is a JSON array of `{actionId, title, kind}` objects.
`last_error` records the sanitised reason for the last delivery failure
(no secrets in this field). `config` stores the type-specific secret
fields as JSON (see [Secrets and masking](#secrets-and-masking)).

---

## SDK usage

The Python and TypeScript SDKs do not yet expose a dedicated
notifications client. Use the REST API directly with an admin-scope key.

Python example:

```python
import httpx

headers = {"Authorization": "Bearer im_..."}
base = "https://api.impri.dev/v1"  # or "http://localhost:8484/v1" self-hosted

# Create a Slack channel
r = httpx.post(f"{base}/notification-channels", headers=headers, json={
    "name": "ops-alerts",
    "type": "slack",
    "config": {"url": "https://hooks.slack.com/services/T.../B.../..."},
    "digest_window_sec": 120,
})
r.raise_for_status()
channel = r.json()
print(channel["id"])  # chan_...

# Test it
r = httpx.post(f"{base}/notification-channels/{channel['id']}/test", headers=headers)
print(r.json())  # {"ok": true}
```

TypeScript example:

```typescript
const headers = {
  "Authorization": "Bearer im_...",
  "Content-Type": "application/json",
};

const res = await fetch("http://localhost:8484/v1/notification-channels", {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: "ops-alerts",
    type: "discord",
    config: { url: "https://discord.com/api/webhooks/..." },
  }),
});
const channel = await res.json();
```

---

## Environment variables

The following variables affect notification channel behaviour at the
server level. They are in addition to the channel-specific config stored
in the database.

| Variable | Purpose |
|---|---|
| `SMTP_HOST` | SMTP server for the `email` channel type. Absent = email channels cannot be created and sends fail. |
| `SMTP_PORT` | SMTP port (default 587). |
| `SMTP_SECURE` | Set to `"true"` for implicit TLS (port 465). |
| `SMTP_USER` | SMTP username (omit for open relay). |
| `SMTP_PASS` | SMTP password. |
| `SMTP_FROM` | From address used in outbound emails (default `impri@localhost`). |
| `BASE_URL` | Public API URL; the confirmation link points to `${BASE_URL}/v1/notification-channels/verify`. |
| `IMPRI_EMAIL_DAILY_CAP` | Notification emails a project may send per rolling 24 h (default 100). |
| `IMPRI_ALLOW_PRIVATE_TARGETS` | Set to `"1"` to allow channel URLs that resolve to private/RFC1918 addresses (intranet use). Off by default. |

The global `NTFY_URL` / `NTFY_TOPIC` variables configure the
**instance-wide** ntfy notification that fires for all projects (via
`notifyAll()` in `notify.ts`). Per-project `ntfy` channels in the
`notification_channels` table are independent and additive.

---

## See also

- [Telegram Approval Bot](telegram-approval.md) — step-by-step setup
  for in-chat Approve / Reject buttons, security model, and
  troubleshooting.
- [Slack Approval Bot](slack-approval.md) — step-by-step setup for
  in-channel Approve / Reject buttons using Slack's Interactivity API,
  security model, and troubleshooting.
- [Discord Approval Bot](discord-approval.md) — step-by-step setup for
  in-channel Approve / Reject buttons using Discord's Interactions API
  (Ed25519 signatures), security model, and troubleshooting.
