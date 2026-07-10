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
