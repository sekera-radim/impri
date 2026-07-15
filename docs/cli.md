# Impri CLI

> **Status — v0.1, pre-release.** The CLI lives at `cli/` in this repository and is not yet published to npm. Install it from the local source using the build steps below. The REST API it wraps is stable and works against either the hosted cloud (`api.impri.dev`, early beta) or a self-hosted instance — see `impri init --cloud --signup` below.

The `impri` CLI is the fastest way to manage the approval inbox from a terminal — push actions, watch for new ones, approve or reject, and manage watchers and API keys — without writing any code.

---

## Install (local, pre-npm)

The CLI depends on the TypeScript SDK via a `file:` reference. Build the SDK first:

```bash
cd sdk/typescript && npm install && npm run build
cd ../cli && npm install && npm run build
```

Install globally to put `impri` on your PATH:

```bash
npm install -g ./cli
impri --version
```

> The build inlines the SDK into a single `dist/cli.js` (shebang included). A global install requires no `node_modules/` at runtime — only Node 18+.

**Dev mode** (no build step, for iterating on the CLI source):

```bash
cd cli && npx tsx src/cli.ts inbox
```

---

## Onboarding

Run `impri init` once to store your base URL and API key:

```bash
# Self-hosted (default)
impri init

# Cloud — connect with an existing key
impri init --cloud

# Cloud — create a new free project and key in one step
impri init --cloud --signup

# Seed two sample actions so the inbox is not empty on first run
impri init --cloud --signup --demo
```

`init` calls `GET /v1/project` to validate the key, then writes `~/.impri/config.json` (mode 0600). The interactive flow:

1. Prompt for base URL (default: `http://localhost:8484`).
2. Prompt for API key (`im_...`) with masked input.
3. Validate the key against the server.
4. Write the config file.
5. Print the connected project name.

With `--cloud --signup`, the CLI calls `POST /v1/signup`, prints the returned `im_...` key **once** inside a box border with a "store this now" warning, pauses for confirmation, then saves.

---

## Config and credentials

**File:** `~/.impri/config.json`
Directory created as `0700`; file written as `0600` on every save.

```json
{
  "base_url": "https://api.impri.dev",
  "api_key": "im_xxxxxxxxxxxxxxxxxxxxxxxx"
}
```

**Precedence (highest wins):**

| Source | How to set |
|--------|------------|
| Environment | `IMPRI_API_KEY`, `IMPRI_BASE_URL` |
| Config file | `~/.impri/config.json` (written by `impri init`) |
| Code default | `http://localhost:8484`; no key → commands print "Run 'impri init' first" and exit 1 |

Environment variables take effect immediately without touching the config file — suitable for CI, Docker, and per-process overrides:

```bash
IMPRI_BASE_URL=http://staging.internal:8484 \
IMPRI_API_KEY=im_stg_... \
impri inbox
```

**Security notes:**
- The key is never logged, never printed back in full, and never echoed during interactive input (masked with `*`).
- Any `--verbose` or debug output redacts the key to its prefix only: `im_XXXX****`.
- A missing config file produces a friendly error, not a stack trace.

---

## Commands

### `impri init`

```
impri init [--base-url <url>] [--cloud] [--signup] [--demo]
```

Interactive onboarding. Prompts for base URL and API key, validates credentials, and writes `~/.impri/config.json`.

To supply the API key non-interactively, pipe it on stdin or set the `IMPRI_API_KEY` environment variable. The env var takes precedence over the prompt.

| Flag | Description |
|------|-------------|
| `--cloud` | Set base URL to `https://api.impri.dev` and skip the URL prompt |
| `--signup` | Call `POST /v1/signup` (cloud + unauthenticated) to create a free project and print the `im_...` key once |
| `--demo` | After connecting, seed two sample actions (`demo.email`, `demo.publish`) so the inbox has content |
| `--base-url <url>` | Skip the URL prompt |

---

### `impri login`

```
impri login [--base-url <url>] [--cloud]
```

Alias for `impri init`. Re-run onboarding to rotate your key or switch between self-hosted and cloud without wiping other settings. Supply the key via the interactive prompt, piped stdin, or `IMPRI_API_KEY` env var.

---

### `impri status`

```
impri status [--json]
```

Verify the active config by calling `GET /healthz` and `GET /v1/project`. Prints:

- Connected project name
- Base URL
- Key prefix (`im_xxxx****`)
- Current pending action count

Exits 1 if the server is unreachable or the key is invalid.

---

## Approval Inbox

### `impri push`

```
impri push --kind <kind> --title <title> [options]
```

