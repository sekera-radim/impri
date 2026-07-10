#!/usr/bin/env bash
# Custom off-machine backup of the cloud SQLite DB running on Fly.io.
#
# Takes a *consistent* online snapshot inside the machine (better-sqlite3
# .backup(), not a raw cp of a live WAL file), pulls it out over Fly SSH,
# gzips it, and rotates local copies. Complements Fly's own daily volume
# snapshots with an independent, off-machine copy.
#
# For a high-write production DB, upgrade to continuous replication with
# Litestream → object storage (near-zero RPO). This script is the simple,
# no-extra-infra option that is right while write volume is low.
#
# Env overrides:
#   IMPRI_FLY_APP        Fly app name         (default impri-api)
#   IMPRI_BACKUP_DIR     local backup dir     (default ~/.impri/backups)
#   IMPRI_BACKUP_KEEP    days to keep         (default 14)
#   FLYCTL               flyctl path          (default ~/.fly/bin/flyctl)
set -euo pipefail

APP="${IMPRI_FLY_APP:-impri-api}"
DEST="${IMPRI_BACKUP_DIR:-$HOME/.impri/backups}"
KEEP="${IMPRI_BACKUP_KEEP:-14}"
FLY="${FLYCTL:-$HOME/.fly/bin/flyctl}"

mkdir -p "$DEST"
TS="$(date +%F-%H%M%S)"
REMOTE="/data/_bk_${TS}.db"
LOCAL="$DEST/impri-${TS}.db"

# 1. Consistent online backup inside the machine's volume.
"$FLY" ssh console -a "$APP" -C \
  "node -e \"require('/app/node_modules/better-sqlite3')('/data/impri.db').backup('${REMOTE}').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})\""

# 2. Pull it out, then remove the temp copy from the volume.
"$FLY" ssh sftp get "$REMOTE" "$LOCAL" -a "$APP"
"$FLY" ssh console -a "$APP" -C "rm -f ${REMOTE}"

# 3. Compress + rotate.
gzip -f "$LOCAL"
find "$DEST" -name 'impri-*.db.gz' -mtime "+${KEEP}" -delete 2>/dev/null || true

echo "backup ok: ${LOCAL}.gz ($(du -h "${LOCAL}.gz" | cut -f1))"
