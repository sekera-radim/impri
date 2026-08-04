# Human Approval for AI Recruiting Outreach

A sourcing agent that drafts and sends candidate messages unsupervised will eventually send something a recruiter would never sign their name to — this shows how to gate every outreach message on a human decision first.

---

## Why recruiting outreach needs a different gate than sales

Sales outreach and recruiting outreach look similar on the surface — both are personalized cold messages sent at volume — but the failure modes diverge. A bad sales email costs you one lead. A bad recruiting message costs you a candidate relationship, and candidates talk to each other. Sourcing agents also touch more sensitive material per message: a candidate's current employer, tenure, a scraped resume detail, sometimes an inferred visa status or salary expectation. If the agent hallucinates or misreads a LinkedIn profile, that error is now in front of a real person whose current employer might see it forwarded.

The fix isn't "review outreach sometimes." It's making the send action structurally impossible without a recorded human decision — the same pattern used for [emails your agent sends](approve-emails-before-your-ai-agent-sends-them.md), applied to the recruiting-specific fields: which candidate, which role, which claim about their background.

---

## Wiring it into a Python sourcing agent

Most sourcing pipelines are already Python (scraping, enrichment, an LLM call to draft the message). Add one function between "draft written" and "message sent":

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"

def request_approval(candidate, role, draft_message, source_url):
    resp = requests.post(
        f"{BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "recruiting.outreach",
            "title": f"Outreach to {candidate['name']} — {role}",
            "preview": {
                "format": "markdown",
                "body": (
                    f"**Candidate:** {candidate['name']} ({candidate['current_title']})\n"
                    f"**Sourced from:** {source_url}\n\n"
                    f"{draft_message}"
                ),
            },
            "target_url": candidate["profile_url"],
            "expires_in": 172800,  # 48h — stale candidate context goes bad fast
            "editable": ["preview.body"],
            "idempotent": False,
        },
    )
    return resp.json()["id"]

def await_decision(action_id, poll_seconds=15, timeout_s=3600):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = requests.get(
            f"{BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()
        if r["status"] != "pending":
            return r
        time.sleep(poll_seconds)
    return {"status": "expired"}

action_id = request_approval(candidate, role, draft_message, source_url)
result = await_decision(action_id)

if result["status"] == "approved":
    send_linkedin_message(candidate["profile_url"], result["decision"]["final_preview"]["body"])
    requests.post(
        f"{BASE}/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={"status": "executed"},
    )
```

The recruiter sees a card with the candidate's name, the claim the agent is making about them, and the exact message text — editable before it goes out. `idempotent: false` shows a warning badge on the card, since re-sending outreach to a candidate who already replied is its own kind of mistake.

---

## What this catches in practice

| Failure the agent might make | What the reviewer catches |
|---|---|
| Wrong seniority inferred from a stale LinkedIn title | Recruiter edits the message before send |
| Candidate already in an active pipeline for a different role | Recruiter rejects, flags for dedup |
| Draft references a skill scraped from the wrong profile section | Caught reading the preview against the source link |
| Message tone doesn't match how this recruiter actually writes | Edited in place via `editable` |

None of this requires Impri to understand recruiting — it only needs to hold the message and the decision. The judgment stays with the recruiter, same as it would reviewing a draft in their own outbox.

---

## Batches and multi-touch sequences

Sourcing agents typically queue outreach in batches — 20 candidates for one req, sent over a morning. Push one action per candidate rather than one action for the batch; a recruiter approving or editing message 3 shouldn't block a decision on message 17. For a second-touch follow-up, treat it as its own action referencing the same candidate — Impri doesn't model sequences itself, so any "wait 4 days, then follow up" logic lives in your agent, with each follow-up message gated the same way as the first.

---

## Where this stops

Impri holds the message and the decision; it doesn't know your ATS, doesn't check compliance rules, and doesn't verify the candidate data is accurate — that's still your agent's and your recruiter's job. It's a real gate only if the agent has no other path to LinkedIn or your outreach tool; wrap the sending call itself so it can't run without an approved decision, per [the integration pattern](how-to-add-human-approval-to-an-ai-agent.md).

New to Impri? Start with the [quickstart](quickstart.md) to get an API key, or see the [Python SDK](sdk-python.md) if you'd rather not hand-roll the REST calls above.
