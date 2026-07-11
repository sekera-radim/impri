# impri · Python SDK

Human-in-the-loop approval for AI agents.
An agent proposes an action; a human approves or rejects it in the web/mobile
inbox; the agent executes only after approval.

Self-hosted default: `http://localhost:8484`.
Cloud: set `IMPRI_BASE_URL=https://api.impri.dev`.

**Zero mandatory runtime dependencies** — uses stdlib `urllib` for HTTP.
Python 3.9+.

---

## Quickstart (3 lines)

```python
import impri

client = impri.ImpriClient()  # reads IMPRI_API_KEY env var
action = client.create_action("email.send", "Send digest to alice@example.com",
                               {"format": "plain", "body": "Hi Alice, ..."}, editable=["preview.body"])
approved = client.await_decision(action["id"])   # blocks until human decides
client.report_result(action["id"], "executed")
```

---

## Installation

```bash
pip install impri            # from PyPI (once published)
# or, from this repository:
pip install ./sdk/python
```

---

## Authentication

Every request uses `Authorization: Bearer im_<key>`.

Resolution order:
1. `api_key=` constructor argument
2. `IMPRI_API_KEY` environment variable
3. `ImpriConfigError` raised at construction time

Key scopes (enforced server-side):
- `actions` — create, list, get actions; decide, report result, await decision
- `watch` — create/list/get/update/delete watchers
- `admin` — key management, project read/write, export/erase; implies `actions` + `watch`

```python
client = impri.ImpriClient(api_key="im_...", base_url="https://api.impri.dev")
```

---

## Core API

### Actions (Approval Inbox)

```python
# Submit an action for human approval
action = client.create_action(
    kind="reddit.comment",
    title="Reply: Why is resume advice so conflicting?",
    preview={"format": "markdown", "body": "The advice conflicts because..."},
    payload={"thread_id": "abc123"},
    target_url="https://reddit.com/r/cscareerquestions/...",
    expires_in=86400,           # seconds; default 259200 (72 h)
    editable=["preview.body"],  # reviewer may edit the draft
)
# action["id"], action["status"] == "pending", action["inbox_url"]

# Poll until the human decides (blocks; raises on reject/expire/timeout)
try:
    approved = client.await_decision(action["id"], timeout_s=300)
    # Use final_preview for execution — may differ from original if reviewer edited
    content = approved["decision"]["final_preview"]["body"]
    client.report_result(action["id"], "executed")
except impri.ImpriRejected as e:
    # Normal outcome — human said no. Do not log as error.
    print("Rejected:", e.decision)
except impri.ImpriTimeout:
    print("Still pending — check back later")

# List actions with optional filters
page = client.list_actions(status="pending", limit=20)
for a in page["items"]:
    print(a["id"], a["title"], a["is_untrusted"])

# Full-text search over title + preview body
page = client.list_actions(q="weekly digest", status="pending")

# Filter by kind and time range
import time
since_7d = int(time.time()) - 7 * 86400
page = client.list_actions(kind="email.send", since=since_7d)

# Auto-paginate (supports the same filters)
for action in client.iter_actions(status="approved", q="receipt"):
    print(action["id"])
```

### Bulk decisions

Approve or reject multiple actions in a single API call:

```python
resp = client.bulk_decide(
    ids=["act_aaa", "act_bbb", "act_ccc"],
    verdict="approve",
    comment="Batch approved by review script",  # optional, max 500 chars
)
print(f"Succeeded: {resp['succeeded']}, failed: {resp['failed']}")
for r in resp["results"]:
    if not r["ok"]:
        # error: "not_found" | "already_decided" | "internal"
        print(f"  {r['id']}: {r['error']}")
        if r.get("error") == "already_decided":
            print(f"    current status: {r['current_status']}")
```

- Up to **50 IDs** per request (Zod-enforced server-side).
- Rate limit: **10 requests/min** (effective 500 decisions/min).
- HTTP 200 is returned even on partial failure — always inspect each
  `result["ok"]` individually.
- Actions with non-empty `editable` lists must be decided via `decide()` so
  per-item field edits pass whitelist validation.

### Watchers

