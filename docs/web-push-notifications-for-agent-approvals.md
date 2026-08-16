# Web Push Notifications for Agent Approvals

Wire browser-native web push into Impri so a pending AI agent action pops a real OS notification on your desktop the instant it lands, no Slack workspace or polling tab required.

---

## Why polling a tab isn't enough

An on-call incident-response agent doesn't wait for business hours. It watches your alerting feed, drafts a remediation (restart a pod, roll back a deploy, silence a noisy alert) and pushes it to Impri as a pending action. If the only way you find out is by refreshing the web inbox, you'll miss the ones that matter — the whole point of gating the agent's actions is that a human actually looks at them before they run.

Impri's web push support closes that gap. It's built directly into the web inbox at `app.impri.dev` (or your self-hosted instance) using the standard Web Push API and VAPID — no Firebase project, no Google account, no extra SaaS dependency. Keep the inbox open in a pinned tab and your OS notification tray does the rest.

---

## How the subscription flow works

The browser talks to two things: the browser's own push service (Chrome/FCM, Safari/APNs, etc.) and Impri's `/v1/push` endpoints. Once a tab subscribes, Impri pushes to it on every new pending action — no polling loop needed on the client side.

```javascript
// Run once, e.g. when the ops dashboard tab loads and the user opts in
const { public_key: vapidKey } = await fetch('/v1/push/vapid-public-key').then(r => r.json())

const registration = await navigator.serviceWorker.ready
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: vapidKey,
})

const { endpoint, keys } = subscription.toJSON()

await fetch('https://api.impri.dev/v1/push/subscribe', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${IMPRI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ endpoint, keys }),
})
```

That's the entire client integration. From here, every pending action your incident-response agent creates with `POST /v1/actions` triggers a push to this browser session, and the OS shows a native notification even if the tab is backgrounded.

---

## Server setup if you self-host

Impri Cloud has web push enabled out of the box. Self-hosting it yourself means generating a VAPID key pair and setting three environment variables before the endpoints will respond:

```bash
npx web-push generate-vapid-keys   # prints a public + private key pair

# then set on the server:
VAPID_PUBLIC_KEY=BNpW...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:oncall@yourcompany.com
```

Without these, `GET /v1/push/vapid-public-key` reports `{ "enabled": false }` and the browser subscribe step never fires — the inbox just falls back to normal polling, so nothing breaks, you simply don't get the popup. See [self-hosting](self-hosting.md) for the rest of the deployment.

---

## What actually triggers a push

Only genuinely new pending actions fire a push — `action.created` events where `status="pending"`. If a rule in your project auto-approves or auto-rejects an action before a human ever needs to see it, no push is sent, because there's nothing to review. This matters for an incident agent tuned with rules for low-risk remediations (like silencing a known-flaky alert) versus ones that always need a human (like a rollback) — only the latter buzzes your desktop.

Each subscription is tied to a specific browser session and project. Log out, or the push service invalidates the endpoint, and it stops receiving pushes — no manual cleanup required beyond calling `DELETE /v1/push/subscribe` if you want to revoke it explicitly.

---

## Web push vs. the other channels

| | Notification channels | Web push |
|---|---|---|
| Best for | Team-wide alerts (Slack, Telegram, ntfy) | An operator with the inbox open |
| Setup | `POST /v1/notification-channels`, once per project | Browser `pushManager.subscribe()`, per session |
| Digest batching | Yes | No — always immediate |

Web push isn't a replacement for a team notification channel — it's for the person actually watching the queue. Most teams running an always-on agent pair both: [ntfy or Telegram](notifications.md) so someone always gets pinged, and web push so whoever has the dashboard open sees it the second it lands.

---

## Next step

Full API reference — endpoints, response shapes, and the notification-channels comparison table — lives in [web push](web-push.md). If you haven't wired up the base approval loop yet, start with [quickstart](quickstart.md) to get an API key and push your first gated action.
