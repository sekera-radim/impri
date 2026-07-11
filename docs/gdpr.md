# GDPR & Data Management

Impri provides two GDPR-compliant data management endpoints under your project's admin scope: a full data export and a hard erasure. Both are project-scoped — cross-project data access is impossible regardless of the key used.

---

## Data export

`GET /v1/project/export` returns a JSON snapshot of everything stored under your project.

```http
GET /v1/project/export HTTP/1.1
Authorization: Bearer im_...
```

Response:

```json
{
  "exported_at": 1720000000,
  "project": {
    "id": "prj_...",
    "name": "My project",
    "timezone": "UTC",
    "created_at": 1719000000
  },
  "actions": [ ... ],
  "decisions": [ ... ],
  "watchers": [ ... ],
  "audit_log": [ ... ]
}
```

Included tables:
- `project` — name, timezone, created_at (no Stripe IDs or secrets)
- `actions` — all actions ever created for the project
- `decisions` — all approve/reject decisions linked to those actions
- `watchers` — all watcher definitions and their current state
- `audit_log` — full audit trail (see [Audit log](audit-log.md))

**Not included:**
- `api_keys` — contains argon2 hashes; key material is never exported
- `pii_log` — request IPs are stored separately and excluded from the export JSON (they are erased by `DELETE /v1/project/data`)
- `push_subscriptions` — browser push endpoint details

A `gdpr.export` audit event is written before the response is returned.

### Using the export

```bash
# Save the export to a file
curl -H "Authorization: Bearer im_..." \
     https://api.impri.dev/v1/project/export \
     -o export-$(date +%Y%m%d).json

# Or with the SDK:
export_data = client.export_project()
import json
with open("export.json", "w") as f:
    json.dump(export_data, f, indent=2)
```

---

## Data erasure

`DELETE /v1/project/data` performs a hard GDPR erasure. It wipes all user-generated content while preserving the project record and API keys so the account remains functional.

```http
DELETE /v1/project/data HTTP/1.1
Authorization: Bearer im_...
```

Response:

```json
{
  "erased": true,
  "actions": 142,
  "watchers": 5
}
```

**What is erased (irreversible):**
- All `actions` for the project
- All `decisions` linked to those actions
- All `webhook_deliveries` linked to those actions
- All `watchers` for the project
- All `watcher_items` (dedup state) for those watchers
- The entire `audit_log` for the project
- All `pii_log` rows (request IPs) for the project

**What is preserved:**
- The `projects` row (account identity, tier, Stripe link)
- All `api_keys` (so the account can still authenticate)
- `push_subscriptions` (browser push endpoints)

After erasure, a single `gdpr.erase` tombstone audit row is written. This is the only surviving audit record and confirms the erasure happened.

> **Warning: this operation is irreversible.** There is no soft-delete or recovery path. Export first if you need to retain data.

### SDK

```python
# Python
counts = client.erase_project_data()
print(f"Erased {counts['actions']} actions and {counts['watchers']} watchers")
```

```typescript
// TypeScript
const { actions, watchers } = await client.eraseProjectData()
console.log(`Erased ${actions} actions and ${watchers} watchers`)
```

---

## What data Impri stores

| Data | Where | Erasable |
|------|-------|----------|
| Action content (title, preview, payload) | `actions` table | Yes |
| Decisions (verdict, edited content) | `decisions` table | Yes |
| Webhook delivery attempts | `webhook_deliveries` table | Yes |
| Watcher definitions and hit dedup | `watchers`, `watcher_items` | Yes |
| Audit trail (events, actors, timestamps) | `audit_log` table | Yes (one tombstone survives) |
| Request IP addresses | `pii_log` table (separate) | Yes |
| API key hashes and prefixes | `api_keys` table | **No** (preserved for account continuity) |
| Project metadata (name, tier, Stripe ID) | `projects` table | **No** (preserved for account continuity) |

---

## Audit events

| Event | Trigger |
|-------|---------|
| `gdpr.export` | `GET /v1/project/export` called |
| `gdpr.erase` | `DELETE /v1/project/data` completed |

The `gdpr.erase` tombstone is written **after** the transaction that deletes all other audit rows, so it is not deleted by the erasure itself. It records the count of erased rows in the `data` field.

---

## Retention policy

By default, audit log rows are kept indefinitely (until a GDPR erasure). To enable automatic cleanup, set `AUDIT_RETENTION_DAYS=90` (or any positive integer) in the server environment. The scheduler purges rows older than that threshold during its maintenance pass.

See [Audit log](audit-log.md) for the full audit log reference.
