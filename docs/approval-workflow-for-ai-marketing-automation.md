# An Approval Workflow for AI Marketing Automation

Marketing automation agents draft campaigns, schedule sends, and touch ad spend — an approval workflow keeps a human signing off before copy goes out or budget moves.

---

## Two different risk profiles, one gate

Marketing automation covers a wide range of actions, and they don't all carry the same risk:

- **Reversible, low-stakes**: scheduling a social post in a drafts queue, generating A/B variants of subject lines nobody sees yet.
- **Irreversible or costly**: sending an email to your full list, publishing a post live, raising a daily ad budget cap.

The second category is where an autonomous agent can do real damage fast — a typo in a subject line reaching 50,000 inboxes, or a budget change that silently 10x's your daily ad spend because the agent misread a KPI. Those are the actions worth gating. The first category can usually run unattended; gating everything just trains reviewers to rubber-stamp without reading, which defeats the point.

---

## Wiring it up over MCP

If your marketing agent runs inside Claude Code, Claude Desktop, or another MCP client, the Impri MCP server handles the push/poll/report cycle as tool calls — no HTTP client needed in your agent code. Configure it once:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here"
      }
    }
  }
}
```

Then the agent's flow for a campaign send looks like this (shown as the tool calls it makes):

```
impri_push_action(
  kind="campaign.send",
  title="Send: August newsletter — 'What we shipped this month'",
  preview={
    format: "markdown",
    body: "Subject: What we shipped this month\n\nHi {{first_name}},\n\n..."
  },
  expires_in=14400,
  editable=["preview.body"]
)
→ { action_id: "act_9f2", status: "pending", inbox_url: "..." }

impri_await_decision(action_id="act_9f2", timeout_s=14400)
→ { status: "approved", preview: { body: "..." }, edited_by_human: true }

# only now does the agent call your ESP
send_campaign(list_id="newsletter", body=decision.preview.body)

impri_report_result(action_id="act_9f2", status="executed")
```

If a marketer edits a line in the subject or a CTA before approving, `edited_by_human: true` and the corrected body come back in the same response — the agent never has to ask for the edit separately, it just uses what it's given.

---

## Ad spend changes need a different kind of care

A budget change isn't content a reviewer reads and approves — it's a number they need to sanity-check against context they have and the agent doesn't (this week's performance, upcoming promotions, finance limits). Two fields make that review possible instead of a leap of faith:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "ad_campaign.budget_update",
    "title": "Raise daily budget: Q3 retargeting — $80 → $150",
    "preview": {
      "format": "plain",
      "body": "Campaign: Q3 Retargeting\nCurrent daily budget: $80\nProposed: $150\nReason: CTR up 34% over last 7 days, spend capped before 6pm daily"
    },
    "idempotent": false,
    "undo": "PATCH ad campaign budget back to $80 via platform API",
    "expires_in": 21600
  }'
```

`undo` tells the reviewer how to reverse it if the new budget turns out to be wrong after the fact — cheap to write, and it changes a "trust the agent" decision into a "worst case is a two-minute fix" decision. `idempotent: false` puts a warning on the card so a distracted reviewer can't approve the same bump twice from two different notifications.

---

## What this workflow does and doesn't cover

Impri stores the proposed action, notifies whoever reviews marketing sends, and holds the decision — it doesn't know your brand voice, your send-time best practices, or whether "150" is a reasonable ad budget for your account. That judgment stays with the human and with however you've prompted the agent to draft in the first place.

It's also not a campaign scheduler or a workflow engine — if you need multi-step sequencing (draft → legal review → design review → send), build that in your own pipeline or a tool like n8n and call Impri for the final human sign-off step. See [MCP integration](mcp.md) for wiring this into a Claude Agent SDK or LangChain-based marketing agent, and [approve AI-generated content before publishing](approve-ai-generated-content-before-publishing.md) for the content-review side of this same pattern.

Next step: [quickstart](quickstart.md) to get an API key and wire this into your first campaign.
