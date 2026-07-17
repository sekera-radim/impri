# Human Approval for the Vercel AI SDK

Gate risky tool calls in the Vercel AI SDK behind human approval — pause execution until a reviewer approves, edits, or rejects the draft first.

---

## Where the gate belongs

The `ai` package runs tools as plain async functions passed to `generateText` or `streamText`. Most tools are safe to let run unattended — a lookup, a read-only API call. A smaller set reach into the world in ways you cannot take back: issuing a refund, sending an email, posting to a customer. Those are the ones worth pausing on.

There is no special SDK feature needed for this. A tool's `execute` function can `await` anything, including a call that blocks on a human decision. As long as the side effect happens inside `execute` — not before it — the tool call itself becomes the gate.

---

## Scenario: refunds from a support inbox

A support-triage agent reads incoming tickets and, when a customer clearly deserves one, issues a Stripe refund. Refunds are exactly the kind of action you don't want an LLM approving on its own: wrong charge ID, wrong amount, or a customer who talked the model into a refund it shouldn't have granted are all real failure modes.

```typescript
import { generateText, tool, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'
import Stripe from 'stripe'

const IMPRI_API_KEY = process.env.IMPRI_API_KEY!
const IMPRI_BASE = 'https://api.impri.dev'
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

async function pushAndAwait(kind: string, title: string, body: string) {
  const created = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${IMPRI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind,
      title,
      preview: { format: 'markdown', body },
      expires_in: 3600,
      editable: ['preview.body'],
    }),
  }).then((r) => r.json())

  while (true) {
    const poll = await fetch(`${IMPRI_BASE}/v1/actions/${created.id}`, {
      headers: { Authorization: `Bearer ${IMPRI_API_KEY}` },
    }).then((r) => r.json())

    if (poll.status !== 'pending') return { actionId: created.id, poll }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
}

const issueRefund = tool({
  description: 'Propose a Stripe refund for a customer. Requires human approval before it is issued.',
  inputSchema: z.object({
    chargeId: z.string(),
    amountCents: z.number(),
    reason: z.string(),
  }),
  execute: async ({ chargeId, amountCents, reason }) => {
    const preview = `**Charge:** \`${chargeId}\`\n**Amount:** $${(amountCents / 100).toFixed(2)}\n\n${reason}`
    const { actionId, poll } = await pushAndAwait(
      'stripe.refund.create',
      `Refund $${(amountCents / 100).toFixed(2)} — ${chargeId}`,
      preview,
    )

    if (poll.status !== 'approved') {
      return { issued: false, reason: `Not approved — status was "${poll.status}".` }
    }

    // decision.final_preview carries any edits the reviewer made to the reason/amount note
    const refund = await stripe.refunds.create({ charge: chargeId, amount: amountCents })

    await fetch(`${IMPRI_BASE}/v1/actions/${actionId}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${IMPRI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'executed' }),
    })

    return { issued: true, refundId: refund.id }
  },
})

const result = await generateText({
  model: openai('gpt-4.1'),
  system:
    'You handle refund requests from the support inbox. Use issueRefund for every refund — never tell the customer a refund was issued unless the tool result has issued: true.',
  prompt: 'Charge ch_1PxYz: item arrived broken, customer wants a full refund of $42.00.',
  tools: { issueRefund },
  stopWhen: stepCountIs(5),
})

console.log(result.text)
```

---

## What actually blocks execution

`generateText` awaits each tool's `execute` function before it can use the result to continue the conversation. Inside `issueRefund`, `pushAndAwait` polls `GET /v1/actions/:id` until the status leaves `pending` — the function does not return, so the model has no tool result to reason about and `stripe.refunds.create` is never reached, until a human decides. Reject or let it expire and the `if (poll.status !== 'approved')` branch returns early; the refund call is skipped entirely.

This only holds as long as `issueRefund` is the agent's sole path to `stripe.refunds.create`. If another tool or a direct Stripe key elsewhere in your codebase can also trigger a refund, the gate only covers the path that goes through it.

---

## Multi-step loops and `stopWhen`

`stopWhen: stepCountIs(5)` caps how many tool-call rounds the model can take in one `generateText` call. Each poll inside `execute` can take anywhere from seconds to the full `expires_in` window, so a single gated tool call can dominate the run's wall-clock time — that's expected, not a bug. If the agent runs inside a request handler with its own timeout (a Vercel serverless function, for instance), a long-pending approval will hit that timeout before Impri's. For approvals that can sit for hours, run the agent from a durable worker or queue consumer instead of an HTTP handler, so the wait doesn't get killed by an unrelated timeout.

---

## Next step

- [Quickstart](quickstart.md) — get an API key and push your first action
- [TypeScript SDK](sdk-typescript.md) — a typed client instead of raw `fetch` calls
- [How to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) — the underlying push → poll → execute pattern this page builds on
