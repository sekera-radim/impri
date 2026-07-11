# Web Push Notifications

Impri supports browser-native push notifications via the Web Push API (VAPID). When an action is created with `status=pending`, all subscribed browser sessions for the project receive an immediate push notification — no polling or page refresh needed.

Web push is a complement to the notification channel system (Slack, Telegram, etc.) and is built into the web inbox at `app.impri.dev`.

---

## How it works

1. The browser fetches the server's VAPID public key (`GET /v1/push/vapid-public-key`).
2. The browser registers a push subscription with its push service (using the VAPID key).
3. The subscription endpoint + crypto keys are registered with Impri (`POST /v1/push/subscribe`).
4. When `POST /v1/actions` creates a pending action, the server sends a push to all project-scoped subscriptions.
5. The browser receives the push and shows a native OS notification.
6. On logout or unsubscribe, the endpoint is removed (`DELETE /v1/push/subscribe`).

---

## Setup (self-hosting)

Web push requires three environment variables set on the server:

```bash
VAPID_PUBLIC_KEY=...       # Base64url-encoded public key
VAPID_PRIVATE_KEY=...      # Base64url-encoded private key
VAPID_SUBJECT=mailto:you@example.com   # Contact URI (required by VAPID spec)
```

Generate a VAPID key pair:

```bash
# Using web-push CLI
npx web-push generate-vapid-keys
```

Or with the `openssl` command:

```bash
openssl ecparam -genkey -name prime256v1 | openssl pkcs8 -topk8 -nocrypt | \
  openssl pkey -pubout -outform DER | base64url
```

When these variables are absent, the endpoints return `{ "enabled": false }` / `400 Bad Request` and the web inbox silently falls back to polling.

---

## API reference

### `GET /v1/push/vapid-public-key` — public VAPID key

Public endpoint — no authentication required.

```http
GET /v1/push/vapid-public-key HTTP/1.1
```

Response when push is enabled:

```json
{
  "enabled": true,
  "public_key": "BNpW..."
}
```

Response when push is disabled (no VAPID vars set):

```json
{
  "enabled": false,
  "public_key": null
}
```

---

### `POST /v1/push/subscribe` — register a subscription

Requires `actions` scope.

```http
POST /v1/push/subscribe HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BNcR...",
    "auth":   "tBHI..."
  }
}
```

These fields come directly from the browser's `PushSubscription` object:

```javascript
const registration = await navigator.serviceWorker.ready
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidPublicKey,  // from GET /v1/push/vapid-public-key
})
const { endpoint, keys } = subscription.toJSON()
// POST { endpoint, keys } to /v1/push/subscribe
```

Response `201`:

```json
{ "subscribed": true }
```

The endpoint is upserted by `endpoint` — if a subscription with the same endpoint already exists for any project, it is updated to the current project. This handles browser re-subscription scenarios.

Returns `400 Bad Request` if push is disabled on this instance.

---

### `DELETE /v1/push/subscribe` — remove a subscription

Requires `actions` scope.

```http
DELETE /v1/push/subscribe HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{ "endpoint": "https://fcm.googleapis.com/fcm/send/..." }
```

Returns `204 No Content`. Call this on logout or when the user explicitly disables notifications.

---

## When push fires

A push notification is sent for every new **pending** action — `action.created` events where `status="pending"`. Actions that are immediately auto-approved or auto-rejected by the rules engine do not trigger push.

Push fires for the project associated with the authenticated key used to create the action, to all registered browser subscriptions for that project.

---

## Notification channels vs. web push

| | Notification channels | Web push |
|---|---|---|
| Delivery target | Slack, Discord, Telegram, ntfy, email, webhook | Browser / OS |
| Setup | `POST /v1/notification-channels` | Browser `pushManager.subscribe()` |
| Scope | Configured once per project | Per browser session |
| Digest window | Yes (10–3600 s) | No (immediate) |
| Auto-disable on failure | Yes (after 5 failures) | Push service removes invalid endpoints automatically |
| CRUD API | Full (create/update/delete/test) | Subscribe / unsubscribe only |

Use notification channels to send alerts to team Slack or Telegram. Use web push to give operators browser-native notifications when they have the inbox open in a tab.

---

## Browser compatibility

Web push is supported in all modern browsers (Chrome, Firefox, Edge, Safari 16.4+). The push service is managed by the browser vendor (FCM for Chrome, APNs for Safari). Impri uses the VAPID protocol — no Google account or Firebase project required.
