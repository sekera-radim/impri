/**
 * Audit log query + export routes.
 *
 * GET /v1/audit         — paginated query (admin scope)
 * GET /v1/audit/export  — streamed full export as ndjson or CSV (admin scope)
 *
 * Security:
 *   - Admin scope required for both endpoints.
 *   - project_id bound from the authenticated key — never from query params.
 *   - ip column is NEVER returned (lives in pii_log, not surfaced here).
 *   - Export is rate-limited to 5 req/min per key to prevent data-exfiltration storms.
 *   - Export respects AUDIT_RETENTION_DAYS — rows older than the window are excluded.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { nowSec } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import { AuditListQuery, AuditExportQuery } from '../schemas.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AuditRow {
  id: number;
  event: string;
  action_id: string | null;
  actor: string | null;
  channel: string | null;
  data: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Cursor helpers (separate from actions cursor: audit id is INTEGER not TEXT)
// ---------------------------------------------------------------------------

function encodeAuditCursor(createdAt: number, id: number): string {
  return Buffer.from(`${createdAt}.${id}`, 'utf-8').toString('base64url');
}

function decodeAuditCursor(cursor: string): [number, number] {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf-8');
    const dot = raw.indexOf('.');
    if (dot === -1) {
      const ts = Number(raw);
      return [isNaN(ts) ? 0 : ts, Number.MAX_SAFE_INTEGER];
    }
    const ts = Number(raw.slice(0, dot));
    const id = Number(raw.slice(dot + 1));
    return [isNaN(ts) ? 0 : ts, isNaN(id) ? Number.MAX_SAFE_INTEGER : id];
  } catch {
    return [0, Number.MAX_SAFE_INTEGER];
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeRow(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    event: row.event,
    ...(row.action_id != null ? { action_id: row.action_id } : {}),
    ...(row.actor     != null ? { actor:     row.actor     } : {}),
    ...(row.channel   != null ? { channel:   row.channel   } : {}),
    // data is stored as a JSON string; parse it for the API response.
    ...(row.data      != null ? { data: JSON.parse(row.data) as unknown } : {}),
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// CSV helpers (RFC 4180)
// ---------------------------------------------------------------------------

const CSV_HEADER = 'id,event,action_id,actor,channel,data,created_at';

function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection (Excel / LibreOffice Calc): when
  // the first character is a formula trigger (=, +, -, @, TAB, CR), prefix the
  // value with a single apostrophe so the cell is interpreted as text.
  // The apostrophe is placed BEFORE the RFC 4180 quoting so it is always the
  // first visible character regardless of whether the field ends up quoted.
  const formulaTrigger = /^[=+\-@\t\r]/;
  const escaped = formulaTrigger.test(s) ? "'" + s : s;
  // Wrap in double-quotes if the value contains a comma, double-quote, or newline.
  if (escaped.includes(',') || escaped.includes('"') || escaped.includes('\n') || escaped.includes('\r')) {
    return '"' + escaped.replace(/"/g, '""') + '"';
  }
  return escaped;
}

function toCsvRow(row: AuditRow): string {
  return [
    csvField(row.id),
    csvField(row.event),
    csvField(row.action_id),
    csvField(row.actor),
    csvField(row.channel),
    // data column: exported as the raw JSON string (already serialized in DB);
    // the caller receives it as a JSON string inside the CSV cell.
    csvField(row.data),
    csvField(row.created_at),
  ].join(',');
}

// ---------------------------------------------------------------------------
// Shared query builder (used by both query and export)
// ---------------------------------------------------------------------------

// Escape LIKE metacharacters so a user-supplied type prefix cannot inject wildcards.
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, c => '\\' + c);
}

interface FilterParams {
  type?: string;
  actor?: string;
  entity_id?: string;
  since?: number;
  until?: number;
}

function buildAuditWhere(
  projectId: string,
  f: FilterParams,
  opts: { retentionCutoff?: number } = {},
): { where: string; params: unknown[] } {
  let where = 'WHERE project_id = ?';
  const params: unknown[] = [projectId];

  // type filter: exact match OR dot-prefix match (e.g. 'action.' → event LIKE 'action.%')
  if (f.type) {
    if (f.type.endsWith('.')) {
      where += " AND event LIKE ? ESCAPE '\\'";
      params.push(escapeLike(f.type) + '%');
    } else {
      where += ' AND event = ?';
      params.push(f.type);
    }
  }

  if (f.actor) {
    where += ' AND actor = ?';
    params.push(f.actor);
  }

  // entity_id: covers action events (action_id column) and non-action events
  // where the entity id is stored in the JSON data blob.
  // JSON paths covered:
  //   action_id column  — action.created, action.approved, action.rejected, …
  //   $.rule_id         — rule.created, rule.updated, rule.deleted
  //   $.channel_id      — channel.created, channel.updated, channel.deleted, channel.tested
  //   $.watcher_id      — watcher.created, watcher.updated, watcher.deleted
  //   $.new_key_id      — key.created
  //   $.revoked_key_id  — key.revoked
  if (f.entity_id) {
    where +=
      " AND (action_id = ?" +
      " OR json_extract(data, '$.rule_id') = ?" +
      " OR json_extract(data, '$.channel_id') = ?" +
      " OR json_extract(data, '$.watcher_id') = ?" +
      " OR json_extract(data, '$.new_key_id') = ?" +
      " OR json_extract(data, '$.revoked_key_id') = ?)";
    params.push(f.entity_id, f.entity_id, f.entity_id, f.entity_id, f.entity_id, f.entity_id);
  }

  if (f.since !== undefined) {
    where += ' AND created_at >= ?';
    params.push(f.since);
  }

  if (f.until !== undefined) {
    where += ' AND created_at <= ?';
    params.push(f.until);
  }

  // Retention boundary: only applied for the export endpoint to keep it in sync
  // with the live retention window (rows older than this are already pruned or
  // will be pruned soon, so surfacing them in an export would be misleading).
  if (opts.retentionCutoff !== undefined) {
    where += ' AND created_at >= ?';
    params.push(opts.retentionCutoff);
  }

  return { where, params };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuditRoutes(app: FastifyInstance, db: Db): void {
  // GET /v1/audit — paginated query (admin scope)
  app.get('/v1/audit', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    const parsed = AuditListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const q = parsed.data;

    const { where, params } = buildAuditWhere(key.projectId, q);

    // Keyset cursor: (created_at DESC, id DESC) — prevents skips/duplicates at
    // the timestamp boundary. Predicate: row is "before" the cursor position.
    if (q.cursor) {
      const [cTs, cId] = decodeAuditCursor(q.cursor);
      params.push(cTs, cTs, cId);
    }

    const cursorClause = q.cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const sql =
      `SELECT id, event, action_id, actor, channel, data, created_at FROM audit_log ${where}` +
      cursorClause +
      ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(q.limit + 1); // fetch one extra to detect has_more

    const rows = db.prepare(sql).all(...params) as AuditRow[];
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(serializeRow),
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeAuditCursor(last.created_at, last.id) : undefined,
    };
  });

  // GET /v1/audit/export — streamed export (admin scope, rate-limited 5/min)
  app.get('/v1/audit/export', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'admin')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "admin" required' });
    }

    // 5 exports/min per key — export scans the full table, prevent storms.
    if (!(await checkRateLimit(db, key.keyId, 'audit:export', 5))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 5 requests/min per key' });
    }

    const parsed = AuditExportQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const q = parsed.data;

    // Retention boundary: if AUDIT_RETENTION_DAYS is configured, restrict the
    // export to the live retention window so exported data matches what's kept.
    const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10);
    const retentionCutoff = retentionDays > 0 ? nowSec() - retentionDays * 86400 : undefined;

    const { where, params } = buildAuditWhere(key.projectId, q, { retentionCutoff });
    const sql =
      `SELECT id, event, action_id, actor, channel, data, created_at FROM audit_log ${where}` +
      ' ORDER BY created_at DESC, id DESC';

    const isoDate = new Date().toISOString().slice(0, 10);
    const projectId = key.projectId;
    const format = q.format;
    const ext = format === 'csv' ? 'csv' : 'json';
    const contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson';
    const disposition = `attachment; filename="audit-export-${projectId}-${isoDate}.${ext}"`;

    // Hijack the raw response so we can stream rows without buffering all in memory.
    // better-sqlite3's .iterate() yields rows one at a time (synchronously) which
    // is ideal here — no await between rows, no memory spike.
    reply.hijack();
    const raw = reply.raw;

    try {
      raw.statusCode = 200;
      raw.setHeader('Content-Type', contentType);
      raw.setHeader('Content-Disposition', disposition);

      if (format === 'csv') {
        raw.write(CSV_HEADER + '\r\n');
        for (const row of db.prepare(sql).iterate(...params) as IterableIterator<AuditRow>) {
          raw.write(toCsvRow(row) + '\r\n');
        }
      } else {
        for (const row of db.prepare(sql).iterate(...params) as IterableIterator<AuditRow>) {
          raw.write(JSON.stringify(serializeRow(row)) + '\n');
        }
      }

      raw.end();
    } catch (err) {
      if (!raw.headersSent) {
        raw.statusCode = 500;
        raw.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else {
        raw.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}
