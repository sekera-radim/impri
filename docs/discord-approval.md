# Discord Approval Bot

Impri can send pending-action notifications to a Discord channel with
**Approve** and **Reject** buttons that let your team decide without
ever opening a browser. The decision is recorded in Impri with the same
integrity guarantees as a web-inbox decision.

This is an extension of the existing `discord` notification channel
(see [Notification channels](notifications.md)). When `approval_mode`
is `false` (the default), the channel behaves exactly as before —
a rich embed notification with a "Review in Impri" link. Setting
`approval_mode: true` enables the interactive-button approval flow
described here.

---

## How it works

1. An action lands in Impri as `pending`.
2. Impri posts a Discord message embed to the configured channel with
   two component buttons: **✅ Approve** and **❌ Reject**.
3. An authorized team member clicks a button. Discord delivers an
   interaction (type 3, MESSAGE_COMPONENT) to Impri's interaction
   endpoint via HTTP POST.
4. Impri verifies the Ed25519 signature from Discord's servers, the
   HMAC on the button `custom_id`, and the clicker's Discord user ID
   against the allow-list.
5. If all checks pass, Impri records the decision (same transaction as
   `POST /v1/actions/:id/decision`), fires any `callback_url` webhook,
   and responds with an interaction response (type 7, UPDATE_MESSAGE)
   that replaces the original message to show the outcome and remove the
   buttons.

Digest batches (multiple actions coalesced into one message) fall back
to a plain notification with a "View inbox" link — interactive buttons
are only meaningful for a single action.

---

## Setup (one-time, ~15 minutes)

### Step 1 — Create a Discord application and bot

Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
and click **New Application**. Give it a name. Then open the **Bot**
tab, click **Add Bot**, confirm, and click **Reset Token** to reveal
the bot token — copy it. This is `bot_token`. The bot token starts
with `MT` or similar; treat it as a password.

Enable no additional Privileged Gateway Intents (not needed for
interactions-only bots).

### Step 2 — Copy the application credentials

On the **General Information** tab, copy:

- **Application ID** (numeric snowflake, e.g. `123456789012345678`)
  — this is `application_id`.
- **Public Key** (64-char hex string) — this is `public_key`. Discord
  uses the corresponding private key to sign every interaction it sends
  to your endpoint; Impri uses `public_key` to verify those signatures.

### Step 3 — Invite the bot to your server

Go to **OAuth2 → URL Generator**. Select scope `bot` and permission
**Send Messages**. Open the generated URL in a browser and select your
server to add the bot.

### Step 4 — Enable Developer Mode and collect IDs

Enable Discord Developer Mode: **User Settings → Advanced → Developer Mode**.

- **Channel ID:** Right-click the target channel → **Copy Channel ID**
  (numeric snowflake). This is `channel_id`.
- **Approver user IDs:** Right-click each approver's name (or avatar)
  → **Copy User ID** (numeric snowflake). These go in
  `allowed_approver_discord_user_ids`.

### Step 5 — Create the approval channel via the Impri API

```bash
curl -X POST https://api.impri.dev/v1/notification-channels \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ops approvals (Discord)",
    "type": "discord",
    "config": {
      "bot_token":       "MT...",
      "application_id":  "123456789012345678",
      "public_key":      "aabbccdd...",
      "channel_id":      "987654321098765432",
      "approval_mode":   true,
      "allowed_approver_discord_user_ids": ["123456789012345678"]
    },
    "enabled": true
  }'
```

**Omit `hmac_secret`** — Impri generates 32 random bytes (64-char hex)
automatically and stores it masked (`****xxxx`). This secret signs the
button `custom_id` values so they cannot be forged.

Copy the `id` field from the response (e.g. `nchan_...`).

### Step 6 — Set the Interactions Endpoint URL in Discord

In the Discord Developer Portal → **General Information**, find the
**Interactions Endpoint URL** field and enter:

```
https://your-impri-host/v1/integrations/discord/interactions/nchan_...
```

Replace `your-impri-host` with your Impri server's public hostname and
`nchan_...` with the channel ID from Step 5. Click **Save Changes**.

Discord immediately sends a PING (interaction type 1) signed with its
Ed25519 private key. Impri verifies the signature and responds
`{"type":1}` (PONG). If the endpoint is unreachable or the signature
verification fails, Discord rejects the URL — this is a live security
check during setup.

**Local dev:** Discord requires a publicly reachable HTTPS URL. Use
`ngrok http 8484` or `cloudflared tunnel --url http://localhost:8484`,
set `BASE_URL=https://your-tunnel-url`, restart Impri, then enter the
tunnel URL in the Developer Portal.

### Step 7 — Verify

```bash
# Send a test message with interactive buttons
curl -X POST http://localhost:8484/v1/notification-channels/{channelId}/test \
  -H "Authorization: Bearer im_..."
```

