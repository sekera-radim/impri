import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';

export type Db = Database.Database;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  name         TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS actions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  preview         TEXT NOT NULL,
  payload         TEXT,
  target_url      TEXT,
  callback_url    TEXT,
  expires_at      INTEGER,
  idempotency_key TEXT,
  editable        TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending',
  preview_hash    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idempotency
  ON actions(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_actions_project_status ON actions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_expires
  ON actions(expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  action_id     TEXT NOT NULL REFERENCES actions(id),
  verdict       TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    INTEGER NOT NULL,
  channel       TEXT,
  final_preview TEXT,
  diff          TEXT,
  UNIQUE(action_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  action_id        TEXT NOT NULL REFERENCES actions(id),
  callback_url     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempt          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  last_attempt_at  INTEGER,
  last_status_code INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(next_attempt_at)
  WHERE status IN ('pending', 'retry');

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  action_id  TEXT,
  event      TEXT NOT NULL,
  actor      TEXT,
  ip         TEXT,
  channel    TEXT,
  data       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchers (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  config         TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '[]',
  keywords_none  TEXT NOT NULL DEFAULT '[]',
  min_score      INTEGER NOT NULL DEFAULT 1,
  schedule       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  fail_count     INTEGER NOT NULL DEFAULT 0,
  degraded_since INTEGER,
  last_error     TEXT,
  first_run_done INTEGER NOT NULL DEFAULT 0,
  last_run_at    INTEGER,
  next_run_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchers_project ON watchers(project_id);
CREATE INDEX IF NOT EXISTS idx_watchers_due
  ON watchers(next_run_at, status)
  WHERE status IN ('active', 'degraded');

CREATE TABLE IF NOT EXISTS watcher_items (
  id          TEXT PRIMARY KEY,
  watcher_id  TEXT NOT NULL REFERENCES watchers(id),
  item_hash   TEXT NOT NULL,
  url         TEXT,
  title       TEXT,
  first_seen  INTEGER NOT NULL,
  UNIQUE(watcher_id, item_hash)
);

CREATE INDEX IF NOT EXISTS idx_watcher_items_watcher ON watcher_items(watcher_id, first_seen);
`;

export function createDb(path: string): Db {
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  return db;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function genId(prefix: string): string {
  return prefix + randomBytes(16).toString('base64url');
}

export function hashContent(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}
