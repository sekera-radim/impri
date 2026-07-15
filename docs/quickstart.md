# Quickstart

From zero to your first approved action in under 5 minutes.

Two ways to run Impri — pick one:

- **[Option A — Cloud](#option-a--cloud-no-install)**: no install, a hosted key in one request. Fastest way to try it.
- **[Option B — Self-host](#option-b--self-host-docker)**: `docker compose up`, your own data, still free.

Both use the exact same three calls from your agent: push an action, wait for a decision, execute and report back.

---

## Option A — Cloud (no install)

### 1. Create a project and get a key

```bash
curl -s -X POST https://api.impri.dev/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
```

Response (`201 Created`):

```json
{
  "key": "im_<your-key>",
  "project_id": "proj_...",
  "recovery_code": "...",
  "note": "Store this key and recovery code securely — they will not be shown again."
}
```

Save both — the key is shown once. (Prefer clicking through instead? Go to [app.impri.dev](https://app.impri.dev) and use the **Create an API key** button — same result.)

```bash
export AGENT_KEY="im_<your-key-from-the-response>"
```

This key has full `admin` scope, which is fine to start. Once you're wiring up a real agent, create a narrower `actions`-scoped key instead — see [API keys & scopes](api-keys.md).

### 2. Submit an action for approval

Your agent pushes an action to the inbox. This is the single call your agent makes before doing anything consequential:

```bash
ACTION=$(curl -s -X POST https://api.impri.dev/v1/actions \
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
  }')

ACTION_ID=$(echo $ACTION | jq -r .id)
INBOX_URL=$(echo $ACTION | jq -r .inbox_url)
echo "Review it at: $INBOX_URL"
```

### 3. Approve in the web inbox

Open the `inbox_url` printed above (or go to [app.impri.dev](https://app.impri.dev) and click **Inbox**). You'll see the pending action as a card with the markdown preview. Tap **Approve** (or **Reject**).

If you configured `editable: ["preview.body"]`, you can also edit the reply text before approving — the agent receives the final, human-edited version.

### 4. Agent picks up the decision via polling

Poll `GET /v1/actions/:id` until `status` is no longer `pending`:

```bash
curl -s https://api.impri.dev/v1/actions/$ACTION_ID \
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

### 5. Execute and report back

Execute the action with the approved content, then close the loop by reporting the result:

```bash
# After successful execution
curl -s -X POST https://api.impri.dev/v1/actions/$ACTION_ID/result \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "executed"}'

# Or if execution failed
curl -s -X POST https://api.impri.dev/v1/actions/$ACTION_ID/result \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "execute_failed", "detail": "Reddit API returned 403"}'
```

The action lifecycle is now complete: `pending → approved → executed`. That's the whole loop — everything past this point is optional depth (webhooks instead of polling, watchers, notification channels).

### Prefer MCP? (Claude Code, Claude Desktop, any MCP client)

Skip the raw HTTP calls above — the Impri MCP server wraps the same three calls into tool calls your agent can use directly.

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_<your-agent-key>",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

| Tool | What it does |
|------|-------------|
| `impri_push_action` | Submit an action for human approval |
| `impri_await_decision` | Long-poll until a decision arrives (or timeout) |
| `impri_report_result` | Report execution outcome after approval |
| `impri_inbox_status` | Check how many actions are pending |

```
impri_push_action(kind="reddit.comment", title="Reply: ...", preview={...}, editable=["preview.body"])
→ { action_id: "act_abc123", status: "pending", inbox_url: "..." }

impri_await_decision(action_id="act_abc123", timeout_s=600)
→ { status: "approved", preview: { body: "..." }, edited_by_human: true }

impri_report_result(action_id="act_abc123", status="executed")
```

---

## Option B — Self-host (Docker)

Same three calls, running entirely on your own machine — no cloud account, no telemetry.

**Prerequisites:** Docker and Docker Compose, `curl`.

### 1. Start Impri

```bash
git clone https://gitlab.com/sekera.radim/impri.git
cd impri

# Set a strong webhook secret before starting
export WEBHOOK_SECRET=$(openssl rand -hex 32)

docker compose up -d
```

The server starts on **port 8484** (API) and the web inbox on **port 8080**.

On the very first start, a bootstrap admin key is printed to the server log — grab it now, it's shown once and hashed in the database from then on:

```bash
docker compose logs server | grep "Admin API Key"
```

```bash
export ADMIN_KEY="im_<your-key-from-the-log>"
```

### 2. Create an API key for your agent

The bootstrap key has `admin` scope. Create a dedicated key with `actions` scope for your agent so you can rotate it independently:

```bash
curl -s -X POST http://localhost:8484/v1/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "scopes": ["actions"]}' | tee /dev/stderr | jq .key
```

```bash
export AGENT_KEY="im_<agent-key>"
```

### 3–6. Push, approve, poll, execute

Same as the cloud steps above, just swap `https://api.impri.dev` for `http://localhost:8484` and `https://app.impri.dev` for `http://localhost:8080`:

```bash
# 3. Push
curl -s -X POST http://localhost:8484/v1/actions \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "reddit.comment",
    "title": "Reply: Why is resume advice so conflicting?",
    "preview": { "format": "markdown", "body": "The advice conflicts because different advisors optimise for different audiences..." },
    "target_url": "https://reddit.com/r/cscareerquestions/comments/example",
    "expires_in": 3600,
    "editable": ["preview.body"]
  }'
# → { "id": "act_abc123", "status": "pending", "inbox_url": "http://localhost:8080/inbox/act_abc123", ... }

# 4. Approve at the inbox_url above, then poll
curl -s http://localhost:8484/v1/actions/act_abc123 \
  -H "Authorization: Bearer $AGENT_KEY" | jq '{status, decision}'

# 5. Execute with decision.final_preview, then report
curl -s -X POST http://localhost:8484/v1/actions/act_abc123/result \
  -H "Authorization: Bearer $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "executed"}'
```

**Via MCP:** same config as Option A, just point it at your local server:

```bash
export IMPRI_API_KEY="$AGENT_KEY"
export IMPRI_BASE_URL="http://localhost:8484"
npx @impri/mcp
```

---

## What's next

- **Webhook delivery** instead of polling: see [webhooks.md](webhooks.md)
- **Watchers** (monitor RSS, Reddit, URL changes): REST API via `POST /v1/watchers`; see [SPEC.md](https://github.com/sekera-radim/impri/blob/main/SPEC.md) for the schema
- **Self-hosting configuration** (SMTP, ntfy, backups): see [self-hosting.md](self-hosting.md)
- **The full pattern and its guarantees** (why this actually gates execution, and what it doesn't cover): see [How to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md)
