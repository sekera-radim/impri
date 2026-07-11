#!/bin/sh
# Entrypoint: s nakonfigurovaným S3 (BUCKET_NAME + klíče) běží server pod Litestreamem
# (kontinuální replikace + restore prázdného volume); bez něj čistý node — self-host
# bez object storage funguje beze změny.
set -e

DB="${DB_PATH:-/data/impri.db}"

if [ -n "$BUCKET_NAME" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  if [ ! -f "$DB" ]; then
    echo "[litestream] DB not found at $DB — attempting restore from replica"
    litestream restore -if-replica-exists -config /app/docker/litestream.yml "$DB" || echo "[litestream] no replica yet — starting fresh"
  fi
  echo "[litestream] replicating $DB → s3://$BUCKET_NAME/impri-db"
  exec litestream replicate -config /app/docker/litestream.yml -exec "node server/dist/index.js"
fi

exec node server/dist/index.js
