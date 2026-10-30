# Approval Inbox vs a Shared Spreadsheet

Tracking AI agent approvals in a shared spreadsheet breaks down fast. See how an approval inbox gives the agent a real decision to wait for, not a typed cell.

A spreadsheet is the first thing most teams reach for: the agent appends a row with the proposed action, a human types "OK" in a status column. It is cheap and visible. This page covers where that stops working and what an approval inbox changes.

---

## What the spreadsheet version looks like

An agent proposes a refund, an outbound email or a record change. A script appends a row; a reviewer finds it eventually and edits a cell.

| Column | Value |
|--------|-------|
| proposed_at | 2026-10-30 09:12 |
| action | Send follow-up to Acme |
| draft | Hi Sarah, … |
| status | OK |

It is worth being fair about this: for one person, one agent and a handful of rows a day, it is fine. Nothing to host, nothing to learn.

---

## Where it breaks

- **Nobody is told.** A new row notifies no one. Approval latency is however often someone opens the sheet.
- **The status cell is not a decision record.** Anyone with edit access can change "OK" afterwards, and the sheet does not tell you who did it in a form the agent can rely on.
- **The agent has to trust a free-text cell.** "ok", "Ok ", "approved?" and "ok but change the subject" are all valid cell contents. Your code ends up parsing human typing.
- **Edits happen in the draft cell.** If the reviewer fixes the text, the agent must guess whether to send the original or the edited cell, and nothing records the difference.
- **Stale rows stay approvable.** A reply to a two-day-old thread can still be marked OK a week later and sent.
- **Bulk review is manual.** Approving twenty similar rows means twenty cell edits, with no separation between "rejected" and "forgot to look".

---

## The same flow with an inbox

The agent pushes the proposal and waits for the API to return a decision instead of reading a cell:

```python
import os, time, requests

BASE = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

action = requests.post(f"{BASE}/v1/actions", headers=H, json={
    "kind": "email.send",
    "title": "Follow-up to Acme",
    "preview": {"format": "markdown", "body": "Hi Sarah, …"},
    "expires_in": 86400,
    "editable": ["preview.body"],
}).json()

while True:
    r = requests.get(f"{BASE}/v1/actions/{action['id']}", headers=H).json()
    if r["status"] != "pending":
        break
    time.sleep(10)

if r["status"] == "approved":
    send_email(r["decision"]["final_preview"]["body"])  # your sender
    requests.post(f"{BASE}/v1/actions/{action['id']}/result",
                  headers=H, json={"status": "executed"})
```

`status` is one of `pending`, `approved`, `rejected` or `expired`, so there is nothing to parse. The reviewer's edits arrive in `decision.final_preview`, and a `diff` is included when something changed. The action expires after `expires_in` seconds (minimum 300, maximum 30 days, default 72 hours) and can no longer be approved.

---

## Side by side

| | Shared spreadsheet | Approval inbox |
|---|---|---|
| Reviewer is notified | Only if you build it | Email, ntfy or web push; approve from Slack, Discord or Telegram |
| Agent reads | A free-text cell | A fixed status value |
| Human edits | Overwrite the draft | `final_preview` plus a diff |
| Old proposals | Stay approvable | Expire |
| Bulk decisions | Cell by cell | `POST /v1/actions/bulk-decision` |
| Who decided and how | Whatever the sheet history shows | Decision and channel stored with the action; [audit log](audit-log.md) |
| Cost | Free | Self-host the MIT core or use the hosted service |

---

## What an inbox does not fix

Impri is only the gate. It stores the proposed action, notifies a human and holds the decision. It does not write the draft, interpret the action or execute anything.

It is a real gate only if the wrapped tool is the agent's **only** path to the side effect. An agent that still holds the raw email credential can skip the inbox just as easily as it could skip a spreadsheet. It is also not a workflow engine, not content moderation and not agent-to-agent coordination.

Keep the spreadsheet if you want a reporting view. Export from the [audit log](audit-log.md) instead of making the sheet the source of truth.

---

## Next steps

- [Quickstart](quickstart.md): get a key and push a first action.
- [Inbox](inbox.md): the review UI and the bulk decision API.
- [How to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md): the same pattern over REST and MCP.
