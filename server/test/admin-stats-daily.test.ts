/**
 * GET /v1/admin/stats/daily — operator-only daily series for the dashboard "Stats" view.
 *
 * Covers:
 * - Operator gate: non-operator (and non-admin scope) gets 404, not 403 — endpoint stays undiscoverable
 * - Signups are cumulative per day and reconstructed retroactively from created_at
 * - Paid is null for PAST days (tier history isn't stored) and live for today —
 *   the point being it must never back-fill today's number into history
 * - Activity counts DISTINCT projects, so a busy project doesn't inflate "active"
 * - Failed/stuck actions are bucketed into the day they were created
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { nowSec } from '../src/db.js';
import type { Db } from '../src/db.js';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  process.env.OPERATOR_PROJECT_ID = bootstrap!.projectId;
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const DAY = 86_400;
const midnight = (): number => Math.floor(nowSec() / DAY) * DAY;

function addProject(db: Db, id: string, createdAt: number, tier = 'free'): void {
  db.prepare('INSERT INTO projects (id, name, timezone, tier, created_at) VALUES (?,?,?,?,?)').run(
    id,
    id,
    'UTC',
    tier,
    createdAt,
  );
}

function addAction(db: Db, id: string, projectId: string, createdAt: number, status: string): void {
  db.prepare(
    `INSERT INTO actions (id, project_id, kind, title, preview, preview_hash, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, projectId, 'test.kind', `title ${id}`, 'preview', `hash-${id}`, status, createdAt, createdAt);
}

describe('GET /v1/admin/stats/daily', () => {
  it('vrátí 404 komukoli mimo operátorský projekt (endpoint zůstane neobjevitelný)', async () => {
    const { app, adminKey } = await setup();
    process.env.OPERATOR_PROJECT_ID = 'someone-else';
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats/daily',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('signupy jsou kumulativní a dopočítané zpětně z created_at', async () => {
    const { db, app, adminKey } = await setup();
    const m = midnight();
    addProject(db, 'p-old', m - 5 * DAY); // před 5 dny
    addProject(db, 'p-mid', m - 2 * DAY); // před 2 dny
    addProject(db, 'p-today', m + 60); // dnes

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats/daily?days=7',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const { series } = res.json() as { series: { date: string; signups_total: number; signups_new: number }[] };
    expect(series).toHaveLength(7);

    // Bootstrap projekt vznikl teď, proto porovnáváme přírůstky, ne absolutní čísla.
    const day = (backDays: number) => series[series.length - 1 - backDays]!;
    expect(day(6).signups_total).toBe(0); // 6 dní zpět: ještě nic
    expect(day(5).signups_total).toBe(1); // p-old
    expect(day(2).signups_total).toBe(2); // + p-mid
    expect(day(0).signups_new).toBe(2); // p-today + bootstrap projekt
  });

  it('placené jsou null pro minulé dny a živé pro dnešek (historie tierů se neukládá)', async () => {
    const { db, app, adminKey } = await setup();
    addProject(db, 'p-paid', midnight() - 3 * DAY, 'indie');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats/daily?days=3',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const body = res.json() as { series: { paid_total: number | null }[]; paid_now: number };
    expect(body.paid_now).toBe(1);
    expect(body.series[0]!.paid_total).toBeNull(); // předevčírem — neznámé
    expect(body.series[1]!.paid_total).toBeNull(); // včera — neznámé
    expect(body.series[2]!.paid_total).toBe(1); // dnes — živé číslo
  });

  it('aktivní počítá RŮZNÉ projekty, ne akce; chybné a zaseknuté se řadí do svého dne', async () => {
    const { db, app, adminKey } = await setup();
    const m = midnight();
    addProject(db, 'p1', m - 3 * DAY);
    addProject(db, 'p2', m - 3 * DAY);
    // Jeden projekt se včera činil třikrát → aktivní = 1, ne 3.
    addAction(db, 'a1', 'p1', m - DAY + 10, 'executed');
    addAction(db, 'a2', 'p1', m - DAY + 20, 'execute_failed');
    addAction(db, 'a3', 'p1', m - DAY + 30, 'approved');
    addAction(db, 'a4', 'p2', m - DAY + 40, 'executed');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/stats/daily?days=2',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const body = res.json() as {
      series: { active: number; actions: number; failed: number; stuck_approved: number }[];
      unresolved: { id: string; status: string }[];
    };
    const yesterday = body.series[0]!;
    expect(yesterday.active).toBe(2);
    expect(yesterday.actions).toBe(4);
    expect(yesterday.failed).toBe(1);
    expect(yesterday.stuck_approved).toBe(1);

    // Nevyřešené se vypíšou konkrétně, ať se nemusí dohledávat ručně.
    const ids = body.unresolved.map((u) => u.id).sort();
    expect(ids).toEqual(['a2', 'a3']);
  });
});
