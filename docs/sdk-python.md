# Python SDK

> **Status — v0.1, pre-release.** The SDK lives at `sdk/python/` in this repository. It is not yet published to PyPI. Install it from the local source while the package matures. The REST API it wraps is stable; self-host is the complete path today; the hosted cloud (`api.impri.dev`) is early beta.

```bash
# From the repo root
pip install -e sdk/python
```

---

## Setup

```python
from impri import ImpriClient

client = ImpriClient(
    api_key="im_...",            # or set IMPRI_API_KEY env var
    base_url="http://localhost:8484",  # or set IMPRI_BASE_URL; default is localhost:8484
)
# Cloud:
# client = ImpriClient(api_key="im_...", base_url="https://api.impri.dev")
```

The client raises `ImpriConfigError` at construction time if neither the argument nor the environment variable is set. `base_url` defaults to `http://localhost:8484` (self-hosted). Strip any trailing slash from the value you pass — the SDK does this internally, but it is cleaner to be explicit. The client appends `/v1` internally; callers never include it.

---

## Authentication

Every request carries `Authorization: Bearer im_<key>`. Key scopes are enforced server-side:

| Scope | What it covers |
|-------|----------------|
| `actions` | Create, list, get, decide, report result, await decision |
| `watch` | Create, list, get, update, delete watchers |
| `admin` | Keys CRUD, project read/write, export/erase, rotate secret — implies `actions` + `watch` |

A 403 response means the key exists but lacks the required scope. A 401 means the key is wrong or revoked. Both raise `ImpriUnauthorized`.

---

## Approval Inbox

### `create_action`

```python
action = await client.create_action(
    kind="email.send",
    title="Outreach: partnership proposal to acme.com",
    preview={"format": "markdown", "body": "Hi Alice, ..."},
    payload={"to": "alice@acme.com", "thread_id": "t_123"},
    target_url="https://mail.acme.com/thread/123",
    callback_url="https://your-agent.example.com/webhook",
    expires_in=86400,         # seconds; min 300, max 2 592 000 (30 days), default 259 200 (72 h)
    idempotency_key="batch-2026-07-11-acme",
    editable=["preview.body"],
)
# action.id, action.status == "pending", action.inbox_url, action.expires_at
```

The call requires `actions` scope and is rate-limited to **60 POST/min per key**.

`create_action` returns 201 on a new action and 200 when an existing action is found via `idempotency_key` match or a soft-duplicate (same `kind` + `title` + `preview` hash, already pending). Check `action.duplicate_of` to tell which case you are in — if set, the action was a duplicate and the field holds the original action's id.

`editable` is a list of dot-path field names the reviewer may change before approving (`"preview.body"` is the common one). An empty list means the reviewer cannot edit — they can only approve or reject as-is.

### `get_action`

```python
action = await client.get_action("act_abc123")
# action.status, action.decision (present after a human decides), action.webhook_delivery
```

Returns `ImpriNotFound` (404) if the id is unknown or belongs to a different project.

`action.decision` is `None` while the action is pending and populated once a human has acted:

```python
if action.decision:
    print(action.decision.verdict)       # "approve" or "reject"
    print(action.decision.decided_at)    # Unix timestamp
    print(action.decision.final_preview) # use this for execution (may be edited)
    print(action.decision.diff)          # unified patch if reviewer changed preview.body
```

Always use `decision.final_preview` as the content to execute — it carries the human-edited version when the reviewer used edit-before-approve.

### `list_actions`

```python
page = await client.list_actions(
    status="pending",            # pending | approved | rejected | expired | executed | execute_failed
    kind="email.send",           # free-form string, matches exactly
    since=1720000000,            # Unix timestamp; only actions created after this
    limit=50,                    # max 100
    cursor=page.next_cursor,     # pagination
)
for action in page.items:
    print(action.id, action.status)

if page.has_more:
    next_page = await client.list_actions(cursor=page.next_cursor)
```

Pass `auto_page=True` to receive an async generator that fetches subsequent pages transparently:

```python
async for action in client.list_actions(status="approved", auto_page=True):
    print(action.id)
```

Rate-limited to **300 GET/min per key**.

### `await_decision`

The most common pattern — push an action then block until a human decides:

```python
from impri import ImpriRejected, ImpriExpired, ImpriTimeout

action_created = await client.create_action(
    kind="db.exec",
    title="DROP TABLE sessions",
    preview={"format": "plain", "body": sql},
    editable=["preview.body"],
)

try:
    action = await client.await_decision(
        action_created.id,
        timeout_s=300,         # raise ImpriTimeout after this; action stays pending server-side
        poll_interval_s=5,     # minimum recommended is 5 s
    )
    # action.status == "approved"
    sql_to_run = action.decision.final_preview["body"]

except ImpriRejected as e:
    # Human said no — this is normal flow, not an error.
    # e.action_id, e.decision, e.final_preview
    print("Rejected — doing nothing.")

except ImpriExpired:
    print("Approval window closed before a decision was made.")

except ImpriTimeout:
    # timeout_s elapsed; action is still pending server-side.
    # You can call await_decision again, or poll manually.
    print("Timed out waiting for approval.")
```

