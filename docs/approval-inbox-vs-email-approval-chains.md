# Approval Inbox vs Email Approval Chains

Approval inbox vs email approval chains for AI agents: compare forwarded reply threads with one decision record, expiry, editable drafts and an audit trail.

---

## The email chain, as it usually starts

An agent drafts something risky, so it emails a human: "Reply APPROVE to send." It works for the first week. Then the same pattern spreads, and an approval becomes a thread: the agent mails a manager, the manager forwards to legal, legal replies-all with a tweak, and somewhere in the middle someone writes "ok" below a quoted draft.

Email is a fine *notification* medium. It is a poor *state* medium. The problems are structural:

- **No single source of truth.** "Was this approved?" means reading a thread and guessing which message counts.
- **Parsing is your job.** Your agent has to poll a mailbox, strip quoted text, and decide whether "ok, but not the second paragraph" is a yes.
- **No expiry.** A three-day-old "APPROVE" reply can still arrive after the draft went stale.
- **Edits are lost.** A tweak in reply text never becomes the version the agent actually sends.
- **Two people can both answer.** Nothing arbitrates; the agent acts on whichever it reads first.

---

## The same flow with a decision record

Instead of a thread, the agent pushes one action and polls one status field:

```python
import os, time, requests

BASE = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

action = requests.post(f"{BASE}/v1/actions", headers=H, json={
    "kind": "email.send",
    "title": "Renewal reminder to Acme (contract #118)",
    "preview": {"format": "markdown", "body": "Hi Dana, your plan renews on..."},
    "expires_in": 86400,
    "editable": ["preview.body"],
}).json()

while True:
    r = requests.get(f"{BASE}/v1/actions/{action['id']}", headers=H).json()
    if r["status"] != "pending":
        break
    time.sleep(10)

if r["status"] == "approved":
    send_renewal_email(r["decision"]["final_preview"]["body"])
    requests.post(f"{BASE}/v1/actions/{action['id']}/result", headers=H,
                  json={"status": "executed"})
```

There is nothing to parse. The status is one of `pending`, `approved`, `rejected` or `expired`, and the agent executes with `decision.final_preview`, which carries whatever the reviewer edited. The response also includes an `inbox_url` you can hand to the reviewer.

---

## Email chain vs inbox, side by side

| Concern | Email approval chain | Approval inbox (Impri) |
|---|---|---|
| Where the answer lives | Somewhere in a thread | One `status` on one action |
| Two reviewers disagree | Agent acts on first reply it reads | First decision wins; a concurrent second one gets HTTP 409 |
| Stale requests | Reply can arrive any time | `expires_in` from 5 minutes to 30 days (default 72 h), then `expired` |
| Reviewer edits the draft | Pasted into reply text | `editable` fields; result in `decision.final_preview`, with a `diff` |
| Who decided, when, from where | Header metadata, if you kept it | Recorded with each decision, including the channel |
| Clearing a backlog | Open and answer each mail | Bulk decision of up to 50 actions per request |

The first-decision-wins behaviour is enforced by a unique constraint on the decision per action, inside a transaction, so two simultaneous clicks cannot both succeed.

---

## Keep email, drop the chain

You do not have to give up email. Impri can send an email notification (an email channel, configured server-side with SMTP and confirmed via a link before anything is delivered), alongside Slack, Discord, Telegram, ntfy or a webhook. Several actions arriving within the channel's digest window are batched into one message, so a burst does not flood an inbox. The email is a pointer: the decision itself is made on the action, not by replying to the message.

If your reviewers genuinely only live in email, see [approving agent actions by email](approve-ai-agent-actions-by-email.md) for how that maps onto the inbox.

---

## What this does not fix

Be clear about the boundary. Impri is only the approval gate: it stores the proposed action, notifies a human and holds the decision. It does not generate the draft, interpret what the action does, or execute anything. It is a real gate only if the wrapped tool is the agent's *only* path to the side effect; an agent that also holds the raw SMTP credentials can still send around it.

It is also not a workflow engine. If your process is a genuine multi-stage chain (manager, then legal, then finance, each with conditions), model that sequence in your own orchestrator or in a tool like n8n or Temporal, and use one Impri action per approval step.

---

## Next steps

- [Quickstart](quickstart.md): get a key and push your first action.
- [Notifications](notifications.md): set up email and chat channels, digest windows included.
- [Audit log](audit-log.md): see what is recorded for each decision.
