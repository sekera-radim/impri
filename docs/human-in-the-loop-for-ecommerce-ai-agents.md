# Human-in-the-Loop for E-commerce AI Agents

An AI agent that reprices SKUs or files reorder POs unsupervised can bleed margin or blow a budget in one bad run — this shows how to gate those actions behind a human tap before they touch your store.

---

## Where e-commerce agents go wrong unsupervised

A pricing or inventory agent is usually wired straight into the Shopify (or WooCommerce, BigCommerce) Admin API: it scrapes competitor prices, watches sell-through velocity, and pushes updates directly. That works fine until the scrape returns garbage — a competitor's page 404s and the scraper reads "$0.00", or a JSON parse error rounds a $49.99 hoodie down to $4.99 — and the agent happily applies it to 200 live listings before anyone notices. Reorder agents have the same failure mode in the other direction: a demand forecast blip triggers a PO for 5,000 units of something that sells eight a month.

Neither of these is a hypothetical edge case; they're the normal failure mode of "agent reads external data, agent acts on external data" with no human between the two steps.

## The gate: price changes and reorders as pending actions

The fix isn't slower automation — it's an approval gate on exactly two categories of action: **price changes** and **reorder POs above a threshold**. Everything else (updating a product description, tagging inventory, syncing stock counts) can stay fully automated. Impri's job here is narrow: hold the proposed change, show it to a human, and only let the agent proceed once someone taps approve.

## Wiring it into a Shopify price-and-restock agent (TypeScript)

The agent still does all the analysis — Impri only sits between "decided" and "applied":

```typescript
import { ImpriClient, ImpriRejected, ImpriExpired } from "@impri/sdk";

const client = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

interface PriceChange {
  sku: string;
  productTitle: string;
  currentPrice: number;
  proposedPrice: number;
  reason: string;
}

async function proposePriceChange(change: PriceChange) {
  const created = await client.createAction({
    kind: "shopify.price_update",
    title: `Reprice ${change.productTitle}: $${change.currentPrice} → $${change.proposedPrice}`,
    preview: {
      format: "markdown",
      body: `**SKU:** ${change.sku}\n**Current:** $${change.currentPrice}\n**Proposed:** $${change.proposedPrice}\n**Reason:** ${change.reason}`,
    },
    payload: { sku: change.sku, proposedPrice: change.proposedPrice },
    editable: ["preview.body"],
    expiresIn: 21600, // 6 hours — a stale price move isn't worth applying
  });

  try {
    const action = await client.awaitDecision(created.id, { timeoutS: 21600 });
    const finalBody = action.decision!.finalPreview!.body; // carries any human edit

    await shopifyAdmin.productVariant.update(change.sku, {
      price: finalBody.includes(String(change.proposedPrice))
        ? change.proposedPrice
        : change.currentPrice, // fall back if the human edited the numbers in the card
    });

    await client.reportResult(created.id, "executed");
  } catch (e) {
    if (e instanceof ImpriRejected || e instanceof ImpriExpired) return; // never applied
    throw e;
  }
}
```

Reorder POs use the same three-call shape — `kind: "shopify.reorder_po"`, a preview that lists SKU, quantity, and unit cost, and `undo` set to the supplier cancellation window so whoever approves it knows how much time they have to change their mind.

## What the merchant sees

The inbox card is a diff, not a wall of JSON: current price, proposed price, and the reason the agent computed it. On mobile that's a five-second decision — reject the $4.99 hoodie, approve the three legitimate seasonal markdowns sitting next to it. If `editable: ["preview.body"]` is set, the merchant can fix a typo'd price in the card itself before approving, and `decision.finalPreview` carries that correction back to the agent.

## Refunds are a separate, higher-stakes gate

If the same agent also handles customer-facing refunds, treat those as a distinct `kind` (e.g. `shopify.refund`) with its own review — refund amounts and reasons need different scrutiny than a catalog price update, and mixing the two in one inbox makes the queue harder to triage. Set `idempotent: false` on refunds explicitly; approving the same refund action twice should never double-charge a reversal.

## What Impri is and isn't for e-commerce

Impri stores the proposed price change or PO, notifies you, and holds the decision — it does not know what a "reasonable" price move looks like, and it does not talk to Shopify itself. Your agent still owns the pricing logic and the actual API call; Impri only owns the yes/no. And it's a real gate only if the agent's Shopify credentials are wrapped so the price-update call cannot run without an approved decision — a credential the agent can use directly bypasses the gate entirely.

---

Next: see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the base REST/MCP pattern, [the TypeScript SDK](sdk-typescript.md) for the full client, and [integrations](integrations.md) for wrapping the executor so the gate can't be routed around.