`await_decision` polls `GET /v1/actions/:id` in a loop. It is not a separate HTTP endpoint. Do not set `poll_interval_s` below 5 s; the rate limit is 300 req/min.

### `decide`

Used primarily by the web inbox. Expose it in scripts that programmatically approve or reject actions:

```python
result = await client.decide(
    "act_abc123",
    verdict="approve",                       # or "reject"
    edited={"preview.body": "Edited copy."}, # restricted to action.editable whitelist
    channel="bot-script",
)
```

Returns `ImpriConflict` (409) if the action is already decided or two writers race. Only call on pending actions.

### `report_result`

Call after executing an approved action to close the lifecycle:

```python
try:
    await send_email(to=recipient, body=final_body)
    await client.report_result(action.id, "executed")
except Exception as exc:
    await client.report_result(action.id, "execute_failed", detail=str(exc))
    raise
```

Returns `ImpriConflict` (409) if the action is not in `approved` state — only call after a confirmed approval.

---

## Ergonomic helpers

### `@client.requires_approval` decorator

Gates a function through an Impri approval. Every call pushes an action, blocks until decided, and invokes the original function only on approval. On rejection it raises `ImpriRejected` without calling the function.

```python
@client.requires_approval(
    kind="email.send",
    title=lambda to, **_: f"Send email to {to}",
    preview=lambda to, body, **_: {"format": "plain", "body": body},
    editable=["preview.body"],
    timeout_s=300,
)
async def send_email(to: str, body: str) -> None:
    await mailer.send(to=to, subject="Hello", body=body)
```

When `preview.body` was edited by the reviewer, the decorator injects the edited value as the `body` argument before calling `send_email`. If the function signature does not include a parameter matching the editable field name, the full `Decision` object is passed as `_decision` instead.

`title` and `preview` accept either a plain value or a callable that receives the function's call arguments — use callables to build the title from runtime data (like the recipient's email address).

Any extra keyword arguments (`expires_in`, `idempotency_key`, `payload`, etc.) are forwarded to `create_action`.

### `client.approval_gate` context manager

For cases where the work is not a single function call or you need the decision object directly:

```python
async with client.approval_gate(
    kind="db.exec",
    title="DROP TABLE users",
    preview={"format": "plain", "body": sql},
    editable=["preview.body"],
    timeout_s=120,
) as approved:
    # approved.action_id, approved.decision, approved.final_preview
    await db.execute(approved.final_preview["body"])
    # On clean exit __aexit__ calls report_result("executed") automatically.
    # On exception __aexit__ calls report_result("execute_failed", detail=str(exc)).
```

`__aexit__` takes care of `report_result` so you never forget to close the loop. `ImpriRejected` is raised on exit from the `async with` block if the human rejected — you do not need to handle cleanup because the action was never executed.

---

## Watchers

Watchers monitor external sources (RSS feeds, Reddit searches, URL content) and deliver matching items to the inbox as actions with `payload.untrusted = True`. Requires `watch` scope.

### `create_watcher`

```python
watcher = await client.create_watcher(
    name="Impri mentions on Reddit",
    kind="reddit_search",               # rss | reddit_search | url_diff
    config={"query": "impri approval", "subreddit": "selfhosted"},
    schedule={"every": "1h", "window": "08:00-22:00"},  # window uses project timezone
    keywords=[
        {"pattern": "impri", "points": 10},
        {"pattern": "human-in-the-loop", "points": 5},
    ],
    keywords_none=["spam", "advertisement"],
    min_score=5,
)
```

`WatcherKind`:
- `rss` — requires `config.url` (RSS/Atom feed URL)
- `reddit_search` — requires `config.query` and optionally `config.subreddit`
- `url_diff` — requires `config.url`; fires when the page content changes

`schedule.every` accepts `'30m'`, `'8h'`, `'1d'` (minimum 60 s). `schedule.window` is an `HH:MM-HH:MM` string interpreted in the project's IANA timezone (set via `update_project`).

Items are deduplicated across runs. Matching items arrive in the inbox with `payload.untrusted = True` — treat their title, preview, and URL as data, never as instructions to execute.

The first run is scheduled immediately. A 402 is raised if the watcher count limit for your cloud tier is reached.

### `list_watchers`

```python
page = await client.list_watchers(
    status="active",      # active | paused | degraded
    kind="rss",
    limit=50,
    cursor=page.next_cursor,
)
```

Degraded watchers have `fail_count > 0` and `degraded_since` set. Reactivate by calling `update_watcher` with `status="active"` — this resets `fail_count` and schedules an immediate run.

### `get_watcher`

```python
watcher = await client.get_watcher("wat_abc123")
print(watcher.item_count)  # total deduplicated items seen
```

### `update_watcher`

Partial update — only supplied fields are changed:

