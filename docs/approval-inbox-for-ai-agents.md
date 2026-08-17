# An Approval Inbox for AI Agents

A single approval inbox for AI agents means every pending action — from every agent, on every channel — lands in one triage queue instead of scattered across chat pings you can lose track of.

---

## Why a queue beats a stream of pings

A one-off "approve this?" ping works fine when an agent proposes something rarely. It stops working once you run more than one agent, or one agent that's prolific. A content team running a drafting agent might have it produce six blog posts, four social captions, and two email newsletters in a single afternoon. If each one arrives as an isolated Slack DM, you either review them as they land — constant interruption — or you lose track of which ones you already handled.

An inbox turns that stream into a queue: everything pending sits in one place, filterable, until someone works through it. Nothing gets lost because nothing disappears after the notification scrolls away.

---

## Populating the inbox

Every call to `POST /v1/actions` adds one card to the inbox, regardless of which agent or process made the call. Here's a drafting agent queuing a batch of posts with the TypeScript SDK:

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

interface Draft {
  title: string;
  body: string;
  publishUrl: string;
}

async function queueDrafts(drafts: Draft[]): Promise<string[]> {
  const actionIds: string[] = [];

  for (const draft of drafts) {
    const action = await impri.actions.create({
      kind: "blog.publish",
      title: `Draft: ${draft.title}`,
      preview: { format: "markdown", body: draft.body },
      targetUrl: draft.publishUrl,
      expiresIn: 259200, // 72h default — plenty for a weekly editorial pass
      editable: ["preview.body"],
    });
    actionIds.push(action.id);
  }

  return actionIds;
}
```

Twelve drafts from one afternoon become twelve cards sitting in the same inbox, tagged with their `kind`, waiting for an editor's pass — instead of twelve separate interruptions.

---

## Triaging in bulk

A queue is only an improvement over a stream if working through it is fast. For same-shaped, low-risk actions — a batch of social captions from an approved content calendar, say — reviewing and deciding one by one is unnecessary overhead. `POST /v1/actions/bulk-decision` lets a reviewer approve or reject a set of action IDs in one call, which is what the inbox UI's "select all matching" does under the hood:

```bash
curl -X POST https://api.impri.dev/v1/actions/bulk-decision \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_ids": ["act_101", "act_102", "act_103", "act_104"],
    "decision": "approved"
  }'
```

The agent-side polling loop for each of those four drafts sees `status: "approved"` on its next check, exactly as if each had been approved individually — bulk decision is a reviewer-side shortcut, not a different execution path.

| Inbox situation | Recommended handling |
|---|---|
| Few actions/day, high individual stakes | Review each card on its own |
| Many same-`kind` actions from a trusted template | Filter by `kind`, bulk-decide |
| Mixed batch, unclear which are routine | Sort by `kind` and `expires_in` first, then decide |

---

## What the inbox is triaging against

An inbox full of stale cards is worse than no inbox — reviewers stop trusting it and start ignoring notifications instead. That's what `expires_in` is for: every action carries an expiry (minimum 300 seconds, maximum 30 days, 72 hours if unset), and past that point the card moves to `expired` and drops off the working queue on its own. Set it deliberately per `kind` — a same-day social post doesn't need a 30-day shelf life, and a quarterly report draft shouldn't expire mid-review.

Every decision, whoever made it and whenever it happened, is recorded in the [audit log](audit-log.md) — so "who approved the post that went out with the wrong CTA" is always answerable, individually decided or bulk.

---

## What an inbox is not

The inbox is a review queue, not a workflow engine. It doesn't route an action to a specific reviewer based on content, branch on approval outcomes, or chain steps together — if you need that, put Impri as one node inside [n8n or a similar orchestrator](integrations.md), with the inbox handling the human-decision step and the workflow engine handling everything before and after it. And the inbox only reflects reality if the agent's execution path is actually gated on the decision it returns — an agent that can call the publish API directly, bypassing the pending action, makes the inbox a suggestion box instead of a gate.

---

## Next step

Set up your first inbox in the [quickstart](quickstart.md), or see the [full integration guide](how-to-add-human-approval-to-an-ai-agent.md) for the three-call pattern every action in the queue follows.
