# Human-in-the-Loop for Durable Agent Runtimes: Pause, Approve, Resume

Durable execution frameworks checkpoint every step so an agent can survive a crash — this shows how to make "waiting for a human" one of those durable steps instead of a process you have to keep alive.

---

## The property durable runtimes give you for free

Frameworks built around durable execution — Restate, DBOS, Inngest's step functions, a hand-rolled checkpoint table, or Temporal's own workflow engine — share one trait: each step's result is persisted before the next step runs. If the process dies between steps, a new worker picks up from the last completed step instead of starting over. That property is exactly what a human approval needs, because "wait for a person to look at their phone" can take minutes or it can take two days, and nothing about your compute budget should depend on which.

The mistake is treating the wait as a loop that has to run somewhere. It doesn't. It has to be a *step*, and steps in a durable runtime are allowed to end.

---

## The shape: checkpoint before you wait, resume on the decision

Instead of a worker sitting in a poll loop for two days, the pattern is:

1. Push the action to Impri, including a `callback_url` that points at your resume endpoint.
2. Checkpoint the run with the `action_id` as its resume key, then let the step finish — the worker is free to shut down.
3. When Impri POSTs the decision to `callback_url`, your handler resumes the durable function from that checkpoint.
4. The resumed run executes the side effect (if approved) and reports the result.

No process is billed or held open for the gap between step 2 and step 3, whether that gap is ninety seconds or the full 30-day maximum on `expires_in`.

---

## Example (Go, framework-agnostic durable function)

The sketch below matches the checkpoint/resume shape common to DBOS, Restate, and similar Go-based durable runtimes — swap `durable.Step`, `durable.Suspend`, and `durable.ResumeFrom` for your framework's actual calls:

```go
package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

const base = "https://api.impri.dev"

func authHeader(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+os.Getenv("IMPRI_API_KEY"))
	req.Header.Set("Content-Type", "application/json")
}

// ProposeDNSChange is the first half of the run: push the action, then suspend.
func ProposeDNSChange(rec DNSRecord) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"kind":        "dns.record_update",
		"title":       fmt.Sprintf("Update %s -> %s", rec.Name, rec.Value),
		"preview":     map[string]string{"format": "plain", "body": fmt.Sprintf("%s %s -> %s", rec.Type, rec.Name, rec.Value)},
		"callback_url": "https://agent.example.com/impri/resume",
		"expires_in":  259200, // 72h — plenty for an on-call engineer to notice
		"undo":        fmt.Sprintf("Revert %s to its previous value in the zone file", rec.Name),
	})
	req, _ := http.NewRequest("POST", base+"/v1/actions", bytes.NewReader(body))
	authHeader(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct{ ID string `json:"id"` }
	json.NewDecoder(resp.Body).Decode(&out)

	durable.Suspend(out.ID) // worker is free to exit here
	return out.ID, nil
}

// OnDecision is the webhook handler Impri calls when the human decides.
// It resumes the suspended run identified by the action ID.
func OnDecision(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		ActionID     string `json:"action_id"`
		Status       string `json:"status"`
		FinalPreview struct{ Body string `json:"body"` } `json:"final_preview"`
	}
	json.NewDecoder(r.Body).Decode(&payload)

	run := durable.ResumeFrom(payload.ActionID)
	if payload.Status != "approved" {
		run.Finish(map[string]any{"applied": false, "reason": payload.Status})
		return
	}

	applyDNSRecord(payload.FinalPreview.Body) // your actual side effect

	req, _ := http.NewRequest("POST", base+"/v1/actions/"+payload.ActionID+"/result",
		bytes.NewReader([]byte(`{"status":"executed"}`)))
	authHeader(req)
	http.DefaultClient.Do(req)

	run.Finish(map[string]any{"applied": true})
}
```

The webhook payload's `status` and `final_preview` are exactly what `GET /v1/actions/:id` would return — see [webhooks](webhooks.md) for the full payload shape. If webhook delivery ever fails, the durable run isn't stuck: a scheduled reconciliation step can call `GET /v1/actions/:id` for any checkpoint older than a few minutes and resume it manually, since the action's status in Impri is the source of truth regardless of whether the callback arrived.

---

## Why not just poll inside the durable sleep?

You can — a durable `sleep` plus a polling activity is a completely valid version of this pattern, and it's what [Temporal-based agents](human-in-the-loop-temporal-workflows-for-ai-agents.md) typically do, since Temporal's durable timers make repeated polling cheap. The tradeoff is [blocking vs. polling](blocking-vs-polling-for-human-approval.md): a durable sleep-and-poll loop still wakes the runtime on a schedule (say, every 30 seconds) even though nothing changes between wakeups, which shows up as scheduler load and, in some durable runtimes, billed step invocations. The webhook-resume version above only wakes the run exactly once, when there's actually something to do. If your runtime's public URL requirements make a webhook impractical (no ingress, private network), durable sleep-and-poll is the right fallback — it costs a bit of scheduler noise for zero infrastructure requirements.

---

## What Impri does and doesn't own here

Impri stores the proposed action, notifies the human, and holds the decision — it never touches your durable runtime, your checkpoints, or your workers. The suspend/resume mechanics, the choice of resume key, and retry behavior if a checkpoint fails to resume are entirely your framework's responsibility. Impri's only job is to make sure the decision — approved, rejected, or expired — exists and is durable on its own side by the time your webhook fires or your poll checks again.

New to the REST/MCP calls themselves? Start with [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), then [quickstart](quickstart.md) for getting an API key.
