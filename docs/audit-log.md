# Audit Log

Impri keeps an append-only audit trail of every significant action taken on a
project. The log is designed for compliance review, incident investigation, and
change accountability. It covers the approval lifecycle, key management,
watcher operations, rule changes, notification channel changes, and GDPR
operations.

## Current implementation status

All recording points, query/export API endpoints, and the retention prune job
described in this document are **live** in the current codebase. The schema and
security model are fully implemented.

---

## Schema

Two tables underlie the audit system.

### `audit_log` — immutable trail

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | Monotone within the instance |
| `project_id` | TEXT | Always the authenticated key's project |
| `action_id` | TEXT nullable | Set for action-lifecycle events; NULL for administrative events |
| `event` | TEXT | Event name, e.g. `action.approved` |
| `actor` | TEXT nullable | Key ID of the authenticated caller; NULL for system-generated events (expiry, watcher scheduler) |
| `channel` | TEXT nullable | Decision channel: `web`, `api`, `bulk-web`, `bulk-api` |
| `data` | TEXT nullable | JSON blob with event-specific detail (never contains secrets) |
| `created_at` | INTEGER | Unix seconds |

The `ip` column exists in the schema but is intentionally left NULL on write.
Request IPs are written exclusively to `pii_log`.

### `pii_log` — erasable PII

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `project_id` | TEXT | |
| `action_id` | TEXT nullable | |
| `event` | TEXT | Mirrors the triggering audit event name |
| `ip` | TEXT | Request IP of the caller |
| `created_at` | INTEGER | Unix seconds |

Keeping IPs in a separate table means they can be wiped under GDPR Art. 17
(`DELETE /v1/project/data`) without touching the immutable `audit_log` rows.
The audit trail stays intact; only the PII disappears.

---

## Event types

### Action lifecycle

| Event | Recorded | `action_id` | `actor` | `data` |
|-------|----------|-------------|---------|--------|
| `action.created` | Yes — `actions.ts:181` | set | key ID | — |
| `action.rule_applied` | Yes — `actions.ts:186` | set | NULL | `{rule_id, rule_name, outcome}` |
| `action.approved` | Yes — `actions.ts:580` (single) / `actions.ts:388` (bulk) | set | key ID | — |
| `action.rejected` | Yes — same locations | set | key ID | — |
| `action.expired` | Yes — `webhooks.ts:176`, atomically with the status UPDATE | set | NULL (system) | — |
| `action.executed` | Yes — `actions.ts:650` | set | NULL | `{detail}` |
| `action.execute_failed` | Yes — `actions.ts:650` | set | NULL | `{detail}` |

The `channel` column on decision events distinguishes `api` (single decision),
`web` (single decision via inbox), `bulk-api`, and `bulk-web`.

### Key management

| Event | Recorded | `actor` | `data` |
|-------|----------|---------|--------|
| `key.created` | Yes — `keys.ts:46` | calling key ID | `{new_key_id, name, scopes}` |
| `key.revoked` | Yes — `keys.ts:103` | calling key ID | `{revoked_key_id}` |

Raw key material and hashes are never stored in `data`.

### Watcher lifecycle

| Event | Recorded | `actor` | `data` |
|-------|----------|---------|--------|
| `watcher.created` | Yes — `watchers.ts:100` | key ID | `{watcher_id, kind, name}` |
| `watcher.updated` | Yes — `watchers.ts:264` | key ID | `{watcher_id}` |
| `watcher.deleted` | Yes — `watchers.ts:293` | key ID | `{watcher_id}` |
| `watcher.hit` | Yes — `scheduler.ts:448`, written when a new inbox action is created by the watcher | NULL (system) | `{watcher_id}` |

### Approval rules

| Event | Recorded | `actor` | `data` |
|-------|----------|---------|--------|
| `rule.created` | Yes — `rules.ts:90` | key ID | — |
| `rule.updated` | Yes — `rules.ts:178` | key ID | — |
| `rule.deleted` | Yes — `rules.ts:207` | key ID | `{rule_id}` |

