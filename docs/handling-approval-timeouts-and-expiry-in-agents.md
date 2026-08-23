# Handling Approval Timeouts and Expiry in Agents

Two clocks run against every pending approval — your poll loop's own timeout and the action's `expires_in` — and confusing them makes agents execute stale drafts or silently drop good ones.

---

## Two different timeouts, easily confused

When an agent asks a human to approve something, there are two independent deadlines in play:

1. **The poll timeout** — how long *your code* is willing to keep checking `GET /v1/actions/:id` (or block on `impri_await_decision`) before giving up and moving on to other work.
2. **The action's expiry** — `expires_in` on the action itself, tracked by Impri. Once this passes, the status flips to `expired` server-side and the action can no longer be approved, no matter who checks it or when.

These are not the same thing, and treating them as interchangeable causes two distinct bugs: an agent that stops polling too early and misses a decision made five minutes later, or an agent that keeps a long-running process alive for days waiting on an action that expired hours ago.

---

## Timeout 1: your poll loop giving up

Your poll loop timeout should usually be *shorter* than `expires_in`, not equal to it. If the agent is a long-running background worker, it can afford to poll for the full expiry window. If it's a short-lived script (a CI job, a serverless function), it should poll for as long as it can afford to run, then exit and let a separate process pick the decision back up later via `GET /v1/actions/:id` — the action is still `pending` in Impri regardless of whether your script is watching it.

```python
import time
import requests

BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

def poll_for_decision(action_id: str, poll_timeout_s: int = 240, interval_s: int = 10):
    """Polls up to poll_timeout_s, but the action itself may still be
    pending in Impri after this function gives up — that's expected."""
    deadline = time.monotonic() + poll_timeout_s
    while time.monotonic() < deadline:
        resp = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS)
        status = resp.json()["status"]
        if status != "pending":
            return resp.json()
        time.sleep(interval_s)
    return None  # still pending — caller decides whether to re-check later
```

If `poll_for_decision` returns `None`, that is not a rejection. It just means this process ran out of patience. A cron job that runs every 15 minutes and re-checks `pending` action IDs from a small local store is a common pattern for agents that can't block indefinitely.

---

## Timeout 2: the action itself expiring

`expires_in` is set once, at creation, and is enforced by Impri regardless of what your agent does afterward. It accepts a minimum of 300 seconds and a maximum of 2,592,000 (30 days), defaulting to 259,200 (72 hours). Once the deadline passes, `GET /v1/actions/:id` returns `status: "expired"` permanently — there is no way to re-open it.

Treat `expired` exactly like `rejected` in your execution branch: never run the side effect.

```python
result = poll_for_decision(action_id)
if result is None:
    pass  # still pending, check again later
elif result["status"] == "approved":
    execute(result["decision"]["final_preview"])
elif result["status"] in ("rejected", "expired"):
    log_dropped_action(action_id, reason=result["status"])
    # optionally: re-propose if the underlying task is still relevant
```

---

## What to do when expiry hits mid-task

If the task that generated the action is still relevant after expiry — the agent still wants to send that email, just later — push a fresh action rather than trying to resurrect the old one. Carry over the `undo` and `idempotent` hints if you set them originally, and consider a shorter `expires_in` the second time if the content is time-sensitive (a reply to a live thread, a price quote) so a third stale duplicate can't pile up.

---

## Choosing `expires_in` per action kind

| Action kind | Suggested `expires_in` | Why |
|---|---|---|
| Reply to a live social thread | 900–3600s (15–60 min) | Stale replies read as out of touch |
| Outbound sales/support email | 21600–86400s (6–24h) | Human needs a real review window |
| Scheduled content publish | 86400–259200s (1–3 days) | Not urgent, but shouldn't linger |
| Infrastructure change (deploy, delete) | 300–1800s (5–30 min) | Short-lived, high-stakes, act fast or drop |

---

## Next step

Once timeout handling is in place, wire the actual gate into your agent's tool call — see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full three-call pattern, the [Python SDK](sdk-python.md) if you'd rather not hand-roll the polling loop, and [quickstart](quickstart.md) to get an API key.
