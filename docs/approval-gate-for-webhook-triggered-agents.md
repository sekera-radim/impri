# An Approval Gate for Webhook-Triggered Agents

Webhook-triggered agents fire the instant an event lands, with no chat window open for a human to catch a bad call — here's how to wire in an approval gate anyway.

---

## Why webhook triggers are a different problem

Most human-in-the-loop advice assumes an agent running inside a chat session, where a person is already watching and can just answer "yes, send it." A webhook-triggered agent has no such person nearby. A GitHub `pull_request` event, a Stripe `charge.dispute.created` event, a CI pipeline finishing — any of these can kick off a handler that runs unattended, at 2am, with nobody tailing the logs. If that handler's last step is "merge the PR" or "issue the refund," the gate has to be built into the handler itself, because there is no human already in the loop to lean on.

That means the approval step needs to be a real suspend-and-resume in the code, not a Slack message the agent "hopes" someone reads before it keeps going.

---

## Example: an agent that triages and merges dependency-update PRs

Say you have an agent that reads the diff on incoming PRs opened by a bot (Dependabot-style version bumps) and decides whether the bump looks safe. When it's confident, its job is to merge. That's exactly the kind of action worth gating — a bad automatic merge is hard to notice until something breaks in production.

Here's a minimal Flask webhook receiver in Python that pushes the merge decision to Impri instead of merging directly:

```python
import os
import requests
from flask import Flask, request

app = Flask(__name__)
IMPRI_KEY = os.environ["IMPRI_API_KEY"]
IMPRI_BASE = "https://api.impri.dev"

@app.route("/webhooks/github", methods=["POST"])
def handle_pr_event():
    payload = request.json
    if payload.get("action") != "opened":
        return "", 204

    pr = payload["pull_request"]
    if not looks_like_safe_bump(pr):   # your own heuristic / model call
        return "", 204

    action = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "git.merge_pr",
            "title": f"Auto-merge: {pr['title']}",
            "preview": {
                "format": "markdown",
                "body": f"PR #{pr['number']} by {pr['user']['login']}\n\n{pr['body'] or '(no description)'}",
            },
            "target_url": pr["html_url"],
            "expires_in": 21600,  # 6 hours — stale PR approvals aren't worth acting on
            "idempotent": False,
            "undo": f"Revert the merge commit on {pr['base']['ref']}",
        },
    ).json()

    return {"queued_action_id": action["id"]}, 202
```

Note that the webhook handler's job ends at `POST /v1/actions`. It does not merge anything itself. A separate worker — a small poller or a queue consumer — is the only place `merge_pull_request()` is ever called, and only after it sees `status: "approved"`.

---

## The polling side: where the actual merge happens

```python
import time

def process_pending_merge(action_id, pr_number):
    while True:
        result = requests.get(
            f"{IMPRI_BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()

        if result["status"] == "pending":
            time.sleep(15)
            continue

        if result["status"] == "approved":
            merge_pull_request(pr_number)  # your GitHub API call
            requests.post(
                f"{IMPRI_BASE}/v1/actions/{action_id}/result",
                headers={"Authorization": f"Bearer {IMPRI_KEY}"},
                json={"status": "executed"},
            )
        # rejected or expired: do nothing, PR stays open for a human to handle manually
        break
```

Keeping the merge call and the poller in a separate process (or a scheduled job) from the webhook receiver matters: webhook handlers are usually expected to return in a few seconds, and blocking one on a human decision that might take hours is the wrong shape. Push the action, return `202`, and let a worker pick up the decision later.

---

## Picking `expires_in` for event-driven actions

Chat-driven approvals can afford a long expiry — a human might come back to the conversation the next day. Webhook-driven actions are usually tied to something time-sensitive: a PR that will get more commits pushed to it, a refund window, an incident that resolves itself. Set `expires_in` short enough that an approval past that point would be acting on stale information. Six hours for a PR merge, thirty minutes for an incident remediation — pick a number tied to how fast the underlying event goes stale, not a generic default.

---

## What this does and doesn't protect against

Impri holds the decision and notifies a human; it does not inspect the PR diff, run your safety heuristic, or know anything about GitHub. The gate only holds if `merge_pull_request()` genuinely cannot be reached except through the approved path — if the agent process also has a GitHub token it could call directly on some other code path, the gate is decorative. Route the credential only through the code that checks `status: "approved"` first.

For the full three-call pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For receiving the GitHub/Stripe/etc. webhook itself (separate from Impri's own decision notifications), see [webhooks](webhooks.md). To wire the target tool so the approved path is the only path, see [integrations](integrations.md).

---

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then adapt the Flask example above to whatever webhook source triggers your agent.
