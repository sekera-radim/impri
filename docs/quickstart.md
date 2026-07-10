# Quickstart

From zero to your first approved action in under 5 minutes.

## Prerequisites

- Docker and Docker Compose installed
- `curl` available in your terminal

---

## Step 1 — Start Impri

```bash
git clone https://github.com/impri-dev/impri.git   # or your self-host copy
cd impri

# Set a strong webhook secret before starting
export WEBHOOK_SECRET=$(openssl rand -hex 32)

docker compose up -d
```

The server starts on **port 8484** (API) and the web inbox on **port 8080**.

**On the very first start**, a bootstrap admin key is printed to the server log:

```
╔══════════════════════════════════════════════════════╗
║            IMPRI — FIRST RUN BOOTSTRAP               ║
╠══════════════════════════════════════════════════════╣
║  Admin API Key: im_<your-key-here>
║  Project ID:    proj_<your-project-id>
║  Store this key securely — it will not be shown again.║
╚══════════════════════════════════════════════════════╝
```

Grab it now — it is shown once and is hashed in the database.

```bash
# View the bootstrap output
docker compose logs server | grep "Admin API Key"
```

Store the key in your environment:

```bash
export ADMIN_KEY="im_<your-key-from-the-log>"
```

---

## Step 2 — Create an API key for your agent

The bootstrap key has `admin` scope. Create a dedicated key with `actions` scope for your agent so you can rotate it independently:

```bash
curl -s -X POST http://localhost:8484/v1/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "scopes": ["actions"]}' | tee /dev/stderr | jq .key
```

Response:

```json
{
  "id": "key_...",
  "name": "my-agent",
  "key": "im_<agent-key>",
  "scopes": ["actions"],
  "project_id": "proj_...",
  "note": "Store this key securely — it will not be shown again."
}
```

```bash
export AGENT_KEY="im_<agent-key>"
```

---

## Step 3 — Submit an action for approval

Your agent pushes an action to the inbox. This is the single call your agent makes before doing anything consequential:

```bash
curl -s -X POST http://localhost:8484/v1/actions \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "reddit.comment",
    "title": "Reply: Why is resume advice so conflicting?",
    "preview": {
      "format": "markdown",
      "body": "The advice conflicts because different advisors optimise for different audiences — junior vs senior, IC vs management — and rarely say which."
    },
    "target_url": "https://reddit.com/r/cscareerquestions/comments/example",
    "expires_in": 3600,
    "editable": ["preview.body"]
  }'
```

Response (`201 Created`):

```json
{
  "id": "act_abc123",
  "status": "pending",
  "inbox_url": "http://localhost:8080/inbox/act_abc123",
  "expires_at": 1720000000,
  "created_at": 1719996400
}
```

Save the `id` — you need it to poll for the decision.

---

## Step 4 — Approve in the web inbox

Open the web inbox at **http://localhost:8080** (or the `inbox_url` from the response). You will see the pending action as a card with the markdown preview. Tap **Approve** (or **Reject**).

If you configured `editable: ["preview.body"]`, you can also edit the reply text before approving. The agent will receive the final, human-edited version.

---

## Step 5 — Agent picks up the decision via polling

Poll `GET /v1/actions/:id` until `status` is no longer `pending`:

```bash
curl -s http://localhost:8484/v1/actions/act_abc123 \
  -H "Authorization: Bearer $AGENT_KEY" | jq '{status, decision}'
```

Response after approval:

```json
{
  "status": "approved",
  "decision": {
    "verdict": "approve",
    "decided_at": 1719996800,
    "channel": "web",
    "final_preview": {
      "format": "markdown",
      "body": "The advice conflicts because different advisors optimise for different audiences..."
    }
  }
}
```

If the reviewer edited the body, `final_preview` contains the edited version and `diff` is present. **Always use `final_preview` as the content to send — never the original.**

---

## Step 6 — Execute and report back

Execute the action with the approved content, then close the loop by reporting the result:

```bash
# After successful execution
curl -s -X POST http://localhost:8484/v1/actions/act_abc123/result \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "executed"}'

# Or if execution failed
curl -s -X POST http://localhost:8484/v1/actions/act_abc123/result \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "execute_failed", "detail": "Reddit API returned 403"}'
```

The action lifecycle is now complete: `pending → approved → executed`.

---

## Alternative: via MCP (Claude Code, Claude Desktop, any MCP client)

If your agent runs inside a Claude Code session or any MCP-compatible client, you can use the Impri MCP server instead of raw HTTP calls.

**Install and run:**

```bash
# Point the MCP server at your self-hosted instance
export IMPRI_API_KEY="$AGENT_KEY"
export IMPRI_BASE_URL="http://localhost:8484"
npx @impri/mcp
```

**Or configure it in your MCP client config** (e.g. `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_<your-agent-key>",
        "IMPRI_BASE_URL": "http://localhost:8484"
      }
    }
  }
}
```

**Available tools:**

| Tool | What it does |
|------|-------------|
| `impri_push_action` | Submit an action for human approval |
| `impri_await_decision` | Long-poll until a decision arrives (or timeout) |
| `impri_report_result` | Report execution outcome after approval |
| `impri_inbox_status` | Check how many actions are pending |

**Example agent flow in a Claude Code session:**

```
# 1. Push
impri_push_action(
  kind="reddit.comment",
  title="Reply: Why is resume advice so conflicting?",
  preview={ format="markdown", body="The advice conflicts because..." },
  editable=["preview.body"]
)
→ { action_id: "act_abc123", status: "pending", inbox_url: "..." }

# 2. Await (blocks until approved/rejected/expired, default timeout 300s)
impri_await_decision(action_id="act_abc123", timeout_s=600)
→ { status: "approved", preview: { body: "..." }, edited_by_human: true }

# 3. Execute with final preview, then report
impri_report_result(action_id="act_abc123", status="executed")
```

> Note: `impri_create_watcher` and `impri_list_watchers` are fully wired to the
> `/v1/watchers` API — you can create and list watchers straight from the MCP
> tools, or use the REST API directly.

---

## What's next

- **Webhook delivery** instead of polling: see [webhooks.md](webhooks.md)
- **Watchers** (monitor RSS, Reddit, URL changes): REST API via `POST /v1/watchers`; see [SPEC.md](../SPEC.md) for the schema
- **Self-hosting configuration** (SMTP, ntfy, backups): see [self-hosting.md](self-hosting.md)
