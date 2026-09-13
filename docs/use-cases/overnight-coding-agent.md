<!-- title: Let a coding agent run overnight, approve from your phone -->
<!-- description: Kick off a long coding agent run before bed, gate every risky step behind Impri, and approve or reject each one from your phone in the morning. -->
<!-- screenshot: telegram-card.png | An Impri approval card delivered to Telegram, with Approve/Reject buttons -->
# Let a coding agent run overnight, approve from your phone

A long-running coding agent — refactor a module, migrate a dependency, work through a backlog of issues — is most useful unattended. But "unattended" and "unsupervised" are not the same thing: the run should stop at anything that leaves the sandbox, and wait for you.

## Problem

You want to kick off a coding agent before bed and wake up to progress, not to a surprise. The agent editing files in its own worktree is fine to leave alone. The agent running a database migration, pushing a branch, opening a pull request, or calling a paid API is not — one bad prompt turn and it commits to something you'd have vetoed in five seconds if you'd seen it.

Sitting at the terminal all night defeats the point of an overnight run. You need the risky steps to pause and wait for a decision that reaches you wherever you are — which in practice means your phone.

## Workflow

1. Before the agent takes any action outside its own working tree — a shell command with side effects, a git push, an external API call — it calls `impri_push_action` with a short title and a preview of exactly what it's about to do.
2. The agent calls `impri_await_decision` and blocks. Impri delivers the action to your phone via Telegram, ntfy, or web push, so it's a notification, not a tab you have to remember to check.
3. You glance at the card from bed or from breakfast, tap **Approve** or **Reject**, optionally editing the draft first if the agent's plan needs a tweak.
4. The agent's poll returns the decision, it runs the approved step (or skips it and moves to the next task), and calls `impri_report_result` to close the loop.
5. If you're asleep past the timeout, the action expires — the agent logs it as skipped and continues with the rest of its backlog instead of stalling the whole run.

## MCP example

```
impri_push_action({
  kind: "git.push",
  title: "Push branch fix/retry-backoff to origin",
  preview: {
    format: "diff",
    body: "3 files changed, 41 insertions(+), 6 deletions(-)\n+ retry with exponential backoff in http_client.py"
  },
  target_url: "https://github.com/acme/api/compare/main...fix/retry-backoff",
  editable: []
})
// -> { action_id: "act_7g2k...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_7g2k..." }

impri_await_decision({ action_id: "act_7g2k...", timeout_s: 28800 })
// -> { action_id: "act_7g2k...", status: "approved", decision_at: 1757829400, preview: { format: "diff", body: "..." }, edited_by_human: false }

impri_report_result({
  action_id: "act_7g2k...",
  status: "executed",
  detail: "Pushed, opened PR #482"
})
```

## Result

The agent works through its whole backlog overnight instead of blocking on the first risky step. Every push, deploy, or paid call it made while you slept is a card you already reviewed — not something you have to reconstruct from logs at 7am. Nothing left the sandbox without your yes.

## CTA

Free tier covers 100 approvals a month — plenty for a nightly run. [Try it free](https://app.impri.dev) or [read the human approval pattern](/docs/how-to-add-human-approval-to-an-ai-agent).
