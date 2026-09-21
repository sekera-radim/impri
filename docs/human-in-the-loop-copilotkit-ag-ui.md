# Human-in-the-Loop for CopilotKit and AG-UI Agents

CopilotKit's AG-UI protocol renders approval prompts inside your app — this shows how to back that with Impri so the decision survives a closed tab or an offline approver.

---

## Two different places to say "are you sure"

CopilotKit agents built on the AG-UI protocol can pause mid-run and surface an interrupt — a tool call awaiting approval, rendered as a purpose-built UI element in your app via `useHumanInTheLoop` or similar. That's a genuinely good pattern for an admin who's actively watching the copilot work: the diff, the arguments, the approve/reject buttons are all right there in the product.

It has one gap: it only works while that browser tab is open and that user is looking at it. An embedded copilot that proposes a CRM update at 11pm, or one whose approver is a manager who isn't the person driving the chat, has nobody watching the interrupt render. The AG-UI run just sits there.

---

## Backend tool, not just frontend interrupt

The fix is to have the *backend* tool — the one AG-UI actually calls — push the proposal to Impri as well as (or instead of) surfacing an in-app interrupt. Impri notifies over email, Slack, Telegram, or push, and the decision persists whether or not anyone has the app open.

A Next.js API route backing a CopilotKit action that updates a CRM contact, gated on Impri:

```typescript
// app/api/copilotkit/actions/update-contact/route.ts
import { NextRequest, NextResponse } from "next/server";

const IMPRI = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

export async function POST(req: NextRequest) {
  const { contactId, field, oldValue, newValue } = await req.json();

  const pushRes = await fetch(`${IMPRI}/v1/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "crm.contact.update",
      title: `Update contact ${contactId}: ${field}`,
      preview: {
        format: "markdown",
        body: `Change **${field}** from \`${oldValue}\` to \`${newValue}\` on contact ${contactId}.`,
      },
      editable: ["preview.body"],
      expires_in: 21600, // 6h — long enough for a manager to see the notification
      idempotent: false,
    }),
  });
  const action = await pushRes.json();

  // Return the action id and inbox_url immediately — AG-UI renders this as
  // its interrupt UI, but the decision no longer depends on the tab staying open.
  return NextResponse.json({ actionId: action.id, inboxUrl: action.inbox_url, status: "pending" });
}
```

---

## Resolving the interrupt from either side

Two things can now resolve the AG-UI interrupt: the reviewer clicking approve inside your app's rendered UI, or the reviewer approving from Impri's own inbox (on their phone, over lunch, away from the product entirely). Both paths need to converge on the same source of truth. The cleanest way is to make Impri that source: have the in-app "approve" button call your backend, which pushes the decision to Impri via `bulk-decision` or lets the reviewer decide directly in Impri, and have your AG-UI resume handler poll or subscribe to the Impri action rather than trusting only a same-session click:

```typescript
// app/api/copilotkit/actions/update-contact/poll.ts
export async function GET(req: NextRequest) {
  const actionId = req.nextUrl.searchParams.get("actionId")!;
  const res = await fetch(`${IMPRI}/v1/actions/${actionId}`, { headers: HEADERS });
  const state = await res.json();

  if (state.status === "approved") {
    await crm.updateContact(state.decision.final_preview); // your real write
    await fetch(`${IMPRI}/v1/actions/${actionId}/result`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ status: "executed" }),
    });
  }
  return NextResponse.json(state);
}
```

Your AG-UI frontend can poll this route to resolve its own interrupt state, or you can skip polling entirely and use [webhooks](webhooks.md) to push the resume the moment Impri's decision lands.

---

## What stays a frontend concern

Not everything belongs in Impri. A quick "pick which of these three drafts" choice, scoped to the person actively in the chat, is exactly what AG-UI's interrupt UI is for — it's fast and contextual. Reach for Impri when the action has a real side effect (a write, a send, a spend) and the approver might not be the person at the keyboard, or might not see it for hours. Mixing both is normal: AG-UI for the live chat experience, Impri as the durable record behind any interrupt that actually matters.

---

## What Impri does and doesn't do

Impri stores the proposed contact update, notifies whoever needs to see it, and holds the decision. It doesn't know what CopilotKit or AG-UI are, doesn't render your interrupt UI, and doesn't touch your CRM. `update-contact/poll.ts` above is still the only code path that calls `crm.updateContact` — if another action or a direct API route can write to the CRM without going through this gate, the gate is decorative. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying propose → approve → execute contract this builds on.

---

## Next step

Get an API key from the [quickstart](quickstart.md), then swap the raw `fetch` calls above for the TypeScript SDK if you're wiring this into more than one AG-UI action.
