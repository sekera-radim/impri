# Account Recovery

Impri is intentionally anonymous — no email address, no password. Your API key is the only credential. If you lose all your keys, this guide explains how to recover access using a **recovery code**.

## How it works

When a project is created (via `POST /v1/signup` or first-run bootstrap), a recovery code is generated alongside the API key. Both are printed **once** and never stored in plaintext.

The recovery code lets you call `POST /v1/recover` to:

1. Verify your identity without needing an API key.
2. Mint a new admin key.
3. Rotate the recovery code (so the used code is immediately invalidated).

Both the new key and a new recovery code are returned in the response — **store them before closing the response**.

## Recovery code format

```
imr_<32-character base64url random string>
```

Example: `imr_ABcDEfgHiJkLmNopQrStUvwX`

## Getting a recovery code

### At signup

`POST /v1/signup` returns `recovery_code` alongside `key`:

```json
{
  "key": "im_…",
  "project_id": "proj_…",
  "recovery_code": "imr_…",
  "note": "Store this key and recovery code securely — they will not be shown again."
}
```

### Via the dashboard

Open the dashboard, click the **shield icon** in the top-right header, or dismiss the setup banner that appears when no recovery code is set.

### Via the API

```http
POST /v1/recovery-code
Authorization: Bearer im_<admin-key>
```

Response:
```json
{
  "recovery_code": "imr_…",
  "note": "Store this code securely…"
}
```

Generating a new code **invalidates** any previous code. Requires `admin` scope.

## Recovering access

### Via the login screen

Click **"Lost your key?"** on the login screen, enter your project ID and recovery code, and click **"Recover access"**. The UI will display a new API key and a new recovery code — save both.

### Via the API

```http
POST /v1/recover
Content-Type: application/json

{
  "project_id": "proj_…",
  "recovery_code": "imr_…"
}
```

Response (200):
```json
{
  "key": "im_…",
  "recovery_code": "imr_…",
  "project_id": "proj_…",
  "note": "Store the new key and recovery code securely — they will not be shown again."
}
```

This endpoint is **public** (no `Authorization` header needed).

### What happens to existing keys?

Recovery does **not** revoke your existing keys. If you lost them, that is fine — they are still valid if you did not compromise them. The recovery endpoint simply mints a new admin key alongside your existing ones. If you believe your keys were compromised, revoke them via `DELETE /v1/keys/:id` after recovering.

## Rate limits

| Endpoint | Limit | Scope |
|---|---|---|
| `POST /v1/recover` | 5/min per IP | public |
| `POST /v1/recover` | 5/min per project_id | public |
| `POST /v1/recovery-code` | 10/min per API key | admin |

## Self-hosted instances

On a self-hosted single-tenant instance you also have direct database access. If you lose both your API key and recovery code:

1. Open the SQLite database (default: `impri.db`).
2. Run: `SELECT id, name FROM projects;` to find your project.
3. Use the bootstrap flow: if there are no active keys, the server prints a new admin key on startup — but only when the `api_keys` table is empty. You can revoke all keys via SQL and restart.

Or use the Impri CLI (if installed): `impri reset-key --project proj_…`.

## Security notes

- The recovery code is hashed with argon2 in the database — the plaintext is never stored or logged.
- The `/v1/recover` endpoint is protected against project enumeration: a wrong code, a non-existent project, or a project with no recovery code all return the identical `401` response.
- Each use of a recovery code rotates it to a fresh one, so the used code can never be replayed.
