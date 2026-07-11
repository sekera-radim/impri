import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { genId, hashContent, nowSec, encodeCursor, decodeCursor } from '../db.js';
import { hasScope, checkRateLimit } from '../auth.js';
import { approvalsLimitReached, getProjectBilling, TIER_LIMITS } from '../billing.js';
import { scheduleWebhookDelivery } from '../webhooks.js';
import { notifyAll } from '../notify.js';
import { notifyPush } from '../push.js';
import { evaluateRules } from '../rules.js';
import {
  CreateActionBody,
  DecisionBody,
  ResultBody,
  ListActionsQuery,
  BulkDecisionBody,
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

    // Evaluate rules AFTER idempotency/dedup and BEFORE INSERT so we can
    // override expires_in or short-circuit to auto_approve / auto_reject.
    // Zero-rule guarantee: when a project has no rules, evaluateRules returns
    // null and the handler behaves byte-for-byte as it did before.
    const rule = evaluateRules(db, key.projectId, body);

    const effectiveExpiresIn = rule?.action === 'set_expiry' ? rule.expiresIn : body.expires_in;
    const expiresAt = now + effectiveExpiresIn;

    const initialStatus =
      rule?.action === 'auto_approve' ? 'approved' :
      rule?.action === 'auto_reject'  ? 'rejected'  :
      'pending';

    // Wrap INSERT + optional auto-decision row + audit in one transaction so a
    // crash between them cannot leave a half-applied state. The UNIQUE constraint
    // on (project_id, idempotency_key) still governs concurrent races — the
    // losing thread catches UNIQUE, reads back the winning row, and returns 200.
    const insertAndLog = db.transaction(() => {
      db.prepare(`
        INSERT INTO actions
          (id, project_id, kind, title, preview, payload, target_url, callback_url,
           expires_at, idempotency_key, editable, status, preview_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        initialStatus,
        previewHash,
        now,
        now,
      );

      // For auto-decisions, insert a synthetic decision row so GET /v1/actions/:id
      // shows the verdict and final_preview, and webhook delivery carries the verdict.
      if (rule?.action === 'auto_approve' || rule?.action === 'auto_reject') {
        const verdict = rule.action === 'auto_approve' ? 'approve' : 'reject';
        db.prepare(`
          INSERT INTO decisions
            (id, action_id, verdict, decided_by, decided_at, channel, final_preview, diff)
          VALUES (?, ?, ?, ?, ?, 'auto', ?, NULL)
        `).run(
          genId('dec_'),
          actionId,
          verdict,
          `rule:${rule.ruleId}`,
          now,
          JSON.stringify(body.preview),
        );
      }

      db.prepare(
        "INSERT INTO audit_log (project_id, action_id, event, created_at) VALUES (?, ?, 'action.created', ?)",
      ).run(key.projectId, actionId, now);

      if (rule) {
        db.prepare(
          "INSERT INTO audit_log (project_id, action_id, event, data, created_at) VALUES (?, ?, 'action.rule_applied', ?, ?)",
        ).run(
          key.projectId,
          actionId,
          JSON.stringify({ rule_id: rule.ruleId, rule_name: rule.ruleName, outcome: rule.action }),
          now,
        );
      }
    });

    try {
      insertAndLog();
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

    // Always schedule webhook delivery when a callback_url is provided, including
    // for auto-decided actions — the agent's callback must receive the verdict.
    if (body.callback_url) {
      scheduleWebhookDelivery(db, actionId, body.callback_url);
    }

    // Skip human-facing notifications for actions already resolved by a rule.
    // Sending a push for an auto-approved action would confuse the reviewer.
    if (initialStatus === 'pending') {
      const escalateChannel = rule?.action === 'escalate' ? rule.channel : undefined;
      notifyAll({
        actionId,
        title: body.title,
        kind: body.kind,
        inboxUrl,
        ...(escalateChannel ? { escalateChannel } : {}),
      }).catch(() => {});
      notifyPush(db, key.projectId, { title: body.title, body: 'New action pending your approval', url: inboxUrl }).catch(() => {});
    }

    reply.status(201);
    return {
      id: actionId,
      status: initialStatus,
      inbox_url: inboxUrl,
      expires_at: expiresAt,
      created_at: now,
      ...(rule ? { rule_id: rule.ruleId } : {}),
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
    if (q.q) {
      // Escape LIKE metacharacters to prevent wildcard injection, then search
      // the title column and the preview body (via JSON1 json_extract).
      const pattern = '%' + q.q.replace(/[%_\\]/g, c => '\\' + c) + '%';
      sql += " AND (title LIKE ? ESCAPE '\\' OR json_extract(preview, '$.body') LIKE ? ESCAPE '\\')";
      params.push(pattern, pattern);
    }
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

  // POST /v1/actions/bulk-decision
  // Registered before /:id routes so the static segment "bulk-decision" is
  // unambiguous (Fastify would route correctly regardless, but explicit is clearer).
  app.post('/v1/actions/bulk-decision', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !hasScope(key.scopes, 'actions')) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Scope "actions" required' });
    }

    // Lower request ceiling than single-decision (10 vs 60) because each
    // request can touch up to 50 rows. Net throughput = 500 decisions/min.
    if (!(await checkRateLimit(db, key.keyId, 'actions:bulk-decide', 10))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Rate limit: 10 requests/min per key' });
    }

    const parsed = BulkDecisionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // Deduplicate IDs server-side so sending the same ID 50 times = one decision.
    const uniqueIds = [...new Set(body.ids)];
    const now = nowSec();

    // Distinguish browser-originated bulk ops from programmatic API calls
    // for auditability. Both are logged — this tag lets admins filter bulk ops.
    const ua = ((request.headers as Record<string, string | string[] | undefined>)['user-agent'] ?? '') as string;
    const channel = /mozilla/i.test(ua) ? 'bulk-web' : 'bulk-api';

    const results: Array<{ id: string; ok: boolean; status?: string; error?: string; current_status?: unknown }> = [];
    let succeeded = 0;
    let failed = 0;

    for (const id of uniqueIds) {
      // PROJECT ISOLATION: always bind project_id from the verified key —
      // never trust the client. An out-of-project ID returns not_found (same
      // response as a missing ID) so no information about other projects leaks.
      const action = db.prepare(
        'SELECT * FROM actions WHERE id = ? AND project_id = ?',
      ).get(id, key.projectId) as Record<string, unknown> | undefined;

      if (!action) {
        results.push({ id, ok: false, error: 'not_found' });
        failed++;
        continue;
      }

      if (action.status !== 'pending') {
        results.push({ id, ok: false, error: 'already_decided', current_status: action.status });
        failed++;
        continue;
      }

      const newStatus = body.verdict === 'approve' ? 'approved' : 'rejected';
      const decisionId = genId('dec_');
      // No edits in bulk — finalPreview is the original stored preview.
      const finalPreview = JSON.parse(action.preview as string) as object;

      // Each item is decided in its own transaction (per-item atomic,
      // batch-partial). Failures on item N do NOT roll back items 0..N-1.
      const commitBulkItem = db.transaction(() => {
        db.prepare(`
          INSERT INTO decisions
            (id, action_id, verdict, decided_by, decided_at, channel, final_preview, diff, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          decisionId,
          action.id,
          body.verdict,
          key.keyId,
          now,
          channel,
          JSON.stringify(finalPreview),
          body.comment ?? null,
        );
        db.prepare(
          'UPDATE actions SET status = ?, updated_at = ? WHERE id = ?',
        ).run(newStatus, now, action.id);
        db.prepare(
          'INSERT INTO audit_log (project_id, action_id, event, actor, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(key.projectId, action.id, `action.${body.verdict}d`, key.keyId, channel, now);
        // PII (request IP) in separate erasable table — identical to single-decision.
        db.prepare(
          'INSERT INTO pii_log (project_id, action_id, event, ip, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(key.projectId, action.id, `action.${body.verdict}d`, request.ip ?? null, now);
      });

      try {
        commitBulkItem();

        // Schedule webhook delivery per item — identical to single-decision.
        if (action.callback_url) {
          scheduleWebhookDelivery(db, action.id as string, action.callback_url as string);
        }

        results.push({ id, ok: true, status: newStatus });
        succeeded++;
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          // UNIQUE constraint on decisions(action_id) — concurrent decision won
          const current = db.prepare(
            'SELECT status FROM actions WHERE id = ?',
          ).get(id) as { status: string } | undefined;
          results.push({ id, ok: false, error: 'already_decided', current_status: current?.status });
        } else {
          // Unexpected DB error: log server-side but don't surface internals.
          app.log.error({ err, actionId: id }, 'bulk-decision: unexpected DB error on item');
          results.push({ id, ok: false, error: 'internal' });
        }
        failed++;
      }
    }

    // HTTP 200 even on partial failure — the batch was processed; per-item
    // results carry the outcome. The caller must inspect results[] to know
    // which items succeeded.
    return { results, succeeded, failed };
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
    // Tracks the serialized payload when payload.* fields were edited, so the
    // UPDATE in the transaction below can persist the new value atomically.
    let updatedPayloadStr: string | null = null;

    if (body.decision === 'approve' && Object.keys(edited).length > 0) {
      const editedPreview = { ...originalPreview };
      // Deep-clone the stored payload so we can mutate it for payload.* edits.
      const payloadClone: Record<string, unknown> = action.payload
        ? JSON.parse(JSON.stringify(JSON.parse(action.payload as string)))
        : {};
      let payloadChanged = false;

      for (const [field, value] of Object.entries(edited)) {
        if (field === 'preview.body') {
          editedPreview.body = value as string;
        } else if (field.startsWith('payload.')) {
          // Walk the dot-path inside the payload object and assign the new value.
          // The editable whitelist already confirmed this path is allowed (PLAYBOOK A3).
          const parts = field.split('.').slice(1); // strip the leading 'payload' segment
          let node: Record<string, unknown> = payloadClone;
          for (let i = 0; i < parts.length - 1; i++) {
            if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
              node[parts[i]] = {};
            }
            node = node[parts[i]] as Record<string, unknown>;
          }
          node[parts[parts.length - 1]] = value;
          payloadChanged = true;
        }
      }
      finalPreview = editedPreview;

      // Simple unified-style diff for the preview body when it changed
      if (editedPreview.body !== originalPreview.body) {
        diff = `--- original\n+++ edited\n@@ preview.body @@\n-${originalPreview.body}\n+${editedPreview.body}`;
      }

      if (payloadChanged) {
        updatedPayloadStr = JSON.stringify(payloadClone);
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
      // Persist payload edits atomically with the decision so a subsequent GET
      // returns the human-edited value in payload (PLAYBOOK A3).
      if (updatedPayloadStr !== null) {
        db.prepare("UPDATE actions SET payload = ? WHERE id = ?").run(updatedPayloadStr, action.id);
      }
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
