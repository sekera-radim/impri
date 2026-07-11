# Observability

Impri exposes three observability surfaces for self-hosters and operators:

- **`/metrics`** — Prometheus text-format endpoint (opt-in)
- **`/readyz`** — readiness probe (always available, no auth)
- **`/healthz`** — liveness probe (existing, always available)
- **`GET /v1/usage`** — per-project usage snapshot (admin scope)
- **Structured logging** — JSON via pino with request-ID correlation

---

## Prometheus metrics (`/metrics`)

### Enabling

The `/metrics` endpoint does **not exist by default**. It is registered only when `METRICS_ENABLED=1`. Without this env var, any request to `/metrics` returns 404.

```bash
METRICS_ENABLED=1
```

### Protecting access

**Option A — bearer token (recommended when `/metrics` is on the public port):**

```bash
METRICS_ENABLED=1
METRICS_TOKEN=<random-string>
```

When `METRICS_TOKEN` is set, the endpoint requires:

```
Authorization: Bearer <METRICS_TOKEN>
```

Requests with a missing or mismatched token receive `401 Unauthorized`. The comparison uses constant-time (`timingSafeEqual`) to prevent timing attacks.

**Option B — private port (recommended for bare-metal / VM self-hosters):**

Bind a second listener on a non-public interface so the metrics endpoint is never reachable over the internet at all.

```bash
METRICS_ENABLED=1
METRICS_HOST=127.0.0.1
METRICS_PORT=9090
```

With `METRICS_PORT` set to a different value than `PORT`, the server starts a separate Fastify instance (metrics-only, no auth preHandler, no CORS) on `METRICS_HOST:METRICS_PORT`. The main listener on `PORT` receives no `/metrics` traffic.

**Option C — no token, public port (development only):**

`METRICS_ENABLED=1` without `METRICS_TOKEN` is valid but you **must** restrict access at the network layer: firewall rule, reverse proxy IP allowlist, or `METRICS_HOST=127.0.0.1`. Never expose an unprotected `/metrics` to the internet — it leaks operational statistics.

### Content type

```
Content-Type: text/plain; version=0.0.4
```

Standard Prometheus text exposition format. Prometheus, Grafana Agent, VictoriaMetrics, and any compatible scraper will ingest it without configuration.

### Prometheus `scrape_config` examples

**With bearer token:**

```yaml
scrape_configs:
  - job_name: impri
    static_configs:
      - targets: ['your-impri-host:8484']
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
```

**Private port, no token:**

```yaml
scrape_configs:
  - job_name: impri
    static_configs:
      - targets: ['127.0.0.1:9090']
```

---

## Metric reference

All metrics are prefixed with `impri_`. Labels never contain raw API keys, webhook secrets, bot tokens, action content, email addresses, callback URLs, or any other user-supplied data — only enum values and route patterns.

### Build and runtime

| Metric | Type | Description |
|--------|------|-------------|
| `impri_build_info{version, node_version}` | Gauge (always 1) | Identifies the running build. `version` from package.json, `node_version` from `process.version`. Emitted once per scrape. |
| `impri_uptime_seconds` | Gauge | `process.uptime()` at scrape time. Detects unexpected restarts in dashboards. |
| `impri_db_size_bytes` | Gauge | `fs.statSync(DB_PATH).size`. SQLite growth indicator — useful for disk-space alerting without external DB monitoring. |

### HTTP traffic

| Metric | Type | Description |
|--------|------|-------------|
| `impri_http_requests_total{route, method, status_class}` | Counter | Request count by route pattern, HTTP method, and status class (`2xx` / `4xx` / `5xx`). `route` is Fastify's route pattern (e.g. `/v1/actions/:id`), never the real URL with actual IDs or tokens. |
| `impri_http_request_duration_seconds{route, method}` | Histogram | Latency from request start to response send. Buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s. |

The `/metrics` route itself is excluded from HTTP counters to avoid noise.

### Rate limiting

