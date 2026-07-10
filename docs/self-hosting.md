# Self-Hosting Impri

Impri is fully self-hostable. `docker compose up` gives you the complete stack: API server, web inbox, SQLite database, and the watcher scheduler. No licence required, no external services needed to get started.

---

## Requirements

- Docker Engine 24+ and Docker Compose v2
- A machine with at least 256 MB of free RAM (SQLite; a Hetzner CX22 is more than enough)
- (Optional) A domain name and a reverse proxy (Caddy, nginx, Traefik) for HTTPS

---

## Quick start

```bash
git clone https://github.com/impri-dev/impri.git
cd impri

# Generate a strong webhook secret (required — do not leave it as "change-me-in-production")
echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" > .env

docker compose up -d
```

The server is now running:

- **API**: `http://localhost:8484/v1`
- **Web inbox**: `http://localhost:8080`
- **Health check**: `http://localhost:8484/healthz`
- **OpenAPI spec**: `http://localhost:8484/v1/openapi.json`

On first start, the bootstrap admin key is printed to the server log. Retrieve it:

```bash
docker compose logs server | grep "Admin API Key"
```

Store this key somewhere safe — it is hashed in the database and will not be shown again.

---

## Environment variables

All configuration is passed via environment variables. The easiest way to manage them is a `.env` file in the project root (Docker Compose picks it up automatically).

### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_SECRET` | `change-me-in-production` | Shared secret used to sign outgoing webhook payloads (HMAC-SHA256). **Change this before exposing the server to the network.** The server prints a warning on startup if this is the default value. |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `/app/data/impri.db` | Path to the SQLite database file. The Docker volume `impri-data` is mounted at `/app/data`. |
| `PORT` | `8484` | Port the API server listens on inside the container. |
| `HOST` | `0.0.0.0` | Bind address for the API server. |
| `BASE_URL` | `http://localhost:8080` | Public base URL used to construct `inbox_url` values in API responses. Set this to your public domain when deploying with a reverse proxy (e.g. `https://impri.yourdomain.com`). |
| `DISABLE_WATCHER_SCHEDULER` | unset | Set to `1` to disable the watcher scheduler (useful if you only use the approval inbox and do not need watchers). |

### Notifications

Impri can notify you via email (SMTP) and/or ntfy. Both are optional; the server starts without them and falls back to logging the notification.

**Email (SMTP):**

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | unset | SMTP server hostname. If not set, email notifications are skipped. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | Set to `true` for TLS on connect (port 465 style). Port 587 with STARTTLS works with the default `false`. |
| `SMTP_USER` | unset | SMTP username for authentication. |
| `SMTP_PASS` | unset | SMTP password. |
| `SMTP_FROM` | `impri@localhost` | From address for outgoing notification emails. |
| `NOTIFY_EMAIL` | unset | Recipient address for approval notifications. Without this, no emails are sent even if SMTP is configured. |

**ntfy (recommended for self-hosters):**

ntfy is an open-source push notification service with mobile apps. It works with the public `ntfy.sh` instance or your own self-hosted ntfy server, and requires no registration for basic use.

| Variable | Default | Description |
|----------|---------|-------------|
| `NTFY_URL` | unset | ntfy server base URL (e.g. `https://ntfy.sh` or your own instance). |
| `NTFY_TOPIC` | unset | Your private ntfy topic name. Use a random, hard-to-guess string as the topic (it acts as a shared secret on ntfy.sh). |

Example: to receive notifications at `https://ntfy.sh/my-secret-topic-abc123`:

```bash
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=my-secret-topic-abc123
```

Install the ntfy app on your phone, subscribe to the topic, and you will receive a push notification for every pending action.

### Web push (VAPID) — optional

Browser push notifications for the web inbox. Generate a keypair once and set it
in the environment; without these keys the web-push channel is simply off
(email / ntfy still work).

```bash
npx web-push generate-vapid-keys   # prints a public + private key
```

