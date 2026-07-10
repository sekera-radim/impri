import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { genId, hashContent, nowSec, encodeCursor, decodeCursor } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import { approvalsLimitReached, getProjectBilling, TIER_LIMITS } from '../billing.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { notifyAll } from '../notify.js';
import { notifyPush } from '../push.js';
import {
  CreateActionBody,
  DecisionBody,
  ResultBody,
  ListActionsQuery,
} from '../schemas.js';

function serializeAction(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    preview: JSON.parse(row.preview as string),
    payload: row.payload ? JSON.parse(row.payload as string) : undefined,
    target_url: row.target_url ?? undefined,
    callback_url: row.callback_url ?? undefined,
    expires_at: row.expires_at ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    editable: JSON.parse(row.editable as string),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeActionWithDelivery(db: Db, row: Record<string, unknown>) {
  const base = serializeAction(row);
  const delivery = db.prepare(
    'SELECT status, attempt, last_status_code, last_error FROM webhook_deliveries WHERE action_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(row.id as string) as Record<string, unknown> | undefined;

  return {
    ...base,
    webhook_delivery: delivery
      ? {
          status: delivery.status,
          attempt: delivery.attempt,
          last_status_code: delivery.last_status_code ?? undefined,
          last_error: delivery.last_error ?? undefined,
        }
      : undefined,
  };
}

export function registerActionRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/actions
  app.post('/v1/actions', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "actions" required' });
    }

    // Rate limit: 60/min per key
    if (!(await checkRateLimit(db, key.keyId, 'actions:create', 60))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 60 requests/min per key' });
    }

    // Tier limit: monthly approvals quota gates NEW actions only — deciding on
    // already-pending actions is never blocked (safety). No-op when self-host.
    if (approvalsLimitReached(db, key.projectId)) {
      const tier = getProjectBilling(db, key.projectId).tier;
      return reply.status(402).send({
        error: 'Payment Required',
        message: `Monthly approvals limit reached for the ${tier} plan (${TIER_LIMITS[tier].approvalsPerMonth}). Pending actions can still be decided; upgrade to push more.`,
        limit: TIER_LIMITS[tier].approvalsPerMonth,
        tier,
      });
    }

    const parsed = CreateActionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // 256KB payload limit
    const payloadStr = body.payload !== undefined ? JSON.stringify(body.payload) : null;
    if (payloadStr && payloadStr.length > 256 * 1024) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Payload exceeds 256 KB limit' });
    }

    const now = nowSec();
    const expiresAt = now + body.expires_in;
    const previewHash = hashContent(body.kind, body.title, body.preview.body);

    // Idempotency check
    if (body.idempotency_key) {
      const existing = db.prepare(
        'SELECT * FROM actions WHERE project_id = ? AND idempotency_key = ?',
      ).get(key.projectId, body.idempotency_key) as Record<string, unknown> | undefined;
      if (existing) {
        reply.status(200);
        return serializeActionWithDelivery(db, existing);
      }
    }

    // Soft-dedup: same (kind, title, preview_hash) in pending state
    if (!body.idempotency_key) {
      const dup = db.prepare(
        "SELECT * FROM actions WHERE project_id = ? AND kind = ? AND preview_hash = ? AND status = 'pending'",
      ).get(key.projectId, body.kind, previewHash) as Record<string, unknown> | undefined;
      if (dup) {
        reply.status(200);
        return { ...serializeActionWithDelivery(db, dup), duplicate_of: dup.id };
      }
    }

    const actionId = genId('act_');
    const inboxUrl = `${process.env.BASE_URL ?? 'http://localhost:8484'}/inbox/${actionId}`;

    try {
      db.prepare(`
        INSERT INTO actions
          (id, project_id, kind, title, preview, payload, target_url, callback_url,
           expires_at, idempotency_key, editable, status, preview_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        actionId,
        key.projectId,
        body.kind,
        body.title,
        JSON.stringify(body.preview),
        payloadStr,
        body.target_url ?? null,
        body.callback_url ?? null,
        expiresAt,
        body.idempotency_key ?? null,
        JSON.stringify(body.editable),
        previewHash,
        now,
        now,
      );
    } catch (err) {
      // Concurrent request with the same idempotency_key won the INSERT race —
      // return the existing action (200) instead of a 500. PLAYBOOK A5.
      if (err instanceof Error && err.message.includes('UNIQUE') && body.idempotency_key) {
        const existing = db.prepare(
          'SELECT * FROM actions WHERE project_id = ? AND idempotency_key = ?',
        ).get(key.projectId, body.idempotency_key) as Record<string, unknown> | undefined;
        if (existing) {
          reply.status(200);
          return serializeActionWithDelivery(db, existing);
        }
      }
      throw err;
    }

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, created_at) VALUES (?, ?, 'action.created', ?)",
    ).run(key.projectId, actionId, now);

    // Send notifications asynchronously (don't await to keep response fast)
    notifyAll({ actionId, title: body.title, kind: body.kind, inboxUrl }).catch(() => {});
    notifyPush(db, key.projectId, { title: body.title, body: 'New action pending your approval', url: inboxUrl }).catch(() => {});

    reply.status(201);
    return {
      id: actionId,
      status: 'pending',
      inbox_url: inboxUrl,
      expires_at: expiresAt,
      created_at: now,
    };
  });

  // GET /v1/actions
  app.get('/v1/actions', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Higher ceiling than writes: agents long-poll this endpoint.
    if (!(await checkRateLimit(db, key.keyId, 'actions:list', 300))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 300 requests/min per key' });
    }

    const parsed = ListActionsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const q = parsed.data;

    let sql = 'SELECT * FROM actions WHERE project_id = ?';
    const params: unknown[] = [key.projectId];

    if (q.status) { sql += ' AND status = ?'; params.push(q.status); }
    if (q.since) { sql += ' AND created_at >= ?'; params.push(q.since); }
    if (q.kind) { sql += ' AND kind = ?'; params.push(q.kind); }
    // Composite (created_at, id) cursor so two rows in the same second are
    // never skipped or duplicated across page boundaries.
    if (q.cursor) {
      const [cTs, cId] = decodeCursor(q.cursor);
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(cTs, cTs, cId);
    }

    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(q.limit + 1);

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(r => serializeAction(r)),
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(last.created_at as number, last.id as string) : undefined,
    };
  });

  // GET /v1/actions/:id
  app.get<{ Params: { id: string } }>('/v1/actions/:id', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const row = db.prepare('SELECT * FROM actions WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    ) as Record<string, unknown> | undefined;

    if (!row) return reply.status(404).send({ error: 'Not Found' });

    const decision = db.prepare('SELECT * FROM decisions WHERE action_id = ?').get(row.id as string) as
      Record<string, unknown> | undefined;

    return {
      ...serializeActionWithDelivery(db, row),
      decision: decision
        ? {
            verdict: decision.verdict,
            decided_at: decision.decided_at,
            channel: decision.channel ?? undefined,
            final_preview: decision.final_preview ? JSON.parse(decision.final_preview as string) : undefined,
            diff: decision.diff ?? undefined,
          }
        : undefined,
    };
  });

  // POST /v1/actions/:id/decision
  app.post<{ Params: { id: string } }>('/v1/actions/:id/decision', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    if (!(await checkRateLimit(db, key.keyId, 'actions:decide', 60))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 60 requests/min per key' });
    }

    const parsed = DecisionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const action = db.prepare('SELECT * FROM actions WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    ) as Record<string, unknown> | undefined;

    if (!action) return reply.status(404).send({ error: 'Not Found' });

    if (action.status !== 'pending') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Action is already in state "${action.status}"`,
        current_status: action.status,
      });
    }

    // Editable whitelist validation — fail-closed: any unknown key is rejected (PLAYBOOK A3)
    const editableList = JSON.parse(action.editable as string) as string[];
    const edited = body.edited ?? {};
    const invalidKeys = Object.keys(edited).filter(k => !editableList.includes(k));
    if (invalidKeys.length > 0) {
      return reply.status(422).send({
        error: 'Unprocessable Entity',
        message: `Field(s) not in editable whitelist: ${invalidKeys.join(', ')}`,
        invalid_keys: invalidKeys,
        editable: editableList,
      });
    }

    const now = nowSec();

    // Apply edits to produce final preview (only for approve; reject ignores edits)
    const originalPreview = JSON.parse(action.preview as string) as { format: string; body: string };
    let finalPreview = { ...originalPreview };
    let diff: string | null = null;

    if (body.decision === 'approve' && Object.keys(edited).length > 0) {
      const editedPreview = { ...originalPreview };
      for (const [field, value] of Object.entries(edited)) {
        // Apply dot-path fields we know how to set on the preview object
        if (field === 'preview.body') editedPreview.body = value as string;
      }
      finalPreview = editedPreview;

      // Simple unified-style diff for the preview body when it changed
      if (editedPreview.body !== originalPreview.body) {
        diff = `--- original\n+++ edited\n@@ preview.body @@\n-${originalPreview.body}\n+${editedPreview.body}`;
      }
    }

    const newStatus = body.decision === 'approve' ? 'approved' : 'rejected';
    const decisionId = genId('dec_');

    // Decision + status flip + audit must be atomic: a crash between them would
    // leave a decision with a still-pending action (or vice versa). The unique
    // constraint on decisions(action_id) makes the first writer win; a
    // concurrent second decision rolls back and gets 409. PLAYBOOK A1.
    const commitDecision = db.transaction(() => {
      db.prepare(`
        INSERT INTO decisions (id, action_id, verdict, decided_by, decided_at, channel, final_preview, diff)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decisionId,
        action.id,
        body.decision,
        key.keyId,
        now,
        body.channel ?? 'api',
        JSON.stringify(finalPreview),
        diff,
      );
      db.prepare("UPDATE actions SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, now, action.id);
      db.prepare(
        "INSERT INTO audit_log (project_id, action_id, event, actor, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(key.projectId, action.id, `action.${body.decision}d`, key.keyId, body.channel ?? 'api', now);
      // Request IP is PII → separate, erasable table (not the immutable audit).
      db.prepare(
        "INSERT INTO pii_log (project_id, action_id, event, ip, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(key.projectId, action.id, `action.${body.decision}d`, request.ip ?? null, now);
    });

    try {
      commitDecision();
    } catch (err) {
      // Unique constraint violation = concurrent decision
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        const current = db.prepare('SELECT * FROM actions WHERE id = ?').get(action.id as string) as Record<string, unknown>;
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A concurrent decision was already recorded',
          current_status: current.status,
        });
      }
      throw err;
    }

    // Schedule webhook delivery if callback_url set
    if (action.callback_url) {
      scheduleWebhookDelivery(db, action.id as string, action.callback_url as string);
    }

    return {
      id: action.id,
      status: newStatus,
      verdict: body.decision,
      decided_at: now,
      final_preview: finalPreview,
      diff: diff ?? undefined,
    };
  });

  // POST /v1/actions/:id/result
  app.post<{ Params: { id: string } }>('/v1/actions/:id/result', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const parsed = ResultBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const action = db.prepare('SELECT * FROM actions WHERE id = ? AND project_id = ?').get(
      request.params.id,
      key.projectId,
    ) as Record<string, unknown> | undefined;

    if (!action) return reply.status(404).send({ error: 'Not Found' });

    if (action.status !== 'approved') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Cannot set result: action is in state "${action.status}", expected "approved"`,
        current_status: action.status,
      });
    }

    const now = nowSec();
    db.prepare("UPDATE actions SET status = ?, updated_at = ? WHERE id = ?").run(body.status, now, action.id);

    db.prepare(
      "INSERT INTO audit_log (project_id, action_id, event, data, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(key.projectId, action.id, `action.${body.status}`, JSON.stringify({ detail: body.detail }), now);

    return { id: action.id, status: body.status, updated_at: now };
  });
}
