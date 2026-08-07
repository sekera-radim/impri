# AI Agent Approval Queue: Build vs Buy

Weighing whether to build an AI agent approval queue in-house or buy one — the real cost, from schema design to Slack polling to what teams forget.

---

## The question isn't "can we build it"

Any team with a Postgres instance and a Slack webhook can build a table that says `status = pending`, notify someone, and update a row when they click a button. That part takes an afternoon. The question that actually matters is what happens in the following six months, once the first edge case shows up: an action that should have expired but didn't, a reviewer who edited a draft and the agent executed the original anyway, an audit log that's missing the one action someone needs to explain to a customer.

## What building actually requires

The minimal version is deceptively small. The complete version — the one that survives contact with a real agent in production — needs more:

| Component | Why it's not optional |
|---|---|
| Queue storage with expiry | Stale approvals ("yes" on a two-day-old draft) are worse than no approval |
| Notification fan-out | Email-only means missed approvals; you'll want Slack, push, or SMS eventually |
| Edit-then-approve | Reviewers rewrite drafts more often than they reject them outright |
| Diff between original and edited | Otherwise nobody can tell what changed before they approve it |
| Audit trail | The first time compliance or a customer asks "who approved this," you need an answer that isn't a Slack scrollback |
| Rate limiting | An agent stuck in a retry loop shouldn't be able to spam the queue |
| Idempotent execution guard | Approve-twice or retry-after-timeout shouldn't send the same email twice |

None of these are hard individually. Together, they're a small service with its own on-call surface — for a piece of infrastructure that isn't your product.

Here's roughly what the in-house version starts to look like once you get past the happy path:

```typescript
// approval-queue/schema.ts — the "simple" version, six weeks in
interface PendingAction {
  id: string;
  kind: string;
  originalPayload: Record<string, unknown>;
  editedPayload?: Record<string, unknown>;   // reviewers edit drafts
  editDiff?: string;                          // ...and you have to show what changed
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: Date;                            // needs a sweep job to enforce
  notifiedVia: ('slack' | 'email' | 'sms')[];  // fan-out, retried on failure
  executedAt?: Date;                          // idempotency guard for double-approval
  auditEvents: { actor: string; action: string; at: Date }[];
}

// Plus: the sweep cron for expiry, the Slack interactivity endpoint,
// the retry logic for failed notifications, and the admin view for
// "who approved this" — none of which are in this file.
```

That file is the easy 20%. The Slack interactivity endpoint, the expiry sweep, the retry-safe notification fan-out, and the admin audit view are the other 80%, and they're the parts that turn into a maintenance burden nobody signed up for.

## What buying gets you on day one

Impri's REST API collapses that entire list into three calls: push the action, poll for a decision, report the result. Expiry, editable drafts with diffs, audit log, and rate limiting are already handled server-side — see the [full integration walkthrough](how-to-add-human-approval-to-an-ai-agent.md) for the exact request shapes.

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY });

const action = await impri.actions.create({
  kind: "email.send",
  title: "Weekly digest to enterprise-tier customers",
  preview: { format: "markdown", body: draftBody },
  editable: ["preview.body"],
  expires_in: 86_400,
});

const decision = await impri.actions.awaitDecision(action.id, { timeoutS: 3600 });
if (decision.status === "approved") {
  await sendEmail(decision.final_preview.body); // human-edited version, not the original
  await impri.actions.reportResult(action.id, { status: "executed" });
}
```

Same guarantees as the schema above, minus the six weeks and the on-call rotation. See the [TypeScript SDK reference](sdk-typescript.md) for the full client surface.

## When building actually makes sense

Buying isn't universally right. If approvals are core to your product — you're building a moderation platform, not using one — owning that logic is the point, not overhead. If you need branching, multi-step orchestration, or agent-to-agent handoffs, that's a workflow engine's job (n8n, Temporal, Inngest), not an approval queue's; Impri is deliberately narrow and can sit as one step inside a broader workflow rather than replace it. And if compliance requires the data to never leave your infrastructure, the [self-hosted option](self-hosting.md) keeps the build-vs-buy calculus but skips the "who's on call for this" part.

## The honest boundary

Impri stores the proposed action, notifies a human, and holds the decision — it doesn't generate content or execute anything itself. Wiring the actual send/post/publish call, and making sure the agent has no path around the gate, is still your integration work either way. Buying removes the queue infrastructure, not the responsibility for the chokepoint.

**Next step:** [quickstart](quickstart.md) to get an API key and push your first action in under five minutes.
