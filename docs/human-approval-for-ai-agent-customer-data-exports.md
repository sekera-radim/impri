# Human Approval for AI Agent Customer Data Exports and GDPR Requests

Human approval for AI agent customer data exports and GDPR requests: a reviewer checks scope and recipient before any personal data leaves your system.

---

## Why exports are the wrong thing to automate blindly

A support agent that handles "send me everything you have on me" is useful. It is also one misread email away from exporting the wrong person's records, or sending the right records to an address that only looks like the requester's. A GDPR access or portability request has a statutory clock, but a leaked export has no undo.

The failure modes are mundane:

- The agent matches the wrong customer (two accounts, similar names).
- The request is forwarded or spoofed, and the destination address is not the data subject's.
- The query is broader than the request and pulls in other people's data, such as shared-workspace messages.
- A prompt-injected ticket body tells the agent to "also include the admin table".

None of these need a smarter model. They need a person to look at three things before the export runs: **who**, **what**, and **where to**.

---

## What the reviewer sees

The agent does not export anything. It proposes the export as an action, and the card is the review surface. Put the facts a reviewer needs to verify identity and scope into the preview:

```python
import os, requests

API = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

body = """**Request:** GDPR Art. 15 access request, ticket #4821
**Data subject:** customer_id 99 (jane@example.com)
**Identity check:** reply came from the account email on file
**Scope:** profile, orders (2023-2026), support tickets
**Excluded:** internal notes, other users' messages
**Deliver to:** jane@example.com (encrypted ZIP, link expires in 7 days)
"""

r = requests.post(f"{API}/v1/actions", headers=H, json={
    "kind": "data.export",
    "title": "Export for customer 99 (GDPR access request #4821)",
    "preview": {"format": "markdown", "body": body},
    "expires_in": 86400,
    "editable": ["preview.body"],
    "idempotent": False,
    "undo": "Revoke the download link and delete the generated archive",
})
action = r.json()  # { id, status: "pending", inbox_url }
```

`idempotent: false` puts a "not idempotent" warning on the card, which is accurate: you cannot un-send an export. The `undo` text tells the reviewer what the escape hatch is before they approve.

---

## Executing only what was approved

The reviewer may tighten the scope, for example by deleting "support tickets" from the list. Because `preview.body` is editable, the decision carries the version they approved, and your export job must read from that, not from the original request:

```python
import time

while True:
    a = requests.get(f"{API}/v1/actions/{action['id']}", headers=H).json()
    if a["status"] != "pending":
        break
    time.sleep(10)

if a["status"] == "approved":
    approved_scope = a["decision"]["final_preview"]["body"]
    try:
        run_export(approved_scope)  # your code, not Impri
        status = "executed"
    except Exception:
        status = "execute_failed"
    requests.post(f"{API}/v1/actions/{action['id']}/result",
                  headers=H, json={"status": status})
```

`rejected` and `expired` fall through without running anything. That matters for deadlines: a request nobody reviewed is visible as an expired action rather than a silent failure, so it can be escalated by a human instead of being quietly dropped or auto-sent.

---

## Keep the export tool behind the gate

This only works if the gated call is the agent's **only** path to the data. If the agent also holds a database credential or a direct "send email with attachment" tool, it can bypass the approval. Give it a single `request_export` tool that creates the action and returns, and run the actual export from a separate job or wrapper that executes only on `approved`. See [integrations](integrations.md) for wrapping tools this way.

| Concern | Who handles it |
|---------|----------------|
| Verifying the requester's identity | Your agent gathers evidence; the human judges it |
| Deciding what is in scope | Human, via the edited preview |
| Building and delivering the archive | Your code |
| Recording who approved what and when | Impri ([audit log](audit-log.md)) |
| Legal deadlines, retention, redaction rules | You and your counsel |

---

## What Impri does not do

Impri is the approval gate only. It stores the proposed action, notifies a reviewer (email, ntfy, web push, or via [Slack](slack-approval.md) and other channels), and holds the decision. It does not find or redact personal data, interpret whether a request is legally valid, or perform the export. It is not a compliance product and does not make you GDPR-compliant; it gives you a human checkpoint and a record of it.

If you handle regulated data, consider [self-hosting](self-hosting.md) so action previews stay on your own infrastructure. Keep the preview to what the reviewer needs: identifiers and scope, not the exported data itself.

---

## Next step

Create a key and push your first action with the [quickstart](quickstart.md), then read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full request, poll, and report-result flow.
