# Human Approval Before a Browser Agent Submits a Form

Let a browser-automation agent fill out any web form, but hold the final submit click for a human to review and approve first.

---

## The submit click is the side effect, not the typing

Browser agents built on Playwright, Puppeteer, or a "browser-use" style toolkit are good at navigating a page, reading labels, and filling in fields. The risk isn't in the typing — it's in the click that fires the `<form>`'s submit handler. That single click can send a support ticket, apply for a job, submit a government form, or check out a cart. Everything before it is reversible (just re-fill the field); the submit is not.

So the gate doesn't need to wrap the whole browsing session — it needs to wrap exactly one function: the one that clicks submit.

---

## Gating just the submit step

Below, the agent has already filled in a contact form and has the field values in hand. Instead of calling `page.click('button[type=submit]')` directly, it hands the filled values to a gate function first.

```typescript
import { readFile } from "node:fs/promises";

const API = "https://api.impri.dev/v1/actions";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface FormFields {
  [label: string]: string;
}

async function requestSubmitApproval(pageUrl: string, fields: FormFields) {
  const body = Object.entries(fields)
    .map(([label, value]) => `**${label}:** ${value}`)
    .join("\n\n");

  const create = await fetch(API, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "form.submit",
      title: `Submit form on ${new URL(pageUrl).hostname}`,
      preview: { format: "markdown", body },
      target_url: pageUrl,
      editable: ["preview.body"],
      expires_in: 900,
    }),
  }).then((r) => r.json());

  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`${API}/${create.id}`, { headers: HEADERS }).then((r) => r.json());
    if (check.status !== "pending") return check;
  }
}

// Inside the agent's control loop, right before the submit click:
async function submitFormIfApproved(page: import("playwright").Page, fields: FormFields) {
  const decision = await requestSubmitApproval(page.url(), fields);
  if (decision.status !== "approved") return; // rejected/expired — click never happens

  // decision.final_preview carries any human edits; re-parse it back into fields
  // if the reviewer changed a value, then fill and submit:
  await page.click('button[type="submit"]');
}
```

Nothing between `requestSubmitApproval` returning `"rejected"` and the function returning early ever touches `page.click`.

---

## What lands on the approval card

`target_url` puts the page the agent was on right on the card, so the reviewer can open it in a tab and see the live form next to the values the agent extracted. Because `preview.body` is editable, a reviewer who spots a typo'd email address or a wrong dropdown choice can correct the text before approving — `decision.final_preview.body` is what you re-parse and use, not the agent's original guess. A 15-minute `expires_in` fits browser sessions well: pages expire, sessions log out, and an approval for a form that's no longer open on screen isn't worth acting on.

---

## Where this sits in the agent's control loop

| Agent step | Gated? |
|---|---|
| Navigate to page | No |
| Read field labels, extract structure | No |
| Fill text inputs, select dropdowns | No |
| Click submit / checkout / confirm | **Yes** |

Impri has no idea what Playwright or Puppeteer are, and it never touches the browser — it only stores the proposed field values and holds a human decision. The gate is only real if the submit click is the agent's one way to trigger the side effect. If the same agent also has a direct API client for the same backend (skipping the form entirely), that path needs its own wrapper, or it becomes the way around the gate.

For multi-agent browser fleets where several agents each propose form submissions, [the audit log](audit-log.md) is where you'd later confirm who approved what and when.

---

## Next step

If this is your first Impri integration, read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full three-call pattern, or use the [TypeScript SDK](sdk-typescript.md) instead of raw `fetch` calls. See [integrations](integrations.md) for wrapping a tool function so the approved path really is the only path.
