# An Approval Gate for Agents That Run While You Sleep

Overnight AI agents draft emails, tickets, and posts while you're asleep — this shows how to queue their actions for a morning approval pass instead of firing blind.

---

## The problem with "runs overnight, unattended"

A cron job that kicks off a Claude Code agent at 2am to triage inbox threads, draft support replies, or scan RSS feeds for content ideas is genuinely useful — until the agent decides one of those drafts should go out immediately. Nobody is watching at 2am. If the draft is wrong, or a scraped page contained an injected instruction, it ships before anyone notices. The fix isn't "don't run agents overnight" — it's separating **drafting** (fine to do unattended) from **sending** (needs a human awake to look at it).

Impri sits at that boundary. The overnight agent pushes every side-effecting action to Impri and stops. It doesn't wait around — there's no one to notify at 2am anyway. You review the stack when you wake up.

---

## Setting a long expiry for the wake-up window

The default `expires_in` (72 hours) is fine, but for a nightly batch you want actions to survive until morning without needing to be precise about timing. Set it explicitly and generously — a support-reply batch from a 2am run should still be valid at 9am, and probably still relevant at lunch:

```python
import requests
import os

IMPRI_KEY = os.environ["IMPRI_API_KEY"]

def queue_overnight_draft(kind, title, body, target_url=None):
    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "target_url": target_url,
            "expires_in": 43200,  # 12h — covers an overnight run through late morning
            "editable": ["preview.body"],
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]

# Called once per drafted reply during the 2am batch run
for ticket in nightly_triage_batch():
    queue_overnight_draft(
        kind="support.reply",
        title=f"Draft reply: {ticket.subject}",
        body=ticket.drafted_reply,
        target_url=ticket.helpdesk_url,
    )
```

The agent's job ends at `queue_overnight_draft`. It never polls, never waits, never executes — that happens later, from a separate process, only after a human has looked at the inbox.

---

## Batch review in the morning, not one card at a time

A single overnight run can produce a dozen drafts. Reviewing them one by one on your phone before coffee is tedious enough that people start rubber-stamping — which defeats the point. Use the bulk-decision endpoint from a morning review pass to approve the obvious ones together and open only the ones that need a closer read:

```bash
# Check one action's status before deciding
curl -s https://api.impri.dev/v1/actions/act_101 \
  -H "Authorization: Bearer $IMPRI_API_KEY"

# Decide on several at once via the bulk endpoint, rather than
# one API call (or one inbox tap) per drafted reply
curl -s -X POST https://api.impri.dev/v1/actions/bulk-decision \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["act_101", "act_102", "act_105"]}'
```

In practice most people just do this from the inbox web UI on their phone — the bulk endpoint matters when you're scripting a review pass over a batch you've already read, which is a judgment call you make, not something Impri infers on its own.

---

## Push notifications so you don't have to remember to check

Nobody wants to open an app every morning just in case. Wire a push channel so the overnight batch actually surfaces instead of sitting silently in an inbox: ntfy or web push for a phone buzz, or Telegram if you already triage there. See [notifications](notifications.md) for setup and [telegram-approval](telegram-approval.md) if you want approve/reject buttons directly in a chat thread — useful for a half-asleep glance before getting out of bed.

---

## What this doesn't solve

Impri holds the decision; it doesn't decide anything about *when* your agent should run or *how* it should batch work — that scheduling logic is yours (cron, a queue, whatever you already use). It also doesn't retroactively protect you from an agent that has its own direct credentials to the sending service — the gate only holds if the overnight process's *only* path to sending is through the approved action. Wrap the actual send/publish call so it hard-depends on the approved `final_preview`, as described in [the approval guide](how-to-add-human-approval-to-an-ai-agent.md).

---

## Next step

Start with [quickstart](quickstart.md) to get an API key, then wire your nightly job to push actions instead of executing them directly.