### Notification channels

| Event | Recorded | `actor` | `data` |
|-------|----------|---------|--------|
| `channel.created` | Yes — `notification-channels.ts:153` | key ID | `{channel_id, type}` |
| `channel.updated` | Yes — `notification-channels.ts:246` | key ID | `{channel_id, type}` |
| `channel.deleted` | Yes — `notification-channels.ts:277` | key ID | `{channel_id}` |
| `channel.tested` | Yes — `notification-channels.ts:329` | key ID | `{channel_id, type, ok}` |

Channel config (Slack tokens, webhook URLs, Telegram bot tokens) is never
written to any audit row.

### Project operations

| Event | Recorded | `actor` | `data` |
|-------|----------|---------|--------|
| `project.updated` | Yes — `project.ts:63` | key ID | `{fields_changed: [...]}` |
| `project.secret_rotated` | Yes — `project.ts:83` | key ID | — (old/new secrets never stored) |
| `gdpr.export` | Yes — `project.ts:100` | key ID | — |
| `gdpr.erase` | Yes — `project.ts:145` **after** the transaction | key ID | `{erased_actions, erased_watchers}` |

The `gdpr.erase` row is written after the transaction that wipes all project
audit rows. This leaves exactly one surviving audit row for the project — a
tombstone showing that an erasure occurred and who requested it.

---

## Query API

```
GET /v1/audit
```

Requires `admin` scope. Returns events for the authenticated key's project only
(project ID is never taken from the query string).

### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by exact event name (`action.approved`) or dot-prefix (`action.` matches all `action.*` events) |
| `actor` | string | Filter by `actor` column value (key ID) |
| `entity_id` | string | Match `action_id` for action events; for non-action events also matches `rule_id`, `channel_id`, `watcher_id`, `new_key_id`, or `revoked_key_id` inside `data` via `json_extract` |
| `since` | integer | `created_at >= since` (unix seconds) |
| `until` | integer | `created_at <= until` (unix seconds) |
| `limit` | integer | Page size; default 50, max 200 |
| `cursor` | string | Opaque keyset cursor (base64url-encoded `(created_at, id)` pair, descending) |

### Response

```json
{
  "items": [
    {
      "id": 1234,
      "event": "action.approved",
      "action_id": "act_...",
      "actor": "key_...",
      "channel": "web",
      "data": { "rule_id": "rul_..." },
      "created_at": 1720000000
    }
  ],
  "has_more": false,
  "next_cursor": "base64url..."
}
```

The `ip` column is never returned (it lives in `pii_log`). `project_id` is
implicit. `data` is parsed from JSON before serialization.

### Pagination

Pass `next_cursor` from one response as `cursor` in the next request. Cursor
encodes `(created_at, id)` descending using the same `encodeCursor` /
`decodeCursor` pattern used by `GET /v1/actions` and `GET /v1/watchers`.
Predicate: `created_at < cTs OR (created_at = cTs AND id < cId)`.

---

## Export API

```
GET /v1/audit/export
```

Requires `admin` scope. Same project isolation as the query API.

### Query parameters

All filters from `GET /v1/audit` (`type`, `actor`, `entity_id`, `since`,
`until`) plus:

| Parameter | Type | Description |
|-----------|------|-------------|
| `format` | string | `json` (default) = newline-delimited JSON (NDJSON, one object per line); `csv` = RFC 4180 CSV with header row |

### Response headers

```
Content-Type: application/x-ndjson          (format=json)
Content-Type: text/csv; charset=utf-8       (format=csv)
Content-Disposition: attachment; filename="audit-export-<project_id>-<iso_date>.json"
```

### Columns

`id`, `event`, `action_id`, `actor`, `channel`, `data` (JSON string), `created_at`.
The `ip` column is excluded. `project_id` is excluded (implicit).

### Streaming

The response streams row-by-row using `better-sqlite3`'s `.iterate()` so large
exports do not buffer the full result set in process memory.

### Rate limit

