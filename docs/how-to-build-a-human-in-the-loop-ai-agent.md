# How to Build a Human-in-the-Loop AI Agent

A beginner's walkthrough of building an AI agent with a real human approval gate — propose an action, pause for a human decision, then execute only if approved.

---

## What "human in the loop" actually means

The phrase gets used loosely. For this guide it means one specific thing: **the agent cannot execute a side effect without an external, human-controlled data dependency being resolved first.**

That is different from asking the model to "check with the user before sending." A prompt instruction can be talked past; a data dependency cannot. If the agent's posting function requires an approved action ID before it runs, and the only way to get that ID approved is through a human clicking a button, the gate is real.

What Impri provides is exactly that data dependency: you push a proposed action, Impri holds it, a human decides, and your agent gets back `status: "approved"` or `status: "rejected"`. Execution code that only runs on `"approved"` cannot be bypassed by prompt injection or model drift.

---

## What you need

- An [Impri API key](api-keys.md) with `actions` scope
- An agent that performs some external action (post, send, publish, modify)
- A way to receive notifications — email is on by default; see [notifications](notifications.md) to add Slack, Telegram, or mobile push

No SDK required. Any HTTP client works. The examples below use TypeScript with native `fetch`.

---

## The three-step loop

Every human-in-the-loop agent built on Impri follows the same structure:

```
1. propose   →  POST /v1/actions          (agent → Impri)
2. wait       →  GET  /v1/actions/:id      (agent polls; human decides in inbox/Slack/Telegram)
3. execute    →  run your side effect      (only if approved)
              →  POST /v1/actions/:id/result  (close the audit record)
```

That loop can run inside any agent framework — plain Node.js, LangChain, Claude agent SDK, a cron script, or a Fastify webhook handler.

---

## Full walkthrough: a content publishing agent

Here is a complete TypeScript example. The agent generates a blog post summary and asks for approval before publishing it to an external CMS.

```typescript
const IMPRI_KEY = process.env.IMPRI_API_KEY!;
const IMPRI_BASE = "https://api.impri.dev";

async function impriPost(path: string, body: object): Promise<Response> {
  return fetch(`${IMPRI_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function impriGet(path: string): Promise<Response> {
  return fetch(`${IMPRI_BASE}${path}`, {
    headers: { Authorization: `Bearer ${IMPRI_KEY}` },
  });
}

type Proposal = {
  actionId: string;
  status: "approved" | "rejected" | "expired";
  final_preview?: { body: string };
};

async function proposePublication(
  title: string,
  summary: string
): Promise<Proposal> {
  // Step 1: Push the proposed action
  const push = await impriPost("/v1/actions", {
    kind: "blog.publish",
    title,
    preview: { format: "markdown", body: summary },
    expires_in: 86400,          // 24 hours to approve
    editable: ["preview.body"], // reviewer can refine the summary before approving
  });

  if (!push.ok) throw new Error(`Failed to push action: ${push.status}`);
  const { id: actionId } = await push.json();
  console.log(`Proposed action ${actionId} — waiting for human review`);

  // Step 2: Poll until the human decides
  while (true) {
    await new Promise((r) => setTimeout(r, 10_000)); // 10-second poll interval

    const poll = await impriGet(`/v1/actions/${actionId}`);
    const result = await poll.json();

    if (result.status !== "pending") {
      console.log(`Decision received: ${result.status}`);
      return {
        actionId,
        status: result.status,
        final_preview: result.decision?.final_preview,
      };
    }
  }
}

async function publishToCMS(content: string): Promise<void> {
  // your CMS API call goes here
  console.log("Publishing:", content);
}

async function runPublishingAgent(title: string, draft: string): Promise<void> {
  const { actionId, status, final_preview } = await proposePublication(title, draft);

  if (status !== "approved") {
    console.log("Skipping — not approved.");
    return;
  }

  // Use final_preview.body — it may contain edits the reviewer made before approving
  const contentToPublish = final_preview!.body;

  try {
    await publishToCMS(contentToPublish);

    // Step 3: Report success back to Impri
    await impriPost(`/v1/actions/${actionId}/result`, { status: "executed" });
  } catch (err) {
    await impriPost(`/v1/actions/${actionId}/result`, {
      status: "execute_failed",
    });
    throw err;
  }
}

// Entry point
await runPublishingAgent(
  "Post: What we shipped in June",
  "June was a busy month. We shipped four new features..."
);
```

Walk through what happens:

1. The agent calls `proposePublication`. Impri stores the draft and sends you a notification.
2. The poll loop runs every 10 seconds. Your agent process keeps running but does nothing until you decide.
3. If you approve in the Impri inbox (or Slack/Telegram if configured), `result.status` becomes `"approved"` and the loop exits.
4. `final_preview.body` holds whatever you typed if you edited the draft before approving. Always use this — not the original `draft`.
5. A `"rejected"` or `"expired"` decision returns early without touching the CMS.
6. The final `POST /v1/actions/:id/result` closes the audit record, recording whether execution succeeded.

---

## Making the gate binding

The gate is only as strong as the code path you design. Two things break it:

**Leaving the raw credential accessible.** If your agent holds the CMS API key and could call the CMS directly (not through `publishToCMS` which is gated on approval), then the gate is advisory, not enforced. Wrap the target action so the only call site is inside the approval-guarded branch.

**Treating "approved" status as a hint rather than a condition.** The code above only reaches `publishToCMS` if `decision.status === "approved"`. Keep it that way. Do not add a fallback path that skips approval under any condition.

---

## Handling expiry and rejection

Set `expires_in` to match how long the action remains relevant. A social post expires faster than a database migration. When the deadline passes, the status becomes `"expired"` and cannot be approved. Treat `"expired"` the same as `"rejected"` — do not execute.

```typescript
if (decision.status === "expired") {
  console.log("Action expired before review — consider a shorter deadline or alerting sooner.");
  return;
}
```

---

## Next steps

- Run the [quickstart](quickstart.md) to push your first action in under five minutes
- Add Slack, Telegram, or mobile push so approval requests reach you wherever you work: [notifications](notifications.md)
- For the MCP-based flow — where a Claude agent calls `impri_push_action` as a tool rather than making raw HTTP calls — see the [MCP server docs](mcp.md)
- For a deeper look at the push → approve → execute pattern, including the REST examples in shell and the `editable` field semantics, see [How to Add Human Approval to an AI Agent](how-to-add-human-approval-to-an-ai-agent.md)
