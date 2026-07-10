import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { nowSec, genId } from './db.js';

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  name: string;
  scopes: string[];
  key_hash: string;
  key_prefix: string;
}

// Persistent fixed-window rate limiter: one row per (key, route, minute).
// Survives restart and is consistent for a single instance (the MVP target).
// Horizontal scale-out would need a shared store — tracked in PLAYBOOK F.
export function checkRateLimit(db: Db, keyId: string, route: string, limitPerMin = 60): boolean {
  const now = nowSec();
  const windowStart = Math.floor(now / 60) * 60;

  const row = db.prepare(
    'SELECT count FROM rate_limits WHERE key_id = ? AND route = ? AND window_start = ?',
  ).get(keyId, route, windowStart) as { count: number } | undefined;

  if ((row?.count ?? 0) >= limitPerMin) return false;

  db.prepare(`
    INSERT INTO rate_limits (key_id, route, window_start, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(key_id, route, window_start) DO UPDATE SET count = count + 1
  `).run(keyId, route, windowStart);

  // Opportunistic cleanup of windows older than 2 minutes.
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(windowStart - 120);
  return true;
}

export async function verifyApiKey(db: Db, rawKey: string): Promise<ApiKeyRecord | null> {
  if (!rawKey.startsWith('im_')) return null;
  const prefix = rawKey.slice(0, 16);
  const row = db.prepare(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL',
  ).get(prefix) as Record<string, unknown> | undefined;
  if (!row) return null;

  const valid = await argon2.verify(row.key_hash as string, rawKey);
  if (!valid) return null;

  // Update last_used_at
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowSec(), row.id);

  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    scopes: JSON.parse(row.scopes as string) as string[],
    key_hash: row.key_hash as string,
    key_prefix: row.key_prefix as string,
  };
}

export function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope) || scopes.includes('admin');
}

export interface BootstrapResult {
  key: string;
  projectId: string;
}

export async function bootstrapAdminKey(db: Db): Promise<BootstrapResult | null> {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM api_keys').get() as { cnt: number };
  if (existing.cnt > 0) return null;

  // Create default project with its own webhook signing secret
  const projectId = genId('proj_');
  const webhookSecret = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO projects (id, name, webhook_secret, created_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    'Default Project',
    webhookSecret,
    nowSec(),
  );

  // Generate admin key
  const secret = randomBytes(32).toString('base64url');
  const key = `im_${secret}`;
  const prefix = key.slice(0, 16);
  const hash = await argon2.hash(key);

  const keyId = genId('key_');
  db.prepare(
    'INSERT INTO api_keys (id, project_id, key_hash, key_prefix, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(keyId, projectId, hash, prefix, 'Admin Key', JSON.stringify(['admin']), nowSec());

  return { key, projectId };
}