| Metric | Type | Description |
|--------|------|-------------|
| `impri_rate_limited_total{bucket}` | Counter | Incremented when a request is rejected by the rate limiter. `bucket` is the route string used in `checkRateLimit()` (e.g. `actions:create`, `actions:decide`, `watchers:create`). Labels identify the bucket, not the caller. |

### Actions

| Metric | Type | Description |
|--------|------|-------------|
| `impri_actions_total{status}` | Gauge | `COUNT(*) FROM actions GROUP BY status` at scrape time. Labels: `pending`, `approved`, `rejected`, `expired`, `succeeded`, `failed`. |
| `impri_pending_actions` | Gauge | `COUNT(*) WHERE status = 'pending'`. Convenience alias; useful as an alert trigger. |
| `impri_action_decisions_total{verdict, channel}` | Counter | Incremented each time a decision is committed. `verdict` = `approve` or `reject`. `channel` = `api` / `bulk-api` / `bulk-web` / `telegram` / `slack` / `discord` / `auto` (rules engine). |
| `impri_action_decision_latency_seconds{verdict}` | Histogram | Time from action creation to decision (human response time distribution). Value = `decided_at − created_at`. Buckets: 1, 10, 60, 300, 1800, 7200, 86400 s. |
| `impri_actions_expired_total` | Counter | Incremented once per action that transitions to `expired`. No PII labels. |

### Watchers

| Metric | Type | Description |
|--------|------|-------------|
| `impri_active_watchers` | Gauge | `COUNT(*) WHERE status = 'active'` at scrape time. |
| `impri_degraded_watchers` | Gauge | `COUNT(*) WHERE status = 'degraded'` at scrape time. Alert when non-zero. |
| `impri_watcher_runs_total{kind, result}` | Counter | `kind` = `rss` / `reddit_search` / `url_diff`. `result` = `ok` / `error` / `window_skipped` (outside schedule window) / `baseline` (first run, no actions created). |
| `impri_watcher_items_fetched_total{kind}` | Counter | Total items returned by fetch before dedup/scoring. |
| `impri_watcher_hits_total{kind}` | Counter | Actions created by watcher runs (items that passed dedup + score filter). |
| `impri_watcher_burst_truncations_total{kind}` | Counter | Incremented when burst protection triggers. Useful for detecting runaway feeds. |

### Webhooks

| Metric | Type | Description |
|--------|------|-------------|
| `impri_webhook_deliveries_total{result}` | Counter | `result` = `delivered` / `retry` / `dlq` / `gone` / `ssrf_blocked`. |
| `impri_webhook_delivery_duration_seconds` | Histogram | Wall-clock time of the HTTP POST to the callback URL. Buckets: 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15 s. Helps identify slow receivers. |
| `impri_webhook_dlq_size` | Gauge | `COUNT(*) WHERE status = 'dlq'` at scrape time. Alert when this grows. |

### Notification channels

| Metric | Type | Description |
|--------|------|-------------|
| `impri_notifications_total{channel_type, result}` | Counter | `channel_type` = `slack` / `discord` / `telegram` / `ntfy` / `email` / `webhook`. `result` = `ok` / `error`. No URL, token, or project ID in labels. |
| `impri_notification_digest_flushes_total{channel_type}` | Counter | Incremented on each digest queue flush. |
| `impri_channel_auto_disabled_total{channel_type}` | Counter | Incremented when a channel is auto-disabled after consecutive failures. Alert trigger for broken channels. |

---

## Health and readiness probes

### `GET /healthz` — liveness

**Always available. No auth. Never blocks.**

Returns `200 OK` immediately with `{"status":"ok","ts":<unix>}`. Use this as your container liveness probe or uptime-check endpoint. Its only question is: "is the process alive?" — it performs no DB check.

```bash
curl http://localhost:8484/healthz
# {"status":"ok","ts":1720000000}
```

### `GET /readyz` — readiness

**Always available. No auth. Returns sensitive-free pass/fail only.**

