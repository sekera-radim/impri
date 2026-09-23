# Approve AI Agent WhatsApp Business Messages Before They Send

Route every outbound WhatsApp Business message your AI agent drafts through a human approval step first, so a bad reply never reaches a customer's chat thread unreviewed.

---

WhatsApp Business is unlike email or a support ticket: the message lands in a thread the customer already trusts, often on a number they've saved as a real business contact. A hallucinated refund promise, a wrong order status, or a tone-deaf reply sent from that channel does more damage than the same mistake in a draft email folder, because there's no "sent folder" moment where a human might still catch it — the customer has already read it by the time anyone notices.

Agents that read the WhatsApp Business API (inbound messages, order lookups) don't need gating. The one call that does is whatever sends the reply.

## Where the gate sits

```
Customer message ──▶ Agent reads context, drafts reply ──▶ Impri action created
                                                                    │
                                                         Reviewer approves/edits/rejects
                                                                    │
                                                          Agent sends via WhatsApp
                                                          Business API, only if approved
```

The agent never holds a code path that calls the WhatsApp send endpoint on its own — that call only happens after `status: "approved"` comes back.

## Implementation (TypeScript)

```typescript
import fetch from "node-fetch";

const API = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface Decision {
  status: "pending" | "approved" | "rejected" | "expired";
  decision?: { final_preview: { body: string } };
}

async function proposeReply(customerPhone: string, draft: string): Promise<string> {
  const res = await fetch(`${API}/v1/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "whatsapp.message.send",
      title: `Reply to ${customerPhone}`,
      preview: { format: "plain", body: draft },
      editable: ["preview.body"],
      expires_in: 1800, // 30 min — a stale reply reads as ignoring the customer
    }),
  });
  const { id } = await res.json();
  return id;
}

async function pollDecision(actionId: string): Promise<Decision> {
  for (;;) {
    const res = await fetch(`${API}/v1/actions/${actionId}`, { headers: HEADERS });
    const data = (await res.json()) as Decision;
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function handleInboundMessage(customerPhone: string, draft: string) {
  const actionId = await proposeReply(customerPhone, draft);
  const decision = await pollDecision(actionId);

  if (decision.status !== "approved") {
    console.log(`Reply to ${customerPhone} not sent: ${decision.status}`);
    return;
  }

  const finalBody = decision.decision!.final_preview.body; // human edits, if any
  // await sendWhatsAppMessage(customerPhone, finalBody); // your WhatsApp Business API call

  await fetch(`${API}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

## Why the short expiry matters here specifically

A 30-minute `expires_in` is deliberately tight. WhatsApp is a real-time channel — a customer who messaged 20 minutes ago is either still waiting or has moved on to another support avenue. Compare that to the [email approval flow](approve-emails-before-your-ai-agent-sends-them.md), where a same-day expiry is normal because the sender's expectation is slower. Treat an expired WhatsApp reply as a signal to re-draft with fresh context, not to send the stale one late.

## Reviewing from a phone, not a desk

Whoever approves these is often the same person who'd otherwise be answering WhatsApp manually — which means they need to decide from their phone, in the same moment they'd normally be typing a reply. Point notifications at a channel your reviewer already has open. [Telegram approval](telegram-approval.md) and push notifications both work well here since the decision usually needs to happen inside a minute or two, not queued up for an end-of-day review pass.

## Editable replies, not just approve/reject

Setting `editable: ["preview.body"]` matters more for chat replies than for most action types: a reviewer who thinks the agent's answer is 90% right will edit the wording rather than reject and force a full re-draft. Always send `final_preview.body`, not the original draft — it carries whatever the human changed, and rejecting that distinction is a common integration bug (sending the original after an edited approval).

## Boundaries

Impri holds the decision and shows the reviewer the draft — it does not know anything about WhatsApp's messaging policies, template-message rules, or the 24-hour customer-service window. Those constraints live in the WhatsApp Business API itself and your integration needs to respect them regardless of what Impri returns. Impri also isn't reading or moderating the *inbound* message; if that inbound text came from an untrusted source, treat it as data when constructing the draft, not as instructions to your agent.

---

Next: get an API key from the [quickstart](quickstart.md), or see [webhooks](webhooks.md) if you'd rather receive the approval decision as a push instead of polling.
