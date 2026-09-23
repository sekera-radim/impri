# Human Approval for Zapier AI Agents

Zapier's AI Actions let a Zap decide what to send, post, or update on its own — add one Code step and Impri holds a human approval gate before anything irreversible runs.

---

## Why Zaps with AI Actions need a gate

A Zap that uses an AI Action to draft a customer email, post a Slack update, or write a CRM record is not the same as a Zap that moves a spreadsheet row. The AI step is non-deterministic: the same trigger can produce a different email body or a different field value each run. Once that step feeds directly into an "Send Email" or "Create Record" action, a bad draft goes out with the same reliability as a good one. Zapier has no built-in "pause until a person says yes" step for AI-generated content — Delay and Filter steps work on fixed conditions, not on human judgment.

The fix is the same pattern used outside Zapier: the Zap proposes the action to Impri instead of executing it directly, and only continues past a human decision.

## Pushing the action from a Code step

Add a **Code by Zapier (Run JavaScript)** step right after your AI Action step, with the AI's output passed in as an input field (call it `draft`):

```javascript
const res = await fetch('https://api.impri.dev/v1/actions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.IMPRI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    kind: 'email.send',
    title: `Outreach: ${inputData.company_name}`,
    preview: { format: 'markdown', body: inputData.draft },
    target_url: inputData.gmail_draft_url,
    expires_in: 21600, // 6 hours — matches how fast leads go cold
    editable: ['preview.body']
  })
});

const action = await res.json();
output = { action_id: action.id, inbox_url: action.inbox_url };
```

This step returns immediately with a `pending` action and an `inbox_url` — it does not block the Zap waiting for a decision. Zapier runs are short-lived, so polling in a loop inside one execution is the wrong shape here.

## Resolving the decision without blocking the run

Two workable patterns, depending on how fast you need the answer:

1. **Separate polling Zap.** A second Zap on a Schedule trigger (every 10–15 minutes) calls `GET /v1/actions/:id` for any action IDs you stored (a Zapier Table or your own database works), and only continues to the send/post/write step once `status` is no longer `pending`.
2. **Webhook callback.** If your Impri deployment has [webhooks](webhooks.md) configured, point the webhook at a **Catch Hook** trigger in a second Zap. That Zap fires the moment a human decides, with the decision already in the payload — no polling step needed.

Either way, the execution Zap step must read `decision.final_preview.body` (not the original AI draft) and check `status === "approved"` before it runs the real send/post/write action:

```javascript
if (inputData.status !== 'approved') {
  throw new Error(`Not sending — action ${inputData.status}`);
}
output = { body: inputData.final_preview_body };
```

## What kind of Zap steps this fits

| AI Action feeds into... | `kind` value | Why gate it |
|---|---|---|
| Send Email / Gmail / Outlook | `email.send` | Irreversible once sent |
| Post Message (Slack/Discord) | `chat.post` | Visible to a whole channel immediately |
| Create/Update Record (CRM, Sheets, Airtable) | `record.create` / `record.update` | Bad data is hard to trace back later |
| Publish (CMS, social) | `content.publish` | Public and hard to fully retract |

## What Impri does not replace in your Zap

Impri is the approval gate, not a Zapier replacement. It does not branch on conditions, retry failed steps, or coordinate multiple Zaps — that logic still lives in Zapier itself (Paths, Filters, Delay). Impri's only job inside this flow is to hold the human decision and hand back `final_preview` so the rest of your Zap can trust it.

Next: set up an API key with the [quickstart](quickstart.md), or read the full [REST/MCP integration guide](how-to-add-human-approval-to-an-ai-agent.md) for the non-Zapier version of this same pattern.
