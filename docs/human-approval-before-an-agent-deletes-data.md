# Require Human Approval Before an Agent Deletes Data

Delete is the one action an agent can't undo by apologizing. Here's how to gate `DELETE` calls behind a human decision so a bad prompt never turns into a bad purge.

---

## Why deletes need a different posture than sends or posts

Most human-in-the-loop guides use "send an email" as the example, because a bad email is embarrassing but recoverable — you can send a correction. A bad delete is not recoverable in the same way. If an agent runs a cleanup job, purges stale accounts, or removes rows a user asked it to "clean up," the failure mode isn't "oops, awkward" — it's "the data is gone and there's no undo button in the UI."

That changes what the approval card needs to show. For a delete, the reviewer isn't just checking tone or wording — they're checking *scope*: which rows, how many, and whether the filter is right. A `WHERE last_login < '2020-01-01'` clause that accidentally matches every row because of a bad NULL comparison is exactly the kind of thing a five-second human glance catches and an agent running unattended doesn't.

---

## Wrapping the delete function

Say you have a support-ops agent with a tool that deletes inactive customer accounts. The unsafe version calls the database directly:

```python
def delete_inactive_accounts(account_ids: list[str]) -> None:
    db.execute("DELETE FROM accounts WHERE id = ANY(%s)", [account_ids])
```

The agent's only path to that side effect should be a wrapped version that requires an approved Impri action first. Everything else — the model choosing to call the tool, the reasoning that led there — stays exactly as flexible as before. What changes is that the tool itself refuses to run without a decision:

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def delete_inactive_accounts(account_ids: list[str], reason: str) -> None:
    action = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "data.delete",
            "title": f"Delete {len(account_ids)} inactive accounts",
            "preview": {
                "format": "markdown",
                "body": f"**Reason:** {reason}\n\n**Account IDs:**\n" +
                        "\n".join(f"- {a}" for a in account_ids),
            },
            "idempotent": False,
            "undo": "No undo — restore from the nightly accounts backup snapshot if needed.",
            "expires_in": 3600,
        },
    ).json()
    action_id = action["id"]

    while True:
        result = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(10)

    if result["status"] != "approved":
        print(f"Delete blocked: {result['status']}")
        return

    db.execute("DELETE FROM accounts WHERE id = ANY(%s)", [account_ids])
    requests.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed", "payload": {"deleted_count": len(account_ids)}},
    )
```

The `account_ids` list is not editable here — for a delete, letting a human silently trim the list without the agent knowing is more confusing than useful. If you want that, add `"editable": ["preview.body"]` and re-derive the ID list from the edited markdown before executing, rather than trusting the original.

---

## `idempotent: false` and `undo` are doing real work here

Two of Impri's optional fields matter more for deletes than for almost any other action kind:

- **`idempotent: false`** — a retried delete of the same IDs is harmless (they're already gone), but a retry that includes *newly matched* rows because the filter re-ran is not. Setting this to `false` puts a "retrying may duplicate this action" warning on the card, which for a delete reads more like "retrying may delete more than you think" — worth the reviewer's attention.
- **`undo`** — even when there's no real undo, say so explicitly (`"No undo — restore from backup"`). A blank field reads as "reversible" by omission. A stated boundary reads as what it is.

---

## What the reviewer is actually deciding

| Question the card should answer | Where it comes from |
|---|---|
| How many rows / records are affected? | `preview.body` — state the count, not just "some accounts" |
| Why is this happening? | `title` + a reason line in the body |
| Can this be undone? | `undo` |
| Could a re-run duplicate the damage? | `idempotent: false` |

If your agent can't answer "how many rows" before pushing the action, that's worth fixing upstream — a delete proposal without a scoped count is asking the human to approve a blank check.

---

## Rejected and expired deletes

Treat `rejected` and `expired` identically: the delete never runs. For a destructive action, don't auto-retry a rejected delete with a "maybe try smaller batches" fallback unless a human explicitly asked for that — silently re-proposing a delete the reviewer just said no to defeats the point of asking.

See the full three-call pattern in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), how approvals show up in [the audit log](audit-log.md), and how to auto-route delete-kind actions to a specific reviewer with [rules](rules.md).
