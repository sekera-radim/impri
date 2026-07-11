# Rules Engine

Impri's rules engine lets you automate routine approval decisions without touching code. Rules are project-scoped and evaluated on every `POST /v1/actions` call before the action is saved. A matching rule can auto-approve, auto-reject, shorten the expiry window, or escalate to a specific notification channel — instantly, with no polling lag.

Rules are evaluated **once per action at creation time** — they do not re-run when an action's status changes. Without rules, every action starts as `pending` and waits for a human.

---

## How the engine works

1. On `POST /v1/actions`, the server loads the project's enabled rules ordered by `priority ASC`.
2. The engine walks the list and tests each rule's conditions against the incoming action body.
3. The **first matching rule** wins — evaluation stops there. Subsequent rules are skipped.
4. If no rule matches, the action is created as `pending` (the default).
5. An `action.rule_applied` audit event is recorded when a rule fires.

Rules are loaded from an **in-process LRU cache** with a 5-second TTL, invalidated immediately on any mutation (`POST`, `PATCH`, `DELETE /v1/rules`). This means rule changes take effect within 5 seconds at most.

---

## Conditions

A rule can specify up to three independent condition groups. All specified groups must match for the rule to fire.

### `kind_pattern` (glob)

Matches the action's `kind` field using a simple glob pattern:

- `*` — any sequence of characters
- `?` — any single character
- Anything else — literal match

Examples:

| Pattern | Matches |
|---------|---------|
| `email.*` | `email.send`, `email.draft`, `email.reply` |
| `*` | every action |
| `db.exec` | exactly `db.exec` |
| `social.?weet` | `social.tweet` (but not `social.retweet`) |

### `payload_conditions` (array)

JSON path + operator pairs evaluated against the action's `payload` field. All conditions in the array must match (AND logic).

```json
[
  { "path": "amount",        "op": "lt",       "value": 1000 },
  { "path": "env",           "op": "eq",       "value": "production" },
  { "path": "tags",          "op": "contains", "value": "automated" }
]
```

Supported operators:

| Operator | Works on | Meaning |
|----------|----------|---------|
| `eq` | any scalar | `actual === value` |
| `lt` | numbers | `actual < value` |
| `lte` | numbers | `actual <= value` |
| `gt` | numbers | `actual > value` |
| `gte` | numbers | `actual >= value` |
| `contains` | strings, arrays | string: `actual.includes(value)` / array: `actual.includes(value)` |
| `in` | any scalar | `value.includes(actual)` — `value` must be an array |
| `not_in` | any scalar | `!value.includes(actual)` — `value` must be an array |

`path` uses dot-notation to traverse nested objects: `"payment.currency"` traverses `payload.payment.currency`. If the path is absent or the intermediate value is null, the condition does not match (no crash).

### `target_url_hosts` (array of hostnames)

If non-empty, the action's `target_url` must be present and its hostname must appear in this list (case-insensitive).

```json
["staging.example.com", "dev.example.com"]
```

An action with no `target_url` **does not match** a rule that has `target_url_hosts`.

---

## Actions (outcomes)

When all conditions match, the rule fires one of these outcomes:

### `auto_approve`

The action is immediately approved without entering the pending queue. The `status` in the creation response is `approved`. `outcome_params` is an empty object.

### `auto_reject`

The action is immediately rejected. The `status` in the creation response is `rejected`. Useful for blocking categories of action in certain environments. `outcome_params` is an empty object.

### `set_expiry`

Override the action's expiry window. `outcome_params`:

```json
{ "expires_in": 3600 }
```

The action is still created as `pending` — the rule only changes when it expires. Useful for urgent actions that should expire fast if not acted on.

### `escalate`

Route the action to a specific notification channel in addition to (or instead of) the default notification flow. `outcome_params`:

```json
{ "channel": "ch_abc123" }
```

