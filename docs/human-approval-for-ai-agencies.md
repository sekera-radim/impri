# Human Approval for AI Agencies and Freelancers

Human approval for AI agencies means gating client-facing posts, invoices, and deliverables per account before an agent's mistake hits a client's brand.

---

## The problem is specific to running agents for other people

A solo founder using an AI agent on their own accounts can afford to be a little loose — if it sends a rough email from their own inbox, they clean it up themselves. An agency or freelancer running the same kind of agent across five or ten client accounts doesn't have that slack. A social post that goes out with the wrong tone, an invoice sent with the wrong line items, or a deliverable submitted before it's actually reviewed is now a client relationship problem, not an internal one — and it happened on an account the client trusts you to operate carefully.

The agents themselves don't need to change. What needs to exist is a checkpoint between "agent decided to act" and "action reaches the client's audience or inbox," scoped per client, so approval and audit trail are actually enforceable — not just a policy you hope the agent follows.

## One action kind per client-facing surface

Instead of one generic "approve this" gate, agencies get more value from splitting by what the action touches, since different surfaces need different reviewers (the social manager isn't who should approve an invoice):

- `agency.social_post` — scheduled posts to a client's own social accounts
- `agency.invoice_send` — invoices or estimates sent to a client
- `agency.deliverable_submit` — final assets or copy delivered for client sign-off

## Routing each client's approvals to the right reviewer

```typescript
import { ImpriClient } from "@impri/sdk";

const client = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

interface ClientAction {
  clientId: string;
  clientName: string;
  kind: "agency.social_post" | "agency.invoice_send" | "agency.deliverable_submit";
  summary: string;
  body: string;
}

async function proposeForClient(a: ClientAction) {
  const created = await client.createAction({
    kind: a.kind,
    title: `[${a.clientName}] ${a.summary}`,
    preview: { format: "markdown", body: a.body },
    editable: ["preview.body"],
    expiresIn: 172800, // 48h — account managers aren't always online
    undo: a.kind === "agency.social_post"
      ? "Delete the post from the client's account within 5 minutes of publishing"
      : "Contact client to void/reissue if already sent",
  });

  const decision = await client.awaitDecision(created.id, { timeoutS: 172800 });

  if (decision.status !== "approved") {
    console.log(`[${a.clientName}] ${a.kind} not sent: ${decision.status}`);
    return;
  }

  const finalBody = decision.decision!.finalPreview!.body;
  await executeForClient(a.clientId, a.kind, finalBody); // your integration per surface

  await client.reportResult(created.id, "executed");
}
```

The `[${a.clientName}]` prefix in the title matters more here than in a single-tenant setup — an account manager scanning a shared inbox needs to know which client a card belongs to before they even open it.

## Keeping client work out of one shared inbox

Prefixing titles works for a small team checking one inbox, but it doesn't scope who's *allowed* to approve what. Two ways agencies handle that as they grow past a couple of clients:

| Approach | When it fits |
|---|---|
| One Impri API key per client, routed to that account manager's [Slack](slack-approval.md) or [Telegram](telegram-approval.md) | Each client has a dedicated account manager |
| Shared key, `kind` prefixed by surface, reviewers filter their own queue | Small team, everyone reviews everything |

Neither requires Impri to know anything about your client roster — it's just how you choose to issue keys and where you point notifications.

## What this doesn't solve

Impri holds the pending action and the decision — it doesn't manage client relationships, doesn't track retainer hours, and doesn't know which account manager owns which client; that mapping lives in your own agent code or a lookup table you maintain. It also isn't a substitute for a client-facing approval step if your contract requires the *client* to sign off before publishing — that's a second, separate action your agent should push once your internal reviewer has approved it. And as always, the gate only holds if the agent's posting/invoicing credentials are wrapped so `executeForClient` can't run on a path that skips the approval call — see [the propose-approve-execute pattern](the-propose-approve-execute-pattern.md).

---

Next: [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the base pattern, and [audit log](audit-log.md) for the record you'll want when a client asks who approved what.
