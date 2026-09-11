# Approve AI Agent Support Ticket Escalations

Require a human to sign off before a support agent escalates a ticket, issues a refund, or reopens a case — approve or edit the outcome from a phone.

---

## Escalation is a decision, not a draft

Most human-in-the-loop examples are about drafts: an email, a social post, something with a "send" button. Ticket escalation is different — the agent isn't producing text for someone to read later, it's deciding *whether this customer gets a refund, a priority bump, or a callback right now*. That decision has a dollar amount or a policy exception attached to it, and getting it wrong is either a refund that shouldn't have gone out, or a frustrated customer who needed the escalation and didn't get it.

The fix is the same pattern used for drafts, applied to a decision instead of a document: the agent proposes the specific action — kind, amount, reason — and a human with escalation authority approves, rejects, or edits it before anything happens to the customer's account.

## The three-call pattern, via MCP (TypeScript)

For an agent already running as a Claude Agent SDK or Claude Code subagent, the MCP server handles the polling loop for you.

```typescript
import { experimental_createMCPClient as createMCPClient } from "ai";

const impri = await createMCPClient({
  transport: { type: "stdio", command: "npx", args: ["@impri/mcp"] },
});

async function escalateTicket(ticket: {
  id: string; customer: string; amount: number; reason: string;
}) {
  const pushed = await impri.callTool("impri_push_action", {
    kind: "ticket.escalate",
    title: `Refund $${ticket.amount} — ticket #${ticket.id} (${ticket.customer})`,
    preview: {
      format: "markdown",
      body: `**Reason:** ${ticket.reason}\n**Requested refund:** $${ticket.amount}\n**Customer tier:** standard`,
    },
    editable: ["preview.body"],
    expires_in: 14400, // 4h — an unresolved escalation goes stale fast
  });

  const decision = await impri.callTool("impri_await_decision", {
    action_id: pushed.id,
    timeout_s: 14400,
  });

  if (decision.status !== "approved") {
    return { escalated: false, status: decision.status };
  }

  const result = await issueRefund(ticket.id, decision.preview.body);

  await impri.callTool("impri_report_result", {
    action_id: pushed.id,
    status: result.ok ? "executed" : "execute_failed",
  });

  return { escalated: true, refunded: ticket.amount };
}
```

If the on-call lead rejects it, `issueRefund` is never called — the function returns before reaching that line. If they let it expire because nobody was watching the inbox, treat that the same way: no refund goes out for an escalation nobody actually looked at.

## Letting the reviewer adjust the amount, not just approve or deny

Setting `editable: ["preview.body"]` means the on-call lead isn't stuck choosing between "give them the full $80 refund" and "give them nothing." They can edit the body to note a partial refund or a different resolution before approving, and `decision.preview.body` — not the agent's original number — is what your code reads back. That's the difference between a rubber-stamp gate and one that's actually useful for judgment calls.

## Routing escalations to Slack instead of an inbox tab

A refund decision that sits unread in a web inbox for six hours isn't a gate, it's a delay. Most teams running this pattern point notifications at [Slack](slack-approval.md) so the on-call lead gets a card with Approve/Reject buttons directly in the channel where support already happens, instead of a separate tool to check.

| Escalation type | Suggested `expires_in` | Editable |
|---|---|---|
| Refund under a policy threshold | 4h | `preview.body` (amount, note) |
| Account reopen / ban reversal | 24h | `preview.body` (justification) |
| Priority/SLA override | 1h | none — approve or reject only |

## What Impri is not doing here

Impri doesn't know your refund policy, doesn't calculate the amount, and doesn't touch your ticketing system. It stores the proposed escalation, shows it to whoever has approval authority, and hands your code a decision. The `issueRefund` call and the ticket status update are your integration, wired through the [TypeScript SDK](sdk-typescript.md) or the [MCP server](mcp.md) as shown above.

**Next step:** [Quickstart](quickstart.md) to get an API key, then swap the `issueRefund` stub above for your actual support-platform call.
