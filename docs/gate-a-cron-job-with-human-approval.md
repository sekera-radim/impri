# Add Human Approval to a Cron Job Without Blocking

Let the cron job propose instead of act: the first run files an Impri card keyed to its slot, later runs read the decision and send the approved text once.

Each run is a short check; Impri holds the state between runs. The script below was run end to end on 2026-11-22 against a local Impri server built from the repository (Python 3.12, httpx 0.28.1, every run a separate process). What those runs showed is listed after the code.

---

## Why not wait inside the cron run

The obvious version pushes the draft and then polls `GET /v1/actions/:id` until someone decides. On a cron schedule that breaks in three ways:

- The process lives for hours. If the next tick fires while it waits, a second copy starts and pushes a second card.
- A reboot or a deploy kills the waiting process, and the decision arrives to nobody.
- A retry or a manual rerun opens another card. Without an `idempotency_key`, Impri only folds a repeat into an existing card when kind, title and body are identical and still pending, and an LLM-written draft is never identical twice.

So each run looks up the card for its slot and does whatever the card's status says.

---

## The pattern: one card per slot, every run checks it

The slot is the unit of work: this week's newsletter, tonight's purge, today's report. Its key (`newsletter-2026-W48`) goes into `idempotency_key`, so the slot can never hold two cards.

| What the run finds | What it does |
|---|---|
| No card for this slot | Proposes it (`POST /v1/actions` with the slot key) and exits |
| `pending` | Exits; the next run looks again |
| `approved` | Reads `decision.final_preview`, sends it, reports `executed` |
| `rejected`, `expired`, `executed`, `execute_failed` | Nothing: the slot is settled |

The lookup is `GET /v1/actions?kind=…&since=…` filtered by `idempotency_key` in the script. `since` is the start of the slot (Unix seconds), so the list stays short.

---

## Example: weekly newsletter (Python)