5 requests / min per API key (`checkRateLimit`) to prevent export storms or
full-table-scan abuse.

### Retention boundary

When `AUDIT_RETENTION_DAYS` is configured, the export query adds
`AND created_at >= (now - retention_days * 86400)` so exported data matches the
live retention window.

---

## Retention

Configuration is via environment variables (no-op when unset, which is the
self-host default):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIT_RETENTION_DAYS` | unset (unlimited) | Prune audit rows older than N days |
| `PII_RETENTION_DAYS` | same as `AUDIT_RETENTION_DAYS` | Prune `pii_log` rows (often set shorter) |

**Enforcement:** a prune job runs alongside the existing
`runExpiryTick` loop (`webhooks.ts:161`, via `pruneAuditLogs`):

```sql
DELETE FROM audit_log WHERE created_at < (strftime('%s','now') - AUDIT_RETENTION_DAYS * 86400);
DELETE FROM pii_log   WHERE created_at < (strftime('%s','now') - PII_RETENTION_DAYS  * 86400);
```

The prune is instance-wide (all projects) and opt-in (no-op without the env
var).

**GDPR erase** (`DELETE /v1/project/data`) remains the only path to wipe a
specific project's audit history on demand, regardless of retention config.

Cloud tiers can enforce retention by setting `AUDIT_RETENTION_DAYS` per-tier at
deploy time (e.g. free=30 days, indie=180 days, team=unlimited). This is a
billing policy concern; the prune mechanism is the same regardless of tier.

---

## Security model

### Admin scope required

All audit endpoints (`GET /v1/audit`, `GET /v1/audit/export`) call
`hasScope(key.scopes, 'admin')` and return 403 otherwise. This matches the
pattern used by `/v1/keys`, `/v1/rules`, and `/v1/notification-channels`.

### Project isolation

Every query and export binds `project_id = key.projectId` derived from the
authenticated key — never from the request body or query string. A key for
project A cannot read project B's audit rows even if it knows the project ID.

### No secret content in rows

Notification channel configs (Slack tokens, webhook URLs, Telegram bot tokens)
are never written to `audit_log`. Channel events store only `channel_id` and
`type`. API key events store only the key ID and granted scopes, never the raw
secret or its hash. Webhook signing secrets are never logged. The
`channel.tested` event stores only `channel_id`, `type`, and `ok` (boolean).
Every new recording point must be reviewed against this rule before merging.

### Append-only guarantee

No `UPDATE` or `DELETE` routes exist on individual `audit_log` rows. The only
write path is `INSERT`. The only bulk wipe is GDPR erase
(`DELETE WHERE project_id = ?`). Query and export APIs are strictly read-only.

### PII separation

Request IPs go to `pii_log`, not `audit_log`. The `ip` column in `audit_log`
exists in the schema but is kept NULL on all current write paths. The export
API never surfaces this column. Dropping the column in a future migration would
make the separation unambiguous at the schema level.

### Streamed export

The export endpoint uses `better-sqlite3`'s `.iterate()` cursor to avoid
accumulating potentially large result sets in server RAM.

### Rate-limited export

`GET /v1/audit/export` is rate-limited (5 req/min per key) to prevent
export-based data exfiltration at high throughput or denial-of-service via
repeated full-table scans.

---

## GDPR export vs. audit export

These are different endpoints with different purposes:

| | `GET /v1/project/export` | `GET /v1/audit/export` |
|-|--------------------------|----------------------------------|
| Scope | All project data: actions, decisions, watchers, audit rows | Audit rows only |
| Filtering | None — full dump | Type, actor, entity, time range |
| Streaming | No (buffered) | Yes (`.iterate()`) |
| Format | JSON object | NDJSON or CSV |
| Purpose | GDPR data portability | Compliance / incident review |

The existing `GET /v1/project/export` already includes `audit_log` rows as a
raw array. It is sufficient for small projects and GDPR portability requests.
The planned `GET /v1/audit/export` adds streaming, filtering, and format
options for larger datasets.
