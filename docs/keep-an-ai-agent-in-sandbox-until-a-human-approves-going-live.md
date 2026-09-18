# Keep an AI Agent in Sandbox Until a Human Approves Going Live

Gate an autonomous coding agent so it can build and test freely in a sandbox but cannot promote a build to production without human approval.

---

## The failure mode this prevents

Give a coding agent write access to a sandbox and it will happily iterate: branch, build, run tests, deploy to a preview URL, repeat. That loop is safe because nothing it touches is customer-facing. The danger shows up the moment the agent is also trusted to promote its own sandbox to production — a green test suite is not the same thing as "this should ship." Flaky tests pass, migrations that are fine in an empty sandbox DB corrupt real data, and an agent under prompt injection from a fetched dependency changelog has no reason to hesitate before hitting deploy.

The fix isn't "tell the agent to ask first" in its system prompt — that's a suggestion the model can talk itself past under pressure. It has to be a real dependency: the promotion call simply does not exist until a human decision comes back.

---

## Where the gate goes

The agent keeps full autonomy inside the sandbox. The only new step is between "sandbox build is green" and "promote to production" — a single Impri action that blocks until someone approves it.

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function requestPromotion(sandboxUrl: string, diffSummary: string) {
  const action = await impri.actions.create({
    kind: "deploy.promote",
    title: `Promote sandbox build to production: ${process.env.GIT_SHA}`,
    preview: {
      format: "markdown",
      body: `Sandbox: ${sandboxUrl}\n\nChanges:\n${diffSummary}\n\nTest suite: passing (${process.env.CI_RUN_URL})`,
    },
    target_url: sandboxUrl,
    expires_in: 3600, // 1 hour — a stale sandbox build shouldn't ship later unreviewed
    idempotent: false,
    undo: "Re-deploy the previous production tag via the deploy pipeline",
  });

  return action.id;
}
```

The agent then polls (or blocks, if it's running inside an MCP client — see the [MCP integration](mcp.md)) and only calls the actual deploy step, whatever that is in your stack, after `status` comes back `approved`:

```typescript
async function awaitAndPromote(actionId: string) {
  let result;
  do {
    await new Promise((r) => setTimeout(r, 10_000));
    result = await impri.actions.get(actionId);
  } while (result.status === "pending");

  if (result.status !== "approved") {
    console.log(`Promotion ${result.status} — staying in sandbox`);
    return;
  }

  await runDeployPipeline({ target: "production" }); // your real promote step
  await impri.actions.reportResult(actionId, { status: "executed" });
}
```

---

## Why "sandbox" has to mean something narrow

This pattern only holds if the agent's credentials genuinely can't reach production without going through `runDeployPipeline`. If the same CI token the agent uses for sandbox builds also has production deploy rights, an agent (or an injected instruction) can skip the whole flow and deploy directly. Scope the agent's deploy credentials to the sandbox environment, and put the production deploy credential behind the code path that only runs after `status: "approved"` — ideally in a separate CI job or service the agent can't invoke on its own. Impri holds the decision; your infrastructure has to be the thing that actually enforces it.

## Handling rebuilds and stale approvals

Sandbox builds get superseded constantly — a new commit lands while an approval is still pending. Don't reuse the old action for a new commit SHA; expire it and create a fresh one, so the human is always approving the diff that will actually ship, not an earlier one:

```typescript
if (newCommitPushed) {
  // let the old action expire naturally, or treat any pending
  // approval for an older SHA as stale and open a new one
  await requestPromotion(newSandboxUrl, newDiffSummary);
}
```

Because `expires_in` has a 300-second floor and a 30-day ceiling, pick a window that matches how fast your sandbox churns — an hour is usually generous for CI-driven promotion, longer if approval happens on a human's schedule rather than immediately after build.

---

## What this does and doesn't check

Impri stores the promotion request, notifies whoever reviews deploys, and holds the decision — it does not run your tests, diff your migrations, or evaluate whether the sandbox build is actually safe. The `preview.body` markdown is exactly as good as what the agent puts into it, so include the CI run link, the diff summary, and anything a reviewer needs to make the call from the notification alone (see [Slack approval](slack-approval.md) if reviewers want this on mobile).

For the full three-call pattern this builds on, see [How to Add Human Approval to an AI Agent](how-to-add-human-approval-to-an-ai-agent.md). For other CI/CD and agent-framework wiring, check [integrations](integrations.md).