Create an action for human approval (`POST /v1/actions`). Preview body is read from `--body` or stdin when omitted, enabling pipe usage.

| Flag | Description |
|------|-------------|
| `--kind <kind>` | Action kind, e.g. `email.send`, `db.exec`, `reddit.comment` |
| `--title <title>` | Short description shown in the inbox card |
| `--body <text>` | Preview body text (or pipe from stdin) |
| `--format <plain\|markdown\|diff>` | Preview format (default: `plain`) |
| `--editable preview.body` | Allow the reviewer to edit the body before approving |
| `--target-url <url>` | Link to the resource being acted on |
| `--expires-in <seconds>` | Approval window (default: 259200 = 72 h; min: 300; max: 2592000) |
| `--wait` | Poll until decided; exit 0 on approval, exit 1 on rejection |
| `--timeout <seconds>` | Timeout for `--wait` (default: 300) |
| `--json` | Print raw `ActionCreated` JSON |

**Examples:**

```bash
# Push a draft email for review
impri push --kind email.send \
  --title "Draft: Q3 newsletter" \
  --body "Hi everyone, ..." \
  --format markdown \
  --editable preview.body

# Read preview from stdin
echo "$QUERY" | impri push --kind db.exec --title "Run migration"

# Push and block until the human decides
impri push --kind reddit.comment \
  --title "Reply: self-hosting AI" \
  --body "$(cat reply.md)" \
  --wait --timeout 600
```

---

### `impri inbox`

```
impri inbox [--kind <kind>] [--limit <n>] [--json]
```

Show only pending actions — shorthand for `impri list --status pending`. This is the primary human operator view.

```bash
impri inbox
impri inbox --kind email.send
```

---

### `impri list`

```
impri list [--status <pending|approved|rejected|expired>] [--kind <kind>] \
           [--since <iso-date>] [--q <search>] [--limit <n>] [--json]
```

List actions newest-first in a tabular view (id, kind, title, status, age). Defaults to all statuses.

| Flag | Description |
|------|-------------|
| `--status` | Filter by status |
| `--kind` | Filter by action kind |
| `--since <iso-date>` | ISO-8601 date string, e.g. `2026-07-01` (converted internally to a Unix timestamp) |
| `--q <search>` | Free-text search on title and preview body (max 200 chars) |
| `--limit <n>` | Max results (default: 50) |
| `--json` | Newline-delimited JSON records for scripting |

```bash
impri list --status approved --since 2026-07-01
impri list --q "migration" --json | jq .id
```

---

### `impri get <action-id>`

```
impri get <action-id> [--json]
```

Fetch a single action and print full detail: status, preview, editable fields, `expires_at`, and the decision (including `final_preview` and `diff`) when already decided.

```bash
impri get act_abc123
```

---

### `impri approve <action-id>`

```
impri approve <action-id> [--edit <new-body-text>] [--json]
```

Approve an action (`POST /v1/actions/:id/decision`, `verdict=approve`).

`--edit` replaces the preview body before approving. The CLI fetches the action first and exits with an error if `preview.body` is not in the action's `editable` list.

```bash
impri approve act_abc123

# Approve with an edited body
impri approve act_abc123 --edit "$(cat edited-reply.md)"
```

Exits 0 on success.

---

### `impri reject <action-id>`

```
impri reject <action-id> [--json]
```

Reject an action (`POST /v1/actions/:id/decision`, `verdict=reject`). Prints the `DecisionResult`.

Exits 0 on success; exits 2 on `ImpriConflict` (already decided).

---

### `impri tail`

```
impri tail [--kind <kind>] [--interval <seconds>] [--json]
```

Long-running watch mode for the human operator. Polls `GET /v1/actions?status=pending` every `--interval` seconds (default: 10, minimum: 5 to stay under rate limits) and prints newly-arrived pending actions as they appear. Tracks the latest `created_at` seen to avoid reprinting.

Press **Ctrl-C** to exit.

```bash
# Terminal 1 — tail the inbox
impri tail

# Terminal 2 — decide on actions printed by tail
impri approve act_xyz789
```

With `--json`, each new action is streamed as a JSON line — useful for piping into other tools.

---

## Watchers

### `impri presets`

```
impri presets [--category <Community|Developer|Content|Research|News|Monitoring>] [--json]
```

List the 18 watcher preset templates (`GET /v1/watcher-presets`) in a grouped table showing preset ID, description, required params, and default schedule. Use the preset ID with `impri watch add`.

```bash
impri presets
impri presets --category Developer
```

**Available presets:**

