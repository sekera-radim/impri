# Approval Inbox vs Slack Buttons for Agent Sign-off

Comparing a homegrown Slack approve/reject bot to a dedicated approval inbox for AI agent actions, covering audit trail, mobile use, expiry, and edits.

---

## The instinct: just add Slack buttons

The first time someone needs a human to sign off on an agent action, the plan is almost always the same: post to Slack with Block Kit "Approve" / "Reject" buttons, stand up a small webhook receiver for the `interaction` payload, and flip a flag in your own database on click. It looks like an afternoon of work, and for a while it is.

What's easy to underestimate is everything Slack doesn't do for you. It delivers the click; your service handles the rest.

---

## What you actually end up maintaining

- **The webhook receiver.** A public endpoint that verifies Slack's request signature (HMAC against your signing secret + timestamp), replies inside Slack's 3-second window, and does the real work async. Get the check wrong and anyone who finds the URL can approve or reject actions.
- **State for the interaction.** A button click gives you a `message_ts` and whatever `value` you encoded — not an approval record. Your own table for status, decision time, and who clicked, or there's no audit trail.
- **Expiry.** Slack messages don't expire. A three-day-old "Approve this email?" button still fires on day nine, for a draft that's no longer relevant. You build the timeout logic yourself.
- **Editing the draft.** Buttons alone can't let a reviewer tweak the text before sending — that needs a modal, a submit handler, and a way to carry the edit back into your pipeline.
- **Mobile.** One approve/reject button renders fine on Slack mobile; a longer preview or diff is cramped, and there's no "here's what's waiting on me" view — just whatever scrolled past in the channel.
- **Only Slack.** An approver away from Slack — email, SMS, push — means another integration and another retry policy.

None of this is exotic engineering. It's work unrelated to what you wanted to ship, and the kind of code that rots once its author moves on.

---

## The same flow through an approval inbox

Impri replaces the receiver you'd maintain with three calls your agent already needs to make:

```bash
curl -s -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -d '{
    "kind": "slack.message.send",
    "title": "Reply in #support: refund request from customer #4821",
    "preview": { "format": "markdown", "body": "Hi, I have gone ahead and processed..." },
    "expires_in": 3600,
    "editable": ["preview.body"]
  }'
# → { "id": "act_9f2", "status": "pending", "inbox_url": "https://app.impri.dev/a/act_9f2" }
```

Compare that to what the DIY route needs just to render the prompt, before any receiver logic exists:

```json
{
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "Reply in #support: refund request from customer #4821" } },
    { "type": "actions", "elements": [
      { "type": "button", "text": { "type": "plain_text", "text": "Approve" }, "value": "act_9f2:approve" },
      { "type": "button", "text": { "type": "plain_text", "text": "Reject" }, "value": "act_9f2:reject" }
    ]}
  ]
}
```

The Slack JSON is just the button. Everything after the click — signature check, state, expiry, edits, history — is code you write. `GET /v1/actions/act_9f2` gives the agent `status`, `decision.final_preview` (the human-edited version, when `editable` was used), and `decision.diff`, with no receiver of your own.

---

## Slack doesn't disappear

This isn't "Slack vs an inbox" as mutually exclusive options. Impri lists Slack as one of its approval channels alongside Discord and Telegram, plus email, ntfy, and web push for plain notifications — see [slack-approval](slack-approval.md). The difference is who owns the plumbing: the click in Slack still resolves against a real action record with an expiry, an audit entry, and a place to review it later, instead of a bespoke handler you're on the hook for. Teams that want the ping in Slack but the decision handling centralized keep the notification and drop the receiver.

---

## Where the DIY Slack bot is genuinely fine

Be honest about this: for one approver, low volume, and no need to prove later who approved what, a button and a five-line webhook handler is a reasonable afternoon project. If nobody ever needs a diff, an edit step, mobile parity, or a second channel, the extra piece is the inbox, not the bot. The tradeoff shows up as volume grows, as more people need to approve, or the first time someone asks "who approved this and when" and the answer is a Slack search.

| Situation | DIY Slack buttons | Approval inbox (Impri) |
|---|---|---|
| Single approver, a few actions/day | Fine | Also fine, more setup |
| Need an audit log of decisions | Build it yourself | Built in |
| Reviewer edits the draft before approving | Needs a modal + handler | `editable` field |
| Approver on mobile, away from desktop | Cramped, channel-dependent | Dedicated inbox card |
| Expiry on stale actions | You implement it | `expires_in`, enforced |
| Notify beyond Slack | Separate integration each | email/ntfy/push + Slack/Discord/Telegram |

---

## What this doesn't solve

Whichever side you pick, the gate is only as real as the wrapper around it. Impri stores the proposed action, notifies a human, and holds the decision — it doesn't generate the draft, doesn't interpret the action, and never executes anything itself. It's a genuine gate only when the wrapped tool is the agent's *only* path to the side effect; an agent holding the raw Slack or SMTP credential can route around either approach. See [how-to-add-human-approval-to-an-ai-agent](how-to-add-human-approval-to-an-ai-agent.md) for the wrapper pattern.

Next step: [quickstart](quickstart.md) to get an API key and push your first action, or [slack-approval](slack-approval.md) if Slack is where your team wants the notification to land.
