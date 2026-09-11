# Human Approval for AI Agent Terraform Changes

Let an AI agent draft Terraform plans, but require a human to approve the exact resource diff before `apply` ever touches real infrastructure.

---

## Why a prompt-level review step isn't enough

An agent that can run `terraform plan` can usually also run `terraform apply`. If the only thing stopping it from applying a bad change is a system-prompt instruction like "always ask before applying," you are trusting the model to police itself. A model working through a long task, or one nudged by a misleading provider error message, can talk itself past that instruction. Prompt injection isn't even required — a plan that resizes a database instance instead of scaling a web tier is a mistake, not an attack, and it slips through self-review just as easily.

What actually stops it is removing `apply` from the agent's own execution path. The agent generates the plan, pushes it to Impri as a pending action, and only a wrapper that checks `status: "approved"` is allowed to call `terraform apply`. The agent itself never holds that trigger.

## The pattern: plan, propose, wait, apply

```
Agent                          Impri                         Human
  │                              │                             │
  ├─ terraform plan -out=tfplan  │                             │
  ├─ terraform show -json tfplan │                             │
  ├── POST /v1/actions ─────────▶│ stores plan diff, notifies ▶ inbox card
  │                              │                             ├─ reviews resources
  │                              │                             │  changed/destroyed
  │                              │◀────────────────────────────┘ approves / rejects
  ├── GET /v1/actions/:id ──────▶│ returns decision            │
  ├─ [if approved] terraform apply tfplan
  └── POST /v1/actions/:id/result
```

The action's `preview.body` is where the actual plan summary goes — not a vague "infra change requested," but the real resource diff, so the reviewer approves based on what will happen, not on trust.

## Wiring it in (Python)

```python
import json
import subprocess
import time
import requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

def plan_summary(plan_json_path: str) -> str:
    with open(plan_json_path) as f:
        plan = json.load(f)
    lines = []
    for change in plan.get("resource_changes", []):
        actions = change["change"]["actions"]
        if actions != ["no-op"]:
            lines.append(f"{'/'.join(actions):8} {change['address']}")
    return "```\n" + "\n".join(lines) + "\n```"

subprocess.run(["terraform", "plan", "-out=tfplan"], check=True)
subprocess.run(["terraform", "show", "-json", "tfplan"],
                stdout=open("plan.json", "w"), check=True)

resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
    "kind": "terraform.apply",
    "title": "Apply: scale web-tier ASG, resize redis-cache to cache.m6g.large",
    "preview": {"format": "markdown", "body": plan_summary("plan.json")},
    "idempotent": False,
    "undo": "terraform apply using the previous state snapshot in the S3 backend",
    "expires_in": 3600,
})
action_id = resp.json()["id"]

while True:
    decision = requests.get(f"{API}/v1/actions/{action_id}", headers=HEADERS).json()
    if decision["status"] != "pending":
        break
    time.sleep(15)

if decision["status"] == "approved":
    subprocess.run(["terraform", "apply", "tfplan"], check=True)
    requests.post(f"{API}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed"})
```

A rejected or expired decision means `tfplan` is simply discarded — the apply line is never reached.

## Why `idempotent: false` and `undo` matter here

Terraform applies are rarely safe to retry blindly — a retried apply against a partially-changed state can double-create resources or fight a state lock. Setting `idempotent: false` puts a warning badge on the inbox card so the reviewer knows a retry isn't automatically safe. The `undo` field doesn't roll anything back for you; Impri only displays it as a note on the card so a human approving a destructive change also sees the escape hatch before clicking approve.

| Change type | Approval pattern |
|---|---|
| Scaling, tagging, non-destructive updates | Short `expires_in` (e.g. 1h), `idempotent: false` |
| Resource replacement/destroy | Same, plus a clear `undo` describing the prior state |
| Read-only plan/drift check | Doesn't need a gate at all — nothing executes |

## What this doesn't cover

Impri doesn't parse your Terraform plan, doesn't know if a change is safe, and doesn't run `terraform apply` for you — it stores the action, shows the diff to a human, and hands back a decision. The wrapper that reads that decision and calls `terraform apply` is your code, using the [Python SDK](sdk-python.md) or plain HTTP. If your pipeline already runs through CI, look at [integrations](integrations.md) for wiring Impri into a pipeline step rather than a long-running agent process.

Every approval and rejection is recorded in the [audit log](audit-log.md), which matters for infrastructure changes since "who approved this apply and when" is exactly what a postmortem needs.

**Next step:** [Quickstart](quickstart.md) to get an API key, then adapt the Python snippet above to your own plan-parsing logic.
