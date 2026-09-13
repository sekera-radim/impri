/**
 * GET /v1/admin/stats — `funnel` object (activation funnel for the operator dashboard).
 *
 * Covers:
 * - Every step excludes the operator's own project (dogfooding must not count as a signup)
 * - first_action ignores the onboarding "Send a test approval" / `impri init --demo` actions
 *   (kind 'demo' or 'demo.*') so clicking the onboarding button doesn't count as activation
 * - first_decision / activated_* only count HUMAN decisions (channel != 'auto'); rule-engine
 *   auto_approve/auto_reject decisions (channel = 'auto') are not a person doing anything
 * - created_api_key / integration_connected / paid count distinct projects, not rows
 * - activated_last_7d / activated_last_30d are time-windowed on decided_at
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { nowSec, genId } from '../src/db.js';
import type { Db } from '../src/db.js';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  process.env.OPERATOR_PROJECT_ID = bootstrap!.projectId;
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, operatorId: bootstrap!.projectId };
}

function addProject(db: Db, id: string, tier = 'free'): void {
  db.prepare('INSERT INTO projects (id, name, timezone, tier, created_at) VALUES (?,?,?,?,?)').run(
    id,
    id,
    'UTC',
    tier,
    nowSec(),
  );
}

function addApiKey(db: Db, projectId: string): void {
  db.prepare(
    `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, name, scopes, created_at)
     VALUES (?, ?, 'hash', 'im_test', 'key', '[]', ?)`,
  ).run(genId('key_'), projectId, nowSec());
}

function addAction(db: Db, id: string, projectId: string, kind: string): string {
  db.prepare(
    `INSERT INTO actions (id, project_id, kind, title, preview, editable, status, preview_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'title', '{}', '[]', 'pending', 'h', ?, ?)`,
  ).run(id, projectId, kind, nowSec(), nowSec());
  return id;
}

function addDecision(db: Db, actionId: string, channel: string | null, decidedAt: number): void {
  db.prepare(
    `INSERT INTO decisions (id, action_id, verdict, decided_at, channel) VALUES (?, ?, 'approve', ?, ?)`,
  ).run(genId('dec_'), actionId, decidedAt, channel);
}

function addChannel(db: Db, projectId: string): void {
  db.prepare(
    `INSERT INTO notification_channels (id, project_id, name, type, enabled, config, created_at, updated_at)
     VALUES (?, ?, 'chan', 'webhook', 1, '{}', ?, ?)`,
  ).run(genId('nchan_'), projectId, nowSec(), nowSec());
}

async function getFunnel(app: Awaited<ReturnType<typeof setup>>['app'], adminKey: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/admin/stats',
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { funnel: Record<string, number> }).funnel;
}

describe('GET /v1/admin/stats — funnel', () => {
  it('vyloučí operátorský projekt ze všech kroků', async () => {
    const { app, adminKey, db, operatorId } = await setup();
    addApiKey(db, operatorId);
    addChannel(db, operatorId);
    const aid = addAction(db, 'a-op', operatorId, 'real.kind');
    addDecision(db, aid, 'api', nowSec());

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.signed_up).toBe(0);
    expect(funnel.created_api_key).toBe(0);
    expect(funnel.first_action).toBe(0);
    expect(funnel.first_decision).toBe(0);
    expect(funnel.integration_connected).toBe(0);
  });

  it('first_action ignoruje demo/onboarding akce, ale počítá reálné', async () => {
    const { app, adminKey, db } = await setup();
    addProject(db, 'p-demo-only');
    addAction(db, 'a1', 'p-demo-only', 'demo');
    addProject(db, 'p-cli-demo');
    addAction(db, 'a2', 'p-cli-demo', 'demo.email');
    addProject(db, 'p-real');
    addAction(db, 'a3', 'p-real', 'invoice.send');

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.signed_up).toBe(3);
    expect(funnel.first_action).toBe(1);
  });

  it('first_decision a activated_* počítají jen lidská rozhodnutí, ne auto_approve/auto_reject', async () => {
    const { app, adminKey, db } = await setup();
    addProject(db, 'p-auto');
    const aAuto = addAction(db, 'a-auto', 'p-auto', 'invoice.send');
    addDecision(db, aAuto, 'auto', nowSec()); // rule engine — not a person

    addProject(db, 'p-human');
    const aHuman = addAction(db, 'a-human', 'p-human', 'invoice.send');
    addDecision(db, aHuman, 'slack', nowSec());

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.first_decision).toBe(1);
    expect(funnel.activated_last_7d).toBe(1);
    expect(funnel.activated_last_30d).toBe(1);
  });

  it('first_decision/activated_* ignorují rozhodnutí o demo akcích; demo_decided je počítá zvlášť', async () => {
    const { app, adminKey, db } = await setup();

    // A project that only ever decided its onboarding "Send a test approval" action —
    // deciding it (even by a human) must NOT count as first_decision/activated, only
    // as demo_decided (the onboarding "aha" signal).
    addProject(db, 'p-demo-only');
    const aDemo = addAction(db, 'a-demo', 'p-demo-only', 'demo');
    addDecision(db, aDemo, 'api', nowSec());

    // Same for the CLI's `impri init --demo` seeded actions.
    addProject(db, 'p-cli-demo');
    const aCliDemo = addAction(db, 'a-cli-demo', 'p-cli-demo', 'demo.email');
    addDecision(db, aCliDemo, 'web', nowSec());

    // A project that decided a REAL action counts for first_decision/activated_*,
    // but not for demo_decided (it never touched a demo action).
    addProject(db, 'p-real');
    const aReal = addAction(db, 'a-real', 'p-real', 'invoice.send');
    addDecision(db, aReal, 'api', nowSec());

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.first_decision).toBe(1); // only p-real
    expect(funnel.activated_last_7d).toBe(1);
    expect(funnel.activated_last_30d).toBe(1);
    expect(funnel.demo_decided).toBe(2); // p-demo-only + p-cli-demo, not p-real
  });

  it('created_api_key, integration_connected a paid počítají DISTINCT projekty', async () => {
    const { app, adminKey, db } = await setup();
    addProject(db, 'p1', 'indie');
    addApiKey(db, 'p1');
    addApiKey(db, 'p1'); // two keys, same project — must not double count
    addChannel(db, 'p1');
    addProject(db, 'p2', 'free');

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.created_api_key).toBe(1);
    expect(funnel.integration_connected).toBe(1);
    expect(funnel.paid).toBe(1);
    expect(funnel.signed_up).toBe(2);
  });

  it('activated_last_7d/30d respektují časové okno', async () => {
    const { app, adminKey, db } = await setup();
    addProject(db, 'p-old');
    const aOld = addAction(db, 'a-old', 'p-old', 'invoice.send');
    addDecision(db, aOld, 'api', nowSec() - 40 * 86_400); // dávno mimo okna

    addProject(db, 'p-recent');
    const aRecent = addAction(db, 'a-recent', 'p-recent', 'invoice.send');
    addDecision(db, aRecent, 'api', nowSec() - 10 * 86_400); // v 30d, ne v 7d

    const funnel = await getFunnel(app, adminKey);
    expect(funnel.activated_last_7d).toBe(0);
    expect(funnel.activated_last_30d).toBe(1);
    expect(funnel.first_decision).toBe(2); // first_decision není časově omezené
  });
});
