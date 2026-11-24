# ntfy Notifications for AI Agent Approvals

Get an ntfy push on your phone for every AI agent action waiting in Impri: channel setup, a locked-down self-hosted topic, digests, and failure handling.

Everything below was run on 2026-11-24 against a local Impri server built from the repository and ntfy 2.38.1 in Docker. The messages quoted are the ones ntfy stored.

---

## What reaches the phone

Your agent doesn't change: it creates actions with `POST /v1/actions`, and every enabled channel of the project fires when a new action is `pending`. An ntfy channel sends:

| Event | ntfy title | Tags | Tapping it opens |
|---|---|---|---|
| One pending action | the action's `title` | `impri`, the action's `kind` | the action in the inbox (`/inbox/<id>`) |
| Several inside the digest window | `3 actions pending your approval: A, B, C` (`+N more` after three) | `impri`, `action.pending` | the inbox list |
| Action approved or rejected by a [rule](rules.md) | nothing | | |
| Decision or expiry | nothing (that's what [webhooks](webhooks.md) are for) | | |

The body repeats the title after `New action pending:`, priority is ntfy's default (3), and the tap target comes from ntfy's `Click` header. There are no approve or reject buttons: you decide in the inbox. To decide from the notification itself, use [Telegram approval](telegram-approval.md), or Slack or Discord in approval mode.

---

## Create the channel

In the inbox, open the **Notifications** tab and choose **Add channel** → ntfy, or use the API with an `admin`-scope key:

```bash
TOPIC="impri-approvals-$(openssl rand -hex 8)"

curl -s -X POST https://api.impri.dev/v1/notification-channels \
  -H "Authorization: Bearer $IMPRI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Phone\", \"type\": \"ntfy\",
       \"config\": {\"url\": \"https://ntfy.sh\", \"topic\": \"$TOPIC\"},
       \"digest_window_sec\": 60}"

# then: POST /v1/notification-channels/<id>/test  ->  {"ok":true}
```

Subscribe to the same topic in the ntfy app. ntfy topic names are up to 64 letters, digits, `_` and `-`; Impri also accepts `/`, but ntfy doesn't, so leave it out. On `ntfy.sh` anyone who knows a topic name can read it and post to it, so the random suffix is what keeps strangers out.

---

## A private ntfy server: write-only for Impri

Impri's ntfy channel sends no credentials, and the URL can't carry them: `http://user:pass@host` fails with "Request cannot be constructed from a URL that includes credentials", and `https://host/?auth=…` gets `ntfy HTTP 500`, because Impri appends the topic to the URL and it ends up inside the query string. So the topic has to accept anonymous writes. On your own server, deny everything by default and open that one topic for writing:

```yaml
# server.yml
auth-file: /var/lib/ntfy/user.db
auth-default-access: deny-all
```

```bash
ntfy user add phone                                       # the account your phone logs in with
ntfy access everyone impri-approvals-9f3c1d2e write-only
ntfy access phone impri-approvals-9f3c1d2e read-only
```

Before the `everyone … write-only` line every send failed with `ntfy HTTP 403`; after it Impri's messages got through. Anonymous reads of the topic and anonymous posts to other topics got 403, and the `phone` user saw the messages. Anyone who learns the topic name can still post a fake notification, so keep the random name here too.

---

## ntfy on the same host or LAN

Impri checks channel URLs against private addresses:

- A literal private IP (`http://192.168.1.20`) is refused when you create the channel: "Only http/https URLs to non-private addresses are allowed for ntfy server URL".
- A hostname that resolves to a private address (`http://ntfy` on a Docker network, `localhost`) is accepted, but every send fails with `fetch failed` until the Impri server runs with `IMPRI_ALLOW_PRIVATE_TARGETS=1`. That also opens webhook and watcher URLs to the private network: use it only on a [self-hosted](self-hosting.md) server you don't share.

On Impri Cloud the ntfy server must be publicly reachable: `ntfy.sh` or your own public instance.

A self-hosted server also has an instance-wide push, `NTFY_URL` and `NTFY_TOPIC` in the server environment. It isn't behind that check (it reached ntfy on `localhost` without the opt-out), fires for every project, sends one push per action with no digest, and follows `escalate` rules: the push goes to the ntfy topic named in the rule's `channel` (a topic name, not one of your project's channels) instead of `NTFY_TOPIC`. In our run, `deploy.prod` actions went to `impri-oncall`, not to `NTFY_TOPIC`.

---

## Digests and failures

`digest_window_sec` (10–3600, default 60) controls batching. After a quiet period the first pending action is sent immediately. Actions created inside the window are queued and sent as one digest by the server's 60-second background check. With a 10-second window, two posts created two seconds after the first arrived as one message 45 seconds later.

A non-2xx answer or a network error is a failed send, and five in a row disable the channel. With the topic not yet open for anonymous writes, five actions each got `ntfy HTTP 403` and the fifth set `enabled: false`. Nothing was lost: after we restored access and enabled the channel, the next pending action sent one digest, "6 actions pending your approval: Deploy build 1, Deploy build 2, Deploy build 3 +3 more". Two details:

- Actions created while a channel is disabled are not queued for it.
- Enabling the channel doesn't reset the failure count unless the same update changes its config, and a test send doesn't reset it either. Otherwise only the next real notification that succeeds does, so one more failure right after you enable it disables the channel again.

`GET /v1/notification-channels/<id>` shows `enabled`, `fail_count` and `last_error`. Check them after an outage instead of reading silence as "no approvals waiting".

---

## Next step

[Self-host Impri](quickstart.md) with `docker compose` next to your ntfy server, or [start free on the cloud](https://app.impri.dev/?signup=1) and point a channel at `ntfy.sh`. Add the channel, send a test, then create one action from your agent and watch it reach your phone. The full channel reference is in [notifications](notifications.md).
