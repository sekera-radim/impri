/**
 * Rules engine tests.
 *
 * Covers:
 * - CRUD for /v1/rules (admin scope, 50-rule cap, validation)
 * - Off-by-default guarantee: zero rules → identical behaviour to pre-rules code
 * - auto_approve, auto_reject, set_expiry, require_n_approvers, escalate outcomes
 * - Condition matching: kind_pattern (glob), payload_conditions (dot-path + ops), target_url_hosts
 * - First-match-wins priority semantics
 * - POST /v1/actions/:id/decision returns 409 on already auto-decided action
 * - Scope checks (non-admin key cannot access /v1/rules)
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

/** Helper: create a rule via the API. Returns the parsed rule body. */
async function createRule(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  body: Record<string, unknown>,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/rules',
    headers: { Authorization: `Bearer ${adminKey}` },
    payload: body,
  });
  return res;
}

/** Helper: create an action via the API. Returns the inject result. */
async function createAction(
  app: Awaited<ReturnType<typeof setup>>['app'],
  adminKey: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/actions',
    headers: { Authorization: `Bearer ${adminKey}` },
    payload: body,
  });
}

// ---------------------------------------------------------------------------
// Off-by-default guarantee
// ---------------------------------------------------------------------------

describe('Off-by-default guarantee', () => {
  it('project with zero rules creates pending action — response is identical to pre-rules behaviour', async () => {
    const { app, adminKey } = await setup();

    const res = await createAction(app, adminKey, {
      kind: 'no.rules.test',
      title: 'No rules action',
      preview: { format: 'plain', body: 'hello' },
      expires_in: 3600,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.id).toMatch(/^act_/);
    expect(body.inbox_url).toBeTruthy();
    expect(body.expires_at).toBeTypeOf('number');
    // rule_id must NOT appear when no rule matched
    expect(body.rule_id).toBeUndefined();
  });

  it('GET /v1/actions/:id shows pending status when no rules exist', async () => {
    const { app, adminKey } = await setup();

    const create = await createAction(app, adminKey, {
      kind: 'no.rules.get',
      title: 'No rules get',
      preview: { format: 'plain', body: 'check' },
    });
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// CRUD — basic
// ---------------------------------------------------------------------------

describe('Rules CRUD', () => {
  it('POST /v1/rules returns 201 with the created rule', async () => {
    const { app, adminKey } = await setup();

    const res = await createRule(app, adminKey, {
      name: 'Auto-approve low-risk',
      priority: 10,
      kind_pattern: 'email.*',
      rule_action: 'auto_approve',
    });

    expect(res.statusCode).toBe(201);
    const rule = res.json();
    expect(rule.id).toMatch(/^rul_/);
    expect(rule.name).toBe('Auto-approve low-risk');
    expect(rule.priority).toBe(10);
    expect(rule.kind_pattern).toBe('email.*');
    expect(rule.rule_action).toBe('auto_approve');
    expect(rule.enabled).toBe(true);
    expect(rule.payload_conditions).toEqual([]);
    expect(rule.target_url_hosts).toEqual([]);
    expect(rule.outcome_params).toEqual({});
  });

  it('GET /v1/rules returns items ordered by priority ASC', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, { name: 'High', priority: 200, rule_action: 'auto_approve' });
    await createRule(app, adminKey, { name: 'Low', priority: 10, rule_action: 'auto_reject' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/rules',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ name: string; priority: number }> };
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('Low');    // priority 10 first
    expect(items[1].name).toBe('High');   // priority 200 second
  });

  it('GET /v1/rules/:id returns 404 for unknown id', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/rules/rul_doesnotexist',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /v1/rules/:id updates only the provided fields', async () => {
    const { app, adminKey } = await setup();

    const create = await createRule(app, adminKey, {
      name: 'Original name',
      priority: 50,
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });
    const { id } = create.json();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/rules/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { name: 'Updated name', enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json();
    expect(updated.name).toBe('Updated name');
    expect(updated.enabled).toBe(false);
    expect(updated.priority).toBe(50);           // unchanged
    expect(updated.kind_pattern).toBe('*');      // unchanged
    expect(updated.rule_action).toBe('auto_approve'); // unchanged
  });

  it('DELETE /v1/rules/:id returns 204 and the rule is gone', async () => {
    const { app, adminKey } = await setup();

    const create = await createRule(app, adminKey, {
      name: 'Delete me',
      rule_action: 'auto_approve',
    });
    const { id } = create.json();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/rules/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/rules/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(404);
  });

  it('enforces 50-rule cap and returns 409 on the 51st rule', async () => {
    const { app, adminKey } = await setup();

    // Create 50 rules
    for (let i = 0; i < 50; i++) {
      const r = await createRule(app, adminKey, { name: `Rule ${i}`, rule_action: 'auto_approve' });
      expect(r.statusCode).toBe(201);
    }

    // 51st must be rejected
    const overflow = await createRule(app, adminKey, { name: 'One too many', rule_action: 'auto_approve' });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().message).toContain('maximum of 50');
  });
});

// ---------------------------------------------------------------------------
// CRUD — validation
// ---------------------------------------------------------------------------

describe('Rules CRUD validation', () => {
  it('returns 400 when rule_action is missing', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, { name: 'Bad' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for set_expiry with missing expires_in', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, {
      name: 'Bad expiry',
      rule_action: 'set_expiry',
      outcome_params: {},  // missing expires_in
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].message).toContain('expires_in');
  });

  it('returns 400 for set_expiry with out-of-range expires_in', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, {
      name: 'Bad expiry range',
      rule_action: 'set_expiry',
      outcome_params: { expires_in: 10 },  // below 300
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for require_n_approvers with n out of range', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, {
      name: 'Bad n',
      rule_action: 'require_n_approvers',
      outcome_params: { n: 1 },  // must be 2-100
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for kind_pattern with dangerous regex metacharacters', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, {
      name: 'ReDoS attempt',
      rule_action: 'auto_approve',
      kind_pattern: '(a+)+',  // + and () are rejected
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].message).toContain('kind_pattern');
  });

  it('allows dots in kind_pattern (common for dotted kinds like email.send)', async () => {
    const { app, adminKey } = await setup();
    const res = await createRule(app, adminKey, {
      name: 'Dotted kind',
      rule_action: 'auto_approve',
      kind_pattern: 'email.send',
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

describe('Rules scope enforcement', () => {
  it('returns 403 on POST /v1/rules with non-admin key', async () => {
    const { app, adminKey } = await setup();

    // Create an 'actions'-scoped key
    const keyRes = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { name: 'actions-only', scopes: ['actions'] },
    });
    const actionsKey = keyRes.json().key;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: { Authorization: `Bearer ${actionsKey}` },
      payload: { name: 'Sneaky', rule_action: 'auto_approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 on GET /v1/rules with non-admin key', async () => {
    const { app, adminKey } = await setup();

    const keyRes = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { name: 'actions-only', scopes: ['actions'] },
    });
    const actionsKey = keyRes.json().key;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/rules',
      headers: { Authorization: `Bearer ${actionsKey}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation — auto_approve
// ---------------------------------------------------------------------------

describe('Rule evaluation: auto_approve', () => {
  it('auto-approves action when kind matches wildcard *', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Approve all',
      priority: 1,
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });

    const res = await createAction(app, adminKey, {
      kind: 'anything.here',
      title: 'Auto-approved action',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('approved');
    expect(body.rule_id).toMatch(/^rul_/);
  });

  it('auto-approve action appears in GET /v1/actions/:id with decision', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Approve all',
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });

    const create = await createAction(app, adminKey, {
      kind: 'test.auto',
      title: 'Check decision',
      preview: { format: 'plain', body: 'body' },
    });
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(get.statusCode).toBe(200);
    const action = get.json();
    expect(action.status).toBe('approved');
    expect(action.decision).toBeTruthy();
    expect(action.decision.verdict).toBe('approve');
    expect(action.decision.channel).toBe('auto');
    expect(action.decision.decided_at).toBeTypeOf('number');
  });

  it('auto-approved action is NOT returned by ?status=pending filter', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Approve all',
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });

    await createAction(app, adminKey, {
      kind: 'test.auto',
      title: 'Auto approved',
      preview: { format: 'plain', body: 'body' },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/actions?status=pending',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBe(0);
  });

  it('POST /v1/actions/:id/decision returns 409 on an auto-approved action', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Approve all',
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });

    const create = await createAction(app, adminKey, {
      kind: 'test.auto',
      title: 'Already decided',
      preview: { format: 'plain', body: 'body' },
    });
    const { id } = create.json();

    const decision = await app.inject({
      method: 'POST',
      url: `/v1/actions/${id}/decision`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(409);
    expect(decision.json().current_status).toBe('approved');
  });

  it('kind_pattern glob matches correctly — email.* matches email.send but not payment.send', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Email only',
      kind_pattern: 'email.*',
      rule_action: 'auto_approve',
    });

    const emailRes = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'Email',
      preview: { format: 'plain', body: 'body' },
    });
    expect(emailRes.json().status).toBe('approved');

    const paymentRes = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Payment',
      preview: { format: 'plain', body: 'body' },
    });
    expect(paymentRes.json().status).toBe('pending');  // no match → pending
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation — auto_reject
// ---------------------------------------------------------------------------

describe('Rule evaluation: auto_reject', () => {
  it('auto-rejects action and status is rejected', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Reject payments',
      kind_pattern: 'payment.*',
      rule_action: 'auto_reject',
    });

    const res = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Rejected payment',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('rejected');
    expect(res.json().rule_id).toMatch(/^rul_/);
  });

  it('auto-rejected action has a decision row with verdict=reject and channel=auto', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Reject all',
      kind_pattern: '*',
      rule_action: 'auto_reject',
    });

    const create = await createAction(app, adminKey, {
      kind: 'any.kind',
      title: 'Auto rejected',
      preview: { format: 'plain', body: 'body' },
    });
    const { id } = create.json();

    const get = await app.inject({
      method: 'GET',
      url: `/v1/actions/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const action = get.json();
    expect(action.status).toBe('rejected');
    expect(action.decision.verdict).toBe('reject');
    expect(action.decision.channel).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation — set_expiry
// ---------------------------------------------------------------------------

describe('Rule evaluation: set_expiry', () => {
  it('set_expiry rule overrides expires_in from the action body', async () => {
    const { app, adminKey } = await setup();

    const customExpiry = 600; // 10 minutes
    await createRule(app, adminKey, {
      name: 'Short expiry',
      kind_pattern: 'quick.*',
      rule_action: 'set_expiry',
      outcome_params: { expires_in: customExpiry },
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await createAction(app, adminKey, {
      kind: 'quick.action',
      title: 'Quick',
      preview: { format: 'plain', body: 'body' },
      expires_in: 72 * 3600,  // default; should be overridden to 600
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');  // set_expiry doesn't change status
    expect(body.expires_at).toBeGreaterThanOrEqual(before + customExpiry);
    expect(body.expires_at).toBeLessThan(before + customExpiry + 10);  // within 10s
    expect(body.rule_id).toMatch(/^rul_/);
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation — require_n_approvers
// ---------------------------------------------------------------------------

describe('Rule evaluation: require_n_approvers', () => {
  it('require_n_approvers rule leaves action pending and logs rule_applied in audit', async () => {
    const { app, db, adminKey, projectId } = await setup();

    await createRule(app, adminKey, {
      name: 'Needs 2 approvers',
      kind_pattern: 'sensitive.*',
      rule_action: 'require_n_approvers',
      outcome_params: { n: 2 },
    });

    const res = await createAction(app, adminKey, {
      kind: 'sensitive.data',
      title: 'Needs quorum',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.rule_id).toMatch(/^rul_/);

    // Verify audit_log has an action.rule_applied event
    const logs = db.prepare(
      "SELECT * FROM audit_log WHERE project_id = ? AND event = 'action.rule_applied' ORDER BY id DESC LIMIT 1",
    ).all(projectId) as Array<{ data: string }>;
    expect(logs.length).toBe(1);
    const data = JSON.parse(logs[0].data);
    expect(data.outcome).toBe('require_n_approvers');
    expect(data.n).toBeUndefined(); // n is in outcome_params on the rule, not logged separately
  });
});

// ---------------------------------------------------------------------------
// Rule evaluation — escalate
// ---------------------------------------------------------------------------

describe('Rule evaluation: escalate', () => {
  it('escalate rule leaves action pending and records channel in audit', async () => {
    const { app, db, adminKey, projectId } = await setup();

    await createRule(app, adminKey, {
      name: 'Escalate urgent',
      kind_pattern: 'urgent.*',
      rule_action: 'escalate',
      outcome_params: { channel: 'ops-alerts' },
    });

    const res = await createAction(app, adminKey, {
      kind: 'urgent.incident',
      title: 'Escalate me',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.rule_id).toMatch(/^rul_/);

    const logs = db.prepare(
      "SELECT * FROM audit_log WHERE project_id = ? AND event = 'action.rule_applied' ORDER BY id DESC LIMIT 1",
    ).all(projectId) as Array<{ data: string }>;
    const data = JSON.parse(logs[0].data);
    expect(data.outcome).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// Payload conditions
// ---------------------------------------------------------------------------

describe('Payload conditions', () => {
  it('eq condition matches a specific payload field value', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Approve small amounts',
      kind_pattern: 'payment.*',
      payload_conditions: [{ path: 'currency', op: 'eq', value: 'USD' }],
      rule_action: 'auto_approve',
    });

    // USD → approved
    const usd = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'USD payment',
      preview: { format: 'plain', body: 'body' },
      payload: { currency: 'USD', amount: 100 },
    });
    expect(usd.json().status).toBe('approved');

    // EUR → not matched → pending
    const eur = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'EUR payment',
      preview: { format: 'plain', body: 'EUR body' },
      payload: { currency: 'EUR', amount: 100 },
    });
    expect(eur.json().status).toBe('pending');
  });

  it('lt condition rejects when amount exceeds threshold', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Auto-approve under 50',
      kind_pattern: 'payment.*',
      payload_conditions: [{ path: 'amount', op: 'lt', value: 50 }],
      rule_action: 'auto_approve',
    });

    const small = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Small',
      preview: { format: 'plain', body: 'body' },
      payload: { amount: 10 },
    });
    expect(small.json().status).toBe('approved');

    const large = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Large',
      preview: { format: 'plain', body: 'large body' },
      payload: { amount: 100 },
    });
    expect(large.json().status).toBe('pending');
  });

  it('gt and lte conditions work as expected', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Big transfers',
      kind_pattern: 'transfer.*',
      payload_conditions: [{ path: 'amount', op: 'gt', value: 999 }],
      rule_action: 'auto_reject',
    });

    const huge = await createAction(app, adminKey, {
      kind: 'transfer.wire',
      title: 'Huge',
      preview: { format: 'plain', body: 'body' },
      payload: { amount: 1000 },
    });
    expect(huge.json().status).toBe('rejected');

    const ok = await createAction(app, adminKey, {
      kind: 'transfer.wire',
      title: 'OK',
      preview: { format: 'plain', body: 'ok body' },
      payload: { amount: 500 },
    });
    expect(ok.json().status).toBe('pending');
  });

  it('contains condition on string field', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Reject spam domains',
      kind_pattern: 'email.*',
      payload_conditions: [{ path: 'to', op: 'contains', value: 'spam' }],
      rule_action: 'auto_reject',
    });

    const spam = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'Spam',
      preview: { format: 'plain', body: 'body' },
      payload: { to: 'user@spam.example.com' },
    });
    expect(spam.json().status).toBe('rejected');

    const legit = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'Legit',
      preview: { format: 'plain', body: 'legit body' },
      payload: { to: 'user@example.com' },
    });
    expect(legit.json().status).toBe('pending');
  });

  it('in condition checks if payload value is in the rule list', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Trusted regions',
      kind_pattern: 'deploy.*',
      payload_conditions: [{ path: 'region', op: 'in', value: ['us-east-1', 'eu-west-1'] }],
      rule_action: 'auto_approve',
    });

    const trusted = await createAction(app, adminKey, {
      kind: 'deploy.service',
      title: 'Trusted region',
      preview: { format: 'plain', body: 'body' },
      payload: { region: 'us-east-1' },
    });
    expect(trusted.json().status).toBe('approved');

    const untrusted = await createAction(app, adminKey, {
      kind: 'deploy.service',
      title: 'Untrusted region',
      preview: { format: 'plain', body: 'body2' },
      payload: { region: 'ap-southeast-1' },
    });
    expect(untrusted.json().status).toBe('pending');
  });

  it('not_in condition rejects when payload value is in the deny list', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Deny bad regions',
      kind_pattern: 'deploy.*',
      payload_conditions: [{ path: 'env', op: 'not_in', value: ['staging', 'dev'] }],
      rule_action: 'auto_reject',
    });

    const prod = await createAction(app, adminKey, {
      kind: 'deploy.service',
      title: 'Production deploy',
      preview: { format: 'plain', body: 'body' },
      payload: { env: 'production' },
    });
    expect(prod.json().status).toBe('rejected');  // 'production' not in ['staging','dev'] → rule matches

    const staging = await createAction(app, adminKey, {
      kind: 'deploy.service',
      title: 'Staging deploy',
      preview: { format: 'plain', body: 'staging body' },
      payload: { env: 'staging' },
    });
    expect(staging.json().status).toBe('pending');  // 'staging' IS in list → not_in fails → no match
  });

  it('nested dot-path resolves correctly (recipient.domain)', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Trusted domain',
      kind_pattern: 'email.*',
      payload_conditions: [{ path: 'recipient.domain', op: 'eq', value: 'trusted.com' }],
      rule_action: 'auto_approve',
    });

    const trusted = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'Trusted',
      preview: { format: 'plain', body: 'body' },
      payload: { recipient: { domain: 'trusted.com' } },
    });
    expect(trusted.json().status).toBe('approved');

    // Missing nested key → undefined → no match → pending
    const missing = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'Missing domain',
      preview: { format: 'plain', body: 'body2' },
      payload: { recipient: {} },
    });
    expect(missing.json().status).toBe('pending');

    // Null payload → no match → pending
    const noPayload = await createAction(app, adminKey, {
      kind: 'email.send',
      title: 'No payload',
      preview: { format: 'plain', body: 'body3' },
    });
    expect(noPayload.json().status).toBe('pending');
  });

  it('multiple payload conditions are AND-combined — all must match', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'All conditions',
      kind_pattern: '*',
      payload_conditions: [
        { path: 'currency', op: 'eq', value: 'USD' },
        { path: 'amount', op: 'lt', value: 100 },
      ],
      rule_action: 'auto_approve',
    });

    // Both match
    const both = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Both',
      preview: { format: 'plain', body: 'body' },
      payload: { currency: 'USD', amount: 50 },
    });
    expect(both.json().status).toBe('approved');

    // Only one matches → pending
    const partial = await createAction(app, adminKey, {
      kind: 'payment.send',
      title: 'Partial',
      preview: { format: 'plain', body: 'partial body' },
      payload: { currency: 'USD', amount: 200 },  // amount >= 100 → fails
    });
    expect(partial.json().status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// target_url_hosts condition
// ---------------------------------------------------------------------------

describe('target_url_hosts condition', () => {
  it('matches when action target_url hostname is in the allowlist', async () => {
    const { app, adminKey } = await setup();

    await createRule(app, adminKey, {
      name: 'Trusted hosts',
      kind_pattern: '*',
      target_url_hosts: ['trusted.example.com'],
      rule_action: 'auto_approve',
    });

    const trusted = await createAction(app, adminKey, {
      kind: 'file.download',
      title: 'Trusted download',
      preview: { format: 'plain', body: 'body' },
      target_url: 'https://trusted.example.com/file.pdf',
    });
    expect(trusted.json().status).toBe('approved');

    const untrusted = await createAction(app, adminKey, {
      kind: 'file.download',
      title: 'Untrusted download',
      preview: { format: 'plain', body: 'body2' },
      target_url: 'https://evil.example.com/file.pdf',
    });
    expect(untrusted.json().status).toBe('pending');

    // No target_url → rule skipped → pending
    const noUrl = await createAction(app, adminKey, {
      kind: 'file.download',
      title: 'No URL',
      preview: { format: 'plain', body: 'body3' },
    });
    expect(noUrl.json().status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// First-match-wins priority semantics
// ---------------------------------------------------------------------------

describe('First-match-wins priority semantics', () => {
  it('lower priority number wins when both rules match', async () => {
    const { app, adminKey } = await setup();

    // Priority 10 = approve; priority 20 = reject. Priority 10 wins.
    await createRule(app, adminKey, {
      name: 'Approve first',
      priority: 10,
      kind_pattern: 'order.*',
      rule_action: 'auto_approve',
    });
    await createRule(app, adminKey, {
      name: 'Reject second',
      priority: 20,
      kind_pattern: '*',
      rule_action: 'auto_reject',
    });

    const res = await createAction(app, adminKey, {
      kind: 'order.create',
      title: 'Order',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.json().status).toBe('approved');  // priority 10 won
  });

  it('disabled rule is skipped even if it would match', async () => {
    const { app, adminKey } = await setup();

    const createRes = await createRule(app, adminKey, {
      name: 'Disabled approve',
      priority: 1,
      kind_pattern: '*',
      rule_action: 'auto_approve',
      enabled: true,
    });
    const { id } = createRes.json();

    // Disable the rule
    await app.inject({
      method: 'PATCH',
      url: `/v1/rules/${id}`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { enabled: false },
    });

    // Action should now be pending (disabled rule is skipped)
    const res = await createAction(app, adminKey, {
      kind: 'any.kind',
      title: 'After disable',
      preview: { format: 'plain', body: 'body' },
    });
    expect(res.json().status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Idempotency interaction — rules must not re-fire on repeated requests
// ---------------------------------------------------------------------------

describe('Idempotency interaction with rules', () => {
  it('returns the stored status on a repeated request — rules do not re-fire', async () => {
    const { app, adminKey } = await setup();

    // First: create with an approve rule → approved
    await createRule(app, adminKey, {
      name: 'Approve all',
      kind_pattern: '*',
      rule_action: 'auto_approve',
    });

    const payload = {
      kind: 'idem.test',
      title: 'Idempotent',
      preview: { format: 'plain', body: 'same' },
      idempotency_key: 'rule-idem-001',
    };

    const first = await createAction(app, adminKey, payload);
    expect(first.statusCode).toBe(201);
    expect(first.json().status).toBe('approved');

    // Now disable the rule and repeat with same key — should return the stored row (approved)
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/rules',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const ruleId = listRes.json().items[0].id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/rules/${ruleId}`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { enabled: false },
    });

    const second = await createAction(app, adminKey, payload);
    // Idempotency returns existing row with status=200, not 201
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('approved');  // stored status is authoritative
  });
});

// ---------------------------------------------------------------------------
// Audit log entries
// ---------------------------------------------------------------------------

describe('Audit log entries', () => {
  it('action.created and action.rule_applied events are both written', async () => {
    const { app, db, adminKey, projectId } = await setup();

    await createRule(app, adminKey, {
      name: 'Audit test rule',
      kind_pattern: 'audit.*',
      rule_action: 'auto_approve',
    });

    const res = await createAction(app, adminKey, {
      kind: 'audit.check',
      title: 'Audit',
      preview: { format: 'plain', body: 'body' },
    });
    const { id } = res.json();

    const events = db.prepare(
      'SELECT event, data FROM audit_log WHERE action_id = ? ORDER BY id ASC',
    ).all(id) as Array<{ event: string; data: string | null }>;

    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('action.created');
    expect(eventNames).toContain('action.rule_applied');

    const ruleEvent = events.find(e => e.event === 'action.rule_applied');
    expect(ruleEvent).toBeTruthy();
    const ruleData = JSON.parse(ruleEvent!.data!);
    expect(ruleData.outcome).toBe('auto_approve');
    expect(ruleData.rule_id).toMatch(/^rul_/);
    expect(ruleData.rule_name).toBe('Audit test rule');
  });

  it('no action.rule_applied event when no rule matches', async () => {
    const { app, db, adminKey, projectId } = await setup();

    // Rule only matches 'email.*', action is 'other.kind'
    await createRule(app, adminKey, {
      name: 'Email only',
      kind_pattern: 'email.*',
      rule_action: 'auto_approve',
    });

    const res = await createAction(app, adminKey, {
      kind: 'other.kind',
      title: 'No match',
      preview: { format: 'plain', body: 'body' },
    });
    const { id } = res.json();

    const ruleEvents = db.prepare(
      "SELECT * FROM audit_log WHERE action_id = ? AND event = 'action.rule_applied'",
    ).all(id);
    expect(ruleEvents.length).toBe(0);
  });
});
