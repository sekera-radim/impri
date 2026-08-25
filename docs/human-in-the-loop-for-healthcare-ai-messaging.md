# Human-in-the-Loop for Healthcare AI Messaging

Patient-facing AI messaging needs a clinician in the loop before anything sends — this guide wires that gate with three API calls and a Python example.

---

## The scenario

A triage bot drafts a reply to a patient portal message ("my incision looks red, is that normal?"), or an AI scheduling assistant drafts a message confirming a medication change. Both are cases where the agent should never be the last checkpoint. A wrong tone, a missed contraindication, or a drafted answer to a clinical question that reads as advice can cause real harm — and unlike a marketing email, there's no "oops, sending a correction" for a patient who already acted on bad information.

The fix isn't a smarter prompt. It's making the send path structurally depend on a clinician's decision, so the agent literally cannot deliver the message without it.

---

## Minimal integration — Python

The pattern is the same three calls as any Impri integration: push, poll, execute. Here it's wrapped around a patient-messaging function.

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
API_KEY = os.environ["IMPRI_API_KEY"]
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def request_send(patient_name: str, draft_body: str, portal_thread_url: str) -> str:
    resp = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "patient_message.send",
            "title": f"Portal reply to {patient_name}",
            "preview": {"format": "markdown", "body": draft_body},
            "target_url": portal_thread_url,
            "expires_in": 14400,  # 4 hours — clinical replies go stale fast
            "editable": ["preview.body"],
            "idempotent": False,
        },
    )
    return resp.json()["id"]


def wait_for_decision(action_id: str, timeout_s: int = 3600) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        result = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            return result
        time.sleep(10)
    raise TimeoutError("clinician did not respond in time")


def send_and_report(action_id: str, result: dict, send_fn):
    if result["status"] != "approved":
        return  # rejected or expired — never sent
    final_body = result["decision"]["final_preview"]["body"]
    send_fn(final_body)
    requests.post(
        f"{IMPRI_BASE}/v1/actions/{action_id}/result",
        headers=HEADERS,
        json={"status": "executed"},
    )
```

The clinician sees the draft on the approval card, can edit the wording directly (`editable: ["preview.body"]`), and approves or rejects from their phone. If they edit it, `decision.final_preview.body` carries the edited text — the agent always sends that, never its own original draft.

---

## Why the short expiry matters here

A drafted reply about a symptom described three hours ago is a different clinical situation than one from yesterday. Setting `expires_in` short (the example uses 4 hours, well within the API's 300s–30d range) forces staleness to fail safely: an expired action is never sent, and the agent should treat that the same as a rejection rather than firing it off late.

---

## What this does and doesn't cover

Impri stores the proposed message, notifies the clinician, and holds the decision — nothing more. It does not evaluate clinical accuracy, does not know what "normal" means for a given patient, and is not a substitute for your organization's compliance program (BAA with your hosting provider, PHI handling policy, access controls on who can see the inbox). Treat it as the mechanism that stops an unreviewed message from reaching a patient — the judgment about whether the message is clinically sound still belongs entirely to the human who approves it.

It's also only a real gate if the agent has no side channel to the patient portal's send API. If the same credential that Impri gates is also usable directly by the agent's code, wrap the portal-sending function itself so it can only be called with an approved `decision.final_preview`, not just at the call site shown above.

---

## Next step

Start with [the quickstart](quickstart.md) to get an API key, then read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full pattern this example is built on. If you need a record of every clinician decision for compliance review, see [the audit log](audit-log.md).
