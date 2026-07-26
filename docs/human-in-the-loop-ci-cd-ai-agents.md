# Human-in-the-Loop for CI/CD AI Agents

Human-in-the-loop for CI/CD AI agents adds a real approval gate before a deploy bot merges, applies infra changes, or rolls back production on its own.

---

## Why CI/CD agents need a different kind of gate

A CI/CD agent is not drafting a blog post — it's one `terraform apply` or `kubectl rollout` away from a real outage. Traditional pipelines already have a human gate: the "Deploy to production" button in GitHub Actions or the manual approval step in GitLab CI. The problem is that once you hand the *decision* itself to an agent — "should we merge this PR", "is this rollback safe", "does this migration need review" — you've removed the one checkpoint that caught bad judgment before it hit the pipeline.

The fix isn't removing the agent. It's putting a real approval step between "the agent decided this is safe" and "the pipeline executes it," one that lives outside the CI runner so a compromised or confused agent can't just skip it.

## Where the gate belongs in the pipeline

The agent step runs, produces a plan (a diff, a rollout description, a migration summary), and instead of executing directly, it pushes that plan as a pending action and blocks the job until a human decides. This works as a normal step in any CI system because it's just an HTTP call plus a poll — no special runner permissions needed.

```yaml
# .github/workflows/agent-deploy.yml
jobs:
  agent-plan-and-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Agent generates deploy plan
        run: python ci/agent_plan.py > plan.json
      - name: Request human approval before applying
        env:
          IMPRI_API_KEY: ${{ secrets.IMPRI_API_KEY }}
        run: python ci/request_approval.py plan.json
      - name: Apply only if approved
        env:
          IMPRI_API_KEY: ${{ secrets.IMPRI_API_KEY }}
        run: python ci/apply_if_approved.py
```

`request_approval.py` and `apply_if_approved.py` are two ends of the same Impri action:

```python
# ci/request_approval.py
import json, os, sys, requests

plan = json.load(open(sys.argv[1]))
resp = requests.post(
    "https://api.impri.dev/v1/actions",
    headers={"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"},
    json={
        "kind": "infra.apply",
        "title": f"Deploy: {plan['service']} — {plan['summary']}",
        "preview": {"format": "markdown", "body": plan["diff_markdown"]},
        "idempotent": False,
        "undo": f"Roll back to previous release: {plan['previous_release_id']}",
        "expires_in": 3600,
    },
)
action = resp.json()
open("action_id.txt", "w").write(action["id"])
print(f"Waiting for approval: {action['inbox_url']}")

# ci/apply_if_approved.py — poll then gate the real apply step
import os, time, requests

action_id = open("action_id.txt").read().strip()
headers = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}
while True:
    status = requests.get(f"https://api.impri.dev/v1/actions/{action_id}", headers=headers).json()
    if status["status"] != "pending":
        break
    time.sleep(10)

if status["status"] != "approved":
    print(f"Not approved (status={status['status']}), stopping.")
    exit(1)  # fails the job, blocks the rest of the pipeline

# only reached if approved — actual terraform apply / kubectl rollout goes here
os.system("terraform apply -auto-approve tfplan")
requests.post(f"https://api.impri.dev/v1/actions/{action_id}/result",
              headers=headers, json={"status": "executed"})
```

If a reviewer rejects or the action expires, `exit(1)` fails the CI job and nothing downstream runs — no separate credential path exists for the agent to route around that.

## What to gate and what not to

| Pipeline action | Gate it? |
|---|---|
| Merge to main triggered by an agent | Yes |
| Production deploy / infra apply | Yes |
| Database migration with irreversible steps | Yes |
| Rollback to a known-good release | Optional — often safe to automate, still audit-log it |
| Running the test suite, linting, building artifacts | No — no external side effect |

Reserve the gate for steps with a real external effect. Gating every CI step turns a fast pipeline into a ticket queue and trains reviewers to rubber-stamp, which defeats the point.

## Boundaries worth being explicit about

Impri stores the proposed action, notifies a reviewer, and holds the decision — it does not understand Terraform plans or Kubernetes manifests, and it doesn't run your pipeline. It's a real gate only if the CI job's credentials for `terraform apply` or `kubectl` are unreachable except through the code path that checks `status == "approved"" first. If the agent step also has direct cloud credentials in the same job, it can bypass the gate entirely — keep the apply credentials scoped to the gated step only.

This also isn't a replacement for GitHub's or GitLab's built-in environment protection rules — it complements them, giving you a mobile-friendly inbox, an audit log independent of the CI provider, and the ability to let a reviewer edit the plan text before approving.

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then see [webhooks](webhooks.md) if you want the pipeline itself (not just the agent) to trigger actions on external events like a failed health check.