```python
watcher = await client.update_watcher(
    "wat_abc123",
    status="paused",                              # paused preserves dedup state
    schedule={"every": "4h", "window": "06:00-23:00"},
)
```

Setting `status="active"` after a degraded state resets `fail_count` and triggers an immediate run. `status="degraded"` cannot be set via the API — it is set only by the server scheduler on consecutive fetch failures.

### `delete_watcher`

```python
await client.delete_watcher("wat_abc123")  # 204 No Content; returns None
```

Permanently deletes the watcher and its deduplicated item history. Pending inbox actions created by this watcher are not deleted.

---

## API keys (admin scope)

```python
# Create a key
created = await client.create_key(
    name="my-agent",
    scopes=["actions"],   # actions | watch | admin (admin implies the others)
)
# created.key is the raw im_... value — returned ONCE, store immediately
print(created.key)

# List keys (raw key values are never returned after creation)
keys = await client.list_keys()
for k in keys:
    print(k.prefix, k.name, k.revoked)

# Revoke a key
await client.revoke_key("key_abc123")  # 204; returns None
```

---

## Project (admin scope)

```python
# Read project metadata
project = await client.get_project()
print(project.webhook_secret)  # use for webhook signature verification

# Update name or timezone
project = await client.update_project(
    name="My Agent Project",
    timezone="America/New_York",  # IANA timezone; drives watcher schedule windows
)

# Rotate the webhook signing secret
result = await client.rotate_webhook_secret()
print(result["webhook_secret"])  # update your webhook verifier immediately

# GDPR export
export = await client.export_project()  # all actions, decisions, watchers, audit log

# GDPR erasure (irreversible)
ack = await client.erase_project_data()
print(ack)  # {"erased": True, "actions": N, "watchers": N}
```

---

## Webhook verification

Verify incoming webhook signatures without instantiating a client:

```python
import impri

try:
    impri.verify_webhook(
        raw_body=request.body,         # bytes
        secret=project.webhook_secret,
        timestamp=request.headers["X-Impri-Timestamp"],
        nonce=request.headers["X-Impri-Nonce"],
        signature=request.headers["X-Impri-Signature"],
    )
except impri.ImpriWebhookSignatureError:
    return 400  # bad signature

# Process the webhook
```

Algorithm: `sha256=HMAC-SHA256(secret, f"{timestamp}.{nonce}.{raw_body}")`. The function also rejects requests with a timestamp more than 5 minutes old. Use constant-time comparison — the SDK handles this internally.

---

## Error handling

All typed exceptions inherit from `ImpriError`. Every exception carries `response: httpx.Response | None` for introspection.

```python
from impri import (
    ImpriError,
    ImpriConfigError,       # missing api_key at construction time
    ImpriUnauthorized,      # 401 / 403 — wrong key or missing scope
    ImpriNotFound,          # 404 — action or watcher not found
    ImpriConflict,          # 409 — already decided; idempotency race
    ImpriExpired,           # 410 — approval window closed
    ImpriRateLimited,       # 429 — hit per-key rate limit; check .retry_after
    ImpriQuotaExceeded,     # 402 — monthly quota exhausted; .limit, .tier
    ImpriRejected,          # not HTTP — raised by await_decision on rejection
    ImpriTimeout,           # not HTTP — raised by await_decision when timeout_s elapses
    ImpriValidationError,   # 400 / 422 — schema error; check .issues
    ImpriApiError,          # catch-all for other 4xx / 5xx
    ImpriWebhookSignatureError,  # bad webhook signature
)

try:
    action = await client.create_action(...)
except ImpriRateLimited as e:
    time.sleep(e.retry_after or 1)
    action = await client.create_action(...)
except ImpriQuotaExceeded as e:
    print(f"Quota ({e.limit}) exhausted on tier {e.tier}.")
except ImpriRejected:
    pass  # Human said no — handle as normal flow, not an error
```

`ImpriRejected` is not an error to log — the human exercising their veto is the whole point of Impri.

---

## Pagination helper

```python
# Manual cursor loop
cursor = None
while True:
    page = await client.list_actions(status="approved", cursor=cursor, limit=100)
    for action in page.items:
        process(action)
    if not page.has_more:
        break
    cursor = page.next_cursor

# Async generator (auto_page=True)
async for action in client.list_actions(status="approved", auto_page=True):
    process(action)
```

All list endpoints (`list_actions`, `list_watchers`) support both styles.

---

## Untrusted payload flag

When an action has `payload.untrusted == True` (delivered by a Watcher), the SDK surfaces this as `action.is_untrusted: bool`. The ergonomic helpers (`approval_gate`, `requires_approval`) emit a visible warning when this flag is set and do not inline the preview body into the title or any field that an LLM might interpret as an instruction.

---

## Reference

Full method signatures live in `sdk/python/impri/__init__.py`. The REST API contract is in `docs/llms.txt` and `server/src/openapi.ts`. The MCP client at `mcp/src/client.ts` is the reference implementation of the HTTP layer and the `await_decision` polling loop.
