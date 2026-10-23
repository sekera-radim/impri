# Understanding the Maker-Checker Pattern for AI Agents

Maker-checker means the identity that proposes an AI agent action is never the one that approves it — a rule agents break unless you wire the split yourself.

---

## Where the pattern comes from

Maker-checker (also called "four-eyes" or segregation of duties) is a decades-old control from banking and accounting: the person who enters a transaction cannot also be the person who authorizes it. Not because either person is untrusted individually, but because a single party with both powers can make a mistake — or commit fraud — with nobody else in the loop. The control isn't "get permission," it's "get permission from someone who couldn't have granted it to themselves."

That distinction matters more for an AI agent than it ever did for a human clerk. A human asking a colleague for sign-off is a different brain making an independent judgment. An agent that calls a tool, and then calls another tool to "approve" what it just proposed, is the same model checking its own work — there's no second judgment in the loop at all, just an extra API call.

---

## What "maker" and "checker" map to in practice

For an agent wired to Impri, the maker is whatever pushes the pending action:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "invoice.send",
    "title": "Send invoice #4471 to Acme Corp — $12,400",
    "preview": {"format": "plain", "body": "Invoice #4471, due in 30 days."},
    "expires_in": 3600
  }'
```

`$AGENT_KEY` only needs the `actions` scope to do this. The checker is whoever later calls `POST /v1/actions/:id/decision`, `POST /v1/actions/bulk-decision`, or clicks approve in a chat channel. For decisions made through Slack, Discord, or Telegram, that identity is recorded as the platform's own user — not the agent's key at all:

| Decision channel | Identity recorded in `decisions.decided_by` | Distinct from the agent's key? |
|---|---|---|
| Slack button | `sl:{slackUserId}` | Always — Slack authenticates the clicker |
| Discord button | `dc:{discordUserId}` | Always — Discord authenticates the clicker |
| Telegram button | `tg:{telegramUserId}` | Always — Telegram authenticates the clicker |
| Web inbox / REST API | the API key used to decide | Only if that key differs from the agent's |

(Source: `server/src/interactive-decision.ts` builds the chat identities; `server/src/routes/actions.ts` records `key.keyId` for web and API decisions.)

---

## What Impri does *not* enforce

This is the part worth being honest about: Impri doesn't have a separate "propose" scope and "decide" scope. Both `POST /v1/actions` and `POST /v1/actions/:id/decision` check the same `actions` scope. If you hand your agent process a key with that scope and your own code calls the decision endpoint with it, nothing in Impri stops it — the separation has to come from how you wire the agent, not from a permission the API refuses to grant.

Two habits make the split real instead of cosmetic:

- **Give the agent a key it is never asked to decide with.** Code the agent to call `POST /v1/actions` and `GET /v1/actions/:id` only. Don't give it a code path to the decision endpoints.
- **Put the human decision behind a channel the agent doesn't control.** Slack/Discord/Telegram buttons are the cleanest, because the platform — not your key management — authenticates who clicked. A human deciding through the web inbox should log in with their own key, not the agent's.

There's also no quorum feature: `decisions` has a `UNIQUE(action_id)` constraint, so exactly one verdict is recorded per action, first writer wins. If your policy needs two independent humans to sign off, Impri won't do that natively — you'd chain two actions yourself (e.g. treat the first approval as provisional and gate execution behind a second review your own code requests).

---

## Verifying the split after the fact

Because `action.created` and `action.approved`/`action.rejected` are separate audit rows with their own `actor`, you can check — not just assume — that no key approved its own action:

```bash
curl -s "https://api.impri.dev/v1/audit?entity_id=act_9f2" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq '.items[] | {event, actor, channel}'
```

A healthy result shows `action.created` with the agent's key ID and `action.approved` with a different actor — a Slack name, a Discord handle, or a distinct key ID. If both rows show the same actor, your maker-checker split exists in your head but not in the record.

---

## Next step

Set up the two credentials — see [API keys](api-keys.md) for scoping an agent-only key, [Slack approval](slack-approval.md) for a checker identity the agent can't touch, and [the audit log](audit-log.md) for querying `actor` across an action's lifecycle. For the underlying push/poll/report flow, start with [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).
