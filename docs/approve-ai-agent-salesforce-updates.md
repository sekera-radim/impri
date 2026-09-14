# Approve AI Agent Salesforce Updates Before They Save

Give an AI agent write access to your CRM without giving it blast radius — gate every Salesforce record update behind a human approval with Impri.

---

## The problem: agents that write to Salesforce

A CRM enrichment agent reads inbound emails, call transcripts, or a data provider, then writes back to Salesforce: updating a Contact's title, changing an Opportunity stage, appending a Note. Read access is low risk. Write access is not — a bad enrichment run can silently corrupt account data across thousands of records before anyone notices, and Salesforce audit trails tell you *what* changed, not whether it was *correct*.

The fix isn't "review changes after the fact" in a report nobody reads. It's stopping the write from happening until a person on the sales or ops team has actually looked at the proposed value.

## What "approval" means for a CRM update

Impri sits between the agent's decision and the Salesforce API call. The agent doesn't call `sobjects/Account/{id}` directly — it pushes the proposed field change as an action, waits for a decision, and only calls the Salesforce update if that decision is `approved`. The reviewer sees the record name, the field, the old value (if you include it in the preview), and the new value — not raw JSON.

```python
import os
import time
import requests
from simple_salesforce import Salesforce

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
HEADERS = {"Authorization": f"Bearer {IMPRI_KEY}"}

def propose_account_update(account_id, account_name, field, old_value, new_value):
    body = (
        f"Account: **{account_name}** ({account_id})\n\n"
        f"Field: `{field}`\n\n"
        f"Current: `{old_value}`\n\nProposed: `{new_value}`"
    )
    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers=HEADERS,
        json={
            "kind": "salesforce.record.update",
            "title": f"Update {field} on {account_name}",
            "preview": {"format": "markdown", "body": body},
            "target_url": f"https://yourinstance.lightning.force.com/lightning/r/Account/{account_id}/view",
            "expires_in": 21600,  # 6h — stale enrichment isn't worth applying
            "editable": ["preview.body"],
        },
    )
    return resp.json()["id"]

def wait_and_apply(action_id, sf: Salesforce, account_id, field):
    while True:
        result = requests.get(
            f"https://api.impri.dev/v1/actions/{action_id}", headers=HEADERS
        ).json()
        if result["status"] != "pending":
            break
        time.sleep(10)

    if result["status"] != "approved":
        return result["status"]  # rejected or expired — do not write

    new_value = result["decision"]["final_preview"]["body"]
    sf.Account.update(account_id, {field: new_value})

    requests.post(
        f"https://api.impri.dev/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
    return "executed"
```

Note the reviewer sees a Markdown summary, not the literal value they must approve — for a CRM update you'll usually want the *actual* new field value to be unambiguous in the preview text, since `final_preview.body` here is the whole rendered card, not a structured field. Keep the value on its own line so a human reviewer (or your own downstream parser, if you re-extract it) can't confuse it with surrounding text.

## What the human sees before approving

The approval card shows the account name, the field, and both values, plus a link (`target_url`) straight to the record in Salesforce so the reviewer can check other context — recent activity, owner, related opportunities — before deciding. That link is what turns "approve a JSON diff" into "approve a business decision."

## Handling edits to the field values

Setting `editable: ["preview.body"]` lets the sales ops reviewer fix a value inline — say, the agent proposed "VP Engineering" but the reviewer knows the correct title is "VP of Engineering." `decision.final_preview.body` carries that correction. Always write `final_preview`, never the original `preview` — the API guarantees `final_preview` holds whatever the human actually approved, edited or not.

## Where this fits in a bigger CRM agent

A single agent run against a stale contact list might propose hundreds of updates. Route them all to one inbox and use bulk decision (`POST /v1/actions/bulk-decision`) so a reviewer can approve a batch of clearly-correct updates at once and pull out the few that need individual attention, rather than clicking through each one. Pairing this with the [MCP integration](mcp.md) means the same agent code path can run from Claude Code during development and from a scheduled job in production without touching the approval logic.

## What Impri does not do here

Impri doesn't validate that the proposed Salesforce value is *correct* — it doesn't know your CRM schema or business rules. It also isn't a Salesforce-specific integration; there's no `salesforce.*` kind built in, `salesforce.record.update` above is just a label your code chooses for the audit log. And it doesn't stop the agent from calling the Salesforce API directly if the credential is available elsewhere in your code — the gate only holds if the write path is wrapped so `sf.Account.update(...)` is unreachable without an approved decision, as covered in [the SDK integrations guide](integrations.md).

Next step: [add the polling loop from the quickstart](quickstart.md) to your existing enrichment job, then swap direct writes for the propose-and-wait pattern above.
