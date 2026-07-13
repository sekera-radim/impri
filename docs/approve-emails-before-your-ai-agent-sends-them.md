# Approve Emails Before Your AI Agent Sends Them

Give your email-sending AI agent a human approval gate: push the draft, let the reviewer edit subject and body, then send only the approved version.

---

## Why email is the highest-risk action for an AI agent

Most agent side effects are reversible or low-stakes. An email is neither. It lands in someone's inbox immediately, carries your name, and can cause real damage if the tone is wrong, the facts are off, or it goes to the wrong address. A reply to a customer complaint, a cold outreach, a notification to a partner — any of these can go sideways when drafted by an agent that misread context or received a subtly manipulated input.

The instinct is to add a confirmation message in the system prompt: *"Always ask for approval before sending emails."* That reduces mistakes. It does not eliminate them, and it is not auditable. The model can rationalize past it.

A structural gate removes that discretion: the email cannot be sent unless an external system returns a human decision of `approved`. The agent literally cannot reach the sending code without it.

---

## What this looks like in practice

The flow is three steps from the agent's perspective:

```
Agent produces draft
  │
  ├─ POST /v1/actions  →  Impri stores draft, notifies you
  │
  ├─ GET /v1/actions/:id  (poll until decided)
  │    Human opens inbox card, reads draft,
  │    optionally edits subject or body, approves or rejects
  │
  └─ On "approved": send decision.final_preview.body
     On "rejected" or "expired": abort, log, optionally retry
```

The gate is not a confirmation prompt — it is a data dependency. The send function is never called without the API returning `status: "approved"`.

---

## Code example: Node.js email agent with approval gate

This example uses TypeScript with `nodemailer` for sending. The Impri calls are plain `fetch`.

```typescript
import nodemailer from "nodemailer";

const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const IMPRI_BASE = "https://api.impri.dev";

async function sendWithApproval(opts: {
  to: string;
  subject: string;
  body: string;
  expiresIn?: number; // seconds; default 3600
}): Promise<"sent" | "rejected" | "expired"> {
  // 1. Push the draft to Impri for human review
  const push = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "email.send",
      title: `Email to ${opts.to}: ${opts.subject}`,
      preview: {
        format: "markdown",
        body: `**To:** ${opts.to}\n**Subject:** ${opts.subject}\n\n---\n\n${opts.body}`,
      },
      editable: ["preview.body"],           // let the reviewer edit the body
      expires_in: opts.expiresIn ?? 3600,
    }),
  });

  if (!push.ok) throw new Error(`Impri push failed: ${push.status}`);
  const { id: actionId } = await push.json();

  // 2. Poll until the human decides (or the action expires)
  let result: { status: string; decision?: { final_preview?: { body: string }; diff?: string } };
  for (;;) {
    const poll = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    result = await poll.json();
    if (result.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (result.status !== "approved") {
    return result.status as "rejected" | "expired";
  }

  // 3. Send using the version the human approved (may differ from original draft)
  const approvedBody = result.decision!.final_preview!.body;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    text: approvedBody,
  });

  // 4. Report the outcome back to Impri (populates the audit log)
  await fetch(`${IMPRI_BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "executed" }),
  });

  return "sent";
}
```

Call this from your agent whenever it wants to send an email. The agent passes its draft; `sendWithApproval` blocks until a human decides; the outcome is returned as a string the agent can act on.

---

## Letting the human edit before approving

Setting `editable: ["preview.body"]` adds an edit field to the inbox card. The reviewer can rewrite the greeting, fix a factual error, adjust the closing — whatever the draft needs — before clicking Approve.

The decision always carries:
- `decision.final_preview` — the body as it was when the human approved (use this to send)
- `decision.diff` — a unified diff of what changed (present only when something was modified)

Never send the original `body` argument — send `final_preview.body`. Even if the human approved without editing, that field holds the canonically approved text. The original is not surfaced in the decision response.

This editing capability is what makes the gate useful for email specifically. AI-drafted copy often needs light touch-ups in tone or specifics. Rather than forcing a reject → regenerate cycle, the reviewer can fix the draft in place and approve it in one step.

---

## Setting the right expiry

```
expires_in: 3600      // 1 hour  — good for time-sensitive follow-ups
expires_in: 86400     // 24 hours — reasonable for non-urgent outreach
expires_in: 259200    // 72 hours — the default; fine for async review flows
```

An email that sat in the approval queue for two days has probably lost its context: the meeting it was following up on happened, the deal moved on, the thread continued without it. Set `expires_in` to match the actual window in which the email would still make sense to send.

Treat `expired` the same as `rejected`: do not send, and surface the outcome to your agent so it can log, notify, or reschedule as appropriate.

---

## Scope and boundaries

Impri is the gate only. It stores the draft, notifies the human (via inbox, Slack, Telegram, or Discord), and holds the decision. It does not interpret the email content, check grammar, filter for spam signals, or send anything itself.

The gate is structural only as long as the agent cannot reach your email-sending credential through any other path. If the agent also has direct access to your SMTP credentials or an email API key outside this wrapper, it can route around the approval step. Keep the sending credential inside the wrapper; do not expose it to the agent.

| Concern | Impri handles it |
|---------|-----------------|
| Gate: block send until human says yes | Yes |
| Notify reviewer via Slack / Telegram | Yes ([notifications](notifications.md)) |
| Let reviewer edit body before approving | Yes (`editable: ["preview.body"]`) |
| Audit log of what was approved, when, by whom | Yes ([audit log](audit-log.md)) |
| Check email for spam / deliverability | No |
| Drafting or improving email content | No |
| Scheduling the send for a future time | No |

---

## Next steps

- [Quickstart](quickstart.md) — get an API key and push your first action in five minutes
- [Webhooks](webhooks.md) — receive a callback instead of polling when the decision arrives
- [Notifications and approval channels](notifications.md) — approve from Slack or Telegram without opening the inbox