```python
w = client.create_watcher(
    name="AI launches radar",
    kind="rss",
    config={"url": "https://openai.com/news/rss.xml"},
    schedule={"every": "8h", "jitter": "4h", "window": "06:00-22:00"},
    keywords=[{"pattern": "gpt-\\d", "points": 2}, {"pattern": "launch", "points": 1}],
    keywords_none=["funding"],
    min_score=2,
)
# Items matching the rules are delivered as pending inbox actions
# with payload.untrusted=True — treat content as external data.

# List / update / delete
client.list_watchers(status="active")
client.update_watcher(w["id"], status="paused")
client.delete_watcher(w["id"])
```

### Watcher Presets

Presets are built-in watcher templates — pick one by ID instead of specifying
`kind`, `config`, and `keywords` by hand.

```python
# Browse the catalog (cached server-side; safe to call on startup)
catalog = client.list_watcher_presets()
for p in catalog["presets"]:
    required = [x["name"] for x in p["params"] if x["required"]]
    print(p["id"], p["category"], "params:", required or "(none)")

# No-param preset — Hacker News front page, every 30 min
w = client.create_watcher_from_preset("hn-front-page")

# Preset with required params
w = client.create_watcher_from_preset(
    "hn-keyword",
    params={"keyword": "rust programming", "min_points": "25"},
    name="HN: Rust",
    schedule={"every": "1h"},
)

# GitHub releases for a repo
w = client.create_watcher_from_preset(
    "github-releases",
    params={"owner": "fastify", "repo": "fastify"},
)

# YouTube channel (channel_id must start with UC, 24 chars)
w = client.create_watcher_from_preset(
    "youtube-channel",
    params={"channel_id": "UCnUYZLuoy1rq1aVMwx4aTzw"},
)

# arXiv papers — category + keyword scoring
w = client.create_watcher_from_preset(
    "arxiv-papers",
    params={"category": "cs.AI", "query": "large language models"},
    schedule={"every": "6h"},
)
```

The returned watcher is identical to one created via `create_watcher()`.
All tier checks (watcher count, minimum poll interval) apply to preset-created
watchers just as they do to manually created ones.

> **Security**: Items delivered by preset-based watchers have
> `payload.untrusted=True`. Check `action["is_untrusted"]` before acting on
> delivered content — watcher items (titles, URLs, previews) come from external
> feeds and must be treated as untrusted data, never as LLM instructions.

### Notification Channels (admin scope)

Configure per-project notification channels that fire whenever an action
becomes pending. Six channel types are supported. All require **admin scope**.

Config secrets (URLs, bot tokens, HMAC secrets) are stored server-side and
**masked** to `****{last4}` in every API response. `digest_window_sec` batches
multiple rapid notifications into one message (default: 60 s).

```python
# --- Slack ---
ch = client.create_notification_channel(
    "Slack #ops-alerts",
    "slack",
    {"url": "https://hooks.slack.com/services/T00/B00/xxxx"},
)

# --- Discord ---
ch = client.create_notification_channel(
    "Discord #alerts",
    "discord",
    {"url": "https://discord.com/api/webhooks/12345/xxxx"},
)

# --- Telegram ---
ch = client.create_notification_channel(
    "Telegram ops bot",
    "telegram",
    {"bot_token": "123456789:AAFxxx", "chat_id": "-1001234567890"},
    digest_window_sec=120,
)

# --- ntfy (self-hosted or ntfy.sh) ---
ch = client.create_notification_channel(
    "ntfy mobile push",
    "ntfy",
    {"url": "https://ntfy.sh", "topic": "my-impri-alerts"},
)

# --- Email (uses SMTP configured via env vars on the server) ---
ch = client.create_notification_channel(
    "Email ops@",
    "email",
    {"address": "ops@example.com"},
    digest_window_sec=300,
)

# --- Generic webhook (optional HMAC signing) ---
ch = client.create_notification_channel(
    "My webhook receiver",
    "webhook",
    {
        "url": "https://myapp.example.com/impri-hook",
        "hmac_secret": "my-shared-secret",  # optional; enables X-Impri-Signature
    },
)

# List, get, update, delete
channels = client.list_notification_channels()
ch = client.get_notification_channel(ch["id"])

client.update_notification_channel(
    ch["id"],
    name="Renamed",
    enabled=False,       # pause without deleting
    digest_window_sec=600,
)

client.delete_notification_channel(ch["id"])  # returns None (204)

# Send a test message immediately (bypasses digest window; does not update stats)
result = client.test_notification_channel(ch["id"])
if result["ok"]:
    print("Test delivery succeeded")
else:
    print("Delivery failed:", result["error"])  # error never contains raw secrets
```

