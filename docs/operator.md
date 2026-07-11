# Operator / Multi-tenant Self-hosting

When you run Impri as a shared platform for multiple teams or users, you need visibility into the whole instance — not just your own project. The operator endpoint provides platform-wide stats without exposing individual project data.

---

## Setup

Set the `OPERATOR_PROJECT_ID` environment variable to the ID of the project whose admin key you will use for operator calls:

```bash
OPERATOR_PROJECT_ID=prj_your_project_id
```

Any admin key belonging to that project can call the operator stats endpoint. All other keys (including admin keys from other projects) receive `404 Not Found` — the endpoint is invisible to non-operators.

---

## `GET /v1/admin/stats` — platform totals

```http
GET /v1/admin/stats HTTP/1.1
Authorization: Bearer im_<operator-admin-key>
```

Response:

```json
{
  "signups": {
    "total":   142,
    "last_24h": 3,
    "last_7d":  18,
    "last_30d": 61
  },
  "by_tier": {
    "free":  115,
    "indie":  22,
    "team":    5
  },
  "paid": 27,
  "activity": {
    "actions_total": 9842,
    "actions_7d":    1203,
    "watchers":       88
  },
  "ts": 1720000000
}
```

Fields:

| Field | Description |
|-------|-------------|
| `signups.total` | Total number of projects (one per signup) |
| `signups.last_24h/7d/30d` | Projects created in the last N days |
| `by_tier` | Breakdown of projects by current tier |
| `paid` | Count of indie + team projects |
| `activity.actions_total` | Total actions ever created across all projects |
| `activity.actions_7d` | Actions created in the last 7 days |
| `activity.watchers` | Active (non-paused) watchers across all projects |
| `ts` | Unix timestamp of the response |

---

## Security notes

- Returns `404 Not Found` for all keys that do not belong to `OPERATOR_PROJECT_ID`, regardless of scope. The endpoint is not discoverable.
- No individual project data is exposed — only platform-level aggregate counts.
- Even operator keys cannot read another project's actions, decisions, or audit log.
- Set `OPERATOR_PROJECT_ID` to a dedicated operator project — do not reuse a user-facing project for this.

---

## Usage example (Python)

```python
import os
from impri import ImpriClient

operator_key = os.environ["OPERATOR_API_KEY"]  # admin key for OPERATOR_PROJECT_ID
client = ImpriClient(api_key=operator_key, base_url="http://localhost:8484")

# The SDK doesn't have a dedicated method — call the raw endpoint
import urllib.request, json, os

req = urllib.request.Request(
    "http://localhost:8484/v1/admin/stats",
    headers={"Authorization": f"Bearer {operator_key}"},
)
with urllib.request.urlopen(req) as resp:
    stats = json.loads(resp.read())

print(f"Total signups: {stats['signups']['total']}")
print(f"Paid projects: {stats['paid']}")
print(f"Actions this week: {stats['activity']['actions_7d']}")
```

---

## Environment variables for multi-tenant operation

| Variable | Purpose |
|----------|---------|
| `OPERATOR_PROJECT_ID` | Unlocks `GET /v1/admin/stats` for that project's admin keys |
| `ALLOW_SIGNUP` | When set to `1` or `true`, enables `POST /v1/signup` for self-serve project creation |
| `DB_PATH` | SQLite database path (default: `data/impri.db`) |
| `BASE_URL` | Public base URL shown in inbox links |

See [Self-hosting](self-hosting.md) for the full environment variable reference.
