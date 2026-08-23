# Wrapping an Agent Tool With a Human Approval Step

Adding a confirmation line to your agent's prompt doesn't stop it from calling a tool directly — wrapping the tool function itself, so the real executor is unreachable without an approved decision, does.

---

## The problem: agents call tools directly

Most agent frameworks give the model a list of callable tools — `sendSlackMessage`, `deleteRecord`, `publishPost` — and the model decides when to call them. If your safety plan is "the system prompt tells it to ask first," you're trusting the model to police itself every single call. One malformed prompt, one injected instruction from a fetched web page, and the tool runs unreviewed.

The fix isn't a smarter prompt. It's removing the model's ability to call the real tool at all, and replacing it with one that can only ever run after a human has approved.

---

## The wrapper pattern

Instead of registering `sendSlackMessage` as a tool, register `withApproval(sendSlackMessage, { kind: "slack.send" })`. The wrapper:

1. Takes the original arguments, builds an Impri action with a human-readable preview.
2. Pushes the action and waits for a decision.
3. Only if `status === "approved"` does it call the wrapped function — with the human-edited `final_preview`, not the model's original draft.
4. Reports the result back to Impri.

The model never holds a reference to the real `sendSlackMessage`. That's what makes this a genuine chokepoint rather than a suggestion.

```typescript
// approval-wrapper.ts
type ToolFn<Args, Result> = (args: Args) => Promise<Result>;

interface ApprovalOptions {
  kind: string;
  titleFor: (args: any) => string;
  previewFor: (args: any) => string;
  expiresInS?: number;
}

const BASE = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function pollUntilDecided(actionId: string, intervalMs = 8000) {
  while (true) {
    const res = await fetch(`${BASE}/v1/actions/${actionId}`, { headers: HEADERS });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function withApproval<Args, Result>(
  execute: ToolFn<Args, Result>,
  opts: ApprovalOptions
): ToolFn<Args, Result | { skipped: "rejected" | "expired" }> {
  return async (args: Args) => {
    const created = await fetch(`${BASE}/v1/actions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: opts.kind,
        title: opts.titleFor(args),
        preview: { format: "markdown", body: opts.previewFor(args) },
        expires_in: opts.expiresInS ?? 86400,
        editable: ["preview.body"],
      }),
    }).then((r) => r.json());

    const decision = await pollUntilDecided(created.id);

    if (decision.status !== "approved") {
      return { skipped: decision.status as "rejected" | "expired" };
    }

    // Note: final_preview.body carries any human edits — pass it through,
    // not the model's original args, if the tool's payload came from the draft.
    const result = await execute({ ...args, body: decision.decision.final_preview.body } as Args);

    await fetch(`${BASE}/v1/actions/${created.id}/result`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ status: "executed" }),
    });

    return result;
  };
}
```

Registering it with the agent is a one-line swap:

```typescript
const gatedSendSlackMessage = withApproval(sendSlackMessage, {
  kind: "slack.send",
  titleFor: (a) => `Slack message to #${a.channel}`,
  previewFor: (a) => a.body,
});

agent.registerTool("send_slack_message", gatedSendSlackMessage);
// sendSlackMessage itself is never registered or exposed to the model
```

---

## Why the wrapper — not the prompt — is the chokepoint

The distinction matters: a prompt instruction is advice the model can ignore, forget after a few turns, or be talked past by adversarial input in a tool result. A wrapper is a data dependency — `execute()` inside `withApproval` is a closure the model has no reference to and cannot call directly, because `send_slack_message` in the tool registry *is* the wrapper. There's no code path from "model decides to send" to "message goes out" that skips the `decision.status !== "approved"` check.

This only holds if it's true end to end. If the agent also has raw Slack API credentials in its environment and a generic `runShellCommand` tool, it can route around the wrapper entirely. The wrapper is a real gate only when it's the tool's *one* path to the side effect — see the chokepoint discussion in [the main approval guide](how-to-add-human-approval-to-an-ai-agent.md).

---

## Handling multiple tools with one wrapper factory

For agents with several gated actions, define one config array and generate wrappers in a loop rather than repeating the `withApproval` call by hand:

```typescript
const gatedTools = [
  { fn: sendSlackMessage, kind: "slack.send", name: "send_slack_message" },
  { fn: publishBlogPost, kind: "blog.publish", name: "publish_blog_post" },
].map(({ fn, kind, name }) => ({
  name,
  fn: withApproval(fn, { kind, titleFor: (a) => a.title ?? name, previewFor: (a) => a.body }),
}));

gatedTools.forEach(({ name, fn }) => agent.registerTool(name, fn));
```

---

## What this doesn't protect against

The wrapper gates *this* tool call. It does not sandbox the agent's environment, inspect the content for policy violations, or stop a model from constructing a misleading title/preview pair that a rushed human approves without reading closely. Keep preview text honest and specific — see [integrations](integrations.md) for framework-specific wrapping patterns (LangChain, Claude Agent SDK) and the [TypeScript SDK](sdk-typescript.md) if you'd rather not hand-roll the fetch calls above.

## Next step

Start from [quickstart](quickstart.md) to get an API key, then adapt the wrapper above to your framework's tool-registration API.
