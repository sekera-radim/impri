<!-- title: Human approval before an AI agent deploys or changes infra -->
<!-- description: Gate deploys, Terraform applies, and other infrastructure changes an AI agent proposes behind a human decision, without slowing down everything else it does. -->
<!-- screenshot: action-detail.png | An Impri action detail view showing a Terraform plan awaiting approval -->
# Human approval before an AI agent deploys or changes infra

A coding agent that can open pull requests is a huge time saver. The same agent running `terraform apply` or triggering a production deploy unsupervised is a different risk category — infra changes are exactly the kind of action where "it looked right in the plan" and "it did the right thing on the actual account" sometimes diverge.

## Problem

You want the agent to keep moving on code review, tests, and PRs without waiting on you for every step. But the moment it reaches for something that changes running infrastructure — a deploy, a Terraform apply, a DNS record, a scaling change — you want a human to see the plan first, because that's the step a rollback can't always undo cleanly.

## Workflow

1. The agent's deploy or Terraform step is wrapped so it calls `impri_push_action` with the plan output (or a deploy diff) as the preview instead of running immediately.
2. The action can carry a `target_url` pointing at the CI run or Terraform plan output, so the reviewer can open the full context with one click from the card.
3. `impri_await_decision` blocks the pipeline step; a human reads the plan in the inbox — resources added, changed, destroyed — and approves or rejects.
4. On approval, the pipeline resumes and runs the actual `terraform apply` or deploy command; on rejection, the pipeline fails cleanly with the rejection reason in its logs.
5. `impri_report_result` records whether the apply succeeded, so a failed apply after approval is distinguishable in the audit log from a rejected one.

## MCP example

```
impri_push_action({
  kind: "infra.terraform_apply",
  title: "terraform apply: add 2 read replicas, resize db.primary to db.r6g.xlarge",
  preview: {
    format: "diff",
    body: "Plan: 2 to add, 1 to change, 0 to destroy.\n+ aws_db_instance.replica[0]\n+ aws_db_instance.replica[1]\n~ aws_db_instance.primary (instance_class: db.r6g.large -> db.r6g.xlarge)"
  },
  target_url: "https://ci.acme.com/pipelines/9931",
  editable: []
})
// -> { action_id: "act_2v7d...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_2v7d..." }

impri_await_decision({ action_id: "act_2v7d...", timeout_s: 3600 })
// -> { action_id: "act_2v7d...", status: "approved", decision_at: 1757830200, preview: { format: "diff", body: "..." }, edited_by_human: false }

impri_report_result({
  action_id: "act_2v7d...",
  status: "executed",
  detail: "Apply completed, 2 replicas online"
})
```

## Result

Code review and tests keep running at agent speed; every change that touches real infrastructure gets a human reading the plan first, with the full CI context one click away. The gate sits exactly where the irreversible step is, not everywhere the agent moves.

## CTA

See also [Human approval before deploying code with an agent](/docs/human-approval-before-deploying-code-with-an-agent) and [Human approval for Terraform changes](/docs/human-approval-for-ai-agent-terraform-changes). [Try Impri free](https://app.impri.dev).
