# Claude Agent SDK Integration

The `integrations/claude-agent-sdk/` package provides a TypeScript integration for adding human-approval gates to Claude-powered agents built with the Anthropic SDK (`@anthropic-ai/sdk`).

It works by intercepting `tool_use` content blocks before they are executed — the agent proposes a tool call, a human approves or rejects it in the Impri inbox, and only then is the tool executor called.

---

## How it works

1. You define a tool normally with an Anthropic-compatible schema (`AnthropicTool`).
2. You wrap it with `withImpriApproval(...)` to get a `GatedTool`.
3. Pass `gatedTool.toolDef` to Claude — it is identical to the original, so Claude behaves normally.
4. In your agent loop, when Claude returns a `tool_use` block for this tool, call `gatedTool.handle(block)` instead of executing directly.
5. `handle()` submits the proposed call to Impri, blocks until a human decides, then either executes or returns a rejection message.
6. The return value of `handle()` is the `tool_result` content to feed back to Claude.

---

## Installation

```bash
# From the repo root
npm install ./integrations/claude-agent-sdk
```

---

## Quick start

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { ImpriClient } from '@impri/sdk'
import { withImpriApproval } from '@impri/claude-agent-sdk'

const anthropic = new Anthropic()
const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! })

// Define the gated tool
const sendEmailGated = withImpriApproval({
  // Tool definition — passed to Claude unchanged
  toolDef: {
    name: 'send_email',
    description: 'Send an email to a recipient.',
    input_schema: {
      type: 'object',
      properties: {
        to:   { type: 'string', description: 'Recipient email address' },
        body: { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'body'],
    },
  },

  // What to actually do after approval
  execute: async ({ to, body }) => {
    await emailService.send({ to: String(to), body: String(body) })
    return `Email sent to ${to}.`
  },

  // Impri configuration
  impriClient: impri,
  kind: 'email.send',

  // What the human sees in the approval inbox
  title: ({ to }) => `Send email to ${to}`,
  preview: ({ body }) => ({ format: 'plain', body: String(body) }),

  // Allow the reviewer to edit the body before approving
  editable: ['preview.body'],

  // Optional: custom rejection handler
  onRejected: (err) => `Email rejected by reviewer (action ${err.actionId}). Stopping.`,
})

// Agent loop
async function runAgent(userMessage: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      tools: [sendEmailGated.toolDef],  // pass the toolDef to Claude
      messages,
    })

    // Accumulate assistant response
    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') break

    // Process tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'send_email') {
        // handle() submits to Impri, waits for human approval, then executes
        const result = await sendEmailGated.handle(block)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults })
    }
  }
}
```

---

## API reference

### `withImpriApproval(options)` → `GatedTool`

Creates a gated tool wrapper.

#### Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `toolDef` | `AnthropicTool` | Yes | Standard Anthropic tool definition — passed to Claude unchanged |
| `execute` | `(input) => Promise<T>` | Yes | Executor called after approval; receives the (possibly human-edited) input |
| `impriClient` | `ImpriClient` | Yes | Initialized Impri client |
| `kind` | string | Yes | Action kind for the inbox (e.g. `"email.send"`, `"db.exec"`) |
| `title` | string or `(input) => string` | Yes | Title shown in the approval inbox; may be a static string or a function of the tool input |
| `preview` | `Preview` or `(input) => Preview` | No | Preview content shown to the reviewer; defaults to a plain-text JSON dump of the full input |
| `editable` | string[] | No | Dot-path fields the reviewer may modify before approving (e.g. `["preview.body"]`) |
| `timeoutS` | number | No | Approval timeout in seconds (default 300) |
| `onRejected` | `(err: ImpriRejected) => string` | No | Called when the human rejects; return value is sent back to Claude as the tool result |

#### Returns: `GatedTool`

| Field | Type | Description |
|-------|------|-------------|
| `toolDef` | `AnthropicTool` | The original tool definition — pass to `client.messages.create({ tools: [...] })` |
| `handle` | `(block: ToolUseBlock) => Promise<string>` | Call for each `tool_use` block of this tool |
| `execute` | `ToolExecutor` | The underlying executor (for testing or manual invocation) |

### `handle(block)` details

`handle()` performs these steps in order:

1. Resolves `title` and `preview` (calling them as functions if needed).
2. Calls `impriClient.createAction(...)` with the resolved title, preview, and the full tool input as `payload`.
3. Waits for a human decision via `impriClient.awaitDecision(...)`.
4. If **approved**: calls `execute()` with the (possibly human-edited) input. If the reviewer changed `preview.body` and the tool input has a `body` field, the edited body replaces the original.
5. Reports the result to Impri (`reportResult("executed")` or `reportResult("execute_failed", { detail })`).
6. Returns the execution output as a string.
7. If **rejected**: calls `onRejected()` and returns its output without calling `execute()`.

Errors from `ImpriTimeout` or `ImpriExpired` propagate to the caller.

---

## `makeToolResult` helper

Convenience function to construct an Anthropic `tool_result` message param:

```typescript
import { makeToolResult } from '@impri/claude-agent-sdk'

const toolResult = makeToolResult(block.id, 'Email sent successfully.')
// { type: 'tool_result', tool_use_id: 'toolu_...', content: 'Email sent successfully.' }
```

For errors:

```typescript
const toolResult = makeToolResult(block.id, 'Permission denied.', true)
// { type: 'tool_result', tool_use_id: '...', content: '...', is_error: true }
```

---

## Multiple gated tools

```typescript
const tools = [sendEmailGated, deployGated, sqlGated]

// In your agent loop:
for (const block of response.content) {
  if (block.type !== 'tool_use') continue
  const gated = tools.find(t => t.toolDef.name === block.name)
  if (gated) {
    const result = await gated.handle(block)
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
  }
}
```

---

## Edit-before-approve

When `editable: ['preview.body']` is set and the reviewer changes the preview body before approving, the edited content is automatically injected into the tool's `input` for execution.

Specifically: if `input.body` exists and the reviewer changed `preview.body`, the `execute()` function receives `{ ...input, body: editedBody }`. For other field layouts, read the `finalPreview` directly from `approvalGate` instead.

---

## Security notes on untrusted content

If an action's `payload.untrusted` is `true` (e.g. from a watcher-triage flow), do not forward the preview body as an instruction to Claude. The `withImpriApproval` wrapper does not apply the `<untrusted-external-content>` tag that the MCP server uses — in the Claude Agent SDK integration, you are responsible for wrapping untrusted content before forwarding it in the `tool_result`.

Check `action.is_untrusted` (from `awaitDecision`) before treating the preview body as trusted data.
