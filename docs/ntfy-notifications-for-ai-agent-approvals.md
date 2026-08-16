# ntfy Notifications for AI Agent Approvals

Get a phone buzz for every AI agent action waiting on your review by wiring Impri to ntfy — no Slack workspace, no app store install, just a topic URL your phone subscribes to.

---

## The self-hosted case for ntfy

Say you're running Impri on a home server alongside a small agent that drafts and queues social posts overnight, and you want a phone notification the moment there's a draft to approve — without creating a Slack workspace just for yourself, or trusting a third-party push SaaS with your homelab's traffic. [ntfy](https://ntfy.sh) is a natural fit: it's a lightweight, MIT-licensed pub/sub push service you can either use hosted at `ntfy.sh` or run yourself in a container next to Impri, and the client is a single Android/iOS app that subscribes to a topic — no account, no API key on the phone side.

Impri treats ntfy as a first-class notification channel type, alongside Slack, Discord, Telegram, and email.

---

## Creating the channel

Channel management requires an **admin-scope** API key. Point it at either the public `ntfy.sh` or your own self-hosted server:

```bash
curl -X POST https://api.impri.dev/v1/notification-channels \
  -H "Authorization: Bearer $IMPRI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Phone - overnight posting agent",
    "type": "ntfy",
    "config": {
      "url": "https://ntfy.sh",
      "topic": "acme-social-agent-a1b2c3"
    },
    "digest_window_sec": 60
  }'
```

Pick a topic name that's hard to guess — ntfy topics are unauthenticated by default, so anything predictable like `my-approvals` can be subscribed to by a stranger. A random suffix, as above, is enough on the public server; a self-hosted ntfy instance behind auth removes the concern entirely.

Subscribe from your phone: open the ntfy app, add topic `acme-social-agent-a1b2c3` on `ntfy.sh` (or your own server URL), and you're done. Use `POST /v1/notification-channels/:id/test` to confirm delivery before trusting it overnight.

---

## Where this fits in the agent loop

The overnight posting agent doesn't know or care that ntfy exists — it just pushes actions to Impri and stops. The channel config you created above is what turns that into a phone notification:

```python
import requests, time

IMPRI_KEY = "im_..."
BASE = "https://api.impri.dev"

def queue_post_for_approval(caption: str, image_url: str) -> str:
    resp = requests.post(f"{BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "social.post",
            "title": f"Scheduled post: {caption[:60]}",
            "preview": {"format": "markdown", "body": f"{caption}\n\n![preview]({image_url})"},
            "expires_in": 43200,  # 12h — stale by the next posting window otherwise
            "editable": ["preview.body"],
        })
    action = resp.json()
    return action["id"]

# agent's overnight loop calls this once per drafted post, then exits;
# a separate cron job polls each action_id the next morning and publishes on approval
```

Every call to `queue_post_for_approval` creates a pending action; within the channel's 60-second digest window, ntfy batches same-window actions into one notification instead of buzzing your phone once per post.

---

## What ntfy does and doesn't guarantee

Impri validates the channel `url` as `http`/`https` and rejects private-IP targets, and the `topic` field is restricted to `/^[A-Za-z0-9_/-]{1,64}$/` to stop path-traversal tricks when the URL is built server-side — but ntfy itself has no built-in approve/reject buttons the way Impri's Slack channel does. A push through ntfy tells you *that* something needs review; you still open the Impri inbox link in the notification to actually approve, reject, or edit it. If you want tap-to-decide from the notification itself, that's what [Telegram approval](telegram-approval.md) is for instead.

A channel that fails delivery five times running is auto-disabled — worth knowing if your homelab server reboots and ntfy is briefly unreachable; check Settings → Notifications after an outage rather than assuming silence means nothing happened.

---

## Next step

Full channel config reference — digest windows, all channel types, secret masking — is in [notifications](notifications.md). If you're setting this up on your own server rather than Impri Cloud, [self-hosting](self-hosting.md) covers the Docker Compose and environment variables. New to the base approval loop entirely? Start with [quickstart](quickstart.md).
