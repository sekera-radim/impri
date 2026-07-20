# Approve AI-Generated Content Before Publishing

Approve AI-generated content before publishing to your CMS — review each draft individually, then batch-approve the ones that don't need a second look.

---

## The problem is volume, not any single draft

A single AI-written blog post is easy to review — read it, fix a line, hit publish. The problem shows up at volume: an agent that generates 200 product descriptions for a new catalog import, or rewrites metadata across an entire category, produces more drafts than anyone will read end to end before they go live. Reviewing each one individually doesn't scale, and skipping review entirely means the first time anyone notices a hallucinated spec ("machine washable" on a dry-clean-only jacket) or an off-brand tone is after it's already on the storefront.

The fix isn't picking one extreme or the other. It's gating every publish call the same way, then giving the reviewer a fast path for the drafts that are obviously fine and a slow path for the ones that need real attention.

---

## Push each draft as its own action

Every generated piece of content becomes its own action, with the CMS write as the gated call. In Node.js, for a catalog-import agent writing to a headless CMS:

```javascript
const IMPRI_BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function pushDraft(sku, title, body, cmsPreviewUrl) {
  const res = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "content.publish",
      title: `Product description: ${sku} — ${title}`,
      preview: { format: "markdown", body },
      target_url: cmsPreviewUrl,
      editable: ["preview.body"],
      idempotent: true, // re-publishing the same body is a safe PUT, not a duplicate
      expires_in: 259200, // 3 days — catalog copy isn't as time-sensitive as a social post
    }),
  });
  const { id } = await res.json();
  return id;
}

async function awaitAndPublish(actionId, sku) {
  let status = "pending", decision;
  while (status === "pending") {
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, { headers });
    ({ status, decision } = await res.json());
  }
  if (status !== "approved") {
    console.log(`${sku}: not published (${status})`);
    return;
  }
  await publishToCms(sku, decision.final_preview.body); // your CMS write
  await fetch(`${IMPRI_BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

`idempotent: true` here is deliberate and worth calling out — unlike an email or a social post, writing a product description to a CMS is usually a `PUT` against a known slug. Re-running it produces the same end state, not a duplicate. That's a genuinely different risk profile from the send-once actions covered elsewhere, and the approval card should say so.

---

## Batch-approving the ones that don't need scrutiny

For the drafts that pass a quick skim — no odd claims, no missing fields, on-brand tone — reviewing 200 individual cards is where teams actually give up on the gate. `POST /v1/actions/bulk-decision` takes up to 50 pending action IDs and a single verdict, so a reviewer can select a page of safe-looking cards in the inbox and approve them in one call instead of one hundred:

```bash
curl -X POST https://api.impri.dev/v1/actions/bulk-decision \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["act_101", "act_102", "act_103"],
    "verdict": "approve",
    "comment": "Batch import review — Q3 catalog"
  }'
```

One deliberate limitation: bulk decisions carry no `edited` field — batch approval is edit-free by design. If a draft needs a fix, it comes out of the batch and gets approved (with an edit) individually. That split is the actual point: bulk for "ship as-is," individual review for "needs a human hand on the text."

---

## What still deserves individual review

| Content type | Batch-approve candidate? |
|---|---|
| Product descriptions, standard categories | Usually — spot-check a sample, batch the rest |
| Descriptions for regulated categories (supplements, medical devices, financial products) | No — claims need individual review every time |
| SEO metadata / alt text | Usually — low stakes, high volume |
| Anything with pricing, availability, or legal disclaimers embedded | No — factual errors here have real consequences |

---

## Rejected, edited, and expired drafts

Same rule as any gated action: `rejected` and `expired` mean `publishToCms` never runs for that SKU. If a reviewer edits a description before approving, `decision.final_preview.body` carries the edited text — always publish from there, not from the original draft. Set `expires_in` generously (days, not minutes) for catalog content; unlike a live-incident social reply, a product description going live a day later than planned isn't itself a problem.

---

## What Impri doesn't check

Impri stores the draft, notifies a reviewer, and holds the decision — it does not verify that a product claim is accurate, does not check brand style guidelines, and never writes to your CMS itself. That judgment is exactly what the human reviewing the card is there for. For the underlying three-call pattern, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md); for the full bulk-decision reference including rate limits and the inbox keyboard shortcuts, see [inbox](inbox.md). Once content approval is flowing through Impri, [the audit log](audit-log.md) gives you a record of every SKU published, by whom, and what the agent's original draft said before it was edited.

Next step: [quickstart](quickstart.md) to get an API key and try this against a small batch first.