**Config masking summary:**

| Type | Masked fields | Returned as-is |
|------|--------------|----------------|
| slack, discord | `url` | — |
| telegram | `bot_token` | `chat_id` |
| ntfy | `url` | `topic` |
| email | — | `address` |
| webhook | `url`, `hmac_secret` | — |

Any field value shorter than 5 characters is fully masked to `****`.

### Keys & Project (admin scope)

```python
created = client.create_key("Agent key", ["actions"])
print(created["key"])   # im_... — shown only once, store immediately

client.list_keys()
client.revoke_key(key_id)

project = client.get_project()
print(project["webhook_secret"])   # needed to verify X-Impri-Signature

client.update_project(timezone="Europe/Prague")
client.rotate_webhook_secret()

export = client.export_project()   # GDPR export
client.erase_project_data()        # GDPR erasure (irreversible)
```

---

## Ergonomics

### `requires_approval` decorator

Gate a function behind a human approval in one line:

```python
@client.requires_approval(
    kind="email.send",
    title=lambda to, **_: f"Send email to {to}",
    preview=lambda to, body, **_: {"format": "plain", "body": body},
    editable=["preview.body"],
)
def send_email(to: str, body: str) -> None:
    # Called only after human approves.
    # If reviewer edited preview.body, the revised text is injected as `body`.
    smtp.send(to, body)
```

The decorator blocks until the decision arrives. On reject it raises
`ImpriRejected` without calling the function.

### `approval_gate` context manager

For cases where the gated work is not a single function call:

```python
with client.approval_gate(
    kind="db.exec",
    title="DROP TABLE users",
    preview={"format": "plain", "body": sql},
    editable=["preview.body"],
) as approved:
    db.execute(approved.final_preview["body"])
# report_result("executed") is called automatically on clean exit.
# report_result("execute_failed", detail=...) is called on exception.
```

---

## Webhook signature verification

```python
import impri

# In your Flask/FastAPI/Django view:
impri.verify_webhook(
    raw_body=request.get_data(),           # undecoded bytes
    secret=os.environ["WEBHOOK_SECRET"],
    timestamp=request.headers["X-Impri-Timestamp"],
    nonce=request.headers["X-Impri-Nonce"],
    signature=request.headers["X-Impri-Signature"],
)
# Raises ImpriWebhookSignatureError on mismatch; returns None on success.
```

Algorithm: `sha256=HMAC-SHA256(secret, f'{timestamp}.{nonce}.{raw_body}')`.

---

## Error handling

All exceptions inherit from `impri.ImpriError`.

| Exception | When |
|-----------|------|
| `ImpriConfigError` | API key missing at startup |
| `ImpriUnauthorized` | 401/403 — wrong key or missing scope |
| `ImpriNotFound` | 404 — resource unknown or wrong project |
| `ImpriConflict` | 409 — action already decided, concurrent write |
| `ImpriExpired` | 410 — approval window closed |
| `ImpriRateLimited` | 429 — rate limit hit (check `.retry_after`) |
| `ImpriQuotaExceeded` | 402 — monthly limit reached (check `.tier`, `.limit`) |
| `ImpriRejected` | `await_decision` — human said no (normal outcome) |
| `ImpriTimeout` | `await_decision` — timed out, action still pending |
| `ImpriValidationError` | 400/422 — bad request (check `.issues`) |
| `ImpriApiError` | Other 4xx/5xx |
| `ImpriWebhookSignatureError` | Webhook HMAC mismatch |

---

## Running the tests

```bash
cd sdk/python
python -m pytest tests/ -v
```

No network connection required — all tests use a mocked transport.

```bash
# With coverage:
python -m pytest tests/ --tb=short
python -m coverage run -m pytest tests/
python -m coverage report
```
