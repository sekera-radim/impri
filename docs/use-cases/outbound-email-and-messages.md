<!-- title: Approve emails, Slack and SMS an AI agent wants to send -->
<!-- description: Hold every outbound email, Slack message, or SMS an AI agent drafts for a human to read and approve before it reaches a real inbox. -->
<!-- screenshot: slack-card.png | An outbound email draft delivered as an approval card in Slack -->
# Approve emails, Slack and SMS an AI agent wants to send

An agent that can draft outreach, support replies, or team notifications is useful. An agent that can also send them, unreviewed, to real people is a different and much riskier thing — tone, factual accuracy, and who's actually on the recipient list all matter, and a language model gets any of the three wrong often enough that you don't want it sending without a look.

## Problem

Outbound messages are hard to take back. A wrong fact in a customer email, a reply-all where a DM was meant, an SMS to the wrong number — once it's sent, it's sent. You want the draft, not a blocked agent: it should still write the email, just not press send by itself.

## Workflow

1. The agent drafts the message and calls `impri_push_action` with the recipient, subject, and body as the preview, marking `preview.body` (and `payload.subject` if applicable) as `editable`.
2. The card lands in whichever channel your team actually watches — the inbox, Slack, Discord, or email itself — so review doesn't require opening a separate tool.
3. A human reads the draft, tweaks a sentence if the tone is off, and approves. Edits are captured as a signed diff against the original draft, so the agent (and the audit log) can see exactly what changed.
4. `impri_await_decision` returns the final (possibly edited) text; the agent sends that, not its original draft, then calls `impri_report_result`.
5. Rejected drafts never reach a mail server — the agent logs the rejection reason if one was given and moves on.

## MCP example

```
impri_push_action({
  kind: "email.send",
  title: "Reply to support ticket #4821 — refund policy question",
  preview: {
    format: "plain",
    body: "Hi Jana, thanks for reaching out — our refund window is 30 days from purchase, and your order from March 2nd is..."
  },
  target_url: "https://support.acme.com/tickets/4821",
  editable: ["preview.body"]
})
// -> { action_id: "act_9wp3...", status: "pending", inbox_url: "https://app.impri.dev/inbox/act_9wp3..." }

impri_await_decision({ action_id: "act_9wp3...", timeout_s: 900 })
// -> { action_id: "act_9wp3...", status: "approved", decision_at: 1757830900, preview: { format: "plain", body: "...human-edited..." }, edited_by_human: true }

impri_report_result({
  action_id: "act_9wp3...",
  status: "executed",
  detail: "Sent via support inbox"
})
```

## Result

The agent keeps drafting at full speed; nothing leaves your domain's mail server or Slack workspace without a person having actually read it first. Tone and factual slips get caught at the one point where catching them is still free — before send, not after a customer replies.

## CTA

Related: [Approve emails before your AI agent sends them](/docs/approve-emails-before-your-ai-agent-sends-them) and [Approve Slack messages from an AI agent](/docs/approve-slack-messages-from-an-ai-agent). [Try Impri free](https://app.impri.dev).
