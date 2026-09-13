# Add human approval to Cursor with Impri

Have Cursor's agent mode pause on real-world side effects — a push, a deploy, a database write — and wait for a human decision from Impri's inbox.

## 60-second install

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["-y", "@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

Self-hosting instead of the cloud? Drop the `IMPRI_BASE_URL` line entirely — it defaults to `http://localhost:8484` — or point it at wherever your instance actually runs (see [self-hosting](self-hosting.md)). Get a cloud key at [impri.dev](https://impri.dev).

Reopen Cursor's MCP settings panel (Settings → MCP) and confirm `impri` shows a green dot with 8 tools listed.

## Tell Cursor's agent to use it

Add to your project's `.cursorrules` or Cursor's custom instructions:

```markdown
## Human approval
Before any action with a real side effect (send, deploy, delete, pay, publish), call
impri_push_action with a clear preview, then impri_await_decision before proceeding.
```

## What you see

Cursor keeps working while the action sits in your Impri inbox. You get the title and preview there, plus a push to Slack/Telegram/ntfy if you've wired one up — approve, reject, or edit the draft before Cursor's agent acts on it.

## Real example call

```
impri_push_action({
  kind: "content.publish",
  title: "Publish blog post: \"5 lessons from our Q3 outage\"",
  preview: { format: "markdown", body: "# 5 lessons from our Q3 outage\n\nOn August 14th..." },
  editable: ["preview.body"]
})
```

Response:

```json
{
  "action_id": "act_3kx0...",
  "status": "pending",
  "inbox_url": "https://app.impri.dev/inbox/act_3kx0..."
}
```

## Troubleshooting

- **`impri` doesn't appear in Cursor's MCP panel** — `.cursor/mcp.json` must be valid JSON; a trailing comma is the usual culprit. Check Cursor's MCP logs panel for the exact parse error.
- **Server shows connected but tool calls fail** — usually `IMPRI_API_KEY` is missing or wrong; the error message from the tool call itself will say so directly.
- **Works locally but not for teammates** — `.cursor/mcp.json` at the project root is typically gitignored (it may contain a key); share the file without the key and have each teammate fill in their own, or use a per-project scoped key.

## Next

[Read the full human approval pattern](how-to-add-human-approval-to-an-ai-agent.md), or see [letting a coding agent run overnight](/use-cases/overnight-coding-agent).
