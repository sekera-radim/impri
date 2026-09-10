# Approve AI Agent Calendar Changes Before They're Sent

Give a scheduling agent write access to your calendar and it will eventually double-book, reschedule the wrong meeting, or send an invite to the wrong list — this pattern puts a human between the proposed change and the send.

---

## Why calendar writes are riskier than they look

A calendar agent looks low-stakes compared to one that sends money or deletes data, but a calendar write has a side effect other people see immediately: an invite lands in a colleague's or a client's inbox, a meeting moves without the attendees agreeing to it, or a "helpful" cleanup cancels something that was intentional. There's also no undo that doesn't itself require an apology email. The fix is the same one used for any agent action with an external side effect: the agent proposes, a human decides, and only an approved decision reaches the calendar API.

## What gets proposed vs. what gets executed

The agent never calls the calendar provider's API directly. It builds the change it wants to make — reschedule, new invite, cancellation — as an Impri action, and a small executor function is the only code path allowed to call the real calendar API, and only after seeing `status: "approved"`.

```typescript
import { Impri } from "@impri/sdk";
import { google } from "googleapis"; // or your calendar client of choice

const impri = new Impri({ apiKey: process.env.IMPRI_API_KEY! });

interface ProposedReschedule {
  eventId: string;
  title: string;
  attendees: string[];
  currentStart: string;
  proposedStart: string;
  reason: string;
}

async function proposeReschedule(change: ProposedReschedule) {
  const action = await impri.actions.create({
    kind: "calendar.reschedule",
    title: `Reschedule: ${change.title}`,
    preview: {
      format: "markdown",
      body:
        `**${change.title}**\n\n` +
        `Attendees: ${change.attendees.join(", ")}\n` +
        `From: ${change.currentStart}\n` +
        `To: ${change.proposedStart}\n\n` +
        `Reason: ${change.reason}`,
    },
    target_url: `https://calendar.google.com/calendar/event?eid=${change.eventId}`,
    expires_in: 3600, // an hour-old reschedule proposal is worth re-checking, not sending stale
    editable: ["preview.body"],
  });
  return action.id;
}

async function applyIfApproved(actionId: string, change: ProposedReschedule) {
  const decision = await impri.actions.awaitDecision(actionId, { timeoutS: 3600 });

  if (decision.status !== "approved") {
    console.log(`Reschedule not applied: ${decision.status}`);
    return;
  }

  // The proposed time itself isn't editable in this action (only the note is),
  // so the approved time is always the one originally proposed.
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });
  await calendar.events.patch({
    calendarId: "primary",
    eventId: change.eventId,
    requestBody: { start: { dateTime: change.proposedStart } },
  });

  await impri.actions.reportResult(actionId, { status: "executed" });
}
```

The `target_url` field is doing real work here: it points the reviewer straight at the existing event in their own calendar, so they can check the current state before approving a change to it instead of trusting the agent's summary alone.

---

## Letting the human edit before it sends

Set `editable: ["preview.body"]` and the reviewer can fix the reasoning text or attendee note directly on the approval card before approving — useful when the agent's proposed message ("Sorry for the short notice!") isn't the tone you want going out attached to the change. Always read the change back from `decision.final_preview`, never the original `preview.body`; that field is guaranteed to hold whatever the human actually approved, edited or not.

---

## Expiry matters more for calendars than for most actions

A reschedule proposal that sits unapproved for a day is usually wrong by the time someone gets to it — the meeting may have already happened, or someone else already moved it. Keep `expires_in` short (the example above uses one hour) and treat an `expired` action the same as a `rejected` one: don't apply it, and have the agent re-check the event's current state before proposing again.

---

## What this doesn't cover

Impri gates the write — it doesn't understand calendar semantics, detect double-bookings, or know which attendees are important enough to warrant extra caution. That logic stays in your agent or a rules layer in front of it; see [rules](rules.md) for filtering which actions need approval at all versus which can auto-approve. For agents that also draft the invite email itself, [approve emails before your AI agent sends them](approve-emails-before-your-ai-agent-sends-them.md) covers that adjacent gate.

**Next step:** [quickstart](quickstart.md) to create a key, then swap the calendar client above for your own — the [TypeScript SDK](sdk-typescript.md) covers the full action/decision API surface used here.
