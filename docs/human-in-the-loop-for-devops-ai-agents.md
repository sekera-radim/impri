# Human-in-the-Loop for DevOps AI Agents

Let a DevOps AI agent read freely, and send every infra write (terraform apply, restart, scale, rollback) through an approval gate it has no way around.

---

## Why infra agents need a stricter gate

A support agent that sends a bad email is embarrassing. A DevOps agent that runs `kubectl scale deployment/api --replicas=0` or applies a plan with a destroy step is an outage, and a retry after a half-finished run can make it worse. So the reviewer needs two facts besides the command: is it safe to run twice, and how do you undo it.

Impri's REST API takes both on the action: `idempotent` (the inbox card then warns "Not idempotent — retrying may duplicate this action") and `undo` (plain text shown on the card). The TypeScript and Python SDKs and the MCP tool don't pass these two fields yet, so a CI job sends them with a direct `POST /v1/actions`:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "kind": "terraform.apply",
    "title": "Apply: drop legacy queue, resize db-main",
    "preview": { "format": "markdown", "body": "- aws_sqs_queue.legacy (destroy)\n~ aws_db_instance.main (large -> xlarge)" },
    "target_url": "https://ci.example.com/runs/4812",
    "expires_in": 3600,
    "idempotent": false,
    "undo": "Re-apply the previous state from the tfstate backup. Messages in the deleted queue are lost."
  }'
```

The job then waits for the decision (`GET /v1/actions/:id`, or `awaitDecision` in the SDK), runs `terraform apply` only on `approved`, and closes the loop with `POST /v1/actions/:id/result`. Its optional `payload` stores a receipt with the action (changed resources, run URL), which is what someone reading the trail later wants.

## A Kubernetes agent over MCP: restarts, scaling, rollbacks

The common setup: an on-call agent (Claude Code, an Agents SDK worker) diagnoses through a Kubernetes MCP server and proposes the fix. Three parts keep the fix behind a person.

**1. The agent can read, not write.** In [containers/kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server), set this in its TOML config:

```toml
read_only = true   # only tools annotated readOnlyHint=true are registered
```

Its configuration reference calls this a best-effort guardrail: it hides tools but doesn't change the cluster permissions of the identity the server runs as, and read tools can still read Secrets. Give that identity a read-only RBAC role as well. The same server has `confirmation_rules`, but they ask the person at the MCP client, and when the client can't ask, the default `confirmation_fallback` is `"allow"`. A headless on-call agent has nobody to ask, so the approval has to happen somewhere else.

**2. The agent proposes through Impri.** Add Impri's MCP server next to it:
`claude mcp add --transport http impri https://api.impri.dev/mcp --header "Authorization: Bearer $IMPRI_API_KEY"`
(self-hosted: `npx @impri/mcp` with `IMPRI_BASE_URL`, see [MCP](mcp.md)). The agent calls `impri_push_action` with a `kind` of `k8s.rollout_restart`, `k8s.scale` or `k8s.rollout_undo`, the exact command as `preview.body` (`kubectl scale deployment/api -n shop --replicas=4`) and the target as `payload` (`{"namespace": "shop", "deployment": "api", "replicas": 4}`).

**3. An executor with its own credentials runs only what a human approved.**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ImpriClient } from "@impri/sdk";

const run = promisify(execFile);
// Reads IMPRI_BASE_URL: https://api.impri.dev for the cloud, your server when self-hosted.
const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

type Target = { namespace: string; deployment: string; replicas?: number; revision?: number };
const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/; // Kubernetes object name

function kubectlArgs(kind: string, t: Target): string[] {
  if (!NAME.test(t.namespace) || !NAME.test(t.deployment)) throw new Error("invalid name");
  const base = [`deployment/${t.deployment}`, "-n", t.namespace];
  if (kind === "k8s.rollout_restart") return ["rollout", "restart", ...base];
  if (kind === "k8s.scale" && Number.isInteger(t.replicas) && t.replicas! >= 0 && t.replicas! <= 50)
    return ["scale", ...base, `--replicas=${t.replicas}`];
  if (kind === "k8s.rollout_undo" && Number.isInteger(t.revision) && t.revision! > 0)
    return ["rollout", "undo", ...base, `--to-revision=${t.revision}`];
  throw new Error(`unsupported action: ${kind}`);
}

// Run every 30 s (cron, a loop, a CronJob): execute what a human approved, nothing else.
for (const kind of ["k8s.rollout_restart", "k8s.scale", "k8s.rollout_undo"]) {
  const { items } = await impri.listActions({ status: "approved", kind, autoPaginate: true });
  for (const action of items) {
    let status: "executed" | "execute_failed" = "execute_failed";
    let detail = "";
    try {
      const args = kubectlArgs(kind, action.payload as Target);
      // The reviewer saw the preview, not the payload: they must say the same thing.
      if (action.preview.body.trim() !== `kubectl ${args.join(" ")}`) throw new Error("payload does not match the approved preview");
      detail = (await run("kubectl", args)).stdout.trim();
      status = "executed";
    } catch (e) {
      detail = String(e);
    }
    // A failed report leaves the action approved, so the next pass repeats it.
    await impri.reportResult(action.id, status, { detail }).catch((e) => console.error(action.id, e));
  }
}
```

Two details carry the safety. The reviewer approves the preview and never sees the payload, so the executor rebuilds the command from the payload and refuses when it differs from what was approved. And a repeat after a crash stays harmless: a replica count is absolute, a repeated restart only rolls the pods again, and `--to-revision` pins the rollback, where a plain `rollout undo` goes to whatever the previous revision is when it runs. Reporting the result moves the action out of `approved`, so the next pass skips it.

## Let small changes through, stop the rest

A [rule](rules.md) (created with an admin-scope key, `POST /v1/rules`) approves small scaling outside production on its own; everything else waits in the inbox and goes to your notification channels (Slack, Telegram, Discord, email, webhook):

```json
{
  "name": "Small scale changes outside prod",
  "kind_pattern": "k8s.scale",
  "payload_conditions": [
    { "path": "replicas", "op": "gte", "value": 2 },
    { "path": "replicas", "op": "lte", "value": 6 },
    { "path": "namespace", "op": "not_in", "value": ["prod"] }
  ],
  "rule_action": "auto_approve"
}
```

An auto-approved action sends no notification; the [audit log](audit-log.md) records which rule approved it, and the executor still checks the preview.

## What Impri does not do here

It doesn't check that a plan or command is correct: it shows it to a person. It isn't a policy engine: "never touch IAM, whoever approves" belongs in OPA or Sentinel before Impri. It never runs kubectl or terraform: your executor does, with credentials the agent never sees. Related: [agentic AI safety patterns](agentic-ai-safety-patterns.md) and [incident response agents](human-in-the-loop-for-ai-agent-incident-response.md).

Next: run the inbox next to your cluster with [self-hosting](self-hosting.md) (`docker compose`, MIT core), or [start free on the cloud](https://app.impri.dev/?signup=1) and point the executor at `https://api.impri.dev`.
