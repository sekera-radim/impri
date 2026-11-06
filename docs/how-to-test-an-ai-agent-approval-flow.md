# How to Test an AI Agent's Approval Flow

How to test an AI agent's approval flow: drive the approve, reject, edit and conflict paths against a local Impri instance with plain HTTP calls in pytest.

---

## What you are actually testing

An approval gate has one job: the side effect must not run unless a human said yes. So the tests worth writing are not "does the API return 200" but "what does my agent do in each outcome". There are four outcomes to cover:

| Outcome | What the agent must do |
|---------|------------------------|
| `approved` | Execute with `decision.final_preview`, then report `executed` |
| `approved` with edits | Execute the edited text, not the original draft |
| `rejected` | Never reach the executor |
| `expired` | Same as rejected |

Everything below tests *your* agent code. Impri only holds the decision; it does not interpret the action, so there is nothing about the content to test on its side.

---

## Test against a throwaway local instance

Do not point tests at your production project. Start a self-hosted instance (see [self-hosting](self-hosting.md)) with `docker compose up -d`; the API listens on `http://localhost:8484`. Create a separate key with the `actions` scope for the test run ([API keys](api-keys.md)).

The decision endpoint, `POST /v1/actions/:id/decision`, accepts a key with the `actions` scope. That is what lets a test play the human. Your test harness approves programmatically; in real use the human decides from the inbox, so keep the agent's production key separate from whatever credential can decide.

---

## A pytest harness that plays both sides

```python
import os, time, requests

BASE = os.environ.get("IMPRI_BASE_URL", "http://localhost:8484")
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose(body="Hi Sarah, draft v1", **extra):
    r = requests.post(f"{BASE}/v1/actions", headers=H, json={
        "kind": "email.send",
        "title": f"test {time.time()}",   # unique, avoids pending-duplicate dedup
        "preview": {"format": "markdown", "body": body},
        "editable": ["preview.body"],
        "expires_in": 300,
        **extra,
    })
    r.raise_for_status()
    return r.json()["id"]

def decide(action_id, decision, edited=None):
    payload = {"decision": decision}
    if edited:
        payload["edited"] = {"preview.body": edited}
    return requests.post(f"{BASE}/v1/actions/{action_id}/decision",
                         headers=H, json=payload)

def run_agent(action_id, send):
    """The code under test: wait, then execute only on approval."""
    while True:
        a = requests.get(f"{BASE}/v1/actions/{action_id}", headers=H).json()
        if a["status"] != "pending":
            break
        time.sleep(0.2)
    if a["status"] == "approved":
        send(a["decision"]["final_preview"]["body"])
        requests.post(f"{BASE}/v1/actions/{action_id}/result",
                      headers=H, json={"status": "executed"})
    return a["status"]

def test_approved_sends_once():
    sent = []
    aid = propose()
    assert decide(aid, "approve").ok
    assert run_agent(aid, sent.append) in ("approved", "executed")
    assert sent == ["Hi Sarah, draft v1"]

def test_edit_wins_over_draft():
    sent = []
    aid = propose()
    decide(aid, "approve", edited="Hi Sarah, edited by a human")
    run_agent(aid, sent.append)
    assert sent == ["Hi Sarah, edited by a human"]

def test_rejected_never_executes():
    sent = []
    aid = propose()
    decide(aid, "reject")
    assert run_agent(aid, sent.append) == "rejected"
    assert sent == []
```

In a real agent, replace the polling loop with your actual wrapper or the [SDK](sdk-python.md); the point is that the test calls the same code path production uses.

---

## Edge cases worth a test each

- **Edits outside the whitelist.** Approving with `edited` keys that are not in `editable` is rejected with HTTP 422. Assert that your agent never receives text it was not meant to accept.
- **Double decision.** A second decision on an already-decided action returns 409. Two reviewers, or a retrying script, must not flip the outcome.
- **Result before approval.** `POST /v1/actions/:id/result` returns 409 unless the action is `approved`. A test that calls it on a rejected action catches agents that report success without checking.
- **Duplicate proposals.** An identical pending action (same kind, title and preview) is returned as a duplicate with HTTP 200 instead of a second card; an `idempotency_key` does the same on retries. Test that a retry loop does not flood the inbox.
- **Expiry.** `expires_in` has a floor of 300 seconds, so you cannot make an action expire in a fast unit test. Test the `expired` branch by stubbing the status your code reads, and keep one slow end-to-end test for CI nightly.
- **Rate limit.** `POST /v1/actions` allows 60 requests per minute per key. Keep parallel test runs on separate keys.

---

## Auto-approve rules change what you test

If your project has a rule with the `auto_approve` outcome ([rules](rules.md)), a matching action comes back already `approved` and never reaches a human. Run the suite in a project with no rules for the gate tests, and add separate tests for each rule you rely on, asserting both the matching and the non-matching case.

---

## What this does not prove

A passing suite shows your agent honours the decision. It does not show the gate cannot be bypassed: if the agent also holds the raw credential for the target service, it can route around Impri. Add one test that the executor function is unreachable without an approved decision, and keep the real credential out of the agent's reach. Impri is only the approval gate; it never executes anything itself.

Next: [Quickstart](quickstart.md) to get a key, or the [CLI](cli.md) to approve test actions by hand with `impri approve`.