Use this as your Kubernetes readiness probe or load-balancer health check. It answers: "is the server ready to serve traffic?" Kubernetes probes cannot carry tokens; the endpoint deliberately returns no sensitive data — only pass/fail per named check.

Checks (in order):

1. **`db_reachable`** — `SELECT 1` confirms the SQLite file is open and WAL is accessible.
2. **`schema_applied`** — verifies the `api_keys` table exists (confirms migrations ran).
3. **`db_writable`** — inserts and immediately deletes a sentinel row in `rate_limits` within a single transaction (confirms writes are not blocked by disk-full or a read-only mount).
4. **`redis`** _(advisory, only when `REDIS_URL` is set)_ — `PING` with a 1 s timeout. Failure sets `status: 'degraded'` in the response but does **not** cause a 503 — Redis is a non-fatal fallback path.

**Success response (HTTP 200):**

```json
{
  "status": "ok",
  "checks": {
    "db_reachable": "ok",
    "schema_applied": "ok",
    "db_writable": "ok",
    "redis": "ok"
  },
  "ts": 1720000000
}
```

**Failure response (HTTP 503):**

```json
{
  "status": "error",
  "checks": {
    "db_reachable": "ok",
    "schema_applied": "error",
    "db_writable": "skipped"
  },
  "error": "schema_applied: expected table api_keys not found",
  "ts": 1720000000
}
```

Error messages contain only the check name and a fixed-string reason — never raw SQL, row data, or secrets.

**Kubernetes example:**

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8484
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 8484
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

---

## Structured logging

Impri uses **pino** with JSON output. All logs include `level`, `time`, `msg`, and Fastify's request fields. The logger redacts `Authorization` and `cookie` headers in HTTP logs.

### Request-ID correlation

Every response includes an `X-Request-Id` header matching the `reqId` field in the server log. This lets you correlate a `429` or `403` in an agent's log with the exact server log line:

```bash
curl -sI https://api.impri.dev/v1/actions | grep x-request-id
# x-request-id: req-abc123
```

Search for that ID in your log aggregator to find the full structured log entry.

### Background tick logging

All background tick functions (`runExpiryTick`, `runWebhookTick`, `runWatcherTick`, `runChannelDigestTick`) receive a pino logger instance so their output flows through pino's redaction pipeline. No background output is written to raw stderr.

### Structured lifecycle events

Key lifecycle events are logged as structured JSON with the fields listed below. None of these fields ever contain raw API keys, tokens, passwords, callback URLs (which may carry auth in query params), watcher config (which may contain embedded credentials), action content, or email addresses.

#### Action lifecycle

```json
{ "event": "action.created", "action_id": "act_...", "kind": "email.send",
  "project_id": "proj_...", "key_id": 42, "rule_applied": null, "initial_status": "pending" }

{ "event": "action.decided", "action_id": "act_...", "verdict": "approve",
  "channel": "telegram", "key_id": 42, "latency_ms": 47213 }

{ "event": "action.expired", "action_id": "act_...", "project_id": "proj_..." }

{ "event": "action.result", "action_id": "act_...", "status": "executed" }
```

#### Webhook delivery

```json
{ "event": "webhook.delivery", "delivery_id": "wdl_...", "action_id": "act_...",
  "attempt": 2, "result": "retry", "status_code": 503, "duration_ms": 1240 }

{ "event": "webhook.dlq", "delivery_id": "wdl_...", "action_id": "act_...", "attempt": 7 }
```

`callback_url` is never logged (may contain tokens in query params).

#### Watcher runs

```json
{ "event": "watcher.run", "watcher_id": "wat_...", "kind": "rss",
  "result": "ok", "items_fetched": 12, "items_new": 3, "items_published": 3, "duration_ms": 890 }

{ "event": "watcher.degraded", "watcher_id": "wat_...", "kind": "rss", "fail_count": 3 }

{ "event": "watcher.paused", "watcher_id": "wat_...", "kind": "rss" }
```

