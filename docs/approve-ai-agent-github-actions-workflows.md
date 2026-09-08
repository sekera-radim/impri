# Approve GitHub Actions Runs Triggered by an AI Coding Agent

When a coding agent holds a GitHub token, it can fire `workflow_dispatch` directly — gate that call so a human signs off before any workflow actually runs.

---

## workflow_dispatch is a side effect, not a suggestion

Coding agents like Claude Code or Cursor increasingly carry a GitHub personal access token so they can open PRs, check CI status, and — if the token has `actions: write` — dispatch workflows directly through the GitHub REST API. That last one is easy to overlook because it doesn't look like "deploying code." It looks like the agent being helpful: "let me just kick off the release workflow" or "I'll trigger the nightly cleanup job now instead of waiting."

But `workflow_dispatch` can run anything a `.github/workflows/*.yml` file defines — a release, a database migration job, a secret rotation script, a bulk-delete maintenance task. None of that goes through a pull request review. The agent decided the trigger was warranted, and the API call is the only step between that decision and the workflow executing. This is a different problem from gating a deploy that's already sitting behind a PR-based pipeline — here there's no PR at all, just an agent with a token calling an endpoint.

## Wrapping the dispatch call

The fix is to make the agent's dispatch function a two-step function: propose to Impri, wait for approval, then call GitHub. The agent never gets a code path that reaches the GitHub API without that middle step.

```typescript
import { Octokit } from "octokit";

const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function dispatchWorkflowWithApproval(
  owner: string,
  repo: string,
  workflowId: string,
  ref: string,
  inputs: Record<string, string>,
) {
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "github.workflow_dispatch",
      title: `Run ${workflowId} on ${owner}/${repo}@${ref}`,
      preview: {
        format: "markdown",
        body: `**Workflow:** ${workflowId}\n**Ref:** ${ref}\n**Inputs:**\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\``,
      },
      target_url: `https://github.com/${owner}/${repo}/actions/workflows/${workflowId}`,
      expires_in: 1800,
    }),
  });
  const { id } = await res.json();

  let status = "pending";
  while (status === "pending") {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`https://api.impri.dev/v1/actions/${id}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    status = (await check.json()).status;
  }

  if (status !== "approved") {
    throw new Error(`Workflow dispatch not approved: ${status}`);
  }

  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowId,
    ref,
    inputs,
  });
}
```

The GitHub call sits after the approval check, not before it — there's no branch in this function that reaches `createWorkflowDispatch` without `status === "approved"` first.

## What the reviewer sees

The inbox card shows the workflow name, the ref it would run against, and the exact inputs the agent wants to pass — the same JSON that would otherwise go straight into the API call. For a workflow that takes a `target_environment` input, that's the difference between rubber-stamping "run deploy" and actually noticing it says `production` when the agent meant `staging`.

## Where the token actually lives

This pattern only holds if the agent process itself can't reach the GitHub API except through `dispatchWorkflowWithApproval`. If the same process also has the raw `GITHUB_TOKEN` available to a general-purpose shell tool, the agent — or a prompt injection riding in through an issue comment it read — can call `gh workflow run` directly and skip the gate entirely. Keep the token scoped to a wrapper process the agent calls into, not a credential it can read and reuse. The [tool-wrapping pattern](wrapping-a-tool-with-a-human-approval-step.md) covers this chokepoint problem in more depth.

## Expiry for one-off runs

`expires_in` matters more here than for a slow-moving action like a blog post. A workflow dispatch tied to "run this now" stops making sense a few hours later — the underlying branch may have moved, or the reason for running it may no longer apply. Thirty minutes to a couple of hours is usually the right window; the default 72-hour expiry is really meant for asynchronous drafts, not time-sensitive triggers.

---

New to Impri? Start with the [quickstart](quickstart.md) to get an API key, or read the general [pattern for adding approval to an agent](how-to-add-human-approval-to-an-ai-agent.md) if this is your first gated action. For agents that already use the TypeScript SDK instead of raw `fetch`, see [sdk-typescript](sdk-typescript.md).
