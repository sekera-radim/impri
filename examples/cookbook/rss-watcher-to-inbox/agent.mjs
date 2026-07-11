#!/usr/bin/env node
// rss-watcher-to-inbox.mjs — Impri cookbook recipe #5
// No dependencies. Node 18+.
//
// Pattern: create an RSS watcher that monitors a feed for new items matching
// keyword rules, then shows how those items land as pending actions in the
// inbox. Demonstrates the Watcher half of the Impri API.
//
// Run:
//   IMPRI_API_KEY=im_xxx node agent.mjs
//   IMPRI_API_KEY=im_xxx IMPRI_BASE_URL=https://api.impri.dev node agent.mjs
//
// Required scope: watch  (admin scope also works)
// Optional:       actions  (to poll for items that landed in the inbox)
//
// Note on first run: Impri baselines the feed on the first run and does NOT
// create inbox items for existing articles — only NEW items since that
// baseline trigger inbox actions. Wait for a second scheduler cycle (or PATCH
// the watcher to reset it) to see live items.

const API_KEY = process.env.IMPRI_API_KEY;
const BASE = (process.env.IMPRI_BASE_URL ?? 'http://localhost:8484').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('Set IMPRI_API_KEY (it starts with im_).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal API helper
// ---------------------------------------------------------------------------
async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} /v1${path} → ${res.status}: ${json.message ?? json.error ?? JSON.stringify(json)}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The RSS watcher we want to create.
// Feed: Hacker News front page (reliably public, updates frequently).
// Keywords: match items about AI, LLMs, or agentic systems.
// ---------------------------------------------------------------------------
const watcherSpec = {
  name: 'HN — AI & agents radar',
  kind: 'rss',
  config: {
    url: 'https://hnrss.org/frontpage',
  },
  keywords: [
    { pattern: 'agent', points: 3 },      // "agent" scores highest
    { pattern: 'llm|language model', points: 2 },
    { pattern: 'ai|artificial intelligence', points: 1 },
    { pattern: 'claude|openai|gemini|mistral', points: 2 },
  ],
  keywords_none: [
    'hiring',    // exclude job posts
    'killed by', // exclude HN "killed by" meta-posts
  ],
  min_score: 2,  // must score >= 2 to reach the inbox
  schedule: {
    every: '4h',      // check every 4 hours
    jitter: '30m',    // random offset up to 30 min to avoid thundering-herd
    window: '06:00-23:00', // only during waking hours
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nImpri rss-watcher-to-inbox → ${BASE}`);
  console.log(`  Feed: ${watcherSpec.config.url}`);
  console.log(`  Keywords: ${watcherSpec.keywords.map((k) => k.pattern).join(', ')}\n`);

  // 1. Create (or find existing) watcher.
  //    If you re-run this script, you'll get a second watcher. In production
  //    you would keep the watcher ID and PATCH it instead of creating a new one.
  console.log('  Creating watcher...');
  const watcher = await api('/watchers', 'POST', watcherSpec);
  console.log(`  Created watcher ${watcher.id} (status: ${watcher.status})`);
  console.log(`  First run scheduled: ${new Date(watcher.next_run_at * 1000).toISOString()}`);
  console.log(`  First run is a BASELINE — no inbox items yet (dedup reference)`);

  // 2. Show all active watchers.
  console.log('\n  Listing all active watchers:');
  const list = await api('/watchers?status=active');
  for (const w of list.items) {
    const nextRun = new Date(w.next_run_at * 1000).toISOString();
    console.log(`    ${w.id}  ${w.name}  (${w.kind}, next: ${nextRun})`);
  }

  // 3. Wait for the scheduler to complete the first (baseline) run.
  //    The server schedules the first run immediately (next_run_at = now).
  //    We poll GET /v1/watchers/:id until first_run_done = true.
  console.log('\n  Waiting for baseline run to complete (this may take up to 30 s)...');
  let current = watcher;
  let elapsed = 0;
  const maxWait = 90_000; // 90 s timeout
  while (!current.first_run_done && elapsed < maxWait) {
    await sleep(4000);
    elapsed += 4000;
    current = await api(`/watchers/${watcher.id}`);
    process.stdout.write(
      `  Watcher status: ${current.status}, first_run_done: ${current.first_run_done}, items so far: ${current.item_count ?? '?'}\r`,
    );
  }
  console.log();

  if (!current.first_run_done) {
    console.log('  Baseline run not completed within timeout — the scheduler may be busy.');
    console.log('  The watcher is active; items will start appearing after the next run cycle.');
  } else {
    console.log(`  Baseline complete. Items seen so far: ${current.item_count ?? 0}`);
    console.log('  From the NEXT run onward, new matching articles will land in your inbox.');
  }

  // 4. Check the inbox for any watcher-sourced actions (kind contains the watcher id).
  //    Watcher items arrive as pending actions with payload.untrusted = true.
  //    On a fresh watcher there won't be any yet (baseline = no actions created).
  console.log('\n  Checking inbox for pending actions (any source)...');
  const inbox = await api('/actions?status=pending&limit=10');
  if (inbox.items.length === 0) {
    console.log('  Inbox is empty — expected for a brand-new watcher after baseline.');
    console.log('  After the NEXT scheduled run, matching HN items will appear here.');
  } else {
    console.log(`  Found ${inbox.items.length} pending action(s):`);
    for (const act of inbox.items) {
      console.log(`    ${act.id}  [${act.kind}]  "${act.title.slice(0, 60)}"`);
    }
  }

  // 5. Show how to pause and delete the watcher (cleanup, so re-running is clean).
  //    Comment these out in production if you want the watcher to keep running.
  console.log(`\n  Pausing watcher ${watcher.id} (demo cleanup)...`);
  await api(`/watchers/${watcher.id}`, 'PATCH', { status: 'paused' });
  console.log('  Watcher paused. Reactivate with PATCH { status: "active" }.');

  console.log('\n  Done. Summary:');
  console.log(`    Watcher ID : ${watcher.id}`);
  console.log(`    Feed       : ${watcherSpec.config.url}`);
  console.log(`    Schedule   : every ${watcherSpec.schedule.every} (window ${watcherSpec.schedule.window})`);
  console.log(`    Min score  : ${watcherSpec.min_score}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Reactivate the watcher: PATCH /v1/watchers/' + watcher.id + ' { status: "active" }');
  console.log('    2. After the next scheduled run, open your inbox — matching HN items will be there.');
  console.log('    3. Approve/reject them as triage decisions, or forward to another agent for action.');
}

main().catch((e) => {
  console.error('\nAgent error:', e.message);
  process.exit(1);
});
