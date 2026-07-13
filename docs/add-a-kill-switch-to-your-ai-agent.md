# Add a Kill Switch to Your AI Agent

A kill switch for your AI agent that actually holds: wrap every action tool in an Impri approval gate so reject or expiry stops the agent in its tracks.

---

## Why prompt-based stops don't hold

Telling an agent "pause and ask me before taking action" works sometimes. It relies on the model to choose to pause — a model that can also reason its way past the instruction, misread an ambiguous context, or be manipulated by injected text in content it processes.

A prompt instruction is a soft constraint. What you need for a reliable kill switch is a *hard constraint*: code that the agent cannot route around. Every execution path to a side effect must require an external approved signal, not just a model decision.

This is exactly what Impri gives you when you wire it correctly.

---

## The approval gate as a kill switch

The agent's action tools are where side effects happen — sending messages, calling APIs, posting content, making changes. If you wrap those tools so they cannot execute without an approved Impri decision, the pattern looks like this:

```
agent decides to take action
    │
    ├── calls your wrapped action tool
    │       │
    │       ├── POST /v1/actions  →  Impri stores it, you are notified
    │       ├── polls for decision
    │       │
    │       ├─[approved]─  proceeds, executes with final_preview content
    │       └─[rejected / expired]─  throws, agent receives an error
    │
    └── agent handles the error (logs, reports, stops)
```

Rejecting any pending action stops the current step. If the agent has no other path to the side effect, it stalls. That stall is your kill switch.

---

## Wrapping an action tool (TypeScript)

Here is a small wrapper that turns a bare "post Slack message" function into a gated one. The agent calls `sendSlackMessage` — the wrapper adds the approval step, and the underlying Slack credential never reaches the agent's context.

```typescript
import fetch from "node-fetch";

const API_BASE = "https://api.impri.dev";
const HEADERS = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function awaitDecision(
  actionId: string,
  timeoutMs: number
): Promise<{ status: string; body: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/v1/actions/${actionId}`, { headers: HEADERS });
    const data = (await res.json()) as any;
    if (data.status !== "pending") {
      return {
        status: data.status,
        body: data.decision?.final_preview?.body ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 5000)); // poll every 5 s
  }
  return { status: "timeout", body: null };
}

// This is what the agent calls — it cannot reach postToSlack any other way
export async function sendSlackMessage(channel: string, draft: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      kind: "slack.message",
      title: `Slack → #${channel}`,
      preview: { format: "markdown", body: draft },
      expires_in: 900,            // 15-minute window per action
      editable: ["preview.body"],
    }),
  });
  const action = (await res.json()) as any;
  console.log(`Action queued: ${action.inbox_url}`);

  const decision = await awaitDecision(action.id, 900_000);

  if (decision.status !== "approved") {
    // This throw is the kill switch: agent cannot proceed past this point
    throw new Error(`Action ${action.id} ${decision.status} — message not sent`);
  }

  // Only reachable after approval — final_preview carries any human edits
  await postToSlack(channel, decision.body!);

  await fetch(`${API_BASE}/v1/actions/${action.id}/result`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ status: "executed" }),
  });
}

// Real Slack credential lives here only — not in the agent's context
async function postToSlack(channel: string, text: string): Promise<void> {
  // your Slack API call here
}
```

The critical structural property: `postToSlack` is only reachable through `sendSlackMessage`, and `sendSlackMessage` cannot return successfully without an approved decision. Strip the agent of any direct Slack credential and this wrapper becomes a genuine chokepoint.

---

## What reject and expiry do

| Event | Agent sees | Side effect fires? |
|---|---|---|
| You reject | `awaitDecision` returns `rejected`, wrapper throws | No |
| Window expires (15 min in the example) | `timeout` or `expired`, wrapper throws | No |
| No response from you at all | Expiry kicks in automatically | No |
| You approve as-is | `approved`, execution proceeds with original draft | Yes |
| You approve after editing | `approved`, execution proceeds with your edits | Yes (your version) |

Short `expires_in` values (900–3600 seconds) work well for autonomous agents. They bound how long the agent can queue work without attention and automatically stall the agent if you stop responding — no explicit revoke action needed.

---

## Limitations: what this does not cover

Impri is a chokepoint you confine the agent to, not a network-level firewall. The wrapping only holds when the agent has no other path to the side effect. Specifically:

- If the agent also has the raw Slack token in its context, it can call Slack directly and bypass the wrapper.
- If other tools in the agent's toolkit can achieve the same effect (a different messaging integration, a webhook call, etc.), those also need the same treatment.
- Impri does not intercept egress traffic. It is a data-dependency gate: the execution code can only reach the side-effect call through a branch that requires an approved response.

The practical setup: give the agent API keys only for your Impri-wrapped tools, never for the underlying services directly. The wrapper holds the real credentials; the agent context does not.

---

## Configuring notifications so you catch the signal

A kill switch only works if you see the pending action. For autonomous agents pushing actions at arbitrary times, configure a push notification channel so your phone buzzes when something needs your attention:

- [Telegram approval](telegram-approval.md) — one-tap approve/reject from a Telegram bot message
- [Slack approval](slack-approval.md) — approve from Slack with an interactive button
- [Notifications](notifications.md) — email and web push as a fallback

---

## Next steps

- [Quickstart](quickstart.md) — issue your first API key and push a test action
- [MCP server](mcp.md) — if your agent runs inside Claude Code or another MCP client, the `impri_push_action` and `impri_await_decision` tools wrap this same pattern without any HTTP code
- [Webhooks](webhooks.md) — receive a push notification on decision instead of polling, if your infrastructure supports inbound HTTP
