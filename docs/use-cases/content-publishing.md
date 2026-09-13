<!-- title: Approve AI-generated content before it publishes -->
<!-- description: Put a human review step in front of AI-drafted blog posts, social media, and marketing copy before it goes live, without slowing down the drafting itself. -->
<!-- screenshot: getting-started.png | The Impri getting-started screen for a new project -->
# Approve AI-generated content before it publishes

An AI writing agent is fast at drafts and inconsistent at judgment — the same model that nails a blog post outline can also confidently state a wrong statistic, adopt the wrong tone for the channel, or ship a claim your product doesn't back. None of that is obvious until a human reads the final draft with the publish button in mind.

## Problem

Drafting and publishing are different acts with different risk. You want the agent generating blog posts, social copy, and marketing pages continuously — that's the whole point of using it. You don't want any of it live on a public channel until someone has actually read it, because "read it while writing the prompt" and "read the finished draft that will go out under the company's name" catch different mistakes.

## Workflow

1. The agent finishes a draft — blog post, tweet thread, changelog entry — and calls `impri_push_action` with the full text as the preview instead of calling the CMS or social API directly.
2. The action's `preview.format` is `"markdown"` so the reviewer sees real formatting (headings, links, code) in the inbox, not a wall of raw text.
3. A human reads it, fixes a sentence or a claim directly in the editable preview if needed, and approves — the edit is captured as a diff against the agent's original draft.
4. `impri_await_decision` returns the final text; the agent publishes exactly that (not its own draft) via the CMS or social API, then calls `impri_report_result` with the published URL.
5. A rejected draft never reaches the CMS. The agent can use the rejection note to redraft and resubmit as a new action.

## MCP example

```
impri_push_action({
  kind: "content.publish",
  title: "Publish blog post: \"5 lessons from our Q3 outage\"",
  preview: {
    format: "markdown",
    body: "# 5 lessons from our Q3 outage\n\nOn August 14th our API was down for 22 minutes. Here's what we changed...\n\n## 1. Timeouts everywhere..."
  },
  target_url: "https://cms.acme.com/drafts/9021",
  editable: ["preview.body"]
})
// -> { action_id: "act_3kx0...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_3kx0..." }

impri_await_decision({ action_id: "act_3kx0...", timeout_s: 86400 })
// -> { action_id: "act_9wp3...", status: "approved", decision_at: 1757830900, preview: { format: "plain", body: "...human-edited..." }, edited_by_human: true }

impri_report_result({
  action_id: "act_3kx0...",
  status: "executed",
  detail: "Published at https://acme.com/blog/q3-outage-lessons"
})
```

## Result

The agent keeps drafting on its own schedule; nothing reaches a public channel under your name without a person reading the actual final text first. Factual slips and tone mismatches get caught before an audience sees them, not after.

## CTA

Related: [Human approval before an agent posts to social media](/docs/human-approval-before-an-agent-posts-to-social-media) and [Approve AI-generated content before publishing](/docs/approve-ai-generated-content-before-publishing). [Try Impri free](https://app.impri.dev).
