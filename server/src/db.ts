import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';

export type Db = Database.Database;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  webhook_secret         TEXT,
  timezone               TEXT NOT NULL DEFAULT 'UTC',
  tier                   TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,
  current_period_end     INTEGER,
  created_at             INTEGER NOT NULL
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

-- PII (request IP) is kept apart from the immutable audit trail so it can be
-- pruned/erased (GDPR art. 17) without rewriting audit history. PLAYBOOK F.
CREATE TABLE IF NOT EXISTS pii_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  action_id  TEXT,
  event      TEXT NOT NULL,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pii_log_created ON pii_log(created_at);

-- Web-push (VAPID) subscriptions per project. endpoint is the unique browser
-- push endpoint; keys are the client's p256dh/auth for payload encryption.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subs_project ON push_subscriptions(project_id);

-- Persistent fixed-window rate limiter (survives restart; shared across a
-- single instance). Bucket = floor(now/60). PLAYBOOK F.
CREATE TABLE IF NOT EXISTS rate_limits (
  key_id       TEXT NOT NULL,
  route        TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, route, window_start)
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
  size_bytes  INTEGER,
  first_seen  INTEGER NOT NULL,
  UNIQUE(watcher_id, item_hash)
);

CREATE INDEX IF NOT EXISTS idx_watcher_items_watcher ON watcher_items(watcher_id, first_seen);
`;

// Idempotent column adds for DBs created before these columns existed.
// CREATE TABLE IF NOT EXISTS never alters an existing table, so evolving
// columns need explicit ALTERs guarded by PRAGMA table_info.
function migrate(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));

  const project = columns('projects');
  if (!project.has('webhook_secret')) db.exec('ALTER TABLE projects ADD COLUMN webhook_secret TEXT');
  if (!project.has('timezone')) db.exec("ALTER TABLE projects ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
  if (!project.has('tier')) db.exec("ALTER TABLE projects ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
  if (!project.has('stripe_customer_id')) db.exec('ALTER TABLE projects ADD COLUMN stripe_customer_id TEXT');
  if (!project.has('stripe_subscription_id')) db.exec('ALTER TABLE projects ADD COLUMN stripe_subscription_id TEXT');
  if (!project.has('subscription_status')) db.exec('ALTER TABLE projects ADD COLUMN subscription_status TEXT');
  if (!project.has('current_period_end')) db.exec('ALTER TABLE projects ADD COLUMN current_period_end INTEGER');

  if (!columns('watcher_items').has('size_bytes')) {
    db.exec('ALTER TABLE watcher_items ADD COLUMN size_bytes INTEGER');
  }
}

export function createDb(path: string): Db {
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  migrate(db);
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

// Opaque keyset pagination cursor: "<created_at>.<id>" base64url-encoded.
// Composite so two rows in the same second are never skipped or duplicated.
export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}.${id}`, 'utf-8').toString('base64url');
}
export function decodeCursor(cursor: string): [number, string] {
  const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
  const dot = raw.indexOf('.');
  if (dot === -1) return [Number(raw) || 0, '￿']; // tolerate legacy ts-only cursor
  return [Number(raw.slice(0, dot)) || 0, raw.slice(dot + 1)];
}
