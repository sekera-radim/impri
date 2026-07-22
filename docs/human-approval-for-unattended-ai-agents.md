# Human Approval for Unattended AI Agents

An agent that runs on a schedule with nobody watching still needs a way to stop and ask — this covers the async approval pattern for unattended AI agents.

---

## The problem with "nobody's watching"

Most human-in-the-loop examples assume a person is sitting at a terminal, ready to approve within seconds. Unattended agents break that assumption entirely: a nightly cron job that drafts invoices, a scheduled scraper that posts market summaries, a batch pipeline that runs at 3am while you're asleep. There's no synchronous human on the other end of the loop.

That doesn't mean you skip the approval step — it means the approval has to be asynchronous and durable. The agent pushes a proposal and stops. A human reviews it whenever they next look at their phone, not necessarily within the next ten seconds. The gate has to survive that gap.

---

## Where the gate lives in an unattended pipeline

The shape is the same three calls as any Impri integration, but the framing changes: instead of a human hovering over a chat window, the notification channel (Telegram, Slack, email, push) *is* the interface. The agent pushes the action, then either exits (if it's a fire-and-forget batch job) or blocks on a long poll if it's a long-running process.

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_invoice_run(invoice_summary: str, total_amount: str):
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "finance.invoice_batch",
        "title": f"Nightly invoice run — {total_amount} across batch",
        "preview": {"format": "markdown", "body": invoice_summary},
        "idempotent": False,
        "undo": "Void the batch via the billing dashboard before end of day",
        "expires_in": 43200,  # 12h — long enough to survive the night
    })
    resp.raise_for_status()
    return resp.json()["id"]

def wait_for_decision(action_id: str, poll_every=60):
    while True:
        r = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r
        time.sleep(poll_every)
```

The cron job calls `propose_invoice_run`, exits, and a separate process — the next scheduled run, or a small daemon — calls `wait_for_decision` later. Nothing about the API requires the same process to do both halves.

---

## Sizing the expiry window for "nobody's watching yet"

`expires_in` matters more here than in synchronous flows. A 5-minute default is useless if the review happens over morning coffee eight hours later. Pick the window based on how long the action stays relevant, not how long you'd like the review to take:

| Unattended scenario | Reasonable `expires_in` |
|---|---|
| Overnight batch job, reviewed next morning | `43200` (12h) |
| Weekly report drafted Friday, reviewed Monday | `259200` (72h, the default) |
| Scraper alert tied to a live price/event | `1800`–`3600` (30–60 min — stale fast) |
| Low-urgency backlog item (e.g. content queue) | up to `2592000` (30 days, the max) |

If the window closes before anyone looks, the action expires and is never executed — treat `expired` exactly like `rejected` in your pipeline, and consider re-queuing the underlying task rather than silently dropping it.

---

## Polling from a stateless job vs. blocking from a daemon

Two honest patterns, pick based on how your unattended agent is deployed:

- **Stateless cron job**: push the action and exit immediately. On the *next* scheduled run, check any actions pushed by the previous run before doing new work. This avoids holding a process open for hours.
- **Long-running daemon**: use `impri_await_decision` (MCP) or a polling loop with backoff (REST) and just block, since the process is already resident.

Either way, the agent's actual side effect — sending the invoices, posting the summary — must live behind the `status == "approved"` check, not before it. An unattended agent is exactly the case where "the model will remember to check" isn't good enough; the code path has to make the unapproved branch unreachable.

---

## What Impri does not solve here

Impri stores the action, notifies you, and holds the decision — it does not decide *when* your unattended pipeline should run, retry, or fan out; that's still your scheduler's job (cron, a workflow engine, whatever triggers the agent). And it's only a real gate if the unattended process doesn't also hold a standing credential it could use to bypass the wrapper and act directly. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying three-call pattern this builds on, and [gate a cron job with human approval](gate-a-cron-job-with-human-approval.md) for the scheduler-specific version of this problem.

Next: if your unattended agent needs a hard stop rather than a per-action gate, see [add a kill switch to your AI agent](add-a-kill-switch-to-your-ai-agent.md).
