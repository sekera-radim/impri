# Add Human Approval to a Cron Job

Add human approval to a cron job so the schedule fires but the side effect waits for your go-ahead — with a working Python example and expiry window guidance.

---

## Why scheduled jobs are a blind spot

Cron jobs run without anyone watching. A weekly newsletter goes out even if the draft has a typo. A nightly database purge fires even if someone is in the middle of a migration. A deploy job kicks off at 3 AM regardless of whether there is an active incident.

The instinct is to add an environment flag or a config toggle to pause them. That works, but it requires you to remember to flip the flag before the window opens — and a toggle you forgot is the same as no toggle at all.

A better pattern: the schedule fires on time, but the job *proposes* its action to you and cannot proceed until you approve. The cron script does its preparation work, then blocks on your decision, then either executes or exits cleanly.

---

## How the pattern works

```
cron fires
    │
    ├── job prepares the payload (draft newsletter, purge SQL, deploy config)
    │
    ├── POST /v1/actions  →  Impri stores it, notifies you on phone/Slack/email
    │
    ├── job polls GET /v1/actions/:id  (blocks until decided or expired)
    │
    ├─[approved]─ executes with final_preview content
    │
    └─[rejected/expired]─ exits without side effect, logs reason
```

The cron tab entry stays unchanged. What changes is that the script itself will not fire its side effect until a human decision comes back.

---

## Example: weekly newsletter send (Python)

This script runs via cron every Monday morning. It drafts the newsletter, pushes it to Impri for approval, then either sends or exits cleanly.

```python
#!/usr/bin/env python3
"""weekly-newsletter.py — push draft for approval, then send on go-ahead."""

import os
import time
import requests

API_BASE = "https://api.impri.dev"
HEADERS = {
    "Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}",
    "Content-Type": "application/json",
}

def draft_newsletter() -> str:
    # Your existing newsletter generation logic here
    return "**This week in AI tools** — five picks from the past 7 days..."

def send_newsletter(body: str) -> None:
    # Your existing send logic (MailerLite, Postmark, etc.)
    print(f"Sending newsletter ({len(body)} chars)")

def main():
    body = draft_newsletter()

    # Push the action — give 12 hours to approve before the window closes
    resp = requests.post(f"{API_BASE}/v1/actions", headers=HEADERS, json={
        "kind": "newsletter.send",
        "title": "Weekly newsletter — 14 Jul 2026",
        "preview": {"format": "markdown", "body": body},
        "expires_in": 43200,          # 12 hours
        "editable": ["preview.body"], # allow last-minute edits before approving
    })
    resp.raise_for_status()
    action = resp.json()
    action_id = action["id"]
    print(f"Pushed: {action_id}  inbox: {action['inbox_url']}")

    # Poll until decided or expired
    while True:
        result = requests.get(f"{API_BASE}/v1/actions/{action_id}", headers=HEADERS)
        result.raise_for_status()
        data = result.json()
        status = data["status"]
        if status != "pending":
            break
        time.sleep(30)  # check every 30 seconds

    if status == "approved":
        # Always use final_preview — it carries human edits when editable fields were changed
        final_body = data["decision"]["final_preview"]["body"]
        send_newsletter(final_body)

        requests.post(
            f"{API_BASE}/v1/actions/{action_id}/result",
            headers=HEADERS,
            json={"status": "executed"},
        )
        print("Newsletter sent and result reported.")
    else:
        print(f"Newsletter not sent: action {status}. Exiting cleanly.")

if __name__ == "__main__":
    main()
```

Wire it into your crontab:

```cron
0 7 * * 1  IMPRI_API_KEY=im_... /usr/local/bin/python3 /opt/jobs/weekly-newsletter.py
```

---

## Choosing the right expiry window

`expires_in` is the window within which you must approve. After it passes, the action cannot be approved and the script exits cleanly.

| Job type | Suggested `expires_in` | Reasoning |
|---|---|---|
| Newsletter send | 3–12 hours | Wide review window; content goes stale after a few days |
| Database purge | 1–4 hours | Narrow window — if you miss it, wait for the next run checkpoint |
| Deployment | 900 s (15 min) | Tight window forces attention; stale deploys are risky |
| Report generation | 86400 s (24 h) | Reporting is low-risk and can wait a full day |

The default is 72 hours. For most scheduled jobs, something shorter is safer: it forces the decision to happen while the data is still fresh and stops an old action from being accidentally approved days later.

---

## What rejection and expiry mean

When `status` is `rejected` or `expired`, the script exits without the side effect. Nothing is sent, deleted, or deployed.

Rejection is explicit: someone reviewed the draft and declined. Expiry is implicit: no one responded within the window. Both are safe exits. You can treat them identically in your error handling or distinguish them if you want different alerting behavior:

```python
elif status == "rejected":
    print("Rejected by reviewer. Exiting.")
elif status == "expired":
    print("No response within window. Scheduled for next cycle.")
```

Expiry is not a failure — it is a correctness feature. A draft newsletter from three days ago is probably not worth sending. Setting a short window and letting it expire is a valid workflow.

---

## Handling human edits

When you set `editable: ["preview.body"]`, the reviewer can modify the draft before approving. The polling response then carries:

- `decision.final_preview.body` — the version the human approved (use this, not the original)
- `decision.diff` — a unified diff of what changed (present only when something was actually modified)

Always execute with `final_preview.body`. This is how one-click corrections work: the reviewer fixes a typo or updates a link directly in the inbox card, approves, and the corrected version goes out automatically.

---

## Next steps

- [Quickstart](quickstart.md) — get an API key and push your first test action in under five minutes
- [Notifications](notifications.md) — configure email, Slack, or Telegram so you are alerted the moment a cron job pushes an action
- [Audit log](audit-log.md) — review a history of what ran, what was approved, what was rejected, and when
