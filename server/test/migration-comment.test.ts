/**
 * migration-comment.test.ts
 *
 * Exercises the decisions.comment column migration guard in server/src/db.ts:
 *
 *   if (!columns('decisions').has('comment')) {
 *     db.exec('ALTER TABLE decisions ADD COLUMN comment TEXT');
 *   }
 *
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so this ALTER guard
 * is the only path for DBs created before the comment column was introduced.
 * The test simulates that scenario by opening a file-based DB without the column,
 * then calling createDb() on the same path — which runs SCHEMA_SQL (no-op on the
 * existing table) followed by migrate() (detects the gap and ALTERs it in).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createDb, nowSec, genId } from '../src/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

describe('migration: decisions.comment column', () => {
  it('adds comment column to a legacy DB that is missing it and persists a non-null comment', () => {
    const path = join(tmpdir(), `impri-test-migrate-comment-${Date.now()}.db`);
    try {
      // Bootstrap a pre-migration DB: decisions table without the comment column.
      // No FK on action_id so the test can insert decisions without a parent action row.
      const legacy = new Database(path);
      legacy.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE decisions (
          id            TEXT PRIMARY KEY,
          action_id     TEXT NOT NULL,
          verdict       TEXT NOT NULL,
          decided_by    TEXT,
          decided_at    INTEGER NOT NULL,
          channel       TEXT,
          final_preview TEXT,
          diff          TEXT,
          UNIQUE(action_id)
        );
      `);
      legacy.close();

      // createDb() opens the same file, runs SCHEMA_SQL (CREATE TABLE IF NOT EXISTS → no-op
      // on the existing decisions table), then calls migrate() which detects the missing
      // comment column and ALTERs it in.
      const db = createDb(path);

      // The column must now exist.
      const cols = new Set(
        (db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map(c => c.name),
      );
      expect(cols.has('comment')).toBe(true);

      // A decision with a non-null comment must persist and read back correctly.
      // The legacy decisions table has no FK constraint, so no action row is needed.
      const decisionId = genId('dec_');
      const fakeActionId = genId('act_');
      db.prepare(
        `INSERT INTO decisions (id, action_id, verdict, decided_at, comment)
         VALUES (?, ?, 'approve', ?, ?)`,
      ).run(decisionId, fakeActionId, nowSec(), 'looks good to me');

      const row = db
        .prepare('SELECT comment FROM decisions WHERE id = ?')
        .get(decisionId) as { comment: string };
      expect(row.comment).toBe('looks good to me');

      db.close();
    } finally {
      try { unlinkSync(path); } catch { /* ignore cleanup errors */ }
    }
  });
});
