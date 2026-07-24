# Human Approval for Scheduled AI Scripts

Gate the output of a scheduled AI script — a nightly GitHub Actions job, a Lambda cron, a CI-triggered generator — without holding a runner idle for hours waiting on a decision.

---

## The constraint a long-running agent doesn't have

A cron job on a server you own can afford to sit in a polling loop for an hour. A CI-scheduled script usually can't, or shouldn't. GitHub Actions bills by the minute, most self-hosted runners are shared, and a job that blocks for hours on `GET /v1/actions/:id` is a bad use of a CI runner even when it's technically allowed. This shows up constantly with small automation scripts that use an LLM for one step: a nightly job that drafts release notes from the git log and opens a PR, a scheduled script that summarizes overnight support tickets and posts to Slack, a workflow that generates a changelog and publishes it.

The fix isn't a different approval flow — it's splitting the script into two separate scheduled runs instead of one long-blocking one.

---

## Split into a propose workflow and an execute workflow

The **propose** workflow does the LLM generation, pushes the action to Impri, and exits immediately — no polling, no waiting.

```yaml
# .github/workflows/nightly-release-notes-propose.yml
name: Propose nightly release notes
on:
  schedule:
    - cron: "0 6 * * *"   # 06:00 UTC daily
jobs:
  propose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Generate and push for approval
        env:
          IMPRI_API_KEY: ${{ secrets.IMPRI_API_KEY }}
        run: node scripts/propose-release-notes.mjs
```

The **execute** workflow runs on its own short schedule, checks for any actions that have since been approved, and only then runs the actual side effect (publishing, posting, committing):

```yaml
# .github/workflows/execute-approved-actions.yml
name: Execute approved actions
on:
  schedule:
    - cron: "*/15 * * * *"   # check every 15 minutes
jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Execute anything approved
        env:
          IMPRI_API_KEY: ${{ secrets.IMPRI_API_KEY }}
        run: node scripts/execute-approved.mjs
```

Neither workflow ever blocks. The `propose` job stores the action ID somewhere durable (a repo file, a small key-value store, a GitHub Actions artifact) so the `execute` job knows what to look up:

```javascript
// scripts/propose-release-notes.mjs
import { writeFile } from "node:fs/promises";

const notes = await generateReleaseNotes(); // your LLM call

const res = await fetch("https://api.impri.dev/v1/actions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    kind: "changelog.publish",
    title: `Release notes — ${new Date().toISOString().slice(0, 10)}`,
    preview: { format: "markdown", body: notes },
    expires_in: 172800, // 48h — survives a weekend before the check job sees it
    editable: ["preview.body"],
  }),
});

const { id } = await res.json();
await writeFile(".impri-pending/release-notes.json", JSON.stringify({ id }));
```

The `execute` job reads that file, calls `GET /v1/actions/:id` once, and either runs the publish step (if `approved`) or does nothing and leaves the pending file alone (if still `pending`).

---

## Secrets and scopes

Store `IMPRI_API_KEY` as a GitHub Actions repository secret, never in the workflow file itself. Scope it to `actions` only — a CI script proposing and checking actions has no reason to hold `admin` or `watch` scope. If the propose and execute workflows run as separate jobs, they can share the same `actions`-scoped key; there's no benefit to splitting it further.

---

## Picking `expires_in` for a schedule, not a person

For a synchronous approval you'd set a short expiry — minutes to hours. For a scheduled script, size the expiry to the gap between runs plus slack for a weekend or a day someone doesn't check their phone:

| Script cadence | Suggested `expires_in` |
|---|---|
| Runs hourly, reviewed same-day | `21600` (6h) |
| Runs nightly, reviewed next morning | `86400` (24h) |
| Runs nightly, reviewer may miss a weekend | `259200` (72h, the default) |
| Runs weekly | `604800` (7d) |

Too short and a real Friday-evening backlog silently expires before Monday; too long and stale, no-longer-relevant drafts sit around waiting for a stray approval. Treat `expired` the same as `rejected` in the execute job — log it and let the next scheduled run generate a fresh proposal if the task still matters.

---

## What this doesn't replace

This pattern is not a substitute for GitHub's own Environments protection rules if you're already using them for deploy gating inside a single workflow run — use those when the approval and the job are the same CI run. Reach for the propose/execute split specifically when the script runs unattended on a schedule and you don't want a runner burning minutes (or a self-hosted runner sitting blocked) waiting on a human. And as always, Impri only holds the decision — it doesn't generate the release notes, doesn't know what "good" output looks like, and the execute script is what actually has to enforce that nothing runs without `status: "approved"`.

For the single-workflow blocking version of this pattern, see [gating a cron job](gate-a-cron-job-with-human-approval.md). For everything else on wiring up the three calls, start with the [quickstart](quickstart.md) or browse [integrations](integrations.md).
