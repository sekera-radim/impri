# Human-in-the-Loop for Personal AI Assistants

A personal AI assistant that texts contacts, pays bills, or drafts emails needs a human-in-the-loop check before it acts — here's the minimal pattern to add one.

---

## Personal assistants have a different risk profile than business agents

Most human-in-the-loop writing targets teams: a support bot issuing refunds, a marketing agent posting to a brand account. A personal AI assistant is different in a way that makes approval *more* important, not less: it acts on your behalf with your accounts, your contacts, and your money, and there's no second reviewer, no compliance team, no one else who'd notice if it sent the wrong text to the wrong person. You are the only backstop.

That also means the approval step has to be lightweight enough that you'll actually use it — a phone notification you can tap, not a dashboard you have to open. The mechanics are the same three calls as any agent integration: push the action, wait for a decision, execute on approval.

---

## Wiring it into a personal assistant

Say your assistant handles reminders and can text people on your behalf (via Twilio, iMessage bridge, whatever). Before it sends, it proposes the message and waits:

```typescript
async function proposeText(to: string, body: string) {
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "sms.send",
      title: `Text to ${to}: reschedule reminder`,
      preview: { format: "plain", body },
      editable: ["preview.body"],
      expires_in: 1800, // 30 min — a reminder text is time-sensitive
    }),
  });
  const { id, inbox_url } = await res.json();
  return id;
}

async function waitForDecision(actionId: string) {
  while (true) {
    const res = await fetch(`https://api.impri.dev/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const actionId = await proposeText("+1555...", "Hey, can we move lunch to 1pm?");
const decision = await waitForDecision(actionId);

if (decision.status === "approved") {
  await sendSms(decision.decision.final_preview.body); // your Twilio call
}
```

The `editable: ["preview.body"]` field matters here specifically — a reminder text your assistant drafted might have the wrong tone or a typo'd name, and you'd rather fix it inline on your phone than reject and re-prompt the whole assistant.

New to the flow? [The full integration guide](how-to-add-human-approval-to-an-ai-agent.md) covers REST and MCP end to end.

---

## Where this matters for a personal assistant specifically

| Assistant action | Approve first? |
|---|---|
| Draft a text/email reply | Yes — tone and accuracy matter, low cost to check |
| Pay a bill or send money | Yes — irreversible, use `idempotent: false` |
| Add a calendar event | Often skip — low stakes, easy to undo |
| Delete a photo or file | Yes — irreversible |
| Order something online | Yes, especially above a $ threshold you set |
| Read-only lookup (weather, search) | No — nothing to approve |

The judgment call is yours: gate the actions that are hard to undo or embarrassing to get wrong, skip the ones that aren't. [Approve from your phone](approve-ai-agent-actions-from-your-phone.md) covers the notification side so the tap-to-approve loop is actually fast enough to use daily.

---

## What this doesn't give you

Impri is the approval gate, not the assistant. It doesn't know your contacts, doesn't draft the text, and doesn't decide what "looks wrong" — it just holds the proposed action until you decide and hands back exactly what you approved (including any edits you made). It's also only a real gate if your assistant's SMS/email/payment code path *requires* the approved decision to run — if the assistant still holds a raw Twilio key it could call directly, wrap that credential so the approval step is the only door through.

If your assistant also texts on a schedule unattended (nightly digest, morning reminders), see [gate a cron job with human approval](gate-a-cron-job-with-human-approval.md) for handling actions that fire while you're asleep.

---

## Next step

Start with [the quickstart](quickstart.md) to get an API key, then wrap whichever action in your assistant is the one you'd least want to happen automatically.
