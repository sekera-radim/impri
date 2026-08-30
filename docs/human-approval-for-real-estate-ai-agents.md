# Human Approval for Real Estate AI Agents

Real estate AI agents reply to leads, draft listing descriptions, and propose showing times — this shows how to put a human approval step in front of every one of those before they reach a client's inbox.

---

## Where this goes wrong without a gate

A lead-response agent hooked up to a CRM is one of the more tempting automations in real estate — inbound inquiries about a listing arrive at all hours, and a fast reply matters. It's also a place where an ungated agent causes real damage: quoting a price that changed last week, confirming a showing time the agent double-booked, or replying to a fair-housing-sensitive question with language a broker would never approve. None of these need malice — a stale context window or a bad scrape of the listing feed is enough.

The fix isn't a stricter prompt. It's making the send/confirm call structurally unreachable until a person has actually looked at the draft and said yes.

## Three calls, in TypeScript

```typescript
import fetch from "node-fetch";

const BASE = "https://api.impri.dev";
const KEY = process.env.IMPRI_API_KEY!;
const headers = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function proposeLeadReply(leadName: string, listingAddress: string, draft: string) {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "email.send",
      title: `Lead reply: ${leadName} — ${listingAddress}`,
      preview: { format: "markdown", body: draft },
      expires_in: 3600, // leads go cold fast — 1 hour, not the 72h default
      editable: ["preview.body"],
    }),
  });
  const { id } = await res.json();
  return id as string;
}

async function awaitDecision(actionId: string) {
  while (true) {
    const res = await fetch(`${BASE}/v1/actions/${actionId}`, { headers });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, 8000));
  }
}

const actionId = await proposeLeadReply(
  "Priya Nair",
  "412 Elm St, Unit 3B",
  "Hi Priya, thanks for asking about 412 Elm St — it's still available and we can set up a showing this week...",
);
const decision = await awaitDecision(actionId);

if (decision.status === "approved") {
  await sendReply(decision.decision.final_preview.body); // your CRM/email call
  await fetch(`${BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

If the agent instead confirms a showing time or updates a listing price, the shape doesn't change — only `kind`, `title`, and the preview body do.

## Not every real estate action needs the same urgency

| Action | Typical `expires_in` | Why |
|---|---|---|
| Lead reply | 1 hour (`3600`) | Inbound interest cools fast; a day-old reply reads as ignored |
| Showing confirmation | 4–8 hours | Needs a person to check their actual calendar, not just approve text |
| Listing description update | 24–72 hours | Lower urgency, more scrutiny — brokers often want to read it carefully |
| Price change announcement | Default 72h or longer | High-stakes, rarely time-sensitive in the same-day sense |

Set `expires_in` per `kind` rather than using one value everywhere — a stale lead reply and a stale price change are different failure modes, and the API's 300s–30d range gives room for both.

## The broker still owns the words

Set `editable: ["preview.body"]` and a broker can tighten a lead reply's tone or correct a detail the agent got wrong, right on the approval card, before it goes out. `decision.diff` gives a record of what they changed — useful if a client later disputes what was said about a listing. Execute with `decision.final_preview.body`, not the agent's original draft; the API never lets the original slip back in.

## Impri is the gate, not the CRM

Impri doesn't know your MLS data, doesn't verify a listing is still active, and doesn't check a calendar for conflicts — it stores the proposed action, notifies whoever should review it, and holds the decision until they respond. That's the whole job. If your agent still holds a raw CRM or SMTP credential it can call directly instead of going through the wrapped send function, the gate can be routed around — wire the approval into the actual send path, not next to it (see the [integrations guide](integrations.md)).

It's also not a scheduling engine — if you need real calendar-conflict resolution across multiple agents and showings, that logic belongs in your CRM or booking tool, with Impri sitting in front of the one step that sends a message to a client.

## Next step

Get a key from the [quickstart](quickstart.md), then check the [TypeScript SDK](sdk-typescript.md) if you'd rather not write the fetch calls above by hand.
