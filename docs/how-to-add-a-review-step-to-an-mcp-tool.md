# How to Add a Review Step to an MCP Tool

Wrap any MCP tool's execute handler so it pauses for a human decision before running — turning a one-shot agent action into a reviewable one.

---

## The problem: MCP tools execute the moment they're called

Model Context Protocol tools are designed to run as soon as the client invokes them. That's fine for a `read_file` or `search_docs` tool. It's a problem for a tool like `send_invoice`, `delete_repo_branch`, or `post_to_crm` — the MCP client (Claude Code, Claude Desktop, a custom agent runtime) calls the tool, the tool's `execute` function runs, and the side effect happens. There is no built-in pause in the protocol.

If you own the MCP server, you can add that pause yourself: wrap the tool's handler so it pushes an Impri action first and only calls the real handler after approval.

---

## Wrapping a tool handler

Say your MCP server exposes a `send_invoice` tool, implemented with the TypeScript MCP SDK. The unguarded version looks like this:

```typescript
server.tool(
  "send_invoice",
  { customerId: z.string(), amountCents: z.number() },
  async ({ customerId, amountCents }) => {
    await billingApi.sendInvoice(customerId, amountCents);
    return { content: [{ type: "text", text: "Invoice sent." }] };
  }
);
```

Add a gate by pushing an Impri action before the real call, and blocking on the decision:

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY });

server.tool(
  "send_invoice",
  { customerId: z.string(), amountCents: z.number() },
  async ({ customerId, amountCents }) => {
    const action = await impri.pushAction({
      kind: "invoice.send",
      title: `Send invoice: customer ${customerId}, $${amountCents / 100}`,
      preview: {
        format: "markdown",
        body: `Customer: ${customerId}\nAmount: $${amountCents / 100}`,
      },
      expires_in: 3600,
      idempotent: false,
    });

    const decision = await impri.awaitDecision(action.id, { timeoutS: 1800 });

    if (decision.status !== "approved") {
      return { content: [{ type: "text", text: `Not sent: ${decision.status}` }] };
    }

    await billingApi.sendInvoice(customerId, amountCents);
    await impri.reportResult(action.id, { status: "executed" });
    return { content: [{ type: "text", text: "Invoice sent after approval." }] };
  }
);
```

The `billingApi.sendInvoice` call only appears once, inside the `approved` branch. There is no code path where the tool executes without first getting back `status: "approved"` from Impri.

---

## Why wrap the handler instead of the agent's prompt

You could instead tell the agent in its system prompt "always ask before calling send_invoice." That relies on the model choosing to comply every time, and gives you no record of what was actually approved. Wrapping the handler moves the check into code the agent can't skip: the MCP client can only get a result back from `send_invoice` by going through the wrapped function, and that function's only path to `billingApi.sendInvoice` runs after the approval check.

This is the same chokepoint principle used for [any agent tool call](how-to-add-human-approval-to-an-ai-agent.md#how-this-actually-gates-execution) — it only holds if the wrapped tool is the *only* way the agent can reach `billingApi`. If the agent also has a raw API key and a generic HTTP tool, it can route around your wrapper. Keep the credential inside the MCP server process, not exposed to the model.

---

## Picking which tools to wrap

Not every tool in an MCP server needs a gate. A reasonable rule: wrap tools that produce an external, hard-to-reverse effect (sending, posting, deleting, charging), and leave read-only tools (`list_invoices`, `get_customer`) alone. Gating every tool call would make the agent unusable — the gate is for the moments a human genuinely needs to weigh in.

| Tool type | Wrap with Impri? |
|---|---|
| Read-only lookup (`get_customer`, `search_docs`) | No |
| Sends money, email, or a message externally | Yes |
| Deletes or overwrites a resource | Yes |
| Internal, reversible state change (draft save) | Usually no |

---

## Handling timeouts inside a long-running MCP session

`awaitDecision` blocks the tool call until a human responds or the timeout hits. If your MCP client has its own request timeout shorter than the approval wait, the client will see a stalled tool call before the human even sees the inbox notification. Two ways to avoid that:

- Set `timeout_s` in `awaitDecision` well under any client-side request timeout, and treat a timeout as "not yet decided" rather than "rejected" — check `GET /v1/actions/:id` later instead of re-pushing.
- For tools where the human might take hours, don't block synchronously at all: push the action, return an "awaiting approval, action id `act_xyz`" message to the agent, and let a follow-up tool call (or a webhook — see [webhooks](webhooks.md)) resolve it later.

For the full server setup — configuring `@impri/mcp` as a standalone process versus building the gate directly into your own server as shown above — see the [MCP integration guide](mcp.md). If your agent runs on the Claude Agent SDK rather than a raw MCP client, [the Claude Agent SDK guide](claude-agent-sdk.md) covers wrapping tool definitions the same way.

---

## Next step

Start with [the quickstart](quickstart.md) to get an API key, then wrap your first tool handler using the pattern above.
