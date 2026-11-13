# Human Approval for OpenAI AgentKit After Agent Builder

Agent Builder shuts down on November 30, 2026. Export your AgentKit workflow to the Agents SDK and send its tool approvals to a reviewer's Impri inbox.

---

## What changes on November 30, 2026

OpenAI's [deprecations page](https://developers.openai.com/api/docs/deprecations) lists Agent Builder, the visual workflow editor in AgentKit, as deprecated since June 3, 2026, with a shutdown date of November 30, 2026. The named replacements are the Agents SDK (agents in code) or ChatGPT Workspace Agents (no-code agents inside a ChatGPT Business, Enterprise or Edu workspace). ChatKit remains available.

OpenAI's [migration guide](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder) exports a workflow as Agents SDK code:

1. Open the workflow in Agent Builder.
2. Select **Code** in the top navigation.
3. Select **Agents SDK**, then **TypeScript** or **Python**, and copy the complete export.

The guide warns that the export "does not convert your workflow graph or guarantee that every behavior transfers unchanged," so re-check every step that changes something outside the chat.

## The Human approval node doesn't come along as-is

In Agent Builder, the [Human approval node](https://developers.openai.com/api/docs/guides/node-reference) is described as "Defer to end-users for approval": the person chatting with the workflow answers the yes/no question.

In the Agents SDK, approval belongs to a tool: `needsApproval: true` (TypeScript) or `needs_approval=True` (Python). When the model calls it, the run pauses and returns the pending calls in `result.interruptions`; your code approves or rejects each on `result.state` and runs the agent again with that state.

Who answers is now your code's choice. That matters when:

- The person in the chat shouldn't approve the action: a customer asking for their own refund, an employee asking for their own access.
- Nobody is in a chat at all: the agent runs from a queue, a cron job or a webhook.

Then the approval has to reach someone else. Impri puts the pending call in a reviewer's web inbox, notifies them (Slack, Discord, Telegram, ntfy or email, as the project is set up) and returns the decision to your code.

## Route each interruption to a reviewer

Each `send_ticket_reply` call becomes an Impri action; the reviewer's decision becomes `approve()` or `reject()` on the run state:

```typescript
import { Agent, run, tool } from "@openai/agents";
import { ImpriClient, ImpriRejected, ImpriExpired } from "@impri/sdk";
import { z } from "zod";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

const sendReply = tool({
  name: "send_ticket_reply",
  description: "Send a reply to a customer's support ticket.",
  parameters: z.object({ ticketId: z.string(), body: z.string() }),
  needsApproval: true, // the run pauses here instead of calling execute
  execute: async ({ ticketId, body }) => helpdesk.sendReply(ticketId, body),
});

const agent = new Agent({
  name: "Support agent",
  instructions: "Draft a reply to the ticket and send it with send_ticket_reply.",
  tools: [sendReply],
});

let result = await run(agent, "Ticket 4812: the customer was charged twice for March.");

while (result.interruptions.length > 0) {
  for (const interruption of result.interruptions) {
    // One Impri action per pending tool call, shown to the reviewer as-is.
    const created = await impri.createAction({
      kind: `agents_sdk.${interruption.name}`,
      title: `${interruption.agent.name} wants to call ${interruption.name}`,
      preview: { format: "markdown", body: "```json\n" + (interruption.arguments ?? "{}") + "\n```" },
      expires_in: 3600,
    });

    try {
      await impri.awaitDecision(created.id, { timeoutS: 3600 });
      result.state.approve(interruption);
    } catch (e) {
      if (e instanceof ImpriRejected || e instanceof ImpriExpired) {
        result.state.reject(interruption, { message: "A reviewer did not approve this call." });
      } else {
        throw e; // ImpriTimeout: still pending in the inbox, decide what to do
      }
    }
  }
  result = await run(agent, result.state); // resume where the run paused
}

console.log(result.finalOutput);
```

- **`needsApproval` is the gate, not the prompt.** The SDK doesn't call `execute` until the state holds an approval.
- **`reject()` with a message** tells the model why the call didn't happen.
- **Leave `editable` off for this pattern.** `state.approve()` runs the tool with the model's original arguments, so an edit made in the inbox would never reach the tool. When the reviewer should be able to change the text, use the gate-inside-the-tool pattern from [human-in-the-loop for the OpenAI Agents SDK](human-in-the-loop-openai-agents-sdk.md), which reads `decision.final_preview`.

`awaitDecision` keeps the process waiting for up to an hour here. For longer reviews, the SDK can save the paused run with `result.state.toString()` and restore it later with `RunState.fromString(agent, saved)`; pass a `callback_url` when you create the action and resume when Impri's [webhook](webhooks.md) arrives.

## Guardrails are not approvals

| Need | Where it lives |
|---|---|
| Check every input or output automatically | Agents SDK guardrails |
| A named person says yes to one specific tool call | `needsApproval` + Impri |
| A record of who approved what, and when | Impri's [audit log](audit-log.md) |

Use both: a guardrail stops an obviously bad draft before a reviewer sees it.

## Where Impri stops

Impri doesn't run your tools and doesn't know your agent. It stores the proposed call, notifies the reviewer and returns the decision; the Agents SDK runs the tool after `approve()`. The gate only holds if every tool that reaches the helpdesk is marked `needsApproval`: an unmarked tool with the same API key is a way around it.

## Next step

[Start free on Impri cloud](https://app.impri.dev/?signup=1) or [self-host](self-hosting.md) the MIT-licensed core, then follow the [quickstart](quickstart.md) to approve one test action from the inbox before you wire it into the exported workflow. The general three-call pattern is in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).
