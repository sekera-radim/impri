# Reversible vs Irreversible AI Agent Actions: What to Gate

Not every AI agent action needs a human. Learn which reversible vs irreversible actions to gate, and how to flag them on the approval card with Impri.

---

## Gate by cost of being wrong

If you route every agent action through a human, the inbox becomes noise and people start approving on autopilot. If you gate nothing, the first bad action is your problem. The useful question per action is: **if this is wrong, can I take it back, and how much does it cost?**

| Action | Reversible? | Suggested treatment |
|--------|-------------|---------------------|
| Read a file, query a read-only API | n/a, no side effect | Let the agent run freely |
| Create a draft, a branch, a scratch record | Yes, cheap | Usually no gate; log it |
| Update a CRM field, edit a wiki page | Mostly, with history | Gate if customer-visible |
| Send an email, post publicly, message a customer | No | Gate |
| Charge a card, issue a refund, wire money | No, or costly | Gate, short expiry |
| Delete data, drop a table, revoke access | No | Gate every time |

The line is not "dangerous vs safe". It is "undoable vs not". An email cannot be unsent, so it belongs on the gated side even though it looks harmless.

## Tell the reviewer which kind it is

`POST /v1/actions` accepts two optional fields for exactly this. `idempotent` says whether re-running the action is safe; when it is `false`, the inbox card shows a warning badge that retrying may duplicate the action. `undo` is a plain-text description of the escape hatch, shown on the card so the reviewer knows what rollback looks like before approving.

```python
import os
import requests

BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

# Policy: which kinds are worth a human. Everything else runs directly.
GATED = {
    "email.send": {"idempotent": False, "undo": None},
    "invoice.void": {"idempotent": False, "undo": "Re-issue the invoice from the billing dashboard"},
    "record.delete": {"idempotent": False, "undo": "Restore from last night's backup"},
    "crm.update": {"idempotent": True, "undo": "Set the field back to its previous value (in the preview)"},
}

def propose(kind: str, title: str, body: str) -> str:
    policy = GATED[kind]
    payload = {
        "kind": kind,
        "title": title,
        "preview": {"format": "markdown", "body": body},
        "idempotent": policy["idempotent"],
        "expires_in": 3600,
    }
    if policy["undo"]:
        payload["undo"] = policy["undo"]
    r = requests.post(f"{BASE}/v1/actions", json=payload, headers=HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()["id"]
```

Note that the `GATED` table is your policy, kept in your code. Impri does not classify actions for you and does not decide what needs approval; it holds the decision for whatever you send it.

## An irreversible action with an honest undo

An honest `undo` string matters. "N/A, cannot be undone" is a perfectly good value for an email, and it tells the reviewer this click is final. For a deletion, name the actual recovery path. If none exists, say so, and consider whether the agent should be allowed to propose it at all.

## Receipts close the loop

After executing, report back so the card records what happened. `result.payload` can carry structured data such as the ID of the created object.

```python
def report(action_id: str, ok: bool, payload: dict | None = None):
    body = {"status": "executed" if ok else "execute_failed"}
    if payload:
        body["payload"] = payload
    requests.post(
        f"{BASE}/v1/actions/{action_id}/result",
        json=body, headers=HEADERS, timeout=10,
    ).raise_for_status()
```

## Limits of this approach

- The gate only works if the gated tool is the agent's only route to the side effect. An agent that also holds the raw API key can skip it.
- Impri does not verify that `undo` is true or that `idempotent` is accurate. Those are your claims, shown to the human.
- Impri does not execute anything and is not a workflow engine. Rollback, if needed, is your code.

## Next step

Start with the [quickstart](quickstart.md), then see the broader [guardrails for real-world actions](ai-agent-guardrails-for-real-world-actions.md) and [approving payments and charges](approve-ai-agent-payments-and-charges.md) for high-stakes examples.
