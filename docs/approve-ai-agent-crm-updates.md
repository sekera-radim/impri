# Approve AI Agent CRM Updates Before They Sync

If an agent enriches leads or updates deal stages, approve AI agent CRM updates before they sync — a wrong stage change or merged contact is hard to untangle after the fact.

---

## Why CRM writes are riskier than they look

A CRM-enrichment agent looks low-stakes: it reads an email thread or a call transcript, then updates a contact's title, moves a deal to the next stage, or merges what it thinks are duplicate records. The catch is that CRM data feeds forecasting, commission calculations, and outbound sequences downstream. An agent that moves a deal to "Closed Won" a week early skews the pipeline report a VP is about to present. One that merges two contacts because they share a last name silently drops the older contact's activity history. There's no error thrown — the sync just succeeds, and someone finds out a week later when the numbers don't add up.

The three actions worth gating are the ones a rep can't easily eyeball after the fact: stage changes, record merges, and field overwrites on fields other systems read (owner, deal amount, close date). Free-text notes and activity logging can go straight through — they're additive and don't corrupt existing state.

---

## Gating a deal-stage change

Here the agent runs as a Node/TypeScript service, calling the CRM's API directly once Impri returns an approval.

```typescript
import { setTimeout as sleep } from "node:timers/promises";

const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const IMPRI_BASE = "https://api.impri.dev";

interface DealChange {
  dealId: string;
  dealName: string;
  fromStage: string;
  toStage: string;
  reason: string;
}

async function proposeStageChange(change: DealChange): Promise<string> {
  const res = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "crm.deal_stage_change",
      title: `${change.dealName}: ${change.fromStage} → ${change.toStage}`,
      preview: {
        format: "markdown",
        body: `**Deal:** ${change.dealName}\n**Current stage:** ${change.fromStage}\n**Proposed stage:** ${change.toStage}\n\n**Why:** ${change.reason}`,
      },
      idempotent: false,
      undo: `Move deal ${change.dealId} back to "${change.fromStage}" in the CRM`,
      expires_in: 43200, // 12h
    }),
  });
  const body = await res.json();
  return body.id;
}

async function awaitDecision(actionId: string): Promise<any> {
  while (true) {
    const res = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    const body = await res.json();
    if (body.status !== "pending") return body;
    await sleep(8000);
  }
}

async function applyStageChange(dealId: string, toStage: string) {
  await fetch(`https://crm.example.com/api/deals/${dealId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${process.env.CRM_API_TOKEN}` },
    body: JSON.stringify({ stage: toStage }),
  });
}

const actionId = await proposeStageChange({
  dealId: "d_4471",
  dealName: "Northwind Traders — annual renewal",
  fromStage: "Negotiation",
  toStage: "Closed Won",
  reason: "Signed order form received via email, attached to thread",
});

const decision = await awaitDecision(actionId);

if (decision.status === "approved") {
  await applyStageChange("d_4471", "Closed Won");
  await fetch(`${IMPRI_BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${IMPRI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "executed" }),
  });
}
```

Setting `idempotent: false` puts a warning badge on the inbox card — a stage change isn't safe to blindly retry if the CRM write times out and the agent's retry logic fires twice.

---

## Record merges need the diff, not just the decision

Merges are the CRM action most likely to destroy data silently — a merge picks one contact's field values over another's, and the losing record's activity history typically doesn't survive. Use `editable: ["preview.body"]` when proposing a merge so the reviewer can adjust which fields win before approving, rather than only accepting or rejecting the agent's default choice. The response carries `decision.final_preview` with whatever the human changed — always execute with that, not the original proposal.

---

## Boundaries worth stating plainly

Impri stores the proposed change, notifies you, and holds the decision — it does not know your CRM's schema, does not validate that a stage transition is legal in your pipeline, and does not talk to Salesforce or HubSpot on your behalf. Your agent still owns the CRM API call; Impri only owns the yes/no. And the gate only holds if the agent has no other path to the CRM's write API — if it keeps a long-lived CRM token it can call directly, route every write through the same wrapper that checks for an approved decision.

Get a key from [the quickstart](quickstart.md), see the full push/poll/execute pattern in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), and check [integrations](integrations.md) for wrapping the CRM SDK call itself.
