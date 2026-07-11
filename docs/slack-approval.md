# Slack Approval Bot

Impri can send pending-action notifications to a Slack channel with
**Approve** and **Reject** buttons that let your team decide without
ever opening a browser. The decision is recorded in Impri with the same
integrity guarantees as a web-inbox decision.

This is an extension of the existing `slack` notification channel
(see [Notification channels](notifications.md)). When `approval_mode`
is `false` (the default), the channel behaves exactly as before —
a plain Block Kit message with a "Review in Impri" link. Setting
`approval_mode: true` enables the inline-button approval flow
described here.

---

## How it works

1. An action lands in Impri as `pending`.
2. Impri posts a Slack message to the configured channel with two
   interactive buttons: **✅ Approve** and **❌ Reject**.
3. An authorized team member clicks a button. Slack delivers an
   interaction payload to Impri's interaction endpoint.
4. Impri verifies the Slack request signature (HMAC-SHA256), the HMAC
   on the button value, and the clicker's Slack user ID against the
   allow-list.
5. If all checks pass, Impri records the decision (same transaction as
   `POST /v1/actions/:id/decision`), fires any `callback_url` webhook,
   and updates the Slack message to show the outcome and remove the
   buttons.

Digest batches (multiple actions coalesced into one message) fall back
to a plain notification with a "View inbox" link — interactive buttons
are only meaningful for a single action.

---

## Setup (one-time, ~15 minutes)

### Step 1 — Create a Slack app

