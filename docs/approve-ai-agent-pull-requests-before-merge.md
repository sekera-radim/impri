# Human Approval Before an AI Agent Merges a Pull Request

Give a coding agent merge rights and it will eventually merge something it shouldn't — this shows how to gate the merge call itself behind a human decision, not just the PR review.

---

## The problem isn't the PR, it's the merge button

Most teams already have a human review the diff. The gap is further down the pipeline: once an agent has permission to call the merge endpoint — because it's running in CI, or because it has a `repo` token to close its own loop — nothing stops it from merging the moment its own checks go green. A green check is not a human decision. It confirms the code runs; it says nothing about whether the change is correct, safe to ship today, or something a reviewer glanced at and silently disagreed with.

The fix is narrow: put the actual `merge` API call behind an approval gate, and make sure it's the *only* way the agent's process can reach that call.

---

## Wiring the gate into a merge script

Say your agent runs as a GitHub Action after its own PR passes CI, and a small Node script decides whether to merge. Instead of calling the GitHub merge endpoint directly, the script pushes an Impri action first and only merges once it comes back approved:

```typescript
import { Octokit } from "octokit";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const IMPRI_KEY = process.env.IMPRI_API_KEY!;

async function requestMergeApproval(owner: string, repo: string, pr: number, title: string, summary: string) {
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "github.pr_merge",
      title: `Merge PR #${pr}: ${title}`,
      preview: { format: "markdown", body: summary },
      target_url: `https://github.com/${owner}/${repo}/pull/${pr}`,
      expires_in: 21600, // 6 hours — a stale PR should be re-reviewed, not auto-merged later
      editable: [],
    }),
  });
  const { id } = await res.json();
  return id as string;
}

async function pollAndMerge(owner: string, repo: string, pr: number, actionId: string) {
  while (true) {
    const res = await fetch(`https://api.impri.dev/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    const { status } = await res.json();
    if (status === "approved") {
      await octokit.rest.pulls.merge({ owner, repo, pull_number: pr, merge_method: "squash" });
      await fetch(`https://api.impri.dev/v1/actions/${actionId}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${IMPRI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "executed" }),
      });
      return "merged";
    }
    if (status === "rejected" || status === "expired") return status;
    await new Promise((r) => setTimeout(r, 15000));
  }
}
```

The `summary` in the preview should be more than a commit message — include what changed, why, and any risk notes the agent has. The person approving is deciding whether to ship, not re-reading the diff line by line.

---

## What the reviewer sees and does

The inbox card shows the PR title, the summary, and a link via `target_url` straight to the GitHub PR itself, so the reviewer can jump over and re-check the diff before deciding. Nothing here is editable (`editable: []`) — a merge decision is binary, there's no text field to adjust. That's a legitimate use of an empty `editable` array: not every action type benefits from human-editable content.

If your workflow instead wants the human to be able to tweak the merge commit message before merging, set `editable: ["preview.body"]` and read `decision.final_preview.body` as the commit message when calling `octokit.rest.pulls.merge`.

---

## The chokepoint has to be the merge call, not the agent's intent

This only works if the merge script above is the *only* code path with permission to hit the GitHub merge API. If the agent also holds a `GITHUB_TOKEN` with merge scope and could call the API directly from its own tool loop, it can route around the gate entirely — Impri has no visibility into calls it's never told about. Scope the merge-capable credential to the wrapper script alone; give the agent a token that can open PRs and push commits, not merge them. See [the SDK integrations](integrations.md) for patterns on isolating the executor from the agent's own credentials.

For agents built on Claude Code or another MCP client, the same flow is available as three tool calls instead of raw HTTP — see [the MCP guide](mcp.md).

---

## What this doesn't replace

Impri doesn't review the code. It doesn't run your test suite or static analysis, and it has no opinion about whether the diff is correct — it just makes sure a specific human saw the merge request and said yes before it happened. Branch protection rules, required reviews, and CI checks are still doing their normal job upstream of this; Impri is the last gate on the specific action of merging.

---

New to this pattern? Start with the [quickstart](quickstart.md) to get an API key, then read the general [human approval integration guide](how-to-add-human-approval-to-an-ai-agent.md) for the full push/poll/execute flow this page builds on.
