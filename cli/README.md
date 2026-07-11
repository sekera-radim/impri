# @impri/cli

Command-line interface for [Impri](https://impri.dev) — human-in-the-loop approval for AI agents.

## 60-second quickstart

```bash
# 1. Install globally after building
cd sdk/typescript && npm install && npm run build
cd ../cli && npm install && npm run build
npm install -g ./

# 2. Connect to your Impri instance
impri init                        # self-hosted (default: http://localhost:8484)
impri init --cloud                # Impri Cloud (https://api.impri.dev)
impri init --cloud --signup       # create a free cloud project

# 3. Push an action for approval
impri push --kind db.exec --title "Run migration" --body "ALTER TABLE ..."

# 4. See what needs a decision
impri inbox

# 5. Approve or reject
impri approve act_abc123
impri reject  act_abc123
```

## Commands

### Auth

| Command | Description |
|---|---|
| `impri init [--cloud] [--signup] [--key <k>] [--demo]` | Interactive onboarding — set base URL + API key |
| `impri login [--cloud] [--key <k>]` | Re-run onboarding to update credentials |
| `impri status` | Verify connection and show pending count |

### Actions

| Command | Description |
|---|---|
| `impri push --kind <k> --title <t> [--body <b>] [--format plain\|markdown\|diff] [--editable preview.body] [--wait] [--timeout <s>] [--json]` | Create an action for human approval |
| `impri list [--status <s>] [--kind <k>] [--since <iso>] [--q <search>] [--limit <n>] [--json]` | List actions newest-first |
| `impri inbox [--kind <k>] [--limit <n>] [--json]` | Show only pending actions |
| `impri get <id> [--json]` | Fetch full detail for one action |
| `impri approve <id> [--edit <new-body>] [--json]` | Approve an action |
| `impri reject <id> [--json]` | Reject an action |
| `impri tail [--kind <k>] [--interval <s>] [--json]` | Stream new pending actions as they arrive |

### Watchers

| Command | Description |
|---|---|
| `impri presets [--category <c>] [--json]` | List watcher preset templates |
| `impri watch add <preset-id> [--param k=v]... [--schedule <every>] [--json]` | Create watcher from preset |
| `impri watchers list [--status <s>] [--kind <k>] [--json]` | List watchers |
| `impri watchers get <id> [--json]` | Fetch watcher detail with item count |
| `impri watchers delete <id> [--yes]` | Delete watcher permanently |

### API Keys

| Command | Description |
|---|---|
| `impri keys list [--json]` | List all keys (admin scope required) |
| `impri keys create --name <n> --scopes <actions\|watch\|admin>` | Create key — shown exactly once |
| `impri keys revoke <id> [--yes]` | Revoke a key permanently |

## Configuration

Config file: `~/.impri/config.json` (permissions: directory 0700, file 0600)

```json
{ "base_url": "https://api.impri.dev", "api_key": "im_..." }
```

**Precedence** (highest first):
1. `IMPRI_API_KEY` / `IMPRI_BASE_URL` environment variables
2. `~/.impri/config.json`
3. Default base URL: `http://localhost:8484`

## Pipe usage

```bash
# Push from stdin
echo "SELECT * FROM users LIMIT 10" | impri push --kind db.exec --title "Query users"

# JSON output for scripting
impri inbox --json | jq '.id'
impri list --status approved --json | jq -r '.id + " " + .kind'
```

## --wait for synchronous flows

```bash
impri push --kind email.send --title "Send report" --body "..." --wait --timeout 300
# Exits 0 on approval, 1 on rejection or timeout
```

## Building from source

```bash
cd sdk/typescript && npm install && npm run build
cd ../cli && npm install && npm run build
node dist/cli.js --help
```