```python
#!/usr/bin/env python3
"""weekly_newsletter.py: cron runs this every 10 minutes on Mondays.

The first run of the week proposes the draft as an Impri card. Later runs
look the card up and send the approved text once. Nothing waits in between.
"""
import datetime as dt
import os
import sys

import httpx

KIND = "newsletter.send"
impri = httpx.Client(
    base_url=os.environ.get("IMPRI_BASE_URL", "https://api.impri.dev"),
    headers={"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"},
    timeout=15,
)


def draft_newsletter() -> str:
    return "**This week in AI tools**: five picks from the past 7 days..."


def send_newsletter(body: str) -> str:
    raise NotImplementedError("your send call; return the provider's message id")


def this_week() -> tuple[str, int]:
    """ISO week label and Monday 00:00 local time as Unix seconds."""
    today = dt.date.today()
    year, week, weekday = today.isocalendar()
    monday = dt.datetime.combine(today - dt.timedelta(days=weekday - 1), dt.time())
    return f"{year}-W{week:02d}", int(monday.timestamp())


def find_card(key: str, since: int) -> dict | None:
    r = impri.get("/v1/actions", params={"kind": KIND, "since": since, "limit": 100})
    r.raise_for_status()
    return next((a for a in r.json()["items"] if a.get("idempotency_key") == key), None)


def report(action_id: str, status: str, detail: str) -> None:
    r = impri.post(f"/v1/actions/{action_id}/result",
                   json={"status": status, "detail": detail[:500]})
    r.raise_for_status()


def main() -> int:
    week, since = this_week()
    key = f"newsletter-{week}"
    card = find_card(key, since)

    if card is None:
        r = impri.post("/v1/actions", json={
            "kind": KIND,
            "title": f"Weekly newsletter {week}",
            "preview": {"format": "markdown", "body": draft_newsletter()},
            "editable": ["preview.body"],
            "expires_in": 10 * 3600,
            "idempotency_key": key,
        })
        r.raise_for_status()
        print(f"proposed {r.json()['id']} {r.json().get('inbox_url', '')}")
        return 0

    if card["status"] != "approved":
        # pending: look again next run. rejected, expired, executed,
        # execute_failed: this week is settled.
        print(f"{card['id']} is {card['status']}")
        return 0

    r = impri.get(f"/v1/actions/{card['id']}")
    r.raise_for_status()
    body = r.json()["decision"]["final_preview"]["body"]  # with the reviewer's edits
    try:
        receipt = send_newsletter(body)
    except Exception as exc:
        report(card["id"], "execute_failed", str(exc))
        raise
    report(card["id"], "executed", receipt)
    print(f"sent {card['id']} as {receipt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

The crontab runs it every 10 minutes from 07:00 to 18:50 on Mondays. `flock -n` skips a run while the previous one still holds the lock:

```cron
IMPRI_API_KEY=im_...
*/10 7-18 * * 1  flock -n /tmp/weekly-newsletter.lock /opt/jobs/venv/bin/python /opt/jobs/weekly_newsletter.py
```

Every call in the script needs only the `actions` scope, so give the job a key with nothing else. `expires_in` of 10 hours closes a card proposed at 07:00 at 17:00; the runs after that find it `expired` and leave the week alone.

---

## What the runs showed

- **A regenerated draft changes nothing.** The second run drafted a different text, found the card and exited. The card kept the first draft, so what the reviewer reads is what goes out.
- **Edits arrive.** The card was approved with a corrected body in the inbox; the next run sent the corrected text from `decision.final_preview.body` and reported `executed`. The run after that printed `executed` and sent nothing. A second result report gets `409`.
- **The key holds under a race.** Six simultaneous `POST /v1/actions` with one key returned one `201` and five `200`, and the slot had one card.
- **The key does not stop a double send; the lock does.** Two overlapping runs over an approved card, with a send that took 2 seconds, sent the newsletter twice (the second report got `409`). With `flock -n`, once.
- **Rejected and expired cards send nothing.** An expired card flipped from `pending` to `expired` within a minute of its `expires_at`; later runs left the week alone.
- **A failed send is recorded.** When the send raised, the run reported `execute_failed` with the error as `detail` (it shows in the audit log) and exited with status 1, so cron mails you. Later runs did not retry.

---

## Two gaps to know

**Between the send and the report.** If the send succeeds and the result call fails, the next run sees `approved` and sends again. If your provider accepts an idempotency key, pass it the card id.

**The monthly limit on the cloud plans.** Cloud plans count decisions per month (100 on Free). Once a project has used them, `POST /v1/actions` returns `402` for a new card; a repeat of a key that already has a card still gets that card back with `200`. The script reads with `GET`, which the limit does not touch, so a card approved before the limit still goes out; only next week's proposal waits.

---

## Picking `expires_in` for a schedule

Size the window to how long the side effect is still worth doing. Impri accepts 300 seconds to 30 days; the default is 72 hours, too long for most schedules. The run interval sets the delay between approval and execution: with runs every 10 minutes, an approved newsletter goes out within 10 minutes. More on choosing windows in [handling approval timeouts and expiry](handling-approval-timeouts-and-expiry-in-agents.md).

---

## Related patterns

- [Scheduled AI scripts on CI runners](human-approval-for-scheduled-ai-scripts.md): the same propose and execute split on GitHub Actions.
- [Agents that run overnight](approval-gate-for-overnight-ai-agents.md): many cards, one morning review pass.
- [Blocking vs polling for approval](blocking-vs-polling-for-human-approval.md): when a long-running process may wait.

---

## Next step

Run the script against your own inbox. [Self-host Impri](quickstart.md) with `docker compose` and set `IMPRI_BASE_URL` to your server, or [start free on the cloud](https://app.impri.dev/?signup=1) and [create an `actions`-scoped key](api-keys.md). Then set up [notifications](notifications.md) so the Monday card reaches your phone.
