# The EU AI Act Human Oversight Requirement for AI Agents

The EU AI Act requires human oversight for high-risk AI systems — here is where a real approval gate satisfies that, and where it cannot.

---

## What the regulation actually asks for

Article 14 of the EU AI Act requires that high-risk AI systems be designed so a human can effectively oversee them — including the ability to "decide not to use" an output, or "intervene... or interrupt the system through a 'stop' button." The text is deliberately about *capability to oversee*, not a specific implementation. It doesn't mandate a particular API or vendor. What it does imply, in practice, is that the oversight has to be real: the human needs enough information to make an informed decision, a genuine ability to say no, and — for anything you'd need to demonstrate later — a record that the oversight happened.

This is a compliance question your legal team owns, not something a piece of software can certify for you. What follows is the technical shape of one way to satisfy the "a human can stop this" and "there is a record" parts, for the subset of an AI system that is an agent about to take an external action.

**Important caveat up front: Impri is not a compliance product and does not claim to satisfy the AI Act on its own.** It is a gate and an audit log. Whether that gate, combined with your risk classification, your documentation, and your process around it, satisfies Article 14 for your specific system is a legal determination outside what this page (or Impri) can tell you.

---

## The part a technical gate can address: a real stop button

"Human oversight" is not satisfied by a disclaimer in a system prompt telling the agent to pause — that is not intervention capability, it's a suggestion the model can override under the wrong input. What Article 14 is describing technically is closer to: the action does not happen without a human decision in the loop.

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_oversight(kind: str, title: str, body: str, undo: str):
    resp = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "expires_in": 86400,
            "idempotent": False,
            "undo": undo,
        },
    )
    return resp.json()["id"]

def await_decision(action_id: str, poll_seconds: int = 15) -> dict:
    while True:
        resp = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS)
        data = resp.json()
        if data["status"] != "pending":
            return data
        time.sleep(poll_seconds)
```

An agent classified as high-risk under the Act — say, one that screens loan applications or makes hiring recommendations — calls `request_oversight` before the decision takes effect, and the reviewer sees exactly what the agent proposes to do before it happens:

```python
decision = await_decision(
    request_oversight(
        kind="loan.decision.apply",
        title="Loan application #48213 — recommend: decline",
        body="Applicant score: 612. Model recommendation: decline.\nReasoning: debt-to-income ratio 0.51, 2 late payments in 24mo.",
        undo="Reopen application #48213 for manual review",
    )
)

if decision["status"] == "approved":
    apply_decision(decision["decision"]["final_preview"])
else:
    escalate_for_manual_review()
```

---

## The part it can't address

A gate proves *that* a human made a decision. It says nothing about whether the human was qualified to make it, had enough time and context, or wasn't just clicking approve on autopilot — all things regulators and auditors will actually ask about. Article 14 also covers requirements Impri has no bearing on at all: risk management documentation, technical robustness, training data governance, and the conformity assessment itself. Those live in your compliance process, not in an API call.

| Article 14 concern | Where it's addressed |
|---|---|
| Human can review the proposed action before it takes effect | An Impri action gate |
| Human can decline / stop the action | `rejected` status, never executed |
| Timestamped record of who decided what, when | [Audit log](audit-log.md) |
| Human was competent and adequately informed | Your review process, not Impri |
| Risk classification, conformity assessment, documentation | Your compliance program, not Impri |

---

## Self-hosting for data residency

Some high-risk deployments need the oversight data to stay in-region or off a third-party's cloud entirely. Impri's core is MIT-licensed and self-hostable — see [self-hosting](self-hosting.md) — which keeps the action records and audit trail on your own infrastructure rather than `api.impri.dev`, if that's a constraint your compliance team has.

For the base three-call integration pattern this is built on, start with [How to Add Human Approval to an AI Agent](how-to-add-human-approval-to-an-ai-agent.md), then talk to your legal counsel about whether it covers what your specific system needs.
