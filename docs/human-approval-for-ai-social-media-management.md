# Human Approval for AI Social Media Management

Human approval for AI social media management gates the ongoing stream of replies, DMs, and comment moderation an agent handles across accounts — not just the occasional scheduled post.

---

## Managing accounts is a different problem than posting once

A single scheduled post is one decision: publish this text or don't. Social media *management* is a stream — an agent watching mentions, replying to comments, answering DMs, and moderating spam across one account or a dozen client accounts for an agency, all day. At that volume, requiring a person to open a dashboard and click through a queue one card at a time defeats the point of automating the work in the first place.

The gate has to match the shape of the workload: fast per-item review where it's needed, batch review where a whole class of drafts is low-risk, and it has to work from wherever the reviewer already is — for most social teams, that's Slack, not a separate tool they have to remember to check.

## The three volumes an agency actually deals with

1. **One-off, high-stakes** — a reply to a PR crisis or an angry VIP customer. Push it as a single action with a short expiry; treat it like [approving a single post](human-approval-before-an-agent-posts-to-social-media.md).
2. **Steady trickle** — routine comment replies ("thanks!", "checking on this") across several client accounts through the day. Push each as its own action but route them to a Slack channel the account manager already has open, with inline Approve/Reject buttons — see [Slack approval](slack-approval.md).
3. **Batch** — an agent triages 40 overnight DMs into "safe to auto-reply" drafts. Reviewing 40 individual cards is what makes reviewers start rubber-stamping without reading. Push them all, then let the reviewer clear the routine ones in one motion via the bulk-decision endpoint and read the two or three flagged ones individually.

## Pushing a batch of DM replies for review

```bash
# Agent drafts replies to 3 overnight DMs across 2 client accounts
for draft in "${DRAFTS[@]}"; do
  IFS='|' read -r account handle body <<< "$draft"
  curl -s -X POST https://api.impri.dev/v1/actions \
    -H "Authorization: Bearer $IMPRI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"kind\": \"social.dm_reply\",
      \"title\": \"[$account] Reply to @$handle\",
      \"preview\": { \"format\": \"markdown\", \"body\": $(jq -Rs . <<< "$body") },
      \"editable\": [\"preview.body\"],
      \"expires_in\": 43200
    }" | jq -r .id >> pending_ids.txt
done
```

Each account gets its own `title` prefix so a reviewer scanning the Slack channel or inbox instantly knows which client the draft belongs to — that's the one piece of context a batch view can't lose without becoming useless for an agency handling several accounts at once.

## Clearing the routine ones in bulk

Once the reviewer has skimmed the batch and only wants to greenlight the routine replies (not the two that need edits), a single call decides the rest:

```bash
curl -s -X POST https://api.impri.dev/v1/actions/bulk-decision \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_ids": ["act_a1", "act_a2", "act_a3"],
    "decision": "approved"
  }'
```

The agent's polling loop for each `action_id` sees `status: "approved"` exactly as if it had been clicked individually — bulk decision is a reviewer convenience, not a different code path on the agent's side. Reference it against the flagged replies still sitting `pending`, which get their normal single-item review and can be edited via `decision.final_preview.body` before the agent posts.

## What the agent does after a decision lands

```bash
STATUS=$(curl -s https://api.impri.dev/v1/actions/$ACTION_ID -H "Authorization: Bearer $IMPRI_API_KEY")
if [ "$(echo $STATUS | jq -r .status)" = "approved" ]; then
  BODY=$(echo $STATUS | jq -r '.decision.final_preview.body')
  post_dm_reply "$ACCOUNT" "$HANDLE" "$BODY"   # your platform call, wrapped so it can't run otherwise
  curl -s -X POST https://api.impri.dev/v1/actions/$ACTION_ID/result \
    -H "Authorization: Bearer $IMPRI_API_KEY" -d '{"status": "executed"}'
fi
```

Nothing distinguishes a bulk-approved reply from an individually-approved one at this point — the agent just reads the same `status` and `final_preview` fields either way.

## What this doesn't cover

Impri stores the drafts, notifies the right Slack channel, and holds each decision — it doesn't know which of your client accounts is under a strict brand guideline this week, doesn't moderate the incoming comments for abuse itself, and doesn't manage the content calendar or posting schedule. Whoever reviews the batch is still the one judging tone and accuracy; Impri's job is making sure that judgment happens before anything goes out, at whatever volume the account load actually requires.

Next step: [quickstart](quickstart.md) to get an API key, then wire up [Slack approval](slack-approval.md) so your account managers never have to leave the channel they already work in.
