# Human-in-the-Loop for Cloudflare Agents SDK

Give a Cloudflare Agents SDK Durable Object agent a real human-in-the-loop gate, so tool calls like sending or posting pause for an actual yes before they run.

---

## Confirmation inside the agent isn't a gate

The Agents SDK (the `agents` package Cloudflare ships for building stateful, Durable-Object-backed agents) has a well-known pattern for pausing tool execution: mark a tool as needing confirmation, and the chat UI renders an approve/reject button before the tool's `execute` function runs. That's useful for a demo, but it has two gaps once the agent is doing something real.

First, the confirmation only exists inside your own chat UI — there's no inbox, no mobile push, no record of who clicked what. If the person who needs to approve isn't staring at that tab, the action just sits there. Second, and more important: the gate lives in the same process as the model. Anything that calls the tool's `execute` function directly — a retry path, a scheduled alarm, a different code path in your Durable Object — bypasses the confirmation UI entirely, because the UI was never the thing enforcing the pause. It was decoration around it.

A real gate has to sit *outside* the model's process, on the only path to the side effect.

---

## Wrapping the tool executor, not the model

The fix is mechanical: instead of letting a tool's `execute` function call the side-effecting code directly, have it push an Impri action and block on the decision. The side-effecting function only ever gets called from inside the `if (status === "approved")` branch — there's no other route to it in the codebase.

```typescript
// inside your Agent's Durable Object class (agents SDK)
import { tool } from "ai";
import { z } from "zod";

const postToSlack = tool({
  description: "Post a message to the #eng-updates Slack channel",
  parameters: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    const push = await fetch("https://api.impri.dev/v1/actions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.IMPRI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "slack.post",
        title: "Post to #eng-updates",
        preview: { format: "markdown", body: text },
        expires_in: 1800,
        editable: ["preview.body"],
      }),
    }).then((r) => r.json());

    // Durable Objects give you cheap, persistent polling via alarms —
    // no separate queue needed. Simplified inline loop shown here.
    let result;
    while (true) {
      result = await fetch(`https://api.impri.dev/v1/actions/${push.id}`, {
        headers: { Authorization: `Bearer ${this.env.IMPRI_API_KEY}` },
      }).then((r) => r.json());
      if (result.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (result.status !== "approved") {
      return `Not sent — action was ${result.status}.`;
    }

    await slackClient.postMessage(result.decision.final_preview.body);
    await fetch(`https://api.impri.dev/v1/actions/${push.id}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.IMPRI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "executed" }),
    });
    return "Sent, pending human approval.";
  },
});
```

The important detail: `slackClient.postMessage` appears exactly once in this file, inside the approved branch. There's no second code path — scheduled, retried, or triggered by a different message — that reaches the Slack client without going through this same `execute` function.

---

## Durable Objects make the polling loop cheap

One thing that's genuinely a good fit here: Cloudflare's Durable Objects support alarms, so instead of a busy `while` loop burning a Worker invocation, you can push the action, set an alarm for a few seconds out, and let the alarm handler re-check status and reschedule itself if still pending. The example above uses a simple loop for readability, but in production swap it for `this.storage.setAlarm()` — it's a natural match for the sub-second-cost, long-idle nature of waiting on a human.

---

## What Impri actually gates here

Impri stores the proposed Slack message, notifies you (email, push, or a Slack/Discord/Telegram approval channel), and holds the decision — it does not know what "posting to Slack" means or verify the message content. The gate is only as real as the wrapping: if some other part of your Durable Object still holds a Slack token and calls `slackClient.postMessage` directly, that path routes around Impri entirely. Confine the credential to the wrapped executor, not just the intended call site, and treat the built-in Agents SDK confirmation UI as a UX nicety layered on top of this — not a substitute for it.

For the full three-call pattern this builds on, see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). If you're integrating an SDK rather than raw fetch calls, check the [TypeScript SDK](sdk-typescript.md). New to Impri entirely? Start with the [quickstart](quickstart.md).
