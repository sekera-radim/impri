# Human Approval Before an AI Agent Deploys Code

Add human approval before an AI agent deploys code — gate the deploy call itself, review the diff and rollback plan, and stop a bad deploy before it ever ships.

---

## Why "run the tests" isn't the same as "safe to ship"

Coding agents that open PRs, fix CI failures, and merge on green are common now. The next step — letting the same agent trigger the deploy once the merge lands — is where teams get nervous, for good reason. Green tests confirm the code does what the test suite checked for. They say nothing about whether this is the right week to ship a schema migration, whether the change touches a service currently mid-incident, or whether the agent's fix for a flaky test quietly widened a retry loop that will hammer a downstream API. A human glancing at the diff and the target environment for ten seconds catches things a test suite structurally cannot.

Bolting a "confirm before deploying" instruction into the agent's prompt doesn't hold up under the same failure mode every other ungated action has: it's a suggestion, not a gate, and an agent reasoning about a wall of CI logs can talk itself past a suggestion. What actually holds is making the deploy call itself unreachable until an external decision says so.

---

## Gating the deploy call, not the merge

Push the deploy as an action before the pipeline step that actually ships it, then block on the decision. Here's the pattern in Go, for a service triggering a Kubernetes rollout:

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"time"
)

const base = "https://api.impri.dev"

func pushDeploy(commitSHA, env, diffURL string, hasMigration bool) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"kind":  "deploy.trigger",
		"title": fmt.Sprintf("Deploy %s to %s", commitSHA[:7], env),
		"preview": map[string]string{
			"format": "markdown",
			"body": fmt.Sprintf("**Environment:** %s\n**Commit:** `%s`\n**Includes migration:** %v\n\n[View diff](%s)",
				env, commitSHA, hasMigration, diffURL),
		},
		"idempotent": false,
		"undo":       fmt.Sprintf("kubectl rollout undo deployment/api -n %s", env),
		"expires_in": 1800,
		"target_url": diffURL,
	})
	req, _ := http.NewRequest("POST", base+"/v1/actions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("IMPRI_API_KEY"))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct{ ID string `json:"id"` }
	json.NewDecoder(res.Body).Decode(&out)
	return out.ID, nil
}

func awaitAndDeploy(actionID, env string) error {
	for {
		req, _ := http.NewRequest("GET", base+"/v1/actions/"+actionID, nil)
		req.Header.Set("Authorization", "Bearer "+os.Getenv("IMPRI_API_KEY"))
		res, _ := http.DefaultClient.Do(req)
		var out struct{ Status string `json:"status"` }
		json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()

		if out.Status == "pending" {
			time.Sleep(10 * time.Second)
			continue
		}
		if out.Status != "approved" {
			return fmt.Errorf("deploy blocked: %s", out.Status)
		}
		return exec.Command("kubectl", "apply", "-f", "manifests/"+env).Run()
	}
}
```

Notice there's no `editable` field here. A social post or an email draft is text a reviewer can reasonably fix inline; a deploy plan isn't — you don't want a reviewer hand-editing which commit ships. The decision is binary: ship this exact diff to this exact environment, or don't.

---

## What belongs on the approval card

A reviewer approving a deploy from a phone notification needs three things without clicking through: which environment, which commit, and whether there's a migration attached (migrations are the one class of deploy that can't be rolled back by redeploying the previous image). Everything else — full diff, test results, affected services — belongs behind the `target_url` link to your CI run, not crammed into the preview body.

| Field | Purpose |
|---|---|
| `title` | One line: commit + environment, scannable in a push notification |
| `preview.body` | Environment, commit, migration flag — the three facts that change the decision |
| `target_url` | Link to the full CI run / PR diff for anyone who wants to dig deeper |
| `undo` | The exact rollback command, shown on the card so the reviewer knows the escape hatch exists before approving |
| `idempotent: false` | Re-running a deploy trigger isn't a safe retry — it's a second rollout |

---

## Staging versus production

Not every environment needs the same gate. A reasonable default:

| Environment | Gate before deploy? |
|---|---|
| Preview / ephemeral branch envs | No — low blast radius, fast iteration matters more |
| Staging | Optional — gate if staging feeds a demo or QA signs off there |
| Production | Yes, always, especially with a schema migration attached |

---

## Rejected, expired, and rollback

`rejected` and `expired` both mean `exec.Command` never runs — same rule as any gated action. Set `expires_in` short enough that an approval can't sit stale past a deploy window; a production deploy approved two days late, after three more commits have merged on top, isn't the same deploy the reviewer looked at. If the code still needs to ship, push a fresh action against the current commit rather than resurrecting an old approval.

---

## What Impri isn't doing here

Impri stores the deploy request, notifies a human, and holds the decision — it does not run `kubectl apply` itself, does not know whether your tests are trustworthy, and does not evaluate whether the diff is actually safe. That judgment stays with whoever's holding the phone. For the base three-call pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md); if the agent doing the merging runs on the Claude Agent SDK, see [that integration guide](claude-agent-sdk.md) for wiring the gate into the same process. Once you're gating deploys, [the audit log](audit-log.md) gives you a record of every production rollout, who approved it, and when — useful the next time someone asks "who shipped this."

Next step: [quickstart](quickstart.md) to get an API key and try this against a staging pipeline first.
