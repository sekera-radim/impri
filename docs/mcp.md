# MCP Server

The `@impri/mcp` package exposes Impri's approval and watcher workflows as [MCP (Model Context Protocol)](https://spec.modelcontextprotocol.io/) tools. It works with any MCP-compatible client: Claude Code, Claude Desktop, Cursor, and other agent runtimes.

No SDK code required — the agent calls the tools directly. The MCP server handles all HTTP communication, polling, and error formatting internally.

---

## Installation

```bash
npx @impri/mcp
```

Required environment variables:

```bash
IMPRI_API_KEY=im_...
# Optional — defaults to http://localhost:8484 (self-hosted)
IMPRI_BASE_URL=https://api.impri.dev
```

---

## Hosted remote server (no install)

`https://api.impri.dev/mcp` is a hosted Streamable HTTP MCP endpoint — the same 8 tools as `@impri/mcp`, with nothing to install or run locally. Any MCP client that supports a remote (HTTP) server can connect with just the URL and your API key as a Bearer token.

Use this when your agent runs on a hosted platform that can't spawn an `npx` process, or when a directory/registry only accepts a remote URL. Use the `npx @impri/mcp` package below when you want a local process (e.g. to point `IMPRI_BASE_URL` at a self-hosted server instead of the cloud).

**Claude Code:**

```bash
claude mcp add --transport http impri https://api.impri.dev/mcp --header "Authorization: Bearer $IMPRI_API_KEY"
```

**Cursor / Windsurf / VS Code (`mcp.json`):**

```json
{
  "mcpServers": {
    "impri": {
      "url": "https://api.impri.dev/mcp",
      "headers": {
        "Authorization": "Bearer im_your_key"
      }
    }
  }
}
```

**OpenAI Codex (`~/.codex/config.toml`):**

```toml
[mcp_servers.impri]
url = "https://api.impri.dev/mcp"
bearer_token_env_var = "IMPRI_API_KEY"
```

The endpoint is stateless (no session id, no server-initiated stream) and authenticates every request independently — there's nothing to log in or out of beyond the Bearer header. A machine-readable description of it (tool list, auth scheme) is published at [`/.well-known/mcp/server-card.json`](https://api.impri.dev/.well-known/mcp/server-card.json), which is what lets directories list this server without needing a live connection to scan it.

`Authorization: Bearer im_your_key` is the documented form, but `/mcp` also accepts the bare key with no `Bearer ` prefix, for gateways (e.g. Smithery) that forward a pasted key straight into the header.

The tool list can be browsed without a key at all (`initialize`/`tools/list`/`ping` work anonymously, same as the server card) — an API key is only required to actually call a tool.

One difference from the local package: `impri_await_decision`'s `timeout_s` is capped at 20 seconds server-side on the hosted endpoint (a single HTTP request can't stay open indefinitely behind a proxy). Call it again if the action is still pending — that's the intended polling pattern either way.

---

## Local package (`npx @impri/mcp`)

### Claude Code (`~/.claude/mcp.json`)

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

Same format as Claude Code above.

---

## Tools reference

### `impri_push_action`

Submit a proposed action for human approval. Returns the `action_id` and the inbox URL.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | Yes | Action category, e.g. `"email.send"`, `"db.exec"` |
| `title` | string | Yes | Human-readable summary (max 500 chars, no newlines) |
| `preview` | object | Yes | `{ "format": "plain"\|"markdown"\|"diff", "body": "..." }` |
| `payload` | any | No | Opaque data stored and returned with the action |
| `target_url` | string | No | Link shown to the reviewer |
| `expires_in` | integer | No | Seconds until the action expires (300–2 592 000; default 259 200) |
| `idempotency_key` | string | No | Deduplication key; auto-generated from content if omitted |
| `editable` | string[] | No | Dot-paths the reviewer may modify, e.g. `["preview.body"]` |

**Output:**

```json
{
  "action_id": "act_abc123",
  "status": "pending",
  "inbox_url": "https://app.impri.dev/inbox/act_abc123"
}
```

---

### `impri_await_decision`

