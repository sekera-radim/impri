# A Self-Hosted Approval Inbox for AI Agents

Run your own approval inbox for AI agents — Impri's MIT core is self-hostable in minutes, with the same REST API and MCP server as the cloud.

---

## Why run it yourself

The cloud at impri.dev is the fastest way to get started. But there are reasons to prefer running Impri on your own infrastructure:

**Data stays internal.** Every action pushed to Impri includes the draft content your agent produced — an email body, a database query, a file to be modified. For agents working with internal documents, customer records, or anything under compliance review, you may not want that content leaving your network at all.

**No per-seat or per-action cost at scale.** If you run a high-volume agent loop that produces hundreds of approval requests per day, self-hosting removes that ceiling.

**Integration with internal tooling.** Running on-prem means you can put Impri behind your VPN, use your own SSO, and configure notification channels that point to internal Slack or ntfy instances.

Impri is open-core: the server that handles the approval inbox, the REST API, the MCP server, and the web UI is MIT-licensed and available at [github.com/sekera-radim/impri](https://github.com/sekera-radim/impri). The hosted version at impri.dev runs the same code with managed infrastructure on top.

---

## Running the server

The server is distributed as a Docker image. A single container handles the REST API and the web inbox.

```bash
docker run -d \
  --name impri \
  --restart unless-stopped \
  -p 8484:8484 \
  -v impri_data:/data \
  -e SECRET_KEY=$(openssl rand -hex 32) \
  ghcr.io/sekera-radim/impri:latest
```

The server starts on port 8484. The `/data` volume persists actions, decisions, and audit records across container restarts. `SECRET_KEY` signs sessions — generate once and store it somewhere safe (not in the command history for production use).

After the container is running, open `http://localhost:8484` to create your first API key via the web UI. You'll use that key in the `Authorization: Bearer im_...` header the same way you would with the cloud.

For a compose file, reverse proxy config, and production hardening notes, see [self-hosting](self-hosting.md).

---

## Pointing your agents at the local instance

Wherever you set `IMPRI_BASE_URL`, switch it to your instance's address. The rest of the API is identical.

**MCP server** (Claude Code, Claude Desktop, or any MCP client):

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_local_key",
        "IMPRI_BASE_URL": "http://localhost:8484"
      }
    }
  }
}
```

The MCP server reads `IMPRI_BASE_URL` and routes all tool calls — `impri_push_action`, `impri_await_decision`, `impri_report_result` — to your instance instead of the cloud. No code changes needed in the agent.

**REST directly** — useful for testing that the instance is up and accepting requests:

```bash
# Verify connectivity
curl http://localhost:8484/v1/actions \
  -H "Authorization: Bearer im_your_local_key"

# Push a test action — here an internal database migration awaiting sign-off
curl -X POST http://localhost:8484/v1/actions \
  -H "Authorization: Bearer im_your_local_key" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "db.migration",
    "title": "Run migration: add_user_preferences_table",
    "preview": {
      "format": "markdown",
      "body": "```sql\nALTER TABLE users ADD COLUMN preferences JSONB;\nCREATE INDEX idx_user_preferences ON users(id)\n  WHERE preferences IS NOT NULL;\n```"
    },
    "expires_in": 3600,
    "editable": []
  }'
```

The response is `{ id, status: "pending", inbox_url }` — the same shape as the cloud. Poll `GET /v1/actions/:id` until `status` is no longer `"pending"`, then execute only on `"approved"`.

---

## What you get vs. the cloud

| Capability | Self-hosted (MIT core) | Cloud (impri.dev) |
|---|---|---|
| REST API (`/v1/actions`) | Yes | Yes |
| MCP server (`@impri/mcp`) | Yes | Yes |
| Web inbox | Yes | Yes |
| Audit log | Yes | Yes |
| Notifications (email, ntfy, web push) | Yes — configure your own SMTP/ntfy | Managed |
| Slack / Telegram / Discord approval | Yes | Yes |
| Infrastructure management | You | Managed |
| Uptime SLA | Your infra | Covered |

The split is operational, not functional. A self-hosted instance accepts the same requests, stores decisions in the same schema, and exposes the same inbox UI. You configure your own notification channels — see [notifications](notifications.md) for the available options.

---

## Honesty about what Impri is and is not

Running Impri yourself doesn't change what it does. It stores the proposed action, notifies the designated human, and holds the decision. It does not interpret what the agent is doing, does not generate or modify content, and does not execute anything.

The gate is real only when the agent's path to the side effect runs through the Impri response. If you run the server behind your firewall but your agent also holds direct credentials to the target system, the gate does not enforce anything — it just records what was proposed.

Impri is a focused tool: one human, one decision, one proposed action at a time. It is not a workflow engine with branching or scheduling (look at n8n or Temporal for those), and it is not an agent-to-agent coordination layer. You can embed it as one step inside a larger workflow. For compliance-sensitive environments, pair it with [audit-log](audit-log.md) to export decision records.

---

## Next step

Follow the [self-hosting](self-hosting.md) guide for compose file, reverse proxy, and environment variable reference. To wire up your first agent, start with the [quickstart](quickstart.md) (the examples work against either the cloud or a local instance — just set `IMPRI_BASE_URL`). To use the MCP server with Claude Code or Claude Desktop, see [mcp](mcp.md).
