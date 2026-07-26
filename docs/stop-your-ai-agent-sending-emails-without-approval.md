# Stop Your AI Agent From Sending Emails Without Approval

Stop your AI agent from sending emails without approval by gating the send call behind a human decision, so a bad draft never reaches a real inbox.

---

## The failure mode is always the same

An outreach agent, a support-ticket responder, a newsletter drafter — the pattern repeats: someone wires an LLM to `sendEmail()`, tests it on three good examples, ships it, and a week later it sends something embarrassing, wrong, or to the wrong person. Emails are close to the worst case for "let the agent just do it" — there's no undo, the recipient sees exactly what the model produced, and by the time you notice, it's already delivered.

Telling the agent "always ask before sending" in the system prompt doesn't hold up. It's a suggestion the model can talk itself out of under the right (or adversarial) context, and it leaves no record of what was approved. What actually works is making the send function itself unreachable until an external system says "approved."

## Wrapping the send call

The agent keeps drafting exactly as before. The only change is what happens after the draft is ready: instead of calling your mail API, it calls Impri, then blocks until a human decides, then calls your mail API — but only in the approved branch.

```typescript
import { ImpriClient, ImpriRejected, ImpriExpired, ImpriTimeout } from "@impri/sdk";
import { sendEmail } from "./mailer";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function proposeAndSendEmail(to: string, subject: string, body: string) {
  const action = await impri.createAction({
    kind: "email.send",
    title: `Send to ${to}: ${subject}`,
    preview: { format: "markdown", body },
    expires_in: 21600, // 6 hours
    editable: ["preview.body"],
  });

  console.log(`Awaiting approval: ${action.inbox_url}`);

  let decided;
  try {
    decided = await impri.awaitDecision(action.id, { timeoutS: 21600 });
  } catch (err) {
    if (err instanceof ImpriRejected || err instanceof ImpriExpired || err instanceof ImpriTimeout) {
      console.log(`Not sending — ${err.message}`);
      return;
    }
    throw err;
  }

  // final_preview carries any edits the reviewer made to the draft
  const finalBody = decided.decision?.final_preview?.body ?? decided.preview.body;
  await sendEmail(to, subject, finalBody);

  await impri.reportResult(decided.id, "executed");
}
```

The `sendEmail` call only exists after `awaitDecision` resolves without throwing — a rejection or expiry throws before that line is ever reached, so there is no code path where the agent's own reasoning decides to send. That's the difference between a gate and a suggestion.

## Letting the reviewer fix the draft, not just reject it

Outreach and support drafts are usually 90% right and need a name or a detail corrected, not a full rewrite. Setting `editable: ["preview.body"]` lets the reviewer edit the text directly in the approval card before tapping approve — the corrected version comes back as `decision.final_preview.body`, so you're never at risk of sending the original flawed draft by using the wrong field.

## Choosing what triggers the gate

Not every email needs a human in the loop, or the queue becomes unreviewable noise:

| Email type | Gate before send? |
|---|---|
| Cold outreach / partnership pitch | Yes |
| Reply to a support ticket with account-specific claims | Yes |
| Password reset / transactional confirmation | No — deterministic, not agent-authored |
| Internal digest the agent generates for your own team | Usually no, unless it goes external too |

A useful rule of thumb: gate anything where the recipient is external and the content was authored by the model, not a fixed template.

## What this does and doesn't guarantee

Impri stores the drafted email, notifies you (email, Slack, Telegram, whatever channel you've set up — see [Slack approval](slack-approval.md) and [Telegram approval](telegram-approval.md)), and holds the decision. It does not read the email for tone or accuracy, and it does not send anything itself — your code still owns the actual `sendEmail` call.

The gate is only as strong as the wiring: if the agent process also holds direct SMTP or API credentials it could call instead of going through this flow, nothing stops it from bypassing the gate under the wrong conditions. Keep the send credentials reachable only from the code path shown above, ideally in a separate wrapper the agent's own reasoning can't touch directly.

## Next step

If you're integrating inside Claude Code or another MCP client rather than raw TypeScript, see [MCP](mcp.md) for the tool-call version of this same flow, or start from the [quickstart](quickstart.md) to get an API key first.