Go to [https://api.slack.com/apps](https://api.slack.com/apps) and
click **Create New App → From Scratch**. Give it a name (e.g.
"Impri Approvals") and choose your workspace.

### Step 2 — Add bot permissions and install

Open **OAuth & Permissions → Bot Token Scopes** and add the
`chat:write` scope. If you want the bot to post to public channels
without joining them first, also add `chat:write.public`.

Click **Install to Workspace** and confirm. Slack shows the
**Bot User OAuth Token** (`xoxb-...`) — copy it. This is `bot_token`.

### Step 3 — Copy the Signing Secret

Open **Basic Information → App Credentials**. Copy the value under
**Signing Secret** (32 lowercase hex characters). This is
`signing_secret` — it lets Impri verify that every interaction request
genuinely came from Slack.

### Step 4 — Invite the bot and get the channel ID

In Slack, go to the channel where you want approvals to appear and type
`/invite @your-bot-name`. Then get the **channel ID**:

- Right-click the channel name and choose **Copy Link** — the ID is the
  last path segment (e.g. `C0XXXXXXXX`).
- Or open the channel's **About** pane; the Channel ID appears at the
  bottom.

Channel IDs start with `C` (public channels) or `G` (groups /
private channels).

### Step 5 — Collect authorized Slack user IDs

Each team member who should be able to click the buttons needs their
**Slack user ID** added to `allowed_approver_slack_user_ids`.

To find a user ID: open any message from that person, click
**More actions (…)** → **Copy member ID**. The ID starts with `U`.

Collect all IDs you want to authorize.

### Step 6 — Create the approval channel via the Impri API

```bash
curl -X POST https://api.impri.dev/v1/notification-channels \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ops approvals (Slack)",
    "type": "slack",
    "config": {
      "bot_token":    "xoxb-...",
      "channel_id":   "C0XXXXXXXX",
      "signing_secret": "...",
      "approval_mode": true,
      "allowed_approver_slack_user_ids": ["U0XXXXXXXX", "U1YYYYYYYY"]
    },
    "enabled": true
  }'
```

Copy the `id` field from the response (e.g. `nchan_...`).

### Step 7 — Set the Interactivity Request URL in Slack

In the Slack app dashboard, go to **Interactivity & Shortcuts** and
toggle **Interactivity** on. Set the **Request URL** to:

```
https://your-impri-host/v1/integrations/slack/interactions/nchan_...
```

Replace `your-impri-host` with your Impri server's public hostname and
`nchan_...` with the channel ID from Step 6. Click **Save Changes**.
Slack immediately sends a verification request; Impri verifies the
Slack signature and responds 200.

**Local dev:** Slack requires a publicly reachable HTTPS URL. Use
`ngrok http 8484` or `cloudflared tunnel --url http://localhost:8484`,
set `BASE_URL=https://your-tunnel-url`, restart Impri, then enter the
tunnel URL in the Slack dashboard.

### Step 8 — Verify

```bash
# Send a test message with interactive buttons
curl -X POST http://localhost:8484/v1/notification-channels/{channelId}/test \
  -H "Authorization: Bearer im_..."
```

The bot posts a message with Approve / Reject buttons to the channel.
Clicking them returns an ephemeral "Action not found" — expected, since
the test references a synthetic action ID. For a real end-to-end test,
create a pending action via your agent and click a button; check
`GET /v1/actions/{actionId}` to confirm the decision landed.

---

## Configuration reference

All fields live inside the `config` object of a `slack` channel. The
approval fields are optional and default to off, so existing plain-webhook
channels are unaffected.

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | required when `approval_mode: false` | Slack Incoming Webhook URL. Used for plain (non-approval) notifications. |
| `bot_token` | string | required when `approval_mode: true` | Bot User OAuth Token (`xoxb-...`). Used to post messages via `chat.postMessage`. |
| `channel_id` | string | required when `approval_mode: true` | Slack channel or group ID (`C...` or `G...`). |
| `signing_secret` | string | required when `approval_mode: true` | Slack app Signing Secret (32-char hex). Used to verify the HMAC-SHA256 request signature on every interaction. Masked (`****{last4}`) in all API responses. |
| `approval_mode` | boolean | `false` | When `true`, single-action sends include interactive Approve / Reject buttons. Digest batches always fall back to a plain notification. |
| `allowed_approver_slack_user_ids` | string[] | `[]` | Slack user IDs (`U...`) permitted to click the buttons. Max 50. Must be non-empty when `approval_mode: true`. |

**Masking in API responses:**

| Field | Behavior |
|---|---|
| `url` | `****{last4}` |
| `bot_token` | `****{last4}` |
| `signing_secret` | `****{last4}` |
| `channel_id` | returned as-is |
| `approval_mode` | returned as-is |
| `allowed_approver_slack_user_ids` | returned as-is |

---

## Managing the channel

**Add or remove approvers** without re-creating the channel:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{"config": {"allowed_approver_slack_user_ids": ["U0XXXXXXXX"]}}'
```

Config fields are shallow-merged — you only need to send what changes.

**Rotate `signing_secret`:** Send a new value in a PATCH. Update the
Slack app dashboard to match if you rotate on the Slack side as well.
In-flight messages retain the old button HMACs (signed with
`signing_secret`); existing buttons in chat history become invalid after
a `signing_secret` rotation — clicking them returns "Invalid or expired
approval link". This is safe; the action remains decidable from the web
inbox or CLI.

**Disable the approval flow** (revert to plain notifications):

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"config": {"approval_mode": false}}'
```

When `approval_mode` is `false`, set a plain Incoming Webhook `url` in
the config so notifications continue to deliver.

**Delete the channel:** `DELETE /v1/notification-channels/{channelId}`
removes the row. Deregistering the Interactivity URL in the Slack app
dashboard is optional — Slack will simply stop delivering interactions
to the now-absent endpoint.

---

## Interaction endpoint

Slack posts interaction payloads to:

```
POST /v1/integrations/slack/interactions/:channelId
```

This endpoint is **public** (no Bearer token). Authentication happens
via the Slack request signature verified against `signing_secret` before
the request body is parsed. Operators do not call this endpoint directly
— Slack does.

**Signature verification:** Slack attaches `X-Slack-Signature` and
`X-Slack-Request-Timestamp` headers. Impri:

1. Rejects requests whose timestamp deviates from the server clock by
   more than 5 minutes (replay defense).
2. Computes `HMAC-SHA256(signing_secret, "v0:{timestamp}:{rawBody}")`.
3. Compares `v0=` + hex digest to `X-Slack-Signature` using
   `timingSafeEqual`.

The raw body is read as a string before any URL decoding or JSON parsing
so the signature covers the exact bytes Slack signed. Content-Type is
`application/x-www-form-urlencoded`; the JSON interaction payload is in
the `payload` form field.

Rate limit: 100 requests per minute per `channelId` (fixed window,
keyed on `channelId + IP`). Legitimate Slack traffic is at most one
request per button click; this limit stops scanner abuse.

---

## Security model

### Five independent defenses

An attacker must bypass **all five** simultaneously to forge an approval.

**1. Slack request signature (HMAC-SHA256 with timestamp)**

Every interaction request from Slack carries `X-Slack-Signature` (value:
`v0={64-char hex}`) and `X-Slack-Request-Timestamp`. Impri re-derives
the expected value using `signing_secret` and compares with
`timingSafeEqual`. A missing header, wrong signature, or timestamp more
than 5 minutes old is rejected with 403.

Without `signing_secret`, no external HTTP client can produce a valid
`X-Slack-Signature` for an arbitrary request body.

**2. Button payload HMAC (unforgeable action binding)**

Each Approve / Reject button carries a signature in its `value` field:

```
{v}:{actionId}:{sig}
```

`sig` is the first 6 bytes (48 bits) of
`HMAC-SHA256(signing_secret, "sl:" + v + ":" + actionId)` encoded as
base64url (8 chars). Context prefix `sl:` prevents cross-platform reuse
of signatures (a Telegram or Discord signature cannot be replayed here).

Without `signing_secret`, a workspace member who can see the message
cannot fabricate a valid `value` for any action ID. A 48-bit HMAC
requires 2^47 guesses on average — each requiring a real Slack account
to click a real button in the workspace, rate-limited by Slack.
Comparison uses `timingSafeEqual`.

**3. Authorized-user check (project-scoped allow-list)**

Slack sets `payload.user.id` in its own infrastructure. After the
platform signature passes (Layer 1), this field is authoritative — other
workspace members cannot spoof it. Impri checks it against
`allowed_approver_slack_user_ids`. On failure, an ephemeral "Not
authorized" message is posted via `response_url` (visible only to the
clicker); HTTP 200 is returned so Slack does not retry. No action data
is exposed to unauthorized users.

