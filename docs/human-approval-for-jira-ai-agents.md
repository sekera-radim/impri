# Human Approval for Jira AI Agents

An agent wired into Jira can transition, close, or reassign tickets in bulk — human approval for Jira AI agents stops one bad triage pass from wrecking a sprint.

---

## The failure mode is quiet, not loud

A Jira-triaging agent doesn't usually break in a way you notice immediately. It reads a backlog, decides ticket priorities, transitions statuses, reassigns owners, and posts comments — and most of the time it's right. The failures that matter are the ones buried in volume: a P1 incident ticket auto-transitioned to "Won't Fix" because the agent misread a sarcastic comment thread, forty tickets reassigned to someone on leave, or a customer-facing bug silently closed as a duplicate of an unrelated ticket.

None of that trips an error. Jira's API returns 200 either way. The only thing that catches it is a human looking at the *specific* transition before it lands — which is exactly what a triage agent is supposed to save you from doing at scale. The fix isn't to slow the agent down everywhere; it's to gate the transitions that are expensive to get wrong (closing, reassigning off-team, changing priority on incident-labeled tickets) and let the cheap, reversible ones (adding a triage label, posting a summary comment) go straight through.

---

## Gating a transition with Impri

The agent still calls the Jira REST API — Impri sits in front of the call, not instead of it. Push the proposed transition as an action, poll for a decision, and only call Jira once it comes back approved.

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
JIRA_BASE = os.environ["JIRA_BASE_URL"]
JIRA_AUTH = (os.environ["JIRA_EMAIL"], os.environ["JIRA_API_TOKEN"])

def propose_transition(issue_key: str, transition_id: str, transition_name: str, reason: str) -> str:
    resp = requests.post(
        "https://api.impri.dev/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "jira.transition_issue",
            "title": f"Transition {issue_key} → {transition_name}",
            "preview": {
                "format": "markdown",
                "body": f"**{issue_key}**\n\nProposed transition: `{transition_name}`\n\nAgent reasoning: {reason}",
            },
            "target_url": f"{JIRA_BASE}/browse/{issue_key}",
            "idempotent": False,
            "undo": f"Transition {issue_key} back to its previous status in Jira",
            "expires_in": 21600,  # 6h — stale triage decisions shouldn't fire later
        },
    )
    return resp.json()["id"]

def wait_for_decision(action_id: str) -> dict:
    while True:
        r = requests.get(
            f"https://api.impri.dev/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()
        if r["status"] != "pending":
            return r
        time.sleep(10)

def apply_transition(issue_key: str, transition_id: str):
    requests.post(
        f"{JIRA_BASE}/rest/api/3/issue/{issue_key}/transitions",
        auth=JIRA_AUTH,
        json={"transition": {"id": transition_id}},
    )

action_id = propose_transition("OPS-4821", "31", "Won't Fix", "No repro after 3 attempts; last activity 90 days ago")
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    apply_transition("OPS-4821", "31")
    requests.post(
        f"https://api.impri.dev/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={"status": "executed"},
    )
```

The `target_url` links straight to the Jira issue, so the reviewer taps it in the inbox card and sees full context before deciding — not just the agent's summary of it.

---

## What's worth gating vs. what isn't

| Jira action | Gate it? |
|---|---|
| Transition to Done/Won't Fix/Closed | Yes |
| Reassign to a different team or person | Yes |
| Change priority on an incident-labeled ticket | Yes |
| Add a label or triage tag | No — reversible, low blast radius |
| Post an internal triage summary comment | No |
| Bulk-transition more than N tickets in one run | Yes, always |

The pattern generalizes past Jira: gate on irreversibility and blast radius, not on "is this a write." A label is a write too, but undoing it costs nothing.

---

## The one thing to get right

This only works if the agent's Jira credentials live behind the same code path as the approval check — if the agent (or a retry, or a different code branch) can call the Jira transitions endpoint directly, Impri is decoration, not a gate. Wrap the actual `requests.post` call to Jira so it's unreachable without an `approved` decision in hand; see [the SDK integrations guide](integrations.md) for the wrapper pattern. Start from [the quickstart](quickstart.md) to get an API key, and use the [Python SDK](sdk-python.md) instead of raw `requests` if you're gating more than one Jira action type.
