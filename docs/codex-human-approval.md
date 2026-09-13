# Add human approval to OpenAI Codex with Impri

Wrap Codex's risky tool calls — deploys, database writes, outbound messages, refunds — behind an explicit human decision before any of them are allowed to run.

## 60-second install

```bash
codex mcp add impri \
  --env IMPRI_API_KEY=im_your_key_here \
  --env IMPRI_BASE_URL=https://api.impri.dev \
  -- npx -y @impri/mcp
```

`IMPRI_BASE_URL` defaults to `http://localhost:8484` (self-hosted) — set it explicitly for the cloud API as above, or drop it entirely if you're actually running `docker compose up -d` locally.

Get a key at [impri.dev](https://impri.dev) or self-host per [self-hosting](self-hosting.md). List configured servers with `codex mcp list` to confirm `impri` shows up with its 8 tools.

## Tell Codex to use it

Add to your `AGENTS.md` or system prompt:

```markdown
## Human approval
Before any action with a real side effect (send, deploy, delete, pay, publish), call
impri_push_action with a clear preview and impri_await_decision before proceeding.
Do not execute on rejection or timeout — report it and stop that step.
```

## What you see

The action appears in the Impri inbox with its title, preview, and a Approve/Reject/Edit control. If a [notification channel](notifications.md) is configured, you also get pushed a card in Slack, Discord, Telegram, or as a web push — so you don't have to keep a browser tab open while Codex runs.

## Real example call

```
impri_push_action({
  kind: "payment.refund",
  title: "Refund $84.00 to order #10432 — damaged item",
  preview: { format: "plain", body: "Order #10432, $84.00 full refund. Customer provided photos." },
  payload: { order_id: "10432", amount_cents: 8400, currency: "USD" },
  editable: ["payload.amount_cents"]
})
```

Response:

```json
{
  "action_id": "act_5jf8...",
  "status": "pending",
  "inbox_url": "https://app.impri.dev/inbox/act_5jf8..."
}
```

## Troubleshooting

- **`codex mcp add` accepted but tools never show up** — check the server started at all with `codex mcp list`; a missing `-- npx -y @impri/mcp` (note the `--` separator) is the most common typo.
- **`IMPRI_API_KEY is not set` at call time** — env vars passed with `--env` are per-server; confirm you didn't fat-finger the flag on a re-run and end up with two `impri` entries, one without the key.
- **Codex times out waiting on `impri_await_decision`** — that's expected if nobody has decided yet; the default is 5 minutes, pass a longer `timeout_s` for anything that should survive an overnight run.

## Next

[Read the full human approval pattern](how-to-add-human-approval-to-an-ai-agent.md), or see [gating refunds and payments](/use-cases/refunds-and-payments) end to end.
