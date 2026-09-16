/**
 * Impri status page — samostatný Cloudflare Worker (žádná externí služba).
 *
 * scheduled (cron každých 15 min): změří všechny targety a zapíše do KV
 *   - "latest"   → aktuální stav + "pending" (nezapsané čítače od poslední
 *                  hodiny — viz KV-budget poznámka v runChecks) (pro hlavičku stránky)
 *   - "history"  → 60denní okno denních agregátů { n, fail, msSum } na target,
 *                  zapisuje se max 1×/hod (fold z "pending")
 * fetch: HTML stránka + GET /api/status (JSON).
 *
 * Vedlejší efekt cron pingů: drží scale-to-zero API stroj teplý (žádné cold starty).
 */

/** Brand ikonka: Impri checkmark na indigo dlaždici + zelená status tečka. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#6366f1"/>
  <path d="M17 33.5l10.5 10.5L47 22" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="50" cy="50" r="10" fill="#22c55e" stroke="#0d0e14" stroke-width="4"/>
</svg>`;

const TARGETS = [
  { id: 'api', name: 'API (api.impri.dev)', url: 'https://api.impri.dev/healthz', expect: 200 },
  { id: 'app', name: 'App (app.impri.dev)', url: 'https://app.impri.dev/', expect: 200 },
  { id: 'web', name: 'Web + Docs (impri.dev)', url: 'https://impri.dev/', expect: 200 },
];

const DAYS_SHOWN = 60;
// How long an edge-cached page may be stale. See the KV note in runChecks.
const PAGE_CACHE_SEC = 120;

function dateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function checkTarget(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'impri-status/1.0 (+https://status.impri.dev)' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return { ok: res.status === t.expect, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(err && err.message ? err.message : err) };
  }
}

async function runChecks(env) {
  const now = Date.now();
  const results = {};
  for (const t of TARGETS) {
    results[t.id] = { ...(await checkTarget(t)), ts: now };
  }

  // KV budget: at 15-minute intervals that's 96 runs/day. Writing "history"
  // (the 60-day window) on every run cost 192 writes/day against the free
  // tier's 1000/day limit, shared with other Workers on the account. Instead
  // we fold each run's per-target counters into "pending" — a field on
  // "latest", which is written every run anyway, so this costs no extra
  // write — and only fold "pending" into "history" when the UTC hour bucket
  // changes. That's 96 "latest" writes + ~24 "history" writes ≈ 120/day.
  const curHour = new Date(now).toISOString().slice(0, 13); // 'YYYY-MM-DDTHH', UTC
  const prevLatest = await env.STATUS_KV.get('latest', 'json');
  const prevPending = prevLatest?.pending ?? null;

  // A day rollover is an hour rollover too ("…T23" -> "…T00"), so comparing
  // hour buckets alone guarantees the day's last hour always flushes before
  // the new day starts — no separate day-boundary case is needed.
  if (prevPending && prevPending.hour !== curHour) {
    await flushToHistory(env, prevPending, now);
  }

  const pending = prevPending && prevPending.hour === curHour
    ? prevPending
    : { hour: curHour, counts: {} };
  for (const t of TARGETS) {
    const cell = pending.counts[t.id] ?? { n: 0, fail: 0, msSum: 0 };
    cell.n += 1;
    if (!results[t.id].ok) cell.fail += 1;
    cell.msSum += results[t.id].ms;
    pending.counts[t.id] = cell;
  }

  await env.STATUS_KV.put('latest', JSON.stringify({ ts: now, results, pending }));
  return results;
}

/**
 * Folds one finished hour's "pending" counters into "history" and trims the
 * window. Runs at most once an hour (called only on an hour-bucket change),
 * which is what keeps "history" out of the per-run write budget.
 */
async function flushToHistory(env, finishedPending, now) {
  const day = finishedPending.hour.slice(0, 10);
  let history = (await env.STATUS_KV.get('history', 'json')) ?? null;

  // One-time migration from the per-day keys. Sixty reads, once; afterwards
  // 'history' exists and this never runs again.
  if (history === null) {
    history = {};
    for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
      const d = dateKey(now - i * 86400_000);
      const old = await env.STATUS_KV.get(`agg:${d}`, 'json');
      if (old) history[d] = old;
    }
  }

  const cell = history[day] ?? {};
  for (const t of TARGETS) {
    const p = finishedPending.counts[t.id];
    if (!p) continue;
    const c = cell[t.id] ?? { n: 0, fail: 0, msSum: 0 };
    c.n += p.n;
    c.fail += p.fail;
    c.msSum += p.msSum;
    cell[t.id] = c;
  }
  history[day] = cell;

  // Trim here rather than with a per-key TTL, which one combined key cannot have.
  const cutoff = dateKey(now - DAYS_SHOWN * 86400_000);
  for (const d of Object.keys(history)) {
    if (d < cutoff) delete history[d];
  }

  await env.STATUS_KV.put('history', JSON.stringify(history));
}

/**
 * One KV read for the whole window — see the note in runChecks. "history" is
 * up to an hour stale (it only flushes on the hour), so the still-open
 * "pending" bucket sitting on "latest" (already read by the caller) is added
 * in-memory for whichever day it belongs to — normally today.
 */