| Category | Preset IDs |
|----------|-----------|
| Community | `hn-front-page`, `hn-keyword`, `hn-show-ask`, `reddit-subreddit`, `reddit-keyword` |
| Developer | `github-releases`, `github-commits`, `npm-package`, `pypi-package`, `stackoverflow-tag` |
| Content | `rss-feed`, `blog-newsletter`, `youtube-channel` |
| Research | `arxiv-papers` |
| News | `google-news`, `product-hunt` |
| Monitoring | `url-changed`, `changelog-status` |

---

### `impri watch add <preset-id>`

```
impri watch add <preset-id> [--param key=value]... [--name <name>] [--schedule <every>] [--json]
```

Create a watcher from a named preset (`POST /v1/watchers/from-preset`). `--param` is repeatable.

```bash
# GitHub releases for fastify/fastify, polled hourly
impri watch add github-releases \
  --param owner=fastify \
  --param repo=fastify \
  --schedule 1h

# Reddit keyword search with a custom name
impri watch add reddit-keyword \
  --param "query=self-hosting AI" \
  --param subreddit=selfhosted \
  --name "SH AI mentions"

# Hacker News front page (no params required)
impri watch add hn-front-page
```

Prints the created watcher ID and `next_run_at` on success.

---

### `impri watchers list`

```
impri watchers list [--status <active|paused|degraded>] [--kind <rss|reddit_search|url_diff>] [--json]
```

List all watchers with status, kind, schedule, `fail_count`, and `next_run_at`.

---

### `impri watchers get <watcher-id>`

```
impri watchers get <watcher-id> [--json]
```

Fetch a single watcher by ID, including `item_count` (total deduplicated items seen since creation).

---

### `impri watchers delete <watcher-id>`

```
impri watchers delete <watcher-id> [--yes]
```

Permanently delete a watcher and its deduplication history. Pending inbox actions created by this watcher are **not** deleted.

`--yes` skips the interactive confirmation prompt — safe for scripting.

---

## API Keys

All key commands require `admin` scope.

### `impri keys list`

```
impri keys list [--json]
```

List all API keys: prefix, scopes, `created_at`, `last_used_at`, and revocation status. Raw key values are never returned by the server after creation.

---

### `impri keys create`

```
impri keys create --name <name> --scopes <actions|watch|admin>[,...]
```

Create a new API key (`POST /v1/keys`) and print the raw `im_...` value **exactly once**. The CLI displays the key prominently and warns it will not be shown again.

```bash
# Per-agent key with minimal scope
impri keys create --name "deploy-agent" --scopes actions

# Ops bot that can also manage watchers
impri keys create --name "ops-bot" --scopes actions,watch
```

---

### `impri keys revoke <key-id>`

```
impri keys revoke <key-id> [--yes]
```

Revoke a key permanently (`DELETE /v1/keys/:id`). All subsequent requests with that key will be rejected with 401.

`--yes` skips the confirmation prompt.

---

## Human operator workflow

The typical setup for monitoring an active agent:

```bash
# Terminal 1 — watch for new pending actions
impri tail

# Terminal 2 — inspect and decide on a specific action
impri get act_abc123
impri approve act_abc123
# or
impri reject act_abc123
```

For a lighter setup, poll the inbox on a loop:

```bash
watch -n 30 impri inbox
```

Inspect then edit a draft before approving:

```bash
impri get act_abc123         # read the preview
$EDITOR /tmp/reply.md        # edit locally
impri approve act_abc123 --edit "$(cat /tmp/reply.md)"
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (server unreachable, invalid key, action rejected on `--wait`) |
| 2 | Conflict — action already decided |

---

## Build reference

```
cli/
  src/cli.ts          Entry point — subcommands registered with commander
  package.json        name: @impri/cli, version: 0.1.0, bin: { impri: ./dist/cli.js }
  tsup.config.ts      Bundles SDK inline via noExternal: [/@impri/]; shebang injected
  dist/cli.js         Compiled output (generated by npm run build)
```

**Build sequence for a clean checkout:**

```bash
cd sdk/typescript && npm install && npm run build
cd ../cli && npm install && npm run build
npm install -g ./cli
```

The bundle carries the shebang so the OS can execute `dist/cli.js` directly. No `node_modules/` needed at runtime beyond Node 18.

---

See also:
- [TypeScript SDK reference](sdk-typescript.md) — for agents that push and poll programmatically
- [Quickstart](quickstart.md) — zero to first approved action in < 5 min
- [Watcher presets](watcher-presets.md) — full preset catalog with param reference
- [Inbox UX](inbox.md) — keyboard shortcuts, bulk approve/reject, filters (web inbox)
