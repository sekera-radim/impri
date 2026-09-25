# Approve AI Agent Ad Spend and Marketing Budget Changes

Approve AI agent ad spend and marketing budget changes before money moves: the agent proposes each bid, budget or campaign change, and a human signs off first.

---

## Why spend is different from content

A bad draft costs you embarrassment. A bad budget change costs you cash by the hour. An agent that optimizes campaigns can double a daily cap after misreading a spike, unpause a campaign that was paused for a legal reason, or shift budget on stale numbers. Platforms will happily spend whatever the API allows.

A gate before the change is applied turns "the agent wasted 2,000 overnight" into "the reviewer saw a card that said the daily cap goes from 50 to 500 and tapped reject."

---

## What the reviewer needs on the card

The approval is only as good as what the human can see. Put the numbers in the preview, not just a summary sentence: current value, proposed value, the delta, the scope, and the agent's stated reason. A markdown table renders well in the card.

```typescript
const IMPRI = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

type BudgetChange = {
  campaign: string;
  currentDaily: number;
  proposedDaily: number;
  reason: string;
};

export async function proposeBudgetChange(c: BudgetChange): Promise<boolean> {
  const delta = ((c.proposedDaily - c.currentDaily) / c.currentDaily) * 100;

  const res = await fetch(`${IMPRI}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "ads.budget_change",
      title: `${c.campaign}: daily budget ${c.currentDaily} -> ${c.proposedDaily}`,
      preview: {
        format: "markdown",
        body:
          `| Field | Value |\n|---|---|\n` +
          `| Campaign | ${c.campaign} |\n` +
          `| Current daily | ${c.currentDaily} |\n` +
          `| Proposed daily | ${c.proposedDaily} (${delta.toFixed(0)}%) |\n\n` +
          `**Agent's reason:** ${c.reason}`,
      },
      expires_in: 3600, // a bid decision based on old metrics should lapse
      editable: ["preview.body"],
      idempotent: true,
      undo: `Set ${c.campaign} daily budget back to ${c.currentDaily}`,
    }),
  });
  const { id } = (await res.json()) as { id: string };

  let action: any;
  do {
    await new Promise((r) => setTimeout(r, 15_000));
    action = await (await fetch(`${IMPRI}/v1/actions/${id}`, { headers })).json();
  } while (action.status === "pending");

  if (action.status !== "approved") return false;

  // Your own function that calls the ad platform; Impri never touches it.
  const applied = await applyBudgetToPlatform(c.campaign, action.decision.final_preview.body);

  await fetch(`${IMPRI}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: applied ? "executed" : "execute_failed" }),
  });
  return applied;
}
```

Note the edit path. If you set `editable: ["preview.body"]`, the reviewer can change the proposed number before approving, so parse the amount from `final_preview` rather than trusting the value the agent sent. `applyBudgetToPlatform` must validate whatever it parses.

---

## Layering your own limits

Impri does not know what a sensible budget is. Keep hard limits in code as well as in the human gate:

- **Cap outside the agent.** Enforce a maximum per-campaign and per-day figure in the executor, so an approval cannot push past a ceiling you set on purpose.
- **Split by risk.** Send small nudges (a few percent) straight through and route only changes above a threshold to the inbox. Deciding the threshold is your logic, not Impri's.
- **Distinct `kind` values** such as `ads.budget_change`, `ads.pause`, `ads.creative_launch` keep the [inbox](inbox.md) sortable and let you filter the [audit log](audit-log.md) when finance asks who approved a change.

---

## Boundaries

Impri is only the approval gate. It stores the proposal, notifies the reviewer, and records the decision. It does not analyze performance, decide whether a budget is reasonable, or talk to Google Ads, Meta, or any other platform.

It is a real control only when the ad-platform credential lives in the executor that runs after approval. If the agent also holds a token that can change budgets directly, it can bypass the gate. Confine it by wrapping the platform call, as covered in [the integrations guide](integrations.md).

Use a short `expires_in`. Approving a change an hour late means approving it against data that no longer holds.

---

## Next step

Start with the [quickstart](quickstart.md) to get a key, then gate a single action type, budget increases, before adding pauses and creative launches. If your reviewers live in chat, [Slack approval](slack-approval.md) puts the card where they already are.
