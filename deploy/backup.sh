#!/usr/bin/env bash
# Impri SQLite daily backup
#
# Uses SQLite's built-in online backup (.backup command) which is safe
# to run against a live database under concurrent writes. Do NOT use
# a plain `cp` of the database file — it can produce a corrupt copy if
# a write transaction is in progress.
#
# Usage:
#   ./deploy/backup.sh
#
# Intended to be run via systemd timer (see impri-backup.timer/.service)
# or cron. Must be run from the repo root where docker-compose.prod.yml lives.
#
# Environment:
#   COMPOSE_FILE   Path to the prod compose file. Default: deploy/docker-compose.prod.yml
#   BACKUP_DIR     Where to store backups. Default: /var/backups/impri
#   KEEP_DAYS      How many daily backups to retain. Default: 14
#   HETZNER_BOX    Hetzner Storage Box SSH target, e.g. u123456@u123456.your-storagebox.de
#                  Leave unset to skip remote upload (off by default).

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/impri}"
KEEP_DAYS="${KEEP_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILENAME="impri-${TIMESTAMP}.db"
# Temp path inside the server container (writable by the node user)
CONTAINER_TMP="/tmp/${BACKUP_FILENAME}"

# Resolve absolute path to compose file so cwd doesn't matter at call site.
COMPOSE_FILE="$(realpath "${COMPOSE_FILE}")"
COMPOSE_DIR="$(dirname "${COMPOSE_FILE}")"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { echo "[$(date -u +%H:%M:%SZ)] ERROR: $*" >&2; exit 1; }

log "Starting backup → ${BACKUP_DIR}/${BACKUP_FILENAME}"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# 1. Online backup: runs inside the container against the live database.
#    SQLite's .backup is equivalent to the Online Backup API — it acquires a
#    shared lock per page during the copy, not for the whole file.
docker compose \
  -f "${COMPOSE_FILE}" \
  --env-file "${COMPOSE_DIR}/.env" \
  exec -T server \
  sqlite3 /app/data/impri.db ".backup ${CONTAINER_TMP}" \
  || die "sqlite3 .backup failed inside container"

# 2. Copy the backup file out of the container to the host.
docker compose \
  -f "${COMPOSE_FILE}" \
  --env-file "${COMPOSE_DIR}/.env" \
  cp "server:${CONTAINER_TMP}" "${BACKUP_DIR}/${BACKUP_FILENAME}" \
  || die "docker compose cp failed"

# 3. Remove the temp file from the container.
docker compose \
  -f "${COMPOSE_FILE}" \
  --env-file "${COMPOSE_DIR}/.env" \
  exec -T server \
  rm -f "${CONTAINER_TMP}" 2>/dev/null || true

log "Backup written: ${BACKUP_DIR}/${BACKUP_FILENAME} ($(du -sh "${BACKUP_DIR}/${BACKUP_FILENAME}" | cut -f1))"

# 4. Rotate: delete backups older than KEEP_DAYS days.
find "${BACKUP_DIR}" -maxdepth 1 -name 'impri-*.db' -mtime "+${KEEP_DAYS}" -print -delete \
  | while read -r f; do log "Rotated: ${f}"; done

# 5. Optional: upload to Hetzner Storage Box via rsync over SSH.
#    Uncomment and set HETZNER_BOX in your environment or below.
#
# HETZNER_BOX="${HETZNER_BOX:-}"
# if [[ -n "${HETZNER_BOX}" ]]; then
#   log "Uploading to Hetzner Storage Box: ${HETZNER_BOX}…"
#   # Assumes your VPS's SSH public key is authorised on the Storage Box.
#   # Add it once: ssh-copy-id -p 23 "${HETZNER_BOX}"
#   rsync -az --no-perms -e "ssh -p 23" \
#     "${BACKUP_DIR}/${BACKUP_FILENAME}" \
#     "${HETZNER_BOX}:/impri-backups/${BACKUP_FILENAME}" \
#     || die "rsync to Storage Box failed"
#   log "Upload complete."
# fi

log "Backup done."
