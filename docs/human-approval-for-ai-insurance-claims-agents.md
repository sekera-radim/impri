# Human Approval for AI Insurance Claims Agents

An AI agent that drafts claim decisions is fast and usually right — add a human approval step before any denial or payout actually goes out.

---

## Why claims agents need a harder gate than most

A support-ticket agent that sends a wrong reply is embarrassing. A claims agent that auto-denies a legitimate injury claim, or auto-approves a payout on a fabricated document, is a regulatory complaint and a lawsuit. Claims processing already sits inside compliance frameworks (state insurance codes, NAIC model rules, internal underwriting authority limits) that assume a licensed human signs off on anything above a threshold. An LLM drafting the recommendation does not change who is legally on the hook for the decision.

The fix isn't "make the model more careful." It's structural: the agent proposes, an adjuster decides, and the payout code path only runs after that decision comes back.

---

## The workflow

1. Claims agent reads the intake (policy, incident report, attached photos/documents), drafts a recommendation: approve, deny, or approve-with-adjusted-amount.
2. Agent pushes that recommendation to Impri as a pending action instead of writing to the payout system.
3. An adjuster reviews the recommendation and supporting summary in their inbox, edits the payout amount if needed, and approves or rejects.
4. Only on `approved` does the agent call the actual payout/denial-letter API, using the adjuster's final numbers — never its own draft.

```python
import os, time, requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def submit_claim_decision(claim_id: str, recommendation: str, amount_cents: int, rationale: str):
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "claim.payout",
        "title": f"Claim {claim_id}: {recommendation} (${amount_cents/100:.2f})",
        "preview": {
            "format": "markdown",
            "body": f"**Recommendation:** {recommendation}\n\n**Amount:** ${amount_cents/100:.2f}\n\n**Rationale:** {rationale}",
        },
        "target_url": f"https://claims.internal/cases/{claim_id}",
        "editable": ["preview.body"],
        "expires_in": 259200,  # 72h — adjusters work business hours, don't rush them
        "idempotent": False,   # re-running a payout must never double-pay
        "undo": "Reverse via claims ledger adjustment, case reference " + claim_id,
    })
    return resp.json()["id"]

def wait_and_execute(action_id: str, claim_id: str):
    while True:
        result = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(15)

    if result["status"] == "approved":
        final = result["decision"]["final_preview"]["body"]  # carries adjuster edits
        issue_payout(claim_id, final)  # your actual disbursement call
        requests.post(f"{API}/v1/actions/{action_id}/result", headers=HEADERS,
                      json={"status": "executed"})
    else:
        log_no_action(claim_id, result["status"])  # rejected or expired — do nothing
```

New to the API shape? Start with the [quickstart](quickstart.md) — it covers getting a key on cloud or self-host. If your agent is already Python, the [Python SDK](sdk-python.md) wraps these same three calls.

---

## What the adjuster's card should carry

Impri shows whatever you put in `preview.body`, so the recommendation needs to be self-contained — the adjuster shouldn't have to tab over to the claims system to make a call.

| Claim type | What belongs in the preview | `editable` field worth setting |
|---|---|---|
| Auto collision, low value | Estimate summary, photos link, recommended amount | `preview.body` (amount adjustment) |
| Health claim, denial | Policy clause cited, denial reason, appeal rights text | `preview.body` (reason wording) |
| High-value liability | Full narrative, prior claims history, legal flag | Usually not editable — escalate as-is |

For anything above a dollar threshold you'd normally route to a senior adjuster or a second reviewer, don't set `editable` at all — force a clean approve/reject rather than letting the amount get quietly changed inline.

---

## Idempotency and undo matter more here than anywhere else

Insurance payouts are the textbook case for the `idempotent: false` flag: if your polling loop retries after a network hiccup and creates a second action for the same claim, that's a duplicate payment, not a duplicate email. Always set `undo` to something a human could actually execute — "reverse via claims ledger adjustment" is useful; "contact finance" is not. Every decision, edit, and payout confirmation lands in the [audit log](audit-log.md), which is what you hand to compliance when they ask why a specific claim was paid.

---

## What this doesn't solve

Impri gates the payout call — it does not adjudicate the claim, verify documents, or detect fraud. Those stay the agent's (and adjuster's) job. And the gate only holds if the payout system's credentials live behind the wrapper that waits for `approved`; if the agent also has direct access to the disbursement API "just in case," it can route around the review entirely. Wrap the disbursement call itself, not just the recommendation step.

Next: see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full mechanics of the approve/reject loop.