The bot posts an embed with Approve / Reject buttons to the channel.
Clicking them returns an ephemeral "Action not found" — expected, since
the test references a synthetic action ID. For a real end-to-end test,
create a pending action via your agent and click a button; check
`GET /v1/actions/{actionId}` to confirm the decision landed.

---

## Configuration reference

All fields live inside the `config` object of a `discord` channel. The
approval fields are optional and default to off, so existing
plain-webhook channels are unaffected.

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | required when `approval_mode: false` | Discord Incoming Webhook URL. Used for plain (non-approval) notifications. |
| `bot_token` | string | required when `approval_mode: true` | Discord bot token for `POST /channels/{id}/messages`. |
| `application_id` | string | required when `approval_mode: true` | Discord application snowflake ID. |
| `public_key` | string | required when `approval_mode: true` | 64-char hex Ed25519 public key from the Developer Portal. Used to verify interaction signatures. Masked (`****{last4}`) in responses as defense-in-depth. |
| `channel_id` | string | required when `approval_mode: true` | Discord channel snowflake ID. |
| `hmac_secret` | string | auto-generated | 16–256 char hex secret used to sign button `custom_id` values. Auto-generated (32 random bytes) if omitted at creation. Masked (`****{last4}`) in all responses. |
| `approval_mode` | boolean | `false` | When `true`, single-action sends include interactive Approve / Reject buttons. Digest batches always fall back to a plain embed. |
| `allowed_approver_discord_user_ids` | string[] | `[]` | Discord user snowflake IDs permitted to click the buttons. Max 50. Must be non-empty when `approval_mode: true`. |

**Masking in API responses:**

| Field | Behavior |
|---|---|
| `url` | `****{last4}` |
| `bot_token` | `****{last4}` |
| `public_key` | `****{last4}` (defense-in-depth; technically a public key) |
| `application_id` | returned as-is |
| `channel_id` | returned as-is |
| `hmac_secret` | `****{last4}` (when present) |
| `approval_mode` | returned as-is |
| `allowed_approver_discord_user_ids` | returned as-is |

---

## Managing the channel

**Add or remove approvers** without re-creating the channel:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{"config": {"allowed_approver_discord_user_ids": ["123456789012345678"]}}'
```

Config fields are shallow-merged — you only need to send what changes.

**Rotate `hmac_secret`:** Send a new value in a PATCH. Old buttons in
Discord message history use the previous secret and return "Invalid or
expired approval link" when clicked — safe and harmless. The action
remains decidable from the web inbox or CLI.

**Disable the approval flow** (revert to plain notifications):

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"config": {"approval_mode": false}}'
```

When `approval_mode` is `false`, set a plain Incoming Webhook `url` in
the config so notifications continue to deliver.

**Delete the channel:** `DELETE /v1/notification-channels/{channelId}`
removes the row. Clearing the Interactions Endpoint URL in the Discord
Developer Portal is optional.

---

## Interaction endpoint

Discord posts interaction payloads to:

```
POST /v1/integrations/discord/interactions/:channelId
```

This endpoint is **public** (no Bearer token). Authentication happens
via Ed25519 signature verification before the request body is parsed.
Operators do not call this endpoint directly — Discord does.

**Signature verification:** Discord attaches `X-Signature-Ed25519` and
`X-Signature-Timestamp` headers. Impri:

1. Reads both headers. If either is absent, returns **401**.
2. Constructs the signed message: `Buffer.concat([timestamp_bytes, rawBody_bytes])`.
3. Verifies the 64-byte Ed25519 signature using `public_key` and Node's
   Web Crypto API (`webcrypto.subtle.verify`).
4. If invalid, returns **401** `'invalid request signature'` (the exact
   string Discord's endpoint validator checks when you save the URL).

This check runs on **every** request including PING (type 1) — skipping
it for PINGs would create an unauthenticated code path.

Discord uses an asymmetric scheme: Discord holds the Ed25519 private
key and signs every interaction; Impri holds only `public_key` and
verifies. This means Impri cannot forge Discord interactions, and
`public_key` is not strictly a secret (though it is masked for
defense-in-depth).

Rate limit: 100 requests per minute per `channelId` (fixed window,
keyed on `channelId + IP`). Legitimate Discord traffic is at most one
request per button click; this limit stops scanner abuse.

---

## Security model

### Five independent defenses

An attacker must bypass **all five** simultaneously to forge an approval.

**1. Discord Ed25519 signature (asymmetric)**

Every interaction from Discord carries `X-Signature-Ed25519` and
`X-Signature-Timestamp`. Impri verifies using the application's
`public_key` via `webcrypto.subtle.verify('Ed25519', ...)`. Discord's
servers hold the private key; without it, no one outside Discord can
produce a valid signature. Invalid signature → **401** immediately.

Unlike Slack's HMAC approach, Ed25519 is asymmetric: Impri cannot
forge Discord signatures even if you have the `public_key`.

**2. Button `custom_id` HMAC (unforgeable action binding)**

Each Approve / Reject button carries a signature in its `custom_id`:

```
{v}:{actionId}:{sig}
```

`sig` is the first 6 bytes (48 bits) of
`HMAC-SHA256(hmac_secret, "dc:" + v + ":" + actionId)` encoded as
base64url (8 chars). Context prefix `dc:` prevents cross-platform reuse.
`custom_id` max length is 100 chars; the full value is 36 chars — well
within Discord's limit.

Without `hmac_secret`, a server member who can see the message cannot
fabricate a valid `custom_id` for any action ID. Comparison uses
`timingSafeEqual`.

**3. Authorized-user check (project-scoped allow-list)**

Discord sets `interaction.member.user.id` (guild/server interactions)
or `interaction.user.id` (DM interactions) in its own infrastructure.
After the Ed25519 signature passes (Layer 1), this field is
authoritative. Impri checks it against
`allowed_approver_discord_user_ids`. On failure, an ephemeral "Not
authorized" message is returned (type 4, flags 64 — visible only to the
clicker); HTTP 200 is returned so Discord does not retry. No action data
is exposed to unauthorized users.

