# Human-in-the-Loop for DevOps AI Agents

Give an AI agent kubectl or terraform access and one hallucinated flag can take down a namespace — this is the pattern for gating infra changes behind a human decision without slowing down routine ops.

---

## Why DevOps agents need a different gate than chat agents

A support agent that sends a bad email is embarrassing. A DevOps agent that runs `kubectl scale deployment api --replicas=0` or applies a Terraform plan with a dropped resource is an outage. The blast radius is bigger and the actions are frequently **not reversible** in the way a draft email is — you can't un-delete a database with a retry.

That changes what the approval gate needs to carry. It's not enough to show a human the command; they need to know whether re-running it is safe if something goes wrong mid-execution, and how to undo it if it turns out to be the wrong call. That's what Impri's `idempotent` and `undo` fields are for — they're optional, but for infra actions they're the difference between a reviewer approving blind and approving informed.

## Gating a Terraform apply (TypeScript)

```typescript
import { ImpriClient, ImpriRejected, ImpriExpired, ImpriTimeout } from "@impri/sdk";

const client = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function proposeApply(plan: TerraformPlan) {
  const created = await client.createAction({
    kind: "terraform.apply",
    title: `Apply: ${plan.summary}`,
    preview: { format: "markdown", body: plan.humanReadableDiff },
    targetUrl: plan.ciRunUrl,
    expiresIn: 3600,           // infra plans go stale fast — 1 hour
    idempotent: false,         // re-applying a plan with a destroy step is not safe to blindly retry
    undo: "terraform apply -target=<resource> using the previous state file in s3://tfstate-backups/",
  });

  try {
    const action = await client.awaitDecision(created.id, { timeoutS: 1800 });
    // action.status === 'approved' here — awaitDecision throws otherwise

    const result = await runTerraformApply(plan);  // the only place the apply actually runs

    await client.reportResult(created.id, result.ok ? "executed" : "execute_failed", {
      changed_resources: result.changedResources,
      run_url: result.runUrl,
    });
  } catch (e) {
    if (e instanceof ImpriRejected) {
      console.log("Apply rejected — not running.");
    } else if (e instanceof ImpriExpired) {
      console.log("Approval window closed before a decision was made.");
    } else if (e instanceof ImpriTimeout) {
      console.log("Still pending server-side — check the inbox later.");
    } else {
      throw e;
    }
  }
}
```

`result.payload` is worth using here specifically — a DevOps reviewer checking the inbox later wants to see which resources actually changed, not just "executed."

## Scoping the blast radius before the gate

The gate is only as strong as what the agent can do without it. An agent that holds a kubeconfig with cluster-admin and calls `kubectl` directly can route around any wrapper you build. The pattern that holds up:

1. The agent never gets direct cluster/cloud credentials.
2. It calls an internal executor function — the one shown as `runTerraformApply` above — that itself owns the credentials.
3. That executor refuses to run unless it received an `approved` decision object from Impri, not just a boolean flag the agent could fabricate in its own output.

That third point matters more for DevOps agents than most other use cases, because the cost of a bypassed gate is higher. See [the integrations doc](integrations.md) for the wrapper pattern in more depth.

## Routing by severity

Not every infra action deserves the same friction. A useful split:

| Action | Review path |
|---|---|
| Scale replicas up/down within a bounded range | Auto-approve via a [rule](rules.md), skip human review |
| Terraform apply touching prod, `kubectl delete`, IAM changes | Route to [Slack](slack-approval.md) with `idempotent: false` and a filled `undo` field |
| Anything touching a datastore's data (not just infra) | Route to a second reviewer via [audit log](audit-log.md) — keep the trail, since this is the case someone will ask about later |

Rules let low-stakes scaling actions skip the inbox entirely so the human queue stays for decisions that actually need a human.

## What Impri does not do here

It does not validate the Terraform plan or the kubectl command for correctness — it shows the diff to a human and trusts their judgment, the same as it does for any other action kind. It is not a policy engine; if you need "block any apply that touches IAM regardless of who approves," that's an OPA/Sentinel policy gate upstream of Impri, not something Impri enforces itself. And it doesn't watch your infrastructure for drift — for that you'd run a [watcher](watcher-presets.md) that polls state and opens an action when something changes outside the pipeline.

Next: [the MCP doc](mcp.md) if your agent runs inside Claude Code or another MCP client and you'd rather not write the SDK calls directly.
