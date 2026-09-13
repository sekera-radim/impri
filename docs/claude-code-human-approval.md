# Add human approval to Claude Code with Impri

Give Claude Code a way to pause on risky actions — a deploy, an email, a database write, a payment — and wait for your yes before it proceeds with any of them.

## 60-second install

```bash
claude mcp add impri \
  -e IMPRI_API_KEY=im_your_key_here \
  -e IMPRI_BASE_URL=https://api.impri.dev \
  -- npx @impri/mcp
```

`IMPRI_BASE_URL` defaults to `http://localhost:8484` (self-hosted), so it must be set explicitly for the cloud API — leave it out only if you're actually running `docker compose up -d` locally.

Get an API key at [impri.dev](https://impri.dev), or self-host with `docker compose up -d` (see [self-hosting](self-hosting.md)). Verify it loaded:

```
/mcp
```

You should see `impri` listed with 8 tools.

## Tell Claude Code to use it

Add three lines to your project's `CLAUDE.md` (or a global `~/.claude/CLAUDE.md`):

```markdown
## Human approval
Before running any command with a real side effect — sending an email, pushing to a
remote branch, running a database write, calling a paid API — call impri_push_action
with a clear preview, then impri_await_decision before proceeding. Never skip this.
```

## What you see

A card lands in your Impri inbox (web, or pushed to Telegram/Slack/ntfy if you've set up a [notification channel](notifications.md)) with the action's title and preview, and Approve / Reject buttons. Approving a diff-style preview lets you edit the text before it goes back to the agent.

## Real example call

Claude Code calls the tool directly — no code required on your side:

```
impri_push_action({
  kind: "git.push",
  title: "Push branch fix/retry-backoff to origin",
  preview: { format: "diff", body: "3 files changed, 41 insertions(+), 6 deletions(-)" },
  editable: []
})
```

Response:

```json
{
  "action_id": "act_7g2k...",
  "status": "pending",
  "inbox_url": "https://app.impri.dev/inbox/act_7g2k..."
}
```

Claude Code then calls `impri_await_decision({ action_id: "act_7g2k...", timeout_s: 600 })` and blocks until you decide.

## Troubleshooting

- **`/mcp` doesn't list `impri`** — check `claude mcp list` for a startup error; the most common cause is a missing or malformed `IMPRI_API_KEY`.
- **Tool calls fail with "IMPRI_API_KEY is not set"** — the env var wasn't passed through; re-run the `claude mcp add` command with `-e IMPRI_API_KEY=...` rather than exporting it in the shell that starts Claude Code.
- **Self-hosted server unreachable** — confirm `IMPRI_BASE_URL` has no trailing `/v1` (the client appends it) and that `docker compose up -d` is actually running on that port.

## Next

[Try the human approval pattern](how-to-add-human-approval-to-an-ai-agent.md) end to end, or see it applied to a [coding-agent-specific use case](/use-cases/overnight-coding-agent).