**4. Project-scoped action lookup**

The action is loaded with `WHERE id = ? AND project_id = channel.project_id`.
An action from project A cannot be approved via a channel belonging to
project B, even if an attacker reconstructs a valid HMAC for a foreign
action ID — the lookup returns not-found.

**5. Idempotency via UNIQUE constraint**

`decisions(action_id)` has a DB UNIQUE constraint. The first writer wins.
Concurrent clicks are caught by the constraint violation, answered with
an ephemeral "Already decided," and return 200 to Discord. Replaying a
button click is a safe no-op.

---

### Response timing

Discord requires a response to an interaction within 3 seconds. Because
Impri's decision is a synchronous SQLite transaction, there is no async
latency risk — the response is type 7 (UPDATE_MESSAGE), which replaces
the original message with the decision outcome and removes the buttons
in a single round-trip. No deferred response (`type: 5`) is needed.

### Bot token protection

`bot_token` is masked in all API responses (`****{last4}`), stripped
from error messages by `sanitizeError()` in `notify.ts`, and never
stored in logs or `audit_log`. All outbound Discord API calls go through
`fetchGuarded()` to `https://discord.com/api/v10/channels/{id}/messages`.

### Threat model summary

| Attack | Blocked by |
|---|---|
| Forge an interaction from outside Discord | Ed25519 signature (Layer 1) |
| Craft a valid `custom_id` without `hmac_secret` | Button HMAC `dc:` (Layer 2) |
| Click a button but not in `allowed_approver_discord_user_ids` | Authorized-user check (Layer 3) |
| Approve an action from a different project | `project_id` binding in SQL query (Layer 4) |
| Race two approvers / replay the same click | UNIQUE constraint (Layer 5) |
| Extract `bot_token` from logs or API | `maskConfig()` + `sanitizeError()` |
| SSRF via Discord API URL | `fetchGuarded()` (hardcoded Discord domain) |

---

## Troubleshooting

**Discord rejects the Interactions Endpoint URL when I try to save it.**

Discord sends a PING signed with the application's Ed25519 private key.
Make sure:
- The URL is publicly reachable over HTTPS.
- The `channelId` in the URL matches the channel Impri created.
- The `public_key` in the channel config matches **exactly** the Public
  Key shown in the Discord Developer Portal → General Information.
- Impri is running and returning `{"type":1}` for the PING.

Check Impri logs for a 401 or signature mismatch error.

**The bot posts a message but buttons do nothing.**

The Interactions Endpoint URL in the Developer Portal is not set, is
pointing to an unreachable URL, or the `channelId` in the URL does not
match the channel. Verify the URL matches
`https://your-impri-host/v1/integrations/discord/interactions/{channelId}`.

**"Not authorized to approve in this project" when clicking a button.**

The Discord user ID of the person clicking is not in
`allowed_approver_discord_user_ids`. Find their ID (Developer Mode →
right-click user → **Copy User ID**) and add it with a PATCH.

**"Invalid or expired approval link" when clicking a button.**

The `hmac_secret` was rotated since the message was posted, or the
`custom_id` was tampered with. Old buttons become invalid after rotation
— this is intentional and safe. The action is still decidable from the
web inbox or CLI.

**"Action not found".**

The action expired, was already decided via a different path, or the
button belongs to a test message. Check
`GET /v1/actions/{actionId}` to see current status.

**"Already decided".**

Another approver (or a concurrent click from the same person) beat this
one to it. The decision is idempotent — nothing went wrong.

**The Discord message still shows buttons after a decision.**

The interaction response (type 7) was not delivered within Discord's
3-second window (rare — Impri uses synchronous SQLite). The decision
was still recorded in Impri. The buttons are cosmetically stale; any
additional click is answered with an ephemeral "Already decided" and is
a no-op.

**The channel was auto-disabled (fail_count reached 5).**

Fix the underlying issue (e.g. incorrect `bot_token` or `channel_id`),
then:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"enabled": true}'
```

This resets `fail_count` to 0 and re-enables delivery.
