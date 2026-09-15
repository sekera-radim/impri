# Human Approval for Amazon Bedrock AgentCore Agents

Bedrock AgentCore agents can call real AWS APIs on their own schedule — this shows how to put an actual human decision, not just an AWS trace log, between an AgentCore tool and the action it takes.

---

## AgentCore's tracing isn't the same as someone saying yes

AgentCore Runtime gives you session isolation, a gateway for tool invocation, and a governance layer for rolling agents out incrementally. That's infrastructure for running the agent safely — it is not the same as a person looking at *this specific claim, this specific payout, this specific customer* and deciding it's correct before it goes out. A trace you can review after the fact tells you what happened. A gate tells you before it happens, and lets someone stop it.

The pattern below wraps a single AgentCore tool function so the side effect it triggers cannot run without an approved decision coming back from Impri.

---

## The gate: three calls around your AgentCore tool

This is a claims-payout tool exposed to the agent. The tool itself is the chokepoint — the agent has no other path to `issue_payout`.

```python
import os, time, requests

IMPRI = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def close_insurance_claim(claim_id: str, payout_usd: float, summary: str) -> dict:
    """Tool exposed to the AgentCore agent via the Gateway."""
    action = requests.post(f"{IMPRI}/v1/actions", headers=HEADERS, json={
        "kind": "claim.payout",
        "title": f"Approve payout ${payout_usd:,.2f} for claim {claim_id}",
        "preview": {"format": "markdown", "body": summary},
        "idempotent": False,
        "undo": f"Reverse payout via claims-admin console for {claim_id}",
        "expires_in": 14400,
    }).json()

    while True:
        result = requests.get(f"{IMPRI}/v1/actions/{action['id']}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(10)

    if result["status"] != "approved":
        return {"status": result["status"], "executed": False}

    payout_id = issue_payout(claim_id, payout_usd)  # your actual AWS-side call
    requests.post(f"{IMPRI}/v1/actions/{action['id']}/result", headers=HEADERS,
                  json={"status": "executed", "payload": {"payout_id": payout_id}})
    return {"status": "approved", "executed": True, "payout_id": payout_id}
```

`issue_payout` — wherever it lives, Lambda, Step Functions, a direct SDK call — only runs after `result["status"] == "approved"`. There's no branch in this function that reaches it otherwise.

---

## Don't block a Runtime session past its budget

Bedrock AgentCore Runtime sessions run for a bounded duration, and a claim payout might sit unreviewed for hours, not seconds. If your approval SLA is longer than a session can afford to hold open, don't poll synchronously inside the tool call. Instead:

1. The tool pushes the Impri action and returns immediately with `{"status": "pending", "action_id": ...}`.
2. A separate process — an EventBridge-scheduled Lambda, or a small worker outside AgentCore — polls `GET /v1/actions/:id` on its own cadence.
3. Once `status != "pending"`, that worker calls `issue_payout` and posts the result, then notifies the requester (Slack, email, whatever your stack already uses) that the claim was closed.

The AgentCore session ends; the approval record and the eventual execution don't depend on it staying open.

---

## Where responsibilities split

| Concern | Owned by |
|---|---|
| Running the agent, invoking tools, session isolation | AgentCore Runtime |
| Enterprise-wide tracing and rollout governance | AgentCore's governance layer |
| Whether *this* payout is correct | A human, via the Impri inbox card |
| Storing the decision and the audit trail of who approved what | Impri |
| Actually moving the money | Your `issue_payout` code |

Impri doesn't know what a valid insurance claim looks like, and it doesn't touch AWS. It stores the proposed action, shows it to a person, and hands back a decision your code has to act on.

---

## What this doesn't protect against

If the agent (or something impersonating it) has the AWS credentials to call the payout API directly, wrapping one tool function doesn't stop that path — Impri is only a gate on the code that calls it. Keep the payout credential scoped to the wrapped tool, not handed to the agent's general-purpose execution environment. And treat any claim summary sourced from an external form or email as data, not instructions, before it lands in `preview.body` — AgentCore doesn't sanitize that for you either.

---

Next: the [quickstart](quickstart.md) covers getting an API key for cloud or self-host, the [Python SDK](sdk-python.md) wraps these three calls if you'd rather not hand-roll the polling loop, and [audit log](audit-log.md) covers what's retained for compliance review after a payout is approved.
