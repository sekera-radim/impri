# Impri

**Human-in-the-loop approval inbox for AI agents.**

Your agent wants to send the email, post the reply, run the migration.
You want to see it before it happens, from your phone if you're not at a desk.
Impri is the inbox in between.

```
Agent (Claude Code / any MCP client)  →  Impri inbox  →  You approve, edit, or reject
        ↑                                                          |
        └──────────────── agent executes, reports result ──────────┘
```

![Impri demo: an agent pushing an action, the approval inbox, a human approving it, the agent executing](https://raw.githubusercontent.com/sekera-radim/impri/main/www/assets/demo/killer-demo.gif)

[Watch as MP4](https://impri.dev/assets/demo/killer-demo.mp4?utm_source=github&utm_medium=readme&utm_campaign=impri)

## The problem

Agents that only read and draft are safe by construction. The moment one can send an email, post a reply, or run a write against a database, "ask the user first" becomes a system-prompt instruction — and a instruction is something a capable model can reason its way past, forget under load, or misjudge on an edge case you didn't anticipate.

Impri turns that instruction into a data dependency instead. The agent pushes a proposed action to an inbox and polls for a decision; the execution branch is only reachable once the API actually returns `status: "approved"`. There's nothing to talk the model past — the gate lives outside the model, not inside its prompt.

## 60-second install

**Claude Code:**

```bash
claude mcp add impri --env IMPRI_API_KEY=im_... --env IMPRI_BASE_URL=https://api.impri.dev -- npx -y @impri/mcp
```

**Codex:**

```bash
codex mcp add impri --env IMPRI_API_KEY=im_... --env IMPRI_BASE_URL=https://api.impri.dev -- npx -y @impri/mcp
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["-y", "@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_...",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

**Windsurf** — add the same block to `mcp_config.json`:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["-y", "@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_...",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

Get an `im_...` key with one curl call — no signup form:

```bash
curl -s -X POST https://api.impri.dev/v1/signup -H "Content-Type: application/json" -d '{"name":"my-agent"}'
```

`IMPRI_BASE_URL` defaults to `http://localhost:8484` (self-host) if you omit it — set it to `https://api.impri.dev` for the hosted cloud, as above. Self-hosting instead of the cloud? See [Self-host or cloud](#self-host-or-cloud) below.

## What the agent can do

| Tool | What it does |
|---|---|
| `impri_push_action` | Submit a proposed action — title, formatted preview, optional editable fields |
| `impri_await_decision` | Poll until a human approves, rejects, or the timeout elapses |
| `impri_report_result` | Report whether the approved action actually succeeded |
| `impri_inbox_status` | Check how many actions are waiting, before starting a big batch |
| `impri_create_watcher` | Create a watcher (RSS / Reddit search / URL diff) that feeds matching items into the inbox |
| `impri_list_watchers` | List configured watchers, optionally filtered by status |
| `impri_list_watcher_presets` | List the 18 ready-made watcher templates (Hacker News, GitHub releases, npm, arXiv, …) |
| `impri_create_watcher_from_preset` | Create a watcher from a preset by id + params, no config schema to write |

## The loop

```
1. impri_push_action(kind, title, preview)        → { action_id, status: "pending", inbox_url }
2. impri_await_decision(action_id)                 → waits for a human to approve/reject/edit, or times out
3. If approved: execute the real action
4. impri_report_result(action_id, "executed" | "execute_failed")
```

Or in plain REST, the same three calls:

```bash
ACTION=$(curl -s -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -d '{"kind":"email.send","title":"Outreach: Acme","preview":{"format":"markdown","body":"Hi Sarah, ..."}}')
ID=$(echo "$ACTION" | jq -r .action_id)

# poll (or long-poll) until a human decides
DECISION=$(curl -s "https://api.impri.dev/v1/actions/$ID" -H "Authorization: Bearer $IMPRI_API_KEY")

# only now, and only if approved
[ "$(echo "$DECISION" | jq -r .status)" = "approved" ] && send_email "$(echo "$DECISION" | jq -r .preview.body)"
```

The human doesn't have to be staring at a dashboard: an action can notify Slack, Discord, Telegram, ntfy, email, or a generic webhook, and the reviewer can edit the draft before approving — the agent receives that edited text back.

## Why not just a prompt instruction?

| "Please ask before sending" in the system prompt | Impri |
|---|---|
| The model has to remember, every time | Execution is unreachable without `status: "approved"` from the API |
| No record of who decided what, or when | Every decision is in the audit log |
| Can't fix a typo without a new draft | Edit-before-approve — the agent gets the edited version back |
| One-off per agent, per project | One inbox, six notification channels, 18 watcher presets, all agents |

The honest caveat: this is a real gate only as long as the approved path is the agent's *only* path to the side effect — give it the raw credential too and it can route around you.

## Self-host or cloud

**Cloud** — signup above, inbox at [app.impri.dev](https://app.impri.dev?utm_source=github&utm_medium=readme&utm_campaign=impri), early beta.

**Self-host** — full core, MIT, no license key:

```bash
git clone https://gitlab.com/sekera.radim/impri.git
cd impri
docker compose up
```

Server on `http://localhost:8484`, web inbox on `http://localhost:8080`. The bootstrap admin key prints to the logs on first start. Details: [Self-hosting](docs/self-hosting.md).

## Reference

Everything below is unchanged technical detail: CLI, SDKs, integrations, the full doc set, and legal.

### CLI, SDKs & integrations

> v0.1, pre-release. MCP is published; the CLI and both SDKs are local-install only (pre-npm / pre-PyPI) for now.

| Package | Location | Status |
|---|---|---|
| MCP server | `mcp/` / `npx @impri/mcp` | Published |
| CLI (`impri`) | `cli/` | Local build — see [CLI reference](docs/cli.md) |
| Python SDK | `sdk/python/` | Local install (`pip install -e sdk/python`) |
| TypeScript SDK | `sdk/typescript/` | Local install (`npm install ./sdk/typescript`) |

Framework integrations in [`integrations/`](integrations/): packages for the [Claude Agent SDK](integrations/claude-agent-sdk), [CrewAI](integrations/crewai), [LangChain](integrations/langchain), and the [OpenAI Agents SDK](integrations/openai-agents); documented webhook-based patterns for n8n, Make, and Zapier in [Integrations](docs/integrations.md).

### Notifications

Six channels: Slack, Discord, Telegram, email, ntfy, and generic webhook. See [Notification channels](docs/notifications.md) and [Telegram Approval Bot](docs/telegram-approval.md).

### Documentation

- **Web docs:** <https://impri.dev/docs?utm_source=github&utm_medium=readme&utm_campaign=impri>
- [Quickstart](docs/quickstart.md) — signup to first approved action in under 5 minutes
- [Example agent](examples/approval-gated-agent.mjs) — dependency-free Node script showing the full loop
- [Self-hosting](docs/self-hosting.md) — Docker, env vars, backups, reverse proxy
- [Webhooks](docs/webhooks.md) — HMAC verification, retries, polling fallback
- [Watcher presets](docs/watcher-presets.md) — all 18 templates, REST + SDK + MCP usage
- [Audit log](docs/audit-log.md) — event types, query API, export, retention
- [Architecture](ARCHITECTURE.md)
- [`llms.txt`](docs/llms.txt) — machine-readable index for AI assistants

### Pricing

Free (3 watchers, 100 approvals/mo) · Indie $9/mo (20 watchers, 2,000 approvals/mo, 5-minute checks) · Team $29/mo (unlimited watchers and approvals, 1-minute checks). Self-host the full core for free — no tier limits apply outside the hosted cloud. Details: [impri.dev](https://impri.dev/?utm_source=github&utm_medium=readme&utm_campaign=impri#pricing).

### Privacy & legal

- [Privacy Policy](docs/privacy.md)
- [GDPR notes](docs/gdpr.md)
- [Terms](docs/terms.md)

### License

MIT — see [LICENSE](LICENSE). Self-host the full core freely; the hosted cloud and paid tiers are the commercial offering (see [MONETIZATION.md](MONETIZATION.md)).

---

Made by [Radim Sekera](https://impri.dev?utm_source=github&utm_medium=readme&utm_campaign=impri). Related project: [briefgate.dev](https://briefgate.dev) — client intake for AI coding agents.
