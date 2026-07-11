/**
 * Audit log tests.
 *
 * Covers:
 * - Every designed event type writes a row (recording points)
 * - GET /v1/audit filters (type exact + prefix, actor, entity_id, since/until)
 * - GET /v1/audit cursor pagination
 * - GET /v1/audit/export ndjson + CSV (including CSV special-character escaping)
 * - Admin-scope enforcement on both endpoints
 * - No-secret-content: action payload with a "secret-like" value never leaks to audit_log
 * - Retention prune: only fires when AUDIT_RETENTION_DAYS is set; no-op otherwise
 * - gdpr.erase tombstone: exactly one audit row survives the erase
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { pruneAuditLogs } from '../src/webhooks.js';
import type { Db } from '../src/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof createApp>>;

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

async function adminKey(app: App, baseKey: string, scopes: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/keys',
    headers: { Authorization: `Bearer ${baseKey}` },
    payload: { name: 'test-key', scopes },
  });
  return res.json().key as string;
}

async function createWatcher(app: App, key: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/watchers',
    headers: { Authorization: `Bearer ${key}` },
    payload: {
      name: 'Test watcher',
      kind: 'rss',
      config: { url: 'https://example.com/feed.xml' },
      schedule: { every: '5m' },
    },
  });
}

async function createChannel(app: App, key: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/notification-channels',
    headers: { Authorization: `Bearer ${key}` },
    payload: {
      name: 'Test channel',
      type: 'ntfy',
      config: { url: 'https://ntfy.sh', topic: 'test-topic' },
    },
  });
}

// Counter makes each action payload unique so soft-dedup never triggers.
let _actionSeq = 0;
async function createAction(app: App, key: string, extra: Record<string, unknown> = {}) {
  _actionSeq++;
  return app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { Authorization: `Bearer ${key}` },
    payload: {
      kind: 'audit.test',
      title: `Audit test action #${_actionSeq}`,
      preview: { format: 'plain', body: `body text ${_actionSeq}` },
      ...extra,
    },
  });
}

function latestAuditRow(db: Db, projectId: string, event: string) {
  return db.prepare(
    'SELECT * FROM audit_log WHERE project_id = ? AND event = ? ORDER BY id DESC LIMIT 1',
  ).get(projectId, event) as Record<string, unknown> | undefined;
}

function allAuditRows(db: Db, projectId: string) {
  return db.prepare(
    'SELECT * FROM audit_log WHERE project_id = ? ORDER BY id ASC',
  ).all(projectId) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Recording point tests
// ---------------------------------------------------------------------------

describe('Recording: key.created', () => {
  it('writes a key.created row with actor and data when a key is created', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'new-key', scopes: ['actions'] },
    });
    expect(res.statusCode).toBe(201);
    const newKeyId = res.json().id as string;

    const row = latestAuditRow(db, projectId, 'key.created');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    const data = JSON.parse(row!.data as string) as Record<string, unknown>;
    expect(data.new_key_id).toBe(newKeyId);
    expect(data.name).toBe('new-key');
    expect((data.scopes as string[]).includes('actions')).toBe(true);
    // Must NOT contain raw key material or hash
    expect(JSON.stringify(data)).not.toContain('im_');
    expect(JSON.stringify(data)).not.toContain('$argon2');
  });
});

describe('Recording: key.revoked', () => {
  it('writes a key.revoked row with actor and revoked_key_id', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'to-revoke', scopes: ['actions'] },
    });
    const { id: revokedId } = createRes.json();

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/keys/${revokedId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(delRes.statusCode).toBe(204);

    const row = latestAuditRow(db, projectId, 'key.revoked');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    const data = JSON.parse(row!.data as string);
    expect(data.revoked_key_id).toBe(revokedId);
  });
});

describe('Recording: watcher.created / updated / deleted', () => {
  it('watcher.created has actor, watcher_id, kind, name in data', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const watcherKey = await adminKey(app, key, ['watch']);
    const res = await createWatcher(app, watcherKey);
    expect(res.statusCode).toBe(201);
    const watcherId = res.json().id as string;

    const row = latestAuditRow(db, projectId, 'watcher.created');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    const data = JSON.parse(row!.data as string);
    expect(data.watcher_id).toBe(watcherId);
    expect(data.kind).toBe('rss');
    expect(data.name).toBe('Test watcher');
  });

  it('watcher.updated is recorded on PATCH', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const watcherKey = await adminKey(app, key, ['watch']);
    const createRes = await createWatcher(app, watcherKey);
    const watcherId = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/watchers/${watcherId}`,
      headers: { Authorization: `Bearer ${watcherKey}` },
      payload: { name: 'Updated name' },
    });
    expect(patchRes.statusCode).toBe(200);

    const row = latestAuditRow(db, projectId, 'watcher.updated');
    expect(row).toBeTruthy();
    const data = JSON.parse(row!.data as string);
    expect(data.watcher_id).toBe(watcherId);
  });

  it('watcher.deleted is recorded on DELETE', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const watcherKey = await adminKey(app, key, ['watch']);
    const createRes = await createWatcher(app, watcherKey);
    const watcherId = createRes.json().id as string;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/watchers/${watcherId}`,
      headers: { Authorization: `Bearer ${watcherKey}` },
    });
    expect(delRes.statusCode).toBe(204);

    const row = latestAuditRow(db, projectId, 'watcher.deleted');
    expect(row).toBeTruthy();
    const data = JSON.parse(row!.data as string);
    expect(data.watcher_id).toBe(watcherId);
  });
});

describe('Recording: channel.created / updated / deleted / tested', () => {
  it('channel.created has actor set', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await createChannel(app, key);
    expect(res.statusCode).toBe(201);

    const row = latestAuditRow(db, projectId, 'channel.created');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/); // actor was previously NULL
  });

  it('channel.updated has actor set', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const createRes = await createChannel(app, key);
    const channelId = createRes.json().id as string;

    await app.inject({
      method: 'PATCH',
      url: `/v1/notification-channels/${channelId}`,
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'Updated name' },
    });

    const row = latestAuditRow(db, projectId, 'channel.updated');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
  });

  it('channel.deleted has actor set', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const createRes = await createChannel(app, key);
    const channelId = createRes.json().id as string;

    await app.inject({
      method: 'DELETE',
      url: `/v1/notification-channels/${channelId}`,
      headers: { Authorization: `Bearer ${key}` },
    });

    const row = latestAuditRow(db, projectId, 'channel.deleted');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
  });

  it('channel.tested writes ok boolean in data, never config/token/URL', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const createRes = await createChannel(app, key);
    const channelId = createRes.json().id as string;

    // Test will likely fail (ntfy server unreachable in test) but that's fine —
    // we care that the audit row is written either way.
    await app.inject({
      method: 'POST',
      url: `/v1/notification-channels/${channelId}/test`,
      headers: { Authorization: `Bearer ${key}` },
    });

    const row = latestAuditRow(db, projectId, 'channel.tested');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    const data = JSON.parse(row!.data as string) as Record<string, unknown>;
    expect(data.channel_id).toBe(channelId);
    expect(data.type).toBe('ntfy');
    expect(typeof data.ok).toBe('boolean');
    // The raw config must not appear: no URL, no topic
    const raw = JSON.stringify(data);
    expect(raw).not.toContain('ntfy.sh');
    expect(raw).not.toContain('test-topic');
  });
});

describe('Recording: action.created has actor', () => {
  it('action.created row has actor field set to the submitting key', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await createAction(app, key);
    expect(res.statusCode).toBe(201);
    const actionId = res.json().id as string;

    const rows = db.prepare(
      "SELECT * FROM audit_log WHERE project_id = ? AND action_id = ? AND event = 'action.created'",
    ).all(projectId, actionId) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toMatch(/^key_/);
  });
});

describe('Recording: project.updated', () => {
  it('project.updated records fields_changed when name is patched', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'New Name' },
    });
    expect(res.statusCode).toBe(200);

    const row = latestAuditRow(db, projectId, 'project.updated');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    const data = JSON.parse(row!.data as string);
    expect(data.fields_changed).toContain('name');
  });

  it('project.updated does not write a row when body is empty', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { Authorization: `Bearer ${key}` },
      payload: {},
    });

    const row = latestAuditRow(db, projectId, 'project.updated');
    expect(row).toBeUndefined();
  });
});

describe('Recording: project.secret_rotated', () => {
  it('writes a row without exposing the old or new secret', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/project/rotate-webhook-secret',
      headers: { Authorization: `Bearer ${key}` },
    });
    const newSecret = res.json().webhook_secret as string;

    const row = latestAuditRow(db, projectId, 'project.secret_rotated');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
    // data should be absent (null) for this event
    const rowStr = JSON.stringify(row);
    expect(rowStr).not.toContain(newSecret);
  });
});

describe('Recording: gdpr.export and gdpr.erase', () => {
  it('gdpr.export is recorded in audit_log', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/project/export',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const row = latestAuditRow(db, projectId, 'gdpr.export');
    expect(row).toBeTruthy();
    expect(row!.actor).toMatch(/^key_/);
  });

  it('gdpr.erase leaves exactly one tombstone row (gdpr.erase) and no other rows', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    // Create some audit rows first
    await createAction(app, key);
    await createChannel(app, key);

    const before = allAuditRows(db, projectId);
    expect(before.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/project/data',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const after = allAuditRows(db, projectId);
    expect(after.length).toBe(1);
    expect(after[0].event).toBe('gdpr.erase');
    expect(after[0].actor).toMatch(/^key_/);
    const data = JSON.parse(after[0].data as string);
    expect(typeof data.erased_actions).toBe('number');
    expect(typeof data.erased_watchers).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/audit — query API
// ---------------------------------------------------------------------------

describe('GET /v1/audit — scope enforcement', () => {
  it('returns 403 without admin scope', async () => {
    const { app, adminKey: key } = await setup();
    const actionsKey = await adminKey(app, key, ['actions']);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { Authorization: `Bearer ${actionsKey}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 without any key', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/audit' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/audit — basic query', () => {
  it('returns items in descending created_at order', async () => {
    const { app, adminKey: key } = await setup();

    await createAction(app, key);
    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ created_at: number }> };
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].created_at).toBeGreaterThanOrEqual(items[i].created_at);
    }
  });

  it('data field is parsed from JSON (not a raw string)', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    // channel.created stores data = { channel_id, type }
    await createChannel(app, key);

    const row = latestAuditRow(db, projectId, 'channel.created');
    const channelId = JSON.parse(row!.data as string).channel_id as string;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?type=channel.created',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const item = (res.json() as { items: Array<Record<string, unknown>> }).items[0];
    expect(typeof item.data).toBe('object'); // parsed, not a string
    expect((item.data as Record<string, unknown>).channel_id).toBe(channelId);
  });

  it('ip field is never present in response items', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { Authorization: `Bearer ${key}` },
    });
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    for (const item of items) {
      expect('ip' in item).toBe(false);
    }
  });
});

describe('GET /v1/audit — type filter', () => {
  it('exact type filter returns only matching events', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);
    await createChannel(app, key);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?type=action.created',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ event: string }> };
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.event).toBe('action.created');
    }
  });

  it('dot-prefix type filter matches all events in the namespace', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    // Decide the action so we get action.approved too
    const actions = await app.inject({
      method: 'GET',
      url: '/v1/actions?status=pending',
      headers: { Authorization: `Bearer ${key}` },
    });
    const actionId = (actions.json() as { items: Array<{ id: string }> }).items[0]?.id;
    if (actionId) {
      await app.inject({
        method: 'POST',
        url: `/v1/actions/${actionId}/decision`,
        headers: { Authorization: `Bearer ${key}` },
        payload: { decision: 'approve' },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?type=action.',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ event: string }> };
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.event.startsWith('action.')).toBe(true);
    }
  });

  it('LIKE injection in type prefix is neutralised', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    // '%.' would match everything if not escaped
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?type=%25.',
      headers: { Authorization: `Bearer ${key}` },
    });
    // Should return 0 items (no event starts with '%.')
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: unknown[] };
    expect(items.length).toBe(0);
  });
});

describe('GET /v1/audit — actor filter', () => {
  it('actor filter returns only rows where actor matches', async () => {
    const { db, app, adminKey: key, projectId } = await setup();
    await createAction(app, key);

    const row = latestAuditRow(db, projectId, 'action.created');
    const actor = row!.actor as string;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit?actor=${actor}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ actor?: string }> };
    for (const item of items) {
      expect(item.actor).toBe(actor);
    }
  });
});

describe('GET /v1/audit — entity_id filter', () => {
  it('entity_id matches via action_id column', async () => {
    const { app, adminKey: key } = await setup();
    const res = await createAction(app, key);
    const actionId = res.json().id as string;

    const audit = await app.inject({
      method: 'GET',
      url: `/v1/audit?entity_id=${actionId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(audit.statusCode).toBe(200);
    const { items } = audit.json() as { items: Array<{ event: string }> };
    expect(items.length).toBeGreaterThanOrEqual(1);
    const events = items.map(i => i.event);
    expect(events).toContain('action.created');
  });

  it('entity_id matches channel events via json_extract(data, $.channel_id)', async () => {
    const { app, adminKey: key } = await setup();
    const createRes = await createChannel(app, key);
    const channelId = createRes.json().id as string;

    const audit = await app.inject({
      method: 'GET',
      url: `/v1/audit?entity_id=${channelId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(audit.statusCode).toBe(200);
    const { items } = audit.json() as { items: Array<{ event: string }> };
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.event === 'channel.created')).toBe(true);
  });

  it('entity_id matches rule events via json_extract(data, $.rule_id)', async () => {
    const { app, adminKey: key } = await setup();
    const ruleRes = await app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'Test rule', rule_action: 'auto_approve' },
    });
    expect(ruleRes.statusCode).toBe(201);
    const ruleId = ruleRes.json().id as string;

    const audit = await app.inject({
      method: 'GET',
      url: `/v1/audit?entity_id=${ruleId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(audit.statusCode).toBe(200);
    const { items } = audit.json() as { items: Array<{ event: string }> };
    expect(items.some(i => i.event === 'rule.created')).toBe(true);
  });

  it('entity_id matches key.created/revoked events via json_extract(data, $.new_key_id / $.revoked_key_id)', async () => {
    const { app, adminKey: key } = await setup();

    // Create a key so key.created is written
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${key}` },
      payload: { name: 'filter-test-key', scopes: ['actions'] },
    });
    expect(createRes.statusCode).toBe(201);
    const newKeyId = createRes.json().id as string;

    // Revoke it so key.revoked is written
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/keys/${newKeyId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Filter by the new key's id — must return both key.created and key.revoked
    const audit = await app.inject({
      method: 'GET',
      url: `/v1/audit?entity_id=${newKeyId}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(audit.statusCode).toBe(200);
    const { items } = audit.json() as { items: Array<{ event: string }> };
    const events = items.map(i => i.event);
    expect(events).toContain('key.created');
    expect(events).toContain('key.revoked');
  });
});

describe('GET /v1/audit — since/until filters', () => {
  it('since filter excludes rows before the cutoff', async () => {
    const { app, adminKey: key } = await setup();
    const futureTs = Math.floor(Date.now() / 1000) + 9999;

    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit?since=${futureTs}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: unknown[] };
    expect(items.length).toBe(0);
  });

  it('until filter excludes rows after the cutoff', async () => {
    const { app, adminKey: key } = await setup();
    const pastTs = Math.floor(Date.now() / 1000) - 9999;

    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit?until=${pastTs}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: unknown[] };
    expect(items.length).toBe(0);
  });
});

describe('GET /v1/audit — cursor pagination', () => {
  it('paginates correctly with limit + cursor', async () => {
    const { app, adminKey: key } = await setup();

    // Create enough events: 3 action creates = 3+ audit rows
    await createAction(app, key);
    await createAction(app, key);
    await createAction(app, key);

    // First page: limit=2
    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=2',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as {
      items: Array<{ id: number }>;
      has_more: boolean;
      next_cursor?: string;
    };
    expect(body1.items.length).toBe(2);
    expect(body1.has_more).toBe(true);
    expect(body1.next_cursor).toBeTruthy();

    // Second page using cursor
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/audit?limit=2&cursor=${body1.next_cursor}`,
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json() as { items: Array<{ id: number }>; has_more: boolean };
    expect(body2.items.length).toBeGreaterThanOrEqual(1);

    // No duplicates: all ids from page2 must not appear in page1
    const ids1 = new Set(body1.items.map(i => i.id));
    for (const item of body2.items) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });

  it('has_more is false and next_cursor is absent on the last page', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    // Use limit=200 (max) so everything fits in one page
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=200',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { has_more: boolean; next_cursor?: string };
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/audit/export
// ---------------------------------------------------------------------------

describe('GET /v1/audit/export — scope enforcement', () => {
  it('returns 403 without admin scope', async () => {
    const { app, adminKey: key } = await setup();
    const actionsKey = await adminKey(app, key, ['actions']);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export',
      headers: { Authorization: `Bearer ${actionsKey}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/audit/export — ndjson (default)', () => {
  it('returns ndjson with correct Content-Type and each line is valid JSON', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('audit-export-');
    expect(res.headers['content-disposition']).toContain('.json');

    const lines = res.body.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(typeof obj.id).toBe('number');
      expect(typeof obj.event).toBe('string');
      expect(typeof obj.created_at).toBe('number');
      // ip must never appear
      expect('ip' in obj).toBe(false);
    }
  });

  it('data field is a parsed object in ndjson output', async () => {
    const { app, adminKey: key } = await setup();
    await createChannel(app, key); // channel.created has data = {channel_id, type}

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?type=channel.created',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const first = JSON.parse(res.body.split('\n')[0]) as Record<string, unknown>;
    expect(typeof first.data).toBe('object');
    expect(first.data).not.toBeNull();
  });
});

describe('GET /v1/audit/export — CSV', () => {
  it('returns CSV with header row and correct Content-Type', async () => {
    const { app, adminKey: key } = await setup();
    await createAction(app, key);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?format=csv',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('.csv');

    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('id,event,action_id,actor,channel,data,created_at');
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + at least one row
  });

  it('CSV correctly escapes commas and double-quotes inside data field', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    // Insert a synthetic audit row whose data contains commas and double-quotes
    const tricky = '{"name":"Hello, \\"World\\"","val":42}';
    db.prepare(
      "INSERT INTO audit_log (project_id, event, actor, data, created_at) VALUES (?, 'test.csv_escape', ?, ?, ?)",
    ).run(projectId, 'key_test', tricky, Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?format=csv&type=test.csv_escape',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const lines = res.body.trim().split('\r\n');
    // Skip header
    const dataRow = lines[1];
    // The data field must be quoted (contains commas and quotes)
    expect(dataRow).toContain('"'); // the data cell is CSV-quoted
    // Verify the double-quote inside the value is doubled ("" in CSV)
    expect(dataRow).toContain('""');
  });

  it('CSV neutralizes formula injection: values starting with = + - @ TAB CR are prefixed with apostrophe', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    // Insert synthetic rows with formula trigger characters in the channel column.
    // Direct DB insert bypasses schema validation so we can test the export
    // defense independently of schema constraints.
    const formulaChannels = ['=cmd', '+ATTACK', '-1+1', '@SUM(1+1)'];
    const ts = Math.floor(Date.now() / 1000);
    for (const ch of formulaChannels) {
      db.prepare(
        "INSERT INTO audit_log (project_id, event, channel, created_at) VALUES (?, 'test.csv_formula', ?, ?)",
      ).run(projectId, ch, ts);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?format=csv&type=test.csv_formula',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const lines = res.body.trim().split('\r\n');
    const dataRows = lines.slice(1); // skip header
    expect(dataRows.length).toBe(formulaChannels.length);

    // Export is ORDER BY created_at DESC, id DESC — rows come back reversed relative
    // to insertion order. Check invariants across all rows rather than by index.
    for (const formulaChannel of formulaChannels) {
      // Each neutralized value (`'<original>`) must appear in exactly one row.
      const neutralized = "'" + formulaChannel;
      expect(dataRows.some(row => row.includes(neutralized))).toBe(true);
    }
    // No formula trigger character may appear immediately after a comma (unprotected field start).
    for (const row of dataRows) {
      expect(row).not.toMatch(/,[=+\-@\t\r]/);
    }
  });

  it('CSV handles null fields gracefully (empty string for null)', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES (?, 'test.nulls', ?)",
    ).run(projectId, Math.floor(Date.now() / 1000));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?format=csv&type=test.nulls',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\r\n');
    expect(lines.length).toBe(2); // header + 1 row
    // Null fields become empty CSV cells (commas still present)
    expect(lines[1].split(',').length).toBe(7); // 7 columns
  });
});

describe('GET /v1/audit/export — retention boundary', () => {
  it('excludes rows older than AUDIT_RETENTION_DAYS when set', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    // Insert a row with a very old timestamp (200 days ago)
    const oldTs = Math.floor(Date.now() / 1000) - 200 * 86400;
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES (?, 'test.old', ?)",
    ).run(projectId, oldTs);

    // Also insert a recent row
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES (?, 'test.recent', ?)",
    ).run(projectId, Math.floor(Date.now() / 1000));

    // Without retention: both rows appear
    const noRetention = await app.inject({
      method: 'GET',
      url: '/v1/audit/export?type=test.',
      headers: { Authorization: `Bearer ${key}` },
    });
    const noRetLines = noRetention.body.trim().split('\n').filter(Boolean);
    expect(noRetLines.length).toBe(2); // old + recent

    // With retention=30 days: only recent row
    vi.stubEnv('AUDIT_RETENTION_DAYS', '30');
    try {
      const withRetention = await app.inject({
        method: 'GET',
        url: '/v1/audit/export?type=test.',
        headers: { Authorization: `Bearer ${key}` },
      });
      const retLines = withRetention.body.trim().split('\n').filter(Boolean);
      expect(retLines.length).toBe(1);
      const obj = JSON.parse(retLines[0]) as { event: string };
      expect(obj.event).toBe('test.recent');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('export rate-limits at 5 requests/min per key', async () => {
    const { app, adminKey: key } = await setup();

    // Hit the rate limit
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/v1/audit/export',
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(r.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'GET',
      url: '/v1/audit/export',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// No-secret-content assertion
// ---------------------------------------------------------------------------

describe('No-secret-content assertion', () => {
  it('action payload containing a password-like value never appears in audit_log', async () => {
    const { db, app, adminKey: key, projectId } = await setup();

    const secretValue = 'super-secret-password-12345';

    // Create an action with a secret-like payload
    const actionRes = await createAction(app, key, {
      payload: { operation: 'db.backup', password: secretValue, token: 'tok_' + secretValue },
      editable: ['preview.body'],
    });
    expect(actionRes.statusCode).toBe(201);
    const actionId = actionRes.json().id as string;

    // Approve the action
    await app.inject({
      method: 'POST',
      url: `/v1/actions/${actionId}/decision`,
      headers: { Authorization: `Bearer ${key}` },
      payload: { decision: 'approve' },
    });

    // Inspect all audit rows for this action
    const rows = db.prepare(
      'SELECT data FROM audit_log WHERE project_id = ? AND action_id = ?',
    ).all(projectId, actionId) as Array<{ data: string | null }>;

    for (const row of rows) {
      if (row.data) {
        expect(row.data).not.toContain(secretValue);
      }
    }

    // Also check non-action rows (all rows in this project)
    const allRows = db.prepare(
      'SELECT data FROM audit_log WHERE project_id = ?',
    ).all(projectId) as Array<{ data: string | null }>;
    for (const row of allRows) {
      if (row.data) {
        expect(row.data).not.toContain(secretValue);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Retention prune
// ---------------------------------------------------------------------------

describe('Retention prune (pruneAuditLogs)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a no-op when AUDIT_RETENTION_DAYS is not set', () => {
    const db = createDb(':memory:');
    // Seed some old rows
    const oldTs = Math.floor(Date.now() / 1000) - 400 * 86400;
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test', ?)").run(oldTs);
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES ('p1', 'test.old', ?)",
    ).run(oldTs);

    // No env var → prune must not delete anything
    delete process.env.AUDIT_RETENTION_DAYS;
    pruneAuditLogs(db);

    const count = (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('deletes audit_log rows older than AUDIT_RETENTION_DAYS', () => {
    const db = createDb(':memory:');
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 86400; // 60 days ago
    const nowTs = Math.floor(Date.now() / 1000);

    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test', ?)").run(nowTs);
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES ('p1', 'test.old', ?)",
    ).run(oldTs);
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES ('p1', 'test.new', ?)",
    ).run(nowTs);

    vi.stubEnv('AUDIT_RETENTION_DAYS', '30'); // 30-day window → 60-day-old row is pruned
    pruneAuditLogs(db);

    const rows = db.prepare('SELECT event FROM audit_log').all() as Array<{ event: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('test.new');
  });

  it('deletes pii_log rows independently via PII_RETENTION_DAYS', () => {
    const db = createDb(':memory:');
    const oldTs = Math.floor(Date.now() / 1000) - 10 * 86400; // 10 days ago
    const nowTs = Math.floor(Date.now() / 1000);

    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Test', ?)").run(nowTs);
    db.prepare(
      "INSERT INTO pii_log (project_id, event, ip, created_at) VALUES ('p1', 'test', '1.2.3.4', ?)",
    ).run(oldTs);
    db.prepare(
      "INSERT INTO audit_log (project_id, event, created_at) VALUES ('p1', 'test.keep', ?)",
    ).run(oldTs); // audit row stays (longer retention)

    // AUDIT_RETENTION_DAYS=30, PII_RETENTION_DAYS=7 → pii_log row (10 days old) is pruned
    vi.stubEnv('AUDIT_RETENTION_DAYS', '30');
    vi.stubEnv('PII_RETENTION_DAYS', '7');
    pruneAuditLogs(db);

    const piiCount = (db.prepare('SELECT COUNT(*) as c FROM pii_log').get() as { c: number }).c;
    expect(piiCount).toBe(0); // pruned

    const auditCount = (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
    expect(auditCount).toBe(1); // kept (only 10 days old, retention=30)
  });
});