Watcher config (which may contain RSS URLs with embedded auth or API keys) is never logged.

#### Rate limiting

```json
{ "event": "rate_limit_hit", "key_id": 42, "route": "actions:create" }
```

`key_id` is the database row ID — not the raw `im_...` token value.

#### Notification channels

```json
{ "event": "channel.notification", "channel_id": "ch_...",
  "channel_type": "slack", "result": "ok", "action_id": "act_..." }

{ "event": "channel.auto_disabled", "channel_id": "ch_...",
  "channel_type": "slack", "project_id": "proj_...", "fail_count": 5 }
```

Channel config (containing bot tokens and webhook URLs) is never logged.

### Log levels

| Event | Level |
|-------|-------|
| Action lifecycle (created / decided / result) | `info` |
| Watcher run (success) | `info` |
| Webhook delivery (success) | `info` |
| Watcher run (retry/degraded) | `warn` |
| Webhook delivery (retry) | `warn` |
| Rate limit hit | `warn` |
| Channel auto-disabled | `warn` |
| Webhook DLQ / SSRF blocked | `error` |
| Unexpected exception in tick | `error` (with full `err` object; pino serializes `Error.stack` safely) |

---

## Usage endpoint (`GET /v1/usage`)

Returns a per-project usage snapshot. Useful for building dashboards, quota warnings, or self-service billing pages in your own tooling.

**Auth:** requires `admin` scope. Project is derived exclusively from the verified API key — never from a client-supplied parameter.

**Rate limit:** 60 requests per minute per key.

```bash
curl -H "Authorization: Bearer im_..." https://api.impri.dev/v1/usage
```

**Response (HTTP 200):**

```json
{
  "project_id": "proj_...",
  "billing_active": false,
  "tier": "free",
  "subscription_status": null,
  "current_period_end": null,

  "period": {
    "start": 1719792000,
    "end":   1722470400
  },

  "actions": {
    "created_this_period": 42,
    "pending":  5,
    "approved": 30,
    "rejected":  4,
    "expired":   3
  },

  "approvals": {
    "used":      34,
    "limit":    100,
    "remaining": 66
  },

  "watchers": {
    "active":    2,
    "degraded":  1,
    "paused":    0,
    "total":     3,
    "limit":     3,
    "remaining": 0
  },

  "limits": {
    "approvals_per_month":      100,
    "watchers":                   3,
    "min_watcher_interval_sec": 900
  },

  "webhook_delivery": {
    "dlq_size":  0,
    "pending":   1,
    "in_retry":  0
  },

  "ts": 1720000000
}
```

**Field notes:**

- `approvals.limit` and `watchers.limit` are `null` on unlimited tiers (indie annual, team).
- `approvals.remaining` and `watchers.remaining` are `null` when the limit is `null`.
- `period.start` / `period.end` are Unix seconds for the first second of the current and next UTC calendar months.
- `billing_active: false` on self-hosted instances without `STRIPE_SECRET_KEY` — no usage limits are enforced in that case.
- All counts are scoped to the project that owns the API key; no cross-project data is accessible.

**Error responses:**

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid API key |
| 403 | Key does not have `admin` scope |
| 429 | Rate limit exceeded |

---

## Security notes

- `/metrics` is absent unless `METRICS_ENABLED=1`. When the token option is not used, restrict at the network layer.
- `/readyz` is intentionally public. It returns only pass/fail per named check and fixed-string error reasons — never query content, row data, DB paths, or secrets. The write canary uses a sentinel value and is deleted within the same transaction.
- `GET /v1/usage` enforces `admin` scope and derives `project_id` from the verified key only. Returns 403 (not 404) on missing scope.
- All metric labels are enum values or Fastify route patterns — never user-supplied data, URLs, tokens, or action content.
- Pino's redaction pipeline covers all HTTP logs (`Authorization`, `cookie`). Background ticks use the same logger instance, so nothing flows to raw stderr unredacted.
