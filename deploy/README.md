# Impri — Production Deploy Runbook

This runbook covers deploying Impri to a single Hetzner VPS with automatic TLS via Caddy.

**Architecture:**
```
Internet → Caddy (443/80) → server:8484  (Fastify API)
                           → ui:8080     (nginx/Vue SPA inbox)
```
All three services run in Docker on the same VPS, communicating on an internal bridge network. Caddy is the only service with public ports.

---

## 1. Provision Hetzner VPS

1. Log in to [console.hetzner.cloud](https://console.hetzner.cloud) and create a new server.
2. **Type:** CX23 (2 vCPU, 4 GB RAM, €5.49/month). This handles up to ~5k users; upgrade to CX33 around 5k active users (SQLite cache becomes the bottleneck before CPU).
3. **Location:** Falkenstein (EU) or Helsinki — pick the region closest to your users.
4. **OS:** Ubuntu 24.04 LTS.
5. **SSH key:** upload your public key so you can login as root.
6. Note the server's **public IPv4 address** — you need it for DNS.

---

## 2. Configure DNS (Cloudflare)

In your Cloudflare dashboard, add two A records pointing to the VPS IP:

| Name | Type | Value            | Proxy status        |
|------|------|------------------|---------------------|
| api  | A    | `<VPS IP>`       | DNS only (grey cloud) |
| app  | A    | `<VPS IP>`       | DNS only (grey cloud) |

**Why "DNS only" (proxy OFF)?**
Caddy obtains TLS certificates from Let's Encrypt using the HTTP-01 or TLS-ALPN-01 challenge, which requires Let's Encrypt to reach your server directly on port 80 or 443. When Cloudflare proxying is enabled (orange cloud), Cloudflare terminates TLS at their edge, and the challenge traffic never reaches Caddy — certificate issuance fails. Once Caddy has a valid cert and is running smoothly, you _could_ enable Cloudflare proxying again (it then re-encrypts to Caddy), but "DNS only" is simpler and avoids cert renewal surprises.

---

## 3. Prepare the VPS

SSH into the server and run:

```bash
# Install Docker Engine (official repo, not the Ubuntu snap)
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Clone the repo to /opt/impri
git clone https://github.com/impri-dev/impri.git /opt/impri
cd /opt/impri
```

---

## 4. Create the .env file

```bash
cd /opt/impri
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and fill in every variable. At minimum:

```bash
# Generate a strong secret:
echo "WEBHOOK_SECRET=$(openssl rand -hex 32)"
```

Copy the output into `WEBHOOK_SECRET=` in `deploy/.env`. Fill in SES credentials, ntfy topic, and (when ready) Stripe keys. See `.env.example` for full descriptions of each variable.

---

## 5. Start the stack

```bash
cd /opt/impri
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
```

This builds the server and UI images on the VPS, then starts server, ui, and Caddy. Caddy immediately begins the ACME challenge to obtain TLS certificates for `api.impri.dev` and `app.impri.dev` — this takes up to 60 seconds on first boot.

**Verify everything is up:**
```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
# All three services should show "healthy" or "running".

curl https://api.impri.dev/healthz
# Expected: {"status":"ok","ts":<unix>}
```

---

## 6. Retrieve the bootstrap admin API key

On first start, the server generates an admin key and prints it to the log **once**. Retrieve it immediately:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  logs server | grep "Admin API Key"
```

Store this key in your password manager. It is hashed in the database and cannot be recovered — you would need to create a new key via the API if you lose it.

---

## 7. Register the Stripe webhook endpoint

After starting the stack with your Stripe test keys:

1. Go to **Stripe Dashboard → Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://api.impri.dev/v1/billing/webhook`
3. Events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Save. Stripe shows a **Signing secret** (`whsec_…`) — copy it.
5. Add it to `deploy/.env` as `STRIPE_WEBHOOK_SECRET=whsec_…` and restart the server:
   ```bash
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
     up -d server
   ```

Stripe sends the `Stripe-Signature` header and expects to verify it against the raw request body. Caddy proxies the body without modification, so verification works without any special configuration.

---

## 8. Set up daily backups

Install the systemd units (adjust `WorkingDirectory` in `impri-backup.service` if you cloned to a different path):

```bash
# Units reference /opt/impri — edit if needed
cp /opt/impri/deploy/impri-backup.service /etc/systemd/system/
cp /opt/impri/deploy/impri-backup.timer   /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now impri-backup.timer

# Verify the timer is scheduled
systemctl list-timers impri-backup.timer

# Test a manual run
systemctl start impri-backup.service
journalctl -u impri-backup.service -n 30
ls /var/backups/impri/
```

Backups are stored in `/var/backups/impri/` as `impri-YYYYMMDDTHHMMSSZ.db`. Files older than 14 days are automatically deleted.

**Optional: upload to Hetzner Storage Box.** Uncomment the rsync block at the bottom of `deploy/backup.sh` and set `HETZNER_BOX` to your Storage Box SSH target (e.g. `u123456@u123456.your-storagebox.de`). Authorise your VPS key once:
```bash
ssh-copy-id -p 23 u123456@u123456.your-storagebox.de
```

---

## 9. Upgrading

```bash
cd /opt/impri
git pull

# Rebuild and restart (SQLite schema migrations run automatically on startup)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  up -d --build
```

Take a backup before upgrading:
```bash
systemctl start impri-backup.service
```

There are no manual migration steps for v1.

---

## 10. Monitoring

**Health endpoint** (use with Uptime Kuma or similar):
- `https://api.impri.dev/healthz` → `{"status":"ok","ts":<unix>}`

**Uptime Kuma** (self-hosted, free): add a "HTTP(S)" monitor pointing at the health URL. Install on the same VPS or a separate one:
```bash
docker run -d --name uptime-kuma -p 3001:3001 \
  -v uptime-kuma:/app/data --restart unless-stopped \
  louislam/uptime-kuma:1
```

**Logs:**
```bash
# Follow server logs (API keys are redacted automatically by Fastify)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  logs -f server

# Caddy access logs + TLS events
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  logs -f caddy
```

**Backup status:**
```bash
journalctl -u impri-backup.service -n 50
ls -lh /var/backups/impri/
```
