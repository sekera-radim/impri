# Human-in-the-Loop for AI in HR and Recruiting

An AI recruiter that screens résumés, drafts candidate emails, and books interviews needs a human checkpoint before anything reaches a real person — this is the pattern for adding one without slowing down the pipeline.

---

## Why recruiting agents need a gate, not just a prompt

A screening agent reading hundreds of résumés a day is exactly the kind of workload that benefits from automation — and exactly the kind where an unreviewed mistake is expensive. A misread résumé that sends an auto-rejection to a strong candidate, a scheduling agent that books an interview slot nobody confirmed, or a "congratulations, you're hired" draft that goes out before an offer is actually approved: none of these are hypothetical, they're the normal failure mode of giving an LLM write access to an ATS.

Telling the agent "always ask before sending" in its system prompt doesn't hold up — the model can talk itself past its own instruction, and there's no record of what was proposed versus what a person actually signed off on. What you want instead is a gate the agent's code cannot skip: it can *propose* an email or a calendar action, but the send/book call is only reached after an external decision comes back approved.

## The pattern: propose, wait, execute

Same three calls regardless of what the agent automates — résumé rejection, interview invite, or offer-stage nudge:

```python
import requests
import time
import os

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_KEY}"}

def propose_candidate_email(candidate_name, role, draft_body):
    resp = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json={
        "kind": "email.send",
        "title": f"Outreach: {candidate_name} — {role} screening result",
        "preview": {"format": "markdown", "body": draft_body},
        "expires_in": 14400,  # 4 hours — screening results shouldn't sit stale
        "editable": ["preview.body"],
        "idempotent": False,
        "undo": "No undo once sent — this is a real email to the candidate",
    })
    return resp.json()["id"]

def wait_for_decision(action_id):
    while True:
        r = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if r["status"] != "pending":
            return r
        time.sleep(10)

action_id = propose_candidate_email(
    "Jordan Lee", "Senior Backend Engineer",
    "Hi Jordan,\n\nThanks for applying — after reviewing your background, we'd like to move forward to a technical screen...",
)
decision = wait_for_decision(action_id)

if decision["status"] == "approved":
    body = decision["decision"]["final_preview"]["body"]
    send_via_ats(body)  # your ATS or SMTP call
    requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed"})
```

A recruiter — not the model — is the one who actually decides a candidate hears "let's move forward" or "not this time." The agent only ever holds a draft.

## What the reviewer sees, and why editability matters

Recruiting emails are the clearest case for the `editable` field. A hiring manager rarely wants to reject a draft outright — more often they want to soften a line, fix a role title, or add a personal note before it goes out. Setting `editable: ["preview.body"]` lets them do that directly on the approval card; `decision.final_preview.body` then carries their edited version, and `decision.diff` shows exactly what changed for the audit trail. Always execute with `final_preview`, never the original draft — the API guarantees the original isn't silently reused.

## Where Impri stops

Impri does not read the résumé, decide who's a good fit, or know anything about your ATS's data model. It stores the proposed action, notifies the reviewer, and holds the decision — nothing more. Compliance-sensitive teams tend to also want a durable record of who approved what and when; that's what the [audit log](audit-log.md) is for, and it's often the actual reason HR teams reach for a gate like this over "just trust the agent."

It's also only a real gate if the send path is the *only* path. If your agent also holds a raw SMTP credential or ATS API token it can call directly, it can route around the approval step entirely — the gate has to be the sole chokepoint to the side effect, not an optional detour.

| Situation | Use Impri |
|---|---|
| Agent drafts a rejection/offer email | Yes |
| Agent proposes an interview slot to book | Yes |
| You need proof of who approved a candidate communication | Yes |
| You need multi-stage hiring workflow logic (scorecards, stage transitions) | Use your ATS or a workflow engine; Impri is one step in it |

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then the [Python SDK](sdk-python.md) if you'd rather not hand-roll the requests calls above.