async function loadHistory(env, latest) {
  const history = (await env.STATUS_KV.get('history', 'json')) ?? {};
  const pending = latest?.pending;
  const pendingDay = pending ? pending.hour.slice(0, 10) : null;

  const out = {};
  for (const t of TARGETS) out[t.id] = [];
  const today = Date.now();
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const d = dateKey(today - i * 86400_000);
    let agg = history[d];
    if (d === pendingDay) {
      agg = { ...agg };
      for (const t of TARGETS) {
        const p = pending.counts[t.id];
        if (!p) continue;
        const base = agg[t.id] ?? { n: 0, fail: 0, msSum: 0 };
        agg[t.id] = { n: base.n + p.n, fail: base.fail + p.fail, msSum: base.msSum + p.msSum };
      }
    }
    for (const t of TARGETS) {
      const cell = agg?.[t.id];
      out[t.id].push({
        date: d,
        uptime: cell && cell.n > 0 ? (1 - cell.fail / cell.n) : null,
        avgMs: cell && cell.n > 0 ? Math.round(cell.msSum / cell.n) : null,
      });
    }
  }
  return out;
}

function overallState(latest) {
  if (!latest) return { label: 'Unknown', color: '#8b8fa3' };
  const vals = Object.values(latest.results ?? {});
  if (vals.length === 0) return { label: 'Unknown', color: '#8b8fa3' };
  const down = vals.filter((v) => !v.ok).length;
  if (down === 0) return { label: 'All systems operational', color: '#22c55e' };
  if (down < vals.length) return { label: 'Partial outage', color: '#f59e0b' };
  return { label: 'Major outage', color: '#ef4444' };
}

function barColor(uptime) {
  if (uptime === null) return '#2a2d3a';
  if (uptime >= 0.999) return '#22c55e';
  if (uptime >= 0.98) return '#f59e0b';
  return '#ef4444';
}

function renderHtml(latest, history) {
  const overall = overallState(latest);
  const updated = latest ? new Date(latest.ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';

  const sections = TARGETS.map((t) => {
    const cur = latest?.results?.[t.id];
    const days = history[t.id] ?? [];
    const withData = days.filter((d) => d.uptime !== null);
    const uptimePct = withData.length
      ? (100 * withData.reduce((s, d) => s + d.uptime, 0) / withData.length).toFixed(2) + '%'
      : '—';
    const bars = days
      .map(
        (d) =>
          `<div class="bar" style="background:${barColor(d.uptime)}" title="${d.date}: ${
            d.uptime === null ? 'no data' : (100 * d.uptime).toFixed(2) + '% · avg ' + d.avgMs + ' ms'
          }"></div>`,
      )
      .join('');
    const dot = cur ? (cur.ok ? '#22c55e' : '#ef4444') : '#8b8fa3';
    const statusText = cur ? (cur.ok ? `Operational · ${cur.ms} ms` : `Down (HTTP ${cur.status})`) : 'No data yet';
    return `
    <section class="card">
      <div class="row">
        <span class="dot" style="background:${dot}"></span>
        <strong>${t.name}</strong>
        <span class="muted">${statusText}</span>
        <span class="spacer"></span>
        <span class="muted">${uptimePct} · ${DAYS_SHOWN} days</span>
      </div>
      <div class="bars">${bars}</div>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Impri Status</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta http-equiv="refresh" content="120">
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0d0e14;color:#e6e8f0;font:15px/1.5 system-ui,-apple-system,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:40px 20px}
  h1{font-size:20px;margin:0 0 4px}
  .overall{display:flex;align-items:center;gap:10px;padding:18px;border-radius:12px;background:#151723;margin:24px 0;border:1px solid #23263a}
  .overall .dot{width:14px;height:14px}
  .card{background:#151723;border:1px solid #23263a;border-radius:12px;padding:16px;margin-bottom:14px}
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .muted{color:#8b8fa3;font-size:13px}
  .spacer{flex:1}
  .bars{display:flex;gap:2px;margin-top:12px}
  .bar{flex:1;height:28px;border-radius:2px;min-width:2px}
  a{color:#8ea2ff}
  footer{margin-top:28px;font-size:13px;color:#8b8fa3}
</style></head><body><div class="wrap">
  <h1>Impri Status</h1>
  <div class="muted">Human-in-the-loop approval API — <a href="https://impri.dev">impri.dev</a></div>
  <div class="overall"><span class="dot" style="background:${overall.color}"></span>
    <strong>${overall.label}</strong><span class="spacer"></span>
    <span class="muted">Updated ${updated}</span>
  </div>
  ${sections}
  <footer>Checks run every 15 minutes from Cloudflare's network. JSON: <a href="/api/status">/api/status</a></footer>
</div></body></html>`;
}

export default {
  async scheduled(_event, env, _ctx) {
    await runChecks(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The favicon needs nothing from KV; reading 'latest' before this branch
    // meant every icon request cost a read.
    if (url.pathname === '/favicon.svg') {
      return new Response(FAVICON_SVG, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Serve from the edge cache when we can. A status page is polled — by
    // monitors, by bots, by anyone leaving the tab open — and each of those
    // requests used to reach KV. The probe runs every 15 minutes, so a
    // two-minute-old copy is no less true.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const latest = await env.STATUS_KV.get('latest', 'json');

    if (url.pathname === '/api/status') {
      const history = await loadHistory(env, latest);
      const res = new Response(JSON.stringify({ overall: overallState(latest).label, latest, history }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${PAGE_CACHE_SEC}`,
          'Access-Control-Allow-Origin': '*',
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    const history = await loadHistory(env, latest);
    const res = new Response(renderHtml(latest, history), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=${PAGE_CACHE_SEC}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