| Variable | Default | Description |
|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | unset | VAPID public key. Also served at `GET /v1/push/vapid-public-key` for the browser to subscribe. |
| `VAPID_PRIVATE_KEY` | unset | VAPID private key. Keep secret. |
| `VAPID_SUBJECT` | `mailto:admin@impri.dev` | Contact `mailto:` or URL, per the web-push spec. |

Once enabled, open the web inbox and use **Enable push notifications** in the
Notifications section — the browser subscribes and you get a push for every new
pending action.

### Redis (rate limiter) — optional, multi-instance only

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | unset | Only needed when running **more than one** server instance behind a load balancer: it makes the rate limiter a shared window across instances. A single instance uses SQLite and does not need Redis. |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `IMPRI_ALLOW_PRIVATE_TARGETS` | unset | Set to `1` to allow `callback_url` and watcher `config.url` to target private/intranet addresses (RFC 1918, loopback). **Only set this on an isolated intranet deployment.** By default, the SSRF guard blocks any URL that resolves to a private IP. |

---

## Example `.env` for a production self-host

```bash
WEBHOOK_SECRET=a6f3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4
BASE_URL=https://impri.yourdomain.com

# Notifications via ntfy
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=my-secret-topic-abc123

# Email backup notifications
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.yourdomain.com
SMTP_PASS=your-smtp-password
SMTP_FROM=impri@yourdomain.com
NOTIFY_EMAIL=you@yourdomain.com
```

---

## Reverse proxy (HTTPS)

For production use, put a reverse proxy in front that handles TLS. The UI container serves on port 8080 and the API server on 8484. A typical setup proxies both through a single domain:

- `https://impri.yourdomain.com` → UI (port 8080)
- `https://impri.yourdomain.com/v1` → API (port 8484/v1)

Or run them on separate subdomains. The important variable is `BASE_URL`, which must match the public URL the UI and API are reachable at.

**Example Caddy config:**

```caddyfile
impri.yourdomain.com {
  reverse_proxy /v1/* localhost:8484
  reverse_proxy /* localhost:8080
}
```

---

## Backups

Impri uses SQLite. The database file is stored in the `impri-data` Docker volume, mounted at `/app/data/impri.db` inside the container.

**Manual backup:**

```bash
# Hot backup using SQLite's built-in online backup
docker compose exec server sqlite3 /app/data/impri.db ".backup /app/data/impri-backup-$(date +%Y%m%d).db"
```

**Automated daily backup (cron example):**

```bash
# /etc/cron.daily/impri-backup
#!/bin/bash
BACKUP_DIR=/var/backups/impri
mkdir -p "$BACKUP_DIR"
docker compose -f /home/impri/docker-compose.yml exec -T server \
  sqlite3 /app/data/impri.db ".backup /tmp/impri-$(date +%Y%m%d).db"
docker compose -f /home/impri/docker-compose.yml cp \
  server:/tmp/impri-$(date +%Y%m%d).db "$BACKUP_DIR/"
# Optionally: rsync to offsite storage
```

Decisions (what a human approved or rejected) are the most critical data. The database schema stores them in an append-only `decisions` table with a `decisions` unique constraint that prevents overwrite.

---

## Upgrading

```bash
# Pull the latest images
docker compose pull

# Restart with zero-downtime (the server handles SQLite migrations on startup)
docker compose up -d
```

There are no manual migration steps for v1 — schema migrations run automatically on startup. Database backups before upgrading are always a good idea.

---

## Monitoring

- **Health endpoint**: `GET /healthz` returns `{"status":"ok","ts":<unix>}` — use it for uptime checks.
- **Prometheus metrics**: `GET /metrics` (if enabled in your build — check the deployment).
- **Structured logs**: the server writes JSON logs via Fastify's built-in logger. API keys are redacted from all log output.

---

## Watcher scheduler

When watchers are enabled (the default), the scheduler polls each active watcher on its configured interval and delivers matching items to your inbox or a webhook. The scheduler runs inside the same server container and requires no external queue.

To disable it (approval inbox only):

```bash
DISABLE_WATCHER_SCHEDULER=1
```

Watcher state is persisted in SQLite. A degraded watcher (3 consecutive failures) is surfaced in the UI and triggers a notification. After 24 hours of failures it is automatically paused.
