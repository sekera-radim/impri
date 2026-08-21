# Blocking vs Polling for Human Approval in Agents

Blocking waits inline for a decision; polling re-checks from outside. Here's how to pick between them when gating an AI agent's actions with a human.

---

## Two ways to wait for the same thing

Every human-in-the-loop integration eventually asks the same question: after the agent proposes an action, how does it find out what the human decided? There are exactly two shapes for that:

- **Blocking** — the agent's process stays alive and waits, synchronously, until the decision arrives.
- **Polling from outside** — the agent's process exits or suspends, and something else re-invokes it later to check.

Both call the same underlying API. The difference is entirely about what your runtime can afford to do while it waits.

---

## Blocking: fine when your process can sit idle

If your agent runs as a long-lived worker — a Node process, a container, a Claude Code session — blocking is simpler and reads better. Over MCP, this is a single call:

```typescript
// Long-running worker: the process can afford to wait.
import { callTool } from "@impri/mcp-client"; // illustrative — use your MCP client

async function proposeAndWait(prUrl: string) {
  const pushed = await callTool("impri_push_action", {
    kind: "pr.merge",
    title: `Merge PR: ${prUrl}`,
    preview: { format: "markdown", body: `Merging \`${prUrl}\` — all checks green.` },
    expires_in: 3600,
  });

  // Blocks this call for up to an hour. Nothing else runs on this worker meanwhile.
  const decision = await callTool("impri_await_decision", {
    action_id: pushed.action_id,
    timeout_s: 3600,
  });

  if (decision.status !== "approved") return { merged: false, reason: decision.status };

  await mergePullRequest(prUrl); // your actual merge call
  await callTool("impri_report_result", { action_id: pushed.action_id, status: "executed" });
  return { merged: true };
}
```

`impri_await_decision` polls the REST API every 5 seconds internally — you don't write that loop yourself. The tradeoff is that the worker's memory footprint is held for the entire wait, which is a non-issue for a background worker and a real problem for anything billed per invocation.

---

## Polling from outside: required when your runtime can't block

A serverless function (Lambda, a Vercel/Cloudflare edge function, a cron-triggered job) gets billed for wall-clock time and often has a hard execution ceiling well under an hour. Blocking for a human to check their phone is not an option. Here the "wait" has to happen between invocations, not inside one:

```typescript
// Invocation 1 — propose, then exit immediately. No blocking.
export async function proposeHandler(req: Request) {
  const res = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "social.post",
      title: "Publish scheduled tweet",
      preview: { format: "plain", body: req.draftText },
      expires_in: 21600, // 6h — matches how often the cron re-checks
    }),
  });
  const { id } = await res.json();
  await saveActionIdToQueue(id); // your own durable store, not Impri's
  return new Response("queued");
}

// Invocation 2..N — a cron trigger, re-run every few minutes, checks and exits again.
export async function checkHandler() {
  for (const id of await loadPendingActionIds()) {
    const r = await fetch(`https://api.impri.dev/v1/actions/${id}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    });
    const action = await r.json();
    if (action.status === "pending") continue; // still waiting, do nothing this run

    if (action.status === "approved") {
      await publishTweet(action.decision.final_preview.body);
      await fetch(`https://api.impri.dev/v1/actions/${id}/result`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "executed" }),
      });
    }
    await removeFromQueue(id);
  }
}
```

Each invocation is short and stateless. The "wait" lives in the cron schedule, not in held compute.

---

## Comparison

| | Blocking (MCP `impri_await_decision`) | Polling from outside (cron/queue) |
|---|---|---|
| Best for | Long-lived workers, Claude Code / Claude Desktop agents | Serverless functions, billed-per-invocation runtimes |
| Compute cost while waiting | Held for the full wait | Near zero between checks |
| Code complexity | One call | Two handlers + a durable queue you own |
| Latency to react | ~5s (internal poll interval) | Bounded by your cron interval |
| Needs its own storage | No | Yes — you track pending action IDs yourself |

---

## The one thing that doesn't change

Whichever shape you pick, the gate itself is identical: execution code only runs after `GET /v1/actions/:id` reports `status: "approved"`, and you always execute `decision.final_preview`, not the original draft, since that's the field that carries a human's edits. Blocking vs. polling is purely an implementation detail of *how* you observe that status change — it has no bearing on how strong the gate is. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full three-call pattern both approaches build on.

---

## Next step

If you're wiring this into a webhook-driven pipeline rather than polling on a timer, [webhooks](webhooks.md) covers push-based notification instead. For the TypeScript client used above, see [sdk-typescript](sdk-typescript.md).