**4. Project-scoped action lookup**

The action is loaded with `WHERE id = ? AND project_id = channel.project_id`.
An action from project A cannot be approved via a channel belonging to
project B, even if an attacker reconstructs a valid HMAC for a foreign
action ID — the lookup returns not-found.

**5. Idempotency via UNIQUE constraint**

`decisions(action_id)` has a DB UNIQUE constraint. The first writer wins.
Concurrent clicks (two team members pressing simultaneously) are caught
by the constraint violation, answered with "Already decided," and return
200 to Slack. Replaying a pressed button is a safe no-op.

---

### `response_url` SSRF defense

Before posting the confirmation back to Slack's `response_url`, Impri
validates that the URL matches `^https://hooks\.slack\.com/`. Because
the interaction payload is Slack-signed (Layer 1 already verified), a
tampered `response_url` would require forging the Slack signature —
this check is defense-in-depth. The actual HTTP call goes through
`fetchGuarded()` (SSRF guard).

### Bot token protection

`bot_token` is masked in all API responses (`****{last4}`), stripped
from error messages by `sanitizeError()` in `notify.ts`, and never
stored in logs or `audit_log`. All outbound Slack API calls go through
`fetchGuarded()` to `https://slack.com/api/chat.postMessage`.

### Threat model summary

| Attack | Blocked by |
|---|---|
| Forge an interaction from outside the workspace | Slack request signature (Layer 1) |
| Replay a captured Slack request after 5 min | Timestamp window (Layer 1) |
| Craft a valid button value without `signing_secret` | Button payload HMAC `sl:` (Layer 2) |
| Click a button but not in `allowed_approver_slack_user_ids` | Authorized-user check (Layer 3) |
| Approve an action from a different project | `project_id` binding in SQL query (Layer 4) |
| Race two approvers / replay the same click | UNIQUE constraint (Layer 5) |
| SSRF via `response_url` | URL prefix check + `fetchGuarded()` |
| Extract `bot_token` from logs or API | `maskConfig()` + `sanitizeError()` |

---

## Troubleshooting

**The bot posts a message but buttons do nothing.**

The Interactivity Request URL in the Slack app dashboard is not set, is
pointing to an unreachable URL, or the `channelId` in the URL does not
match the channel in Impri. Verify the URL in **Interactivity &
Shortcuts** matches
`https://your-impri-host/v1/integrations/slack/interactions/{channelId}`.

**"Not authorized to approve in this project" when clicking a button.**

The Slack user ID of the person clicking is not in
`allowed_approver_slack_user_ids`. Find their ID via the Slack profile
`...` menu → **Copy member ID** and add it with a PATCH.

**"Invalid or expired approval link" when clicking a button.**

The `signing_secret` was changed since the message was posted, or the
`value` was tampered with. Old buttons become invalid after a secret
change — this is intentional and safe. The action is still decidable
from the web inbox or CLI.

**"Action not found".**

The action expired, was already decided via a different path, or the
button belongs to a test message. Check
`GET /v1/actions/{actionId}` to see current status.

**"Already decided".**

Another approver (or a concurrent click from the same person) beat this
one to it. The decision is idempotent — nothing went wrong.

**The Slack message still shows buttons after a decision.**

The `response_url` update call failed (expired — `response_url` is
valid for 5 updates within 30 minutes of the interaction). The decision
was still recorded in Impri. The buttons are cosmetically stale; any
additional click is answered with "Already decided" and is a no-op.

**Slack dashboard rejects the Interactions Endpoint URL.**

Slack verifies the URL by sending a test request signed with your app's
`signing_secret`. Make sure the Impri server is publicly reachable over
HTTPS, the URL is correct (including the `channelId` suffix), and the
`signing_secret` in the channel config matches the one in the Slack app
dashboard. Check Impri logs for a 403 or signature mismatch error.

**The channel was auto-disabled (fail_count reached 5).**

Fix the underlying issue (e.g. incorrect `bot_token` or `channel_id`),
then:

```bash
curl -X PATCH .../v1/notification-channels/{channelId} \
  -d '{"enabled": true}'
```

This resets `fail_count` to 0 and re-enables delivery.
