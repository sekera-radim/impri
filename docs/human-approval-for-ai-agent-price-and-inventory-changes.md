# Human Approval for AI Agent Price and Inventory Changes

Stop a repricing or inventory-management agent from pushing a bad price or stock count live by routing every change through a human approval card first.

---

## Why this needs a gate

A pricing agent that watches competitor prices, demand signals, or stock levels and adjusts your listings accordingly is genuinely useful — until it isn't. The failure modes are specific and well known in this space: a scraped competitor price of "$9.99" that was actually a shipping fee, a demand model that decides a stockout means "raise price 40%" during a moment that looks bad publicly, or a decimal error that lists a $299 item at $2.99 and sells out the warehouse in ten minutes. None of these look like bugs from inside the agent's own reasoning — they look like confident, well-justified decisions.

Unlike a single email or a single blog post, a pricing agent usually wants to change *many* SKUs in one pass. That changes the shape of the approval problem: reviewing forty individual pop-ups is not realistic for a human, so the gate has to work as a batch, not just a queue of singles.

## The MCP flow, one SKU at a time

For an agent running inside an MCP client (Claude Code, Claude Desktop, or your own MCP host), each proposed change is one `impri_push_action` call:

```typescript
type PriceChange = {
  sku: string;
  currentPrice: number;
  proposedPrice: number;
  reason: string;
};

async function proposePriceChange(change: PriceChange) {
  const { action_id } = await mcp.call("impri_push_action", {
    kind: "price.update",
    title: `${change.sku}: $${change.currentPrice} → $${change.proposedPrice}`,
    preview: {
      format: "markdown",
      body: [
        `**SKU**: ${change.sku}`,
        `**Current**: $${change.currentPrice}`,
        `**Proposed**: $${change.proposedPrice}`,
        `**Reason**: ${change.reason}`,
      ].join("\n"),
    },
    editable: ["preview.body"],
    expires_in: 3600,
  });

  const decision = await mcp.call("impri_await_decision", {
    action_id,
    timeout_s: 1800,
  });

  if (decision.status !== "approved") return; // rejected or expired: price stays put

  await updateListingPrice(change.sku, change.proposedPrice);
  await mcp.call("impri_report_result", { action_id, status: "executed" });
}
```

A one-hour `expires_in` matches how fast pricing data goes stale — a price change approved eight hours later against a competitor snapshot from that morning is approving something that may no longer be true.

## Batching the review

When the agent produces a whole repricing pass — say thirty SKUs at once — pushing thirty separate actions and letting the human triage them from the inbox is the right shape, not thirty individual interruptions. The inbox supports exactly this: `POST /v1/actions/bulk-decision` lets a reviewer approve or reject a set of pending actions in one pass instead of opening each card individually. Design the agent to tag related actions with a shared prefix in the title (`"Weekly repricing: SKU-1042 ..."`) so they group visually in the inbox even though each one is still gated independently.

## What to gate vs. what to let run

| Change | Gate it? |
|---|---|
| Price change beyond ±5% of current | Yes |
| Price change within ±1% (rounding, currency sync) | Usually not worth the interruption |
| Marking an item out of stock from a real inventory feed | Depends on your risk tolerance — often auto |
| Marking an item back in stock from a supplier feed | Same as above |
| Any change driven by scraped/unverified competitor data | Yes, always |
| Bulk changes affecting more than N SKUs at once | Yes, and batch the review |

Pick thresholds you can defend later, and let the boring, high-confidence cases (small rounding syncs, verified inventory feeds) skip the gate — a gate that fires on everything trains reviewers to rubber-stamp, which defeats the purpose.

## Boundaries

Impri does not know your pricing model, your margin floor, or your competitor data — it only stores what the agent proposed and holds the human's decision on it. The threshold logic above belongs in your agent, not in Impri. And this only holds as a real gate if the agent's price-update function requires an approved decision to run — if it also has a separate cron job that writes prices directly to the store, the gate has a hole in it.

See [the base integration pattern](how-to-add-human-approval-to-an-ai-agent.md) for the full three-call flow, [MCP setup](mcp.md) if you haven't wired the server in yet, and [integrations](integrations.md) for wrapping the actual store-update call so the approved path is the only path.
