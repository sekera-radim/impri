# How to get human approval into your coding agent

Every coding agent that can call MCP tools can be wired to pause on risky actions and wait for a human decision through Impri, with a one-line install per agent.

The pattern underneath is the same everywhere: the agent calls `impri_push_action` with a preview, then `impri_await_decision`, and only acts on `approved`.

Pick your agent:

- [Claude Code](claude-code-human-approval.md) — `claude mcp add impri -e IMPRI_API_KEY=... -e IMPRI_BASE_URL=https://api.impri.dev -- npx @impri/mcp`
- [OpenAI Codex](codex-human-approval.md) — `codex mcp add impri --env IMPRI_API_KEY=... --env IMPRI_BASE_URL=https://api.impri.dev -- npx -y @impri/mcp`
- [Cursor](cursor-human-approval.md) — `.cursor/mcp.json`
- [Windsurf](windsurf-human-approval.md) — `~/.codeium/windsurf/mcp_config.json`

Any other MCP-compatible client works the same way — see the [MCP server reference](mcp.md) for the full tool list and config shape, or the [/agents overview](/agents) for a side-by-side of all four.

## The pattern, in short

1. Get an API key at [impri.dev](https://impri.dev) or self-host with `docker compose up` (see [self-hosting](self-hosting.md)).
2. Register the `@impri/mcp` server with your agent's CLI or config file (links above) — set `IMPRI_BASE_URL` to `https://api.impri.dev` for the cloud, or leave it unset for self-hosted (it defaults to `http://localhost:8484`).
3. Add a short instruction to your agent's system prompt or rules file: before any action with a real side effect, call `impri_push_action`, then `impri_await_decision`, and only proceed on `approved`.
4. Decide from the web inbox at [app.impri.dev](https://app.impri.dev), or from your phone if you've set up [notifications](notifications.md) (Slack, Discord, Telegram, ntfy, or web push).

## Where to go deeper

- [The full human approval pattern](how-to-add-human-approval-to-an-ai-agent.md) — the propose → await → report loop in detail, with REST and MCP examples side by side.
- [Use cases](/use-cases) — concrete gates for overnight runs, database writes, outbound messages, deploys, refunds, and publishing.
- [MCP server reference](mcp.md) — all 8 tools, full input/output schemas.
