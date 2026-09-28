# When Credentials Expire While Your AI Agent Waits for Approval

An approval can sit pending for up to 30 days, but the OAuth token your agent needs to execute it might expire in an hour — here's how to keep the credential fresh without touching Impri's expiry at all.

---

## Two lifetimes that have nothing to do with each other

An Impri action has one clock: `expires_in`, which defaults to 72 hours and can be set anywhere from 5 minutes to 30 days. That clock belongs entirely to Impri and governs whether a human can still approve the action.

The credential your agent needs to *carry out* the approved action has a completely separate clock, one Impri knows nothing about: a Gmail or Google Workspace access token typically lives for about an hour, a Salesforce session token for a few hours to a day, a Slack bot token effectively forever, a short-lived cloud provider STS token for as little as 15 minutes. If your agent fetched that token at the moment it pushed the action, and the human doesn't approve for six hours, the token is dead long before the decision comes back.

This is not an edge case — it's the default outcome for any action whose `expires_in` is longer than the credential's own TTL, which for most OAuth access tokens is nearly always true.

---

## The fix: fetch the credential after the decision, not before

Impri never sees or stores your downstream credentials — `preview.body` is what the human reviews, and it should never contain a live token. The fix follows directly from that: treat "get a valid token" as a step that happens *after* `GET /v1/actions/:id` returns a non-pending status, not before you call `POST /v1/actions`.

```python
import os
import time
import requests

BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}", "Content-Type": "application/json"}

def push_action(subject: str, body: str) -> str:
    resp = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json={
        "kind": "email.send",
        "title": f"Send: {subject}",
        "preview": {"format": "plain", "body": body},
        "expires_in": 259200,  # 72h — the token will not survive this; that's fine
        "editable": ["preview.body"],
    })
    return resp.json()["id"]

def wait_for_decision(action_id: str, poll_timeout_s: int = 240, interval_s: int = 10) -> dict | None:
    deadline = time.monotonic() + poll_timeout_s
    while time.monotonic() < deadline:
        status = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if status["status"] != "pending":
            return status
        time.sleep(interval_s)
    return None  # still pending — a later invocation checks again

def execute_if_approved(action_id: str, decision: dict):
    if decision["status"] != "approved":
        return
    # Fetch a fresh token now, right before use — not when the action was pushed.
    access_token = refresh_gmail_token(os.environ["GMAIL_REFRESH_TOKEN"])
    send_gmail(access_token, decision["decision"]["final_preview"]["body"])
    requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed"})
```

The refresh call itself is just the normal OAuth refresh-token grant for whichever provider you're integrating — Impri has no part in it and no opinion on how you store the refresh token, beyond "not inside the action's `preview`."

---

## Long-running workers vs. short-lived invocations

The fetch-after-decision rule is easy to satisfy on a long-lived worker: hold the refresh token, not the access token, in memory or in your secret store, and mint a new access token in the branch that runs after `impri_await_decision` returns approved.

It's less obvious on a serverless setup that pushes the action and exits, then gets re-invoked later by a cron trigger or a webhook (see [blocking vs. polling for human approval](blocking-vs-polling-for-human-approval.md) for that split). There, the temptation is to cache the access token alongside the `action_id` so the resuming invocation doesn't have to hit the OAuth provider again. Don't — by the time a `pending` action resolves, any access token cached at push time is almost certainly stale. Cache the refresh token or the service-account key instead, and treat "mint an access token" as one of the first things the resuming invocation does, every time.

| Credential type | Typical TTL | Safe to fetch at push time? |
|---|---|---|
| OAuth access token (Gmail, Slack user token, Google Sheets) | ~1 hour | No — refresh after decision |
| Cloud STS / assume-role token | 15 min – 12 hours | No — refresh after decision |
| Service account key / API key | Long-lived or non-expiring | Usually fine either way |
| Refresh token / client secret | Long-lived | This is what you cache, not the access token |

---

## What happens if the refresh itself fails

If the refresh token has been revoked, or the provider's OAuth app lost consent, you'll find out in the execution branch, after a human already approved the action — not before. Report that honestly rather than silently retrying:

```python
requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=HEADERS,
              json={"status": "execute_failed"})
```

`execute_failed` is a distinct status from `executed` precisely so the person who approved the action can see, from the inbox, that their approval didn't translate into the action actually happening — which is a different problem from a rejection and needs a different fix (re-authorize the integration), not a resubmitted action.

---

## Related reading

This is a different clock than the one covered in [handling approval timeouts and expiry in agents](handling-approval-timeouts-and-expiry-in-agents.md) — that page is about the action's own `expires_in` versus your poll loop's timeout. If you haven't wired up the three basic calls yet, start with [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).
