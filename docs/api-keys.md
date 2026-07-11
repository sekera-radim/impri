# API Keys

Every request to the Impri API is authenticated with a Bearer token that looks like `im_<base64url>`. Keys are project-scoped, have one or more scopes, and are stored as argon2 hashes — the raw value is shown **exactly once** at creation and never stored in plain text.

---

## Scopes

| Scope | What it unlocks |
|-------|----------------|
| `actions` | Create and poll actions (`POST /v1/actions`, `GET /v1/actions`, `GET /v1/actions/:id`, `POST /v1/actions/:id/decision`, `POST /v1/actions/bulk-decision`, `POST /v1/actions/:id/result`). Also required for web push subscribe/unsubscribe. |
| `watch` | Manage watchers and presets (`POST/GET/PATCH/DELETE /v1/watchers`, `GET /v1/watcher-presets`, `POST /v1/watchers/from-preset`). |
| `admin` | Key management, project settings, rules, notification channels, audit log, billing, GDPR export/erase. **Implies `actions` and `watch`.** |

Use the narrowest scope for each purpose:

- Agent loops that only submit and poll actions → `actions`
- Watcher management scripts → `watch`
- Admin tooling, dashboards, or CLI sessions → `admin`

---

## Bootstrap key

On the very first server start, Impri prints a bootstrap admin key and project ID to stdout:

```
[impri] Bootstrap complete.
  project: prj_...
  admin key: im_...   ← copy this now; it is printed once
```

The raw key value is shown once and never again. Store it immediately. If you lose it, create a new key via the web inbox settings or the CLI.

---

## API reference

All key endpoints require the **`admin`** scope.

### `POST /v1/keys` — create a key

```http
POST /v1/keys HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{
  "name": "CI deploy key",
  "scopes": ["actions"]
}
```

`name`: human-readable label (required). `scopes`: one or more of `"actions"`, `"watch"`, `"admin"` (required).

Response `201`:

```json
{
  "id":         "key_abc123",
  "name":       "CI deploy key",
  "key":        "im_...",
  "prefix":     "im_A1B2C3D4",
  "scopes":     ["actions"],
  "project_id": "prj_...",
  "created_at": 1720000000,
  "note":       "Store this key securely — it will not be shown again."
}
```

The `key` field contains the raw `im_...` value. **This is the only time it is returned.** Save it to a secrets manager or environment variable immediately. Only `prefix` (first 16 characters) is stored after this point.

An `key.created` audit event is recorded (stores key ID, name, scopes — never the raw value).

---

### `GET /v1/keys` — list keys

```http
GET /v1/keys HTTP/1.1
Authorization: Bearer im_...
```

Response:

```json
{
  "items": [
    {
      "id":          "key_abc123",
      "project_id":  "prj_...",
      "prefix":      "im_A1B2C3D4",
      "name":        "CI deploy key",
      "scopes":      ["actions"],
      "created_at":  1720000000,
      "last_used_at": 1720100000,
      "revoked":     false
    }
  ]
}
```

Revoked keys are included in the list with `"revoked": true`. Raw key values are never returned.

---

### `DELETE /v1/keys/:id` — revoke a key

```http
DELETE /v1/keys/key_abc123 HTTP/1.1
Authorization: Bearer im_...
```

Returns `204 No Content`. The key is permanently invalidated — subsequent requests using it receive `401`. A `key.revoked` audit event is recorded.

Returns `404` if the key does not exist, already has been revoked, or belongs to a different project.

---

## Key lifecycle

```
Created (raw key shown once)
  → In use (last_used_at updated on each request)
  → Revoked (DELETE /v1/keys/:id)
```

There is no "suspend" state — keys are either active or permanently revoked. To rotate, create a new key, update your deployments, then revoke the old one.

---

## Security notes

- Keys are stored as **argon2** hashes. Even with full database access, the raw key cannot be recovered.
- The prefix (`im_A1B2C3D4`) is stored in plain text for display purposes only — it is not enough to authenticate.
- Every key creation and revocation is recorded in the audit log with the acting key's ID.
- Key material never appears in audit log rows, notification channel config, or error responses.
- The `admin` scope gives full control of the project — including the ability to create new admin keys. Treat admin keys with the same care as database credentials.

---

## CLI

```bash
impri keys list                            # list all keys
impri keys create --name "bot" --scopes actions
impri keys revoke key_abc123 [--yes]      # skip confirmation prompt with --yes
```

See [CLI reference](cli.md) for full options.