`channel` is a notification channel ID (`ch_...`). If omitted, the action is created normally. The escalation is advisory — the channel receives the notification; the action is still created as `pending`.

---

## API reference

All routes require the **`admin`** scope.

### `POST /v1/rules` — create a rule

```http
POST /v1/rules HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{
  "name": "Auto-approve low-value payments",
  "priority": 10,
  "enabled": true,
  "kind_pattern": "payment.*",
  "payload_conditions": [
    { "path": "amount", "op": "lt", "value": 500 },
    { "path": "currency", "op": "eq", "value": "USD" }
  ],
  "target_url_hosts": [],
  "rule_action": "auto_approve",
  "outcome_params": {}
}
```

Returns `201` with the created rule object.

Limits: max **50 rules per project**. Creating a 51st rule returns `409 Conflict`.

### `GET /v1/rules` — list rules

```http
GET /v1/rules HTTP/1.1
Authorization: Bearer im_...
```

Returns `{ "items": [...] }` ordered by `priority ASC`. The engine evaluates rules in this order.

### `GET /v1/rules/:id` — get a rule

Returns a single rule object or `404` if not found.

### `PATCH /v1/rules/:id` — update a rule

Partial update — only fields you supply are changed. `outcome_params` is replaced atomically; always send the full object.

```http
PATCH /v1/rules/rul_abc123 HTTP/1.1
Authorization: Bearer im_...
Content-Type: application/json

{ "enabled": false }
```

Every mutation invalidates the per-project rule cache immediately.

### `DELETE /v1/rules/:id` — delete a rule

Returns `204 No Content`. Immediately removes the rule and invalidates the cache.

---

## Rule object shape

```json
{
  "id": "rul_abc123",
  "project_id": "prj_...",
  "name": "Auto-approve low-value payments",
  "priority": 10,
  "enabled": true,
  "kind_pattern": "payment.*",
  "payload_conditions": [
    { "path": "amount", "op": "lt", "value": 500 }
  ],
  "target_url_hosts": [],
  "rule_action": "auto_approve",
  "outcome_params": {},
  "created_at": 1720000000,
  "updated_at": 1720000000
}
```

---

## Audit events

| Event | When |
|-------|------|
| `rule.created` | New rule created |
| `rule.updated` | Rule patched |
| `rule.deleted` | Rule deleted |
| `action.rule_applied` | An incoming action matched a rule |

---

## Examples

### Allow low-risk actions automatically

```json
{
  "name": "Auto-approve staging actions",
  "priority": 1,
  "enabled": true,
  "kind_pattern": "*",
  "payload_conditions": [
    { "path": "env", "op": "eq", "value": "staging" }
  ],
  "target_url_hosts": [],
  "rule_action": "auto_approve",
  "outcome_params": {}
}
```

### Block writes to production database

```json
{
  "name": "Block production DB writes",
  "priority": 5,
  "enabled": true,
  "kind_pattern": "db.exec",
  "payload_conditions": [
    { "path": "database", "op": "eq", "value": "prod" }
  ],
  "target_url_hosts": [],
  "rule_action": "auto_reject",
  "outcome_params": {}
}
```

### Short expiry for time-sensitive alerts

```json
{
  "name": "15-minute expiry on alerts",
  "priority": 20,
  "enabled": true,
  "kind_pattern": "alert.*",
  "payload_conditions": [],
  "target_url_hosts": [],
  "rule_action": "set_expiry",
  "outcome_params": { "expires_in": 900 }
}
```

### Escalate to a specific Slack channel

```json
{
  "name": "Escalate high-value transactions",
  "priority": 15,
  "enabled": true,
  "kind_pattern": "payment.*",
  "payload_conditions": [
    { "path": "amount", "op": "gte", "value": 10000 }
  ],
  "target_url_hosts": [],
  "rule_action": "escalate",
  "outcome_params": { "channel": "ch_your_slack_channel_id" }
}
```