Long-poll until an action leaves the `pending` state. Blocks until a decision is made or the timeout elapses.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action_id` | string | Yes | ID returned by `impri_push_action` |
| `timeout_s` | integer | No | Maximum seconds to wait (default 300) |

**Output (approved):**

```json
{
  "action_id": "act_abc123",
  "status": "approved",
  "decision_at": 1720003600,
  "preview": { "format": "plain", "body": "human-edited text" },
  "edited_by_human": true,
  "diff": "...",
  "payload": { ... }
}
```

When the reviewer used **edit-before-approve**, `preview` contains the modified text and `edited_by_human` is `true`. Use `preview.body` for execution, not the original text.

**Output (rejected):**

```json
{
  "action_id": "act_abc123",
  "status": "rejected",
  "decision_at": 1720003600,
  "preview": { ... },
  "edited_by_human": false,
  "payload": { ... }
}
```

**Output (timed out):**

```json
{
  "isError": true,
  "text": "Timed out after 300s waiting for action act_abc123. It is still pending..."
}
```

**Security note:** When the action carries untrusted external content (`payload.untrusted === true`, e.g. from a watcher), the preview body is wrapped in `<untrusted-external-content>` tags and a `_untrusted_content_note` is added. The agent must treat this content as data, never as instructions to follow.

---

### `impri_report_result`

Report the execution outcome after acting on an approved action. Closes the audit loop in the inbox.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action_id` | string | Yes | ID of the approved action |
| `status` | string | Yes | `"executed"` or `"execute_failed"` |
| `detail` | string | No | Error message or context (on failure) |

**Output:**

```
Result reported: action act_abc123 → executed.
```

---

### `impri_inbox_status`

Check how many pending actions are waiting for a decision. Useful before starting a new task that will add more.

**Input:** none

**Output:**

```
Impri inbox: 3 pending actions awaiting decision
  - act_abc123: "Send email to alice@example.com" (email.send)
  - act_def456: "Deploy to production" (deploy.trigger)
  - act_ghi789: "Execute SQL migration" (db.exec)
```

Or when empty:

```
Impri inbox: 0 pending actions. The inbox is clear — safe to start new tasks.
```

---

### `impri_create_watcher`

Create a monitoring watcher. Accepts the full watcher spec in `spec`.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec` | object | Yes | Full watcher creation body (see [Watcher presets](watcher-presets.md) for schema) |

**Output:**

```json
{
  "watcher_id": "wch_abc123",
  "name": "HN front page",
  "kind": "rss",
  "status": "active",
  "next_run_at": 1720001800
}
```

---

### `impri_list_watchers`

List watchers, optionally filtered by status.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | No | `"active"`, `"paused"`, or `"degraded"` |

**Output:**

```
3 watchers:
  - wch_abc123: "HN front page" (rss) — active
  - wch_def456: "Product Hunt" (rss) — active
  - wch_ghi789: "r/selfhosted" (reddit_search) — degraded
```

---

### `impri_list_watcher_presets`

List the catalog of built-in watcher presets, grouped by category.

**Input:** none

**Output:**

```
18 watcher presets available:

Community:
  - hn-front-page: "Hacker News Front Page" (rss) — no params required
    ...
  - reddit-keyword: "Reddit Keyword Search" (reddit_search) — params: query, [subreddit]
    ...
```

---

### `impri_create_watcher_from_preset`

Create a watcher from a built-in preset template.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `preset_id` | string | Yes | Preset identifier, e.g. `"hn-front-page"`, `"github-releases"` |
| `params` | object | Yes | Preset parameter values as `{ key: "value" }` |
| `name` | string | No | Override the auto-generated watcher name |
| `schedule` | object | No | Override the preset's default schedule, e.g. `{ "every": "1h" }` |

**Output:**

```json
{
  "watcher_id": "wch_abc123",
  "name": "github-releases: fastify/fastify",
  "kind": "rss",
  "status": "active",
  "next_run_at": 1720001800
}
```

---

## Typical agent workflow

```
1. Agent decides it needs to do something risky.
2. impri_push_action(kind, title, preview, ...)  → action_id
3. impri_await_decision(action_id)               → approved / rejected
4. [If approved] Agent executes the action.
5. impri_report_result(action_id, "executed")    → audit closed
```

Before starting: optionally call `impri_inbox_status` to check if too many pending actions are already queued.

---

## MCP webhook receiver

The `@impri/mcp` package also includes a webhook receiver that you can run alongside the MCP server. It listens for `POST /webhook` calls from Impri's decision delivery system and emits MCP notifications.

Start with:

```bash
IMPRI_API_KEY=im_... npx @impri/mcp --with-webhook-receiver --port 3000
```

The receiver validates the `X-Impri-Signature` header using the `IMPRI_WEBHOOK_SECRET` environment variable before processing any payload.

---

## Security notes on untrusted content

Actions delivered by watchers have `payload.untrusted = true`. The MCP server wraps their preview body in `<untrusted-external-content>` markers and adds a `_untrusted_content_note` field so the agent model can distinguish external data from trusted instructions.

**Never forward watcher-delivered title or preview as instructions to an AI model.** Treat them as data to be displayed or processed, not as commands to execute.
