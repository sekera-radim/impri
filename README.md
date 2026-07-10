# Impri — Approval Inbox for AI Agents

> The imprimatur for your AI agents. Watchers watch the world, the Approval
> Inbox holds the agent's hands until a human says yes.

## Quickstart

### Docker Compose (< 5 minutes)

```bash
git clone https://gitlab.com/sekera.radim/impri.git
cd impri
docker compose up
```

Open **http://localhost:8080** in your browser.

On first start the server prints the bootstrap Admin API key to the logs:

```
╔══════════════════════════════════════════════════════╗
║            IMPRI — FIRST RUN BOOTSTRAP               ║
╠══════════════════════════════════════════════════════╣
║  Admin API Key: im_...                               ║
║  Project ID:    proj_...                             ║
║  Store this key securely — it will not be shown again.║
╚══════════════════════════════════════════════════════╝
```

Copy the key, paste it into the login screen, and you're in.

### Dev mode (hot-reload)

**Terminal 1 — server:**

```bash
cd server
npm install
npm run dev
# Server starts on http://localhost:8484
```

**Terminal 2 — UI:**

```bash
cd ui
npm install
npm run dev
# UI starts on http://localhost:5173
# /v1 requests are proxied to localhost:8484
```

## API at a glance

Base URL: `http://localhost:8484/v1`  
Auth: `Authorization: Bearer im_<key>`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/actions` | Push a new action for approval |
| GET | `/v1/actions` | List actions (`?status=pending`) |
| GET | `/v1/actions/:id` | Get action detail + decision |
| POST | `/v1/actions/:id/decision` | Approve or reject |
| POST | `/v1/actions/:id/result` | Report execution result |
| GET | `/v1/openapi.json` | OpenAPI spec |

### Push an action (curl example)

```bash
curl -X POST http://localhost:8484/v1/actions \
  -H "Authorization: Bearer im_..." \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "reddit.comment",
    "title": "Reply to: Why is resume advice so conflicting?",
    "preview": {
      "format": "markdown",
      "body": "The advice conflicts because..."
    },
    "target_url": "https://reddit.com/r/jobs/comments/...",
    "expires_in": 86400,
    "editable": ["preview.body"]
  }'
```

## MCP server (Claude Code / agents)

```bash
npx @impri/mcp
# env: IMPRI_API_KEY=im_...  IMPRI_BASE_URL=http://localhost:8484
```

## Project structure

```
server/   TypeScript + Fastify + SQLite — REST API (port 8484)
mcp/      MCP server (stdio) — thin wrapper over the REST API
ui/       Vue 3 + Vuetify — web inbox (port 5173 dev / 8080 Docker)
docker/   Dockerfiles (server.Dockerfile)
docs/     Research, ADRs
```

## Documentation

- [Quickstart](docs/quickstart.md) — signup → first approved action in < 5 min
- [How to add human approval to an AI agent](docs/how-to-add-human-approval-to-an-ai-agent.md)
- [Self-hosting](docs/self-hosting.md) — Docker, env vars, backups, reverse proxy
- [Webhooks](docs/webhooks.md) — HMAC verification, retries, polling fallback
- [`llms.txt`](docs/llms.txt) — machine-readable index for AI assistants

## Self-hosting notes

- SQLite data is persisted in a Docker volume (`impri-data`).
- Set `WEBHOOK_SECRET` env var to a random string for HMAC webhook signing.
- `BASE_URL` should match the public URL of your deployment (used in inbox_url links).

## License

MIT — see [LICENSE](LICENSE). Self-host the full core freely; the hosted cloud
and team features are the paid offering (see `MONETIZATION.md`).
