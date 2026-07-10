import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { genId, nowSec, hashContent } from './db.js';
import { assertPublicUrl } from './net-guard.js';
import { isFetchAllowed } from './robots.js';

const WATCHER_USER_AGENT = 'Impri-Watcher/1.0 (+https://impri.dev/bot)';
const FETCH_TIMEOUT_MS = 15_000;
// Cap response body to bound memory: a watcher URL serving a huge payload
// (accidental or malicious) must not OOM the process. PLAYBOOK B1 / econ report.
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
// After FAIL_THRESHOLD consecutive failures the watcher goes degraded
const FAIL_THRESHOLD = 3;
// After 24 h in degraded state the watcher is auto-paused (PLAYBOOK B1)
const DEGRADE_TO_PAUSE_SEC = 86_400;
// Burst protection: if more than N new items arrive in one run, deliver only TOP_N
const BURST_THRESHOLD = 25;
const BURST_TOP_N = 10;
// Dedup retention (PLAYBOOK B2): 90 days, max 10k items per watcher
const ITEM_RETENTION_SEC = 90 * 86_400;
const ITEM_CAP_PER_WATCHER = 10_000;
// Minimum delay between requests to the same host (politeness)
const MIN_HOST_INTERVAL_MS = 1_000;

const lastFetchByHost = new Map<string, number>();

// --- Types ---

export interface FetchedItem {
  hash: string;
  url: string;
  title: string;
  // Only for url_diff: byte length of the fetched page, used to show a delta.
  sizeBytes?: number;
}

export interface ScoreResult {
  score: number;
  excluded: boolean;
  matchedKeywords: string[];
}

interface ScoringRule {
  pattern: string;
  points: number;
}

interface WatcherRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  config: string;
  keywords: string;
  keywords_none: string;
  min_score: number;
  schedule: string;
  status: string;
  fail_count: number;
  degraded_since: number | null;
  first_run_done: number;
  last_run_at: number | null;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

// --- Pure helper functions (exported for unit testing) ---

/**
 * Parse a duration string like "8h", "30m", "1d" into seconds.
 */
export function parseDuration(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) throw new Error(`Invalid duration: "${s}" — expected format like "8h", "30m", "1d"`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86_400;
    default: throw new Error(`Unknown unit: ${m[2]}`);
  }
}

/**
 * Minutes-since-midnight of `nowMs` in the given IANA timezone. DST is handled
 * by Intl (offset varies with the date), unlike a fixed numeric offset.
 */
function minutesInZone(nowMs: number, timezone: string): number {
  if (timezone === 'UTC') {
    const d = new Date(nowMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs));
  const h = Number(parts.find(p => p.type === 'hour')?.value) % 24; // Intl may emit "24" at midnight
  const m = Number(parts.find(p => p.type === 'minute')?.value);
  return h * 60 + m;
}

/**
 * Check whether the given timestamp (ms) falls within the window "HH:MM-HH:MM"
 * interpreted in `timezone` (default UTC). Malformed window → true (fail-open).
 */
export function isInWindow(window: string, nowMs = Date.now(), timezone = 'UTC'): boolean {
  const parts = window.split('-');
  if (parts.length !== 2) return true;
  const [startStr, endStr] = parts;
  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  if ([startH, startM, endH, endM].some(n => isNaN(n))) return true;

  const nowMinutes = minutesInZone(nowMs, timezone);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle windows that don't cross midnight
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Window crosses midnight (e.g. "22:00-06:00")
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * Return the millisecond timestamp of the next UTC window start for "HH:MM-HH:MM".
 */
export function nextWindowStartMs(window: string, nowMs = Date.now()): number {
  const [startStr] = window.split('-');
  const [startH, startM] = startStr.split(':').map(Number);

  const target = new Date(nowMs);
  target.setUTCHours(startH, startM, 0, 0);

  // If we've already passed today's window start, push to tomorrow
  if (target.getTime() <= nowMs) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime();
}

/**
 * Compute the next_run_at unix-second timestamp.
 * next = base + every + random(0, jitter)  — PLAYBOOK B3
 */
export function computeNextRunAt(
  everyStr: string,
  jitterStr?: string,
  baseSec = nowSec(),
): number {
  const everySec = parseDuration(everyStr);
  const jitterSec = jitterStr ? parseDuration(jitterStr) : 0;
  const randomJitter = jitterSec > 0 ? Math.floor(Math.random() * jitterSec) : 0;
  return baseSec + everySec + randomJitter;
}

/**
 * Canonicalize a URL by stripping UTM parameters — PLAYBOOK B2.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(p =>
      u.searchParams.delete(p),
    );
    return u.toString();
  } catch {
    return url;
  }
}

function matchesPattern(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Score an item by keyword rules. Returns score=-1/excluded=true when a
 * keywords_none pattern matches; otherwise returns the sum of matched rule points.
 * Deterministic: same input → same output (PLAYBOOK B4).
 */
export function scoreItem(
  text: string,
  keywords: ScoringRule[],
  keywordsNone: string[],
): ScoreResult {
  for (const excl of keywordsNone) {
    if (matchesPattern(text, excl)) {
      return { score: 0, excluded: true, matchedKeywords: [] };
    }
  }

  let score = 0;
  const matchedKeywords: string[] = [];
  for (const kw of keywords) {
    if (matchesPattern(text, kw.pattern)) {
      score += kw.points;
      matchedKeywords.push(kw.pattern);
    }
  }
  return { score, excluded: false, matchedKeywords };
}

// --- RSS/Atom parser ---

function parseRssItems(xml: string): FetchedItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'item' || name === 'entry',
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const items: FetchedItem[] = [];

  // RSS 2.0
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (channel) {
    const rawItems = (channel.item as unknown[]) ?? [];
    for (const raw of rawItems) {
      const item = raw as Record<string, unknown>;
      const title = String(item.title ?? '').trim();
      // guid can be an object with #text or a plain string
      const guidRaw = item.guid;
      const guid =
        guidRaw && typeof guidRaw === 'object'
          ? String((guidRaw as Record<string, unknown>)['#text'] ?? '')
          : String(guidRaw ?? '');
      const link = String(item.link ?? guid).trim();
      if (!link) continue;
      const canonical = canonicalizeUrl(link);
      items.push({
        hash: hashContent(title, canonical),
        url: canonical,
        title: title || canonical,
      });
    }
    return items;
  }

  // Atom
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed) {
    const entries = (feed.entry as unknown[]) ?? [];
    for (const raw of entries) {
      const entry = raw as Record<string, unknown>;
      const title = String(entry.title ?? '').trim();
      const linkRaw = entry.link;
      let link = '';
      if (linkRaw && typeof linkRaw === 'object') {
        link = String((linkRaw as Record<string, unknown>)['@_href'] ?? '');
      } else if (typeof linkRaw === 'string') {
        link = linkRaw;
      }
      if (!link) {
        // Fall back to id
        link = String(entry.id ?? '').trim();
      }
      if (!link) continue;
      const canonical = canonicalizeUrl(link);
      items.push({
        hash: hashContent(title, canonical),
        url: canonical,
        title: title || canonical,
      });
    }
    return items;
  }

  return items;
}

// --- Network helpers ---

async function fetchWithPoliteness(url: string): Promise<Response> {
  // SSRF guard resolves DNS; skip under vitest where fetch is mocked and hosts
  // like example.com would trigger real lookups. Covered by net-guard tests.
  if (!process.env.VITEST) {
    await assertPublicUrl(url);
  }

  const host = new URL(url).hostname;

  const lastFetch = lastFetchByHost.get(host) ?? 0;
  const waitMs = MIN_HOST_INTERVAL_MS - (Date.now() - lastFetch);
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastFetchByHost.set(host, Date.now());

  return fetch(url, {
    headers: { 'User-Agent': WATCHER_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Read a response body with a hard byte cap. Streams so an oversized body is
// aborted mid-flight rather than fully buffered. Falls back to text() when the
// body isn't a stream (never in prod; keeps non-stream mocks working).
async function readCapped(res: Response, max = MAX_FETCH_BYTES): Promise<string> {
  const contentLength = res.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > max) {
    throw new Error(`Response exceeds ${max} bytes (Content-Length ${contentLength})`);
  }
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (text.length > max) throw new Error(`Response exceeds ${max} bytes`);
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function fetchRss(url: string): Promise<FetchedItem[]> {
  const res = await fetchWithPoliteness(url);
  // Propagate backoff hint on 429/403 (PLAYBOOK B1)
  if (res.status === 429 || res.status === 403) {
    const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10) || 300;
    const err = Object.assign(new Error(`HTTP ${res.status} from ${url}`), {
      backoffSec: retryAfterSec,
    });
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await readCapped(res);
  return parseRssItems(text);
}

async function fetchRedditSearch(subreddit: string, query: string): Promise<FetchedItem[]> {
  const rssUrl =
    `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss` +
    `?q=${encodeURIComponent(query)}&sort=new&restrict_sr=1&limit=25`;
  return fetchRss(rssUrl);
}

async function fetchUrlDiff(url: string): Promise<FetchedItem> {
  // Respect robots.txt for page monitoring (SPEC 3.2). Disallow → degrade the
  // watcher with a clear reason rather than crawling anyway.
  if (!(await isFetchAllowed(url, WATCHER_USER_AGENT))) {
    throw new Error(`robots_disallowed: ${url}`);
  }
  const res = await fetchWithPoliteness(url);
  if (res.status === 429 || res.status === 403) {
    const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10) || 300;
    throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { backoffSec: retryAfterSec });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await readCapped(res);
  // Content fingerprint: SHA-256 of the page text
  const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 32);
  const canonical = canonicalizeUrl(url);
  return {
    hash: contentHash,
    url: canonical,
    title: canonical,
    sizeBytes: text.length,
  };
}

// --- Action creation (internal, no HTTP) ---

function createWatcherAction(
  db: Db,
  projectId: string,
  watcherId: string,
  watcherName: string,
  item: FetchedItem,
  score: number,
  matchedKeywords: string[],
  isUrlDiff: boolean,
  prevSizeBytes?: number,
): void {
  const actionId = genId('act_');
  const now = nowSec();
  const expiresAt = now + 7 * 86_400;

  let title: string;
  let previewBody: string;

  if (isUrlDiff) {
    const newLen = item.sizeBytes ?? 0;
    const prevLen = prevSizeBytes;
    title = `Page changed: ${item.url}`;
    previewBody = [
      `URL: ${item.url}`,
      prevLen !== undefined ? `Length: ${prevLen} → ${newLen} bytes` : `Length: ${newLen} bytes`,
    ].join('\n');
  } else {
    title = item.title;
    previewBody = [
      `URL: ${item.url}`,
      matchedKeywords.length > 0 ? `Matched: ${matchedKeywords.join(', ')}` : '',
      `Score: ${score}`,
    ].filter(Boolean).join('\n');
  }

  const preview = { format: 'plain', body: previewBody };
  const previewHash = hashContent('watcher.triage', watcherId, item.hash);

  db.prepare(`
    INSERT INTO actions
      (id, project_id, kind, title, preview, payload, target_url,
       expires_at, editable, status, preview_hash, created_at, updated_at)
    VALUES (?, ?, 'watcher.triage', ?, ?, ?, ?, ?, '[]', 'pending', ?, ?, ?)
  `).run(
    actionId,
    projectId,
    title,
    JSON.stringify(preview),
    JSON.stringify({
      watcher_id: watcherId,
      watcher_name: watcherName,
      url: item.url,
      score,
      matched_keywords: matchedKeywords,
      // Title/preview/url came from an external source (RSS/reddit/page) and may
      // contain adversarial text (e.g. "ignore previous instructions"). Agents
      // must treat these as data, never as instructions. PLAYBOOK B6.
      untrusted: true,
    }),
    item.url || null,
    expiresAt,
    previewHash,
    now,
    now,
  );

  db.prepare(
    "INSERT INTO audit_log (project_id, action_id, event, data, created_at) VALUES (?, ?, 'watcher.hit', ?, ?)",
  ).run(projectId, actionId, JSON.stringify({ watcher_id: watcherId }), now);
}

// --- Core scheduler logic ---

/**
 * Process a single watcher: fetch, score, dedup, publish to inbox.
 * Exported for direct testing.
 */
export async function processWatcher(db: Db, watcher: WatcherRow): Promise<void> {
  const now = nowSec();
  const schedule = JSON.parse(watcher.schedule) as {
    every: string;
    jitter?: string;
    window?: string;
  };

  // Check window in the project's timezone (DST-correct) — if outside, defer
  // without counting as a failure (PLAYBOOK B3)
  const project = db.prepare('SELECT timezone FROM projects WHERE id = ?').get(watcher.project_id) as
    { timezone: string } | undefined;
  const tz = project?.timezone ?? 'UTC';
  if (schedule.window && !isInWindow(schedule.window, Date.now(), tz)) {
    const nextMs = nextWindowStartMs(schedule.window);
    db.prepare('UPDATE watchers SET next_run_at = ?, updated_at = ? WHERE id = ?').run(
      Math.ceil(nextMs / 1000),
      now,
      watcher.id,
    );
    return;
  }

  const config = JSON.parse(watcher.config) as {
    url?: string;
    subreddit?: string;
    query?: string;
  };
  const keywords = JSON.parse(watcher.keywords) as ScoringRule[];
  const keywordsNone = JSON.parse(watcher.keywords_none) as string[];
  const minScore = watcher.min_score;
  const isBaseline = watcher.first_run_done === 0;
  const isUrlDiff = watcher.kind === 'url_diff';

  let fetchedItems: FetchedItem[];
  let backoffSec = 0;

  try {
    switch (watcher.kind) {
      case 'rss':
        fetchedItems = await fetchRss(config.url!);
        break;
      case 'reddit_search':
        fetchedItems = await fetchRedditSearch(config.subreddit!, config.query!);
        break;
      case 'url_diff':
        fetchedItems = [await fetchUrlDiff(config.url!)];
        break;
      default:
        throw new Error(`Unknown watcher kind: ${watcher.kind}`);
    }
  } catch (err) {
    // Extract optional backoff hint from 429/403 errors
    backoffSec = (err as { backoffSec?: number }).backoffSec ?? 0;

    const newFailCount = watcher.fail_count + 1;
    let newStatus = watcher.status;
    let degradedSince = watcher.degraded_since;

    if (watcher.status === 'active' && newFailCount >= FAIL_THRESHOLD) {
      newStatus = 'degraded';
      degradedSince = now;
    } else if (watcher.status === 'degraded') {
      const since = watcher.degraded_since ?? now;
      if (now - since >= DEGRADE_TO_PAUSE_SEC) {
        newStatus = 'paused';
      }
    }

    const nextRun = Math.max(
      computeNextRunAt(schedule.every, schedule.jitter, now),
      now + backoffSec,
    );
    const lastError = err instanceof Error ? err.message : String(err);

    db.prepare(`
      UPDATE watchers
      SET fail_count = ?, status = ?, degraded_since = ?, last_error = ?,
          last_run_at = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(newFailCount, newStatus, degradedSince, lastError, now, nextRun, now, watcher.id);

    console.error(`[scheduler] watcher ${watcher.id} (${watcher.kind}) failed (${newFailCount}/${FAIL_THRESHOLD}): ${lastError}`);
    return;
  }

  // Fetch succeeded — reset fail counter, reactivate if degraded
  const newStatus = watcher.status === 'degraded' ? 'active' : watcher.status;
  db.prepare(`
    UPDATE watchers
    SET fail_count = 0, status = ?, degraded_since = NULL, last_error = NULL,
        last_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(newStatus, now, now, watcher.id);

  // Determine which items are already seen
  const existingHashes = new Set(
    (
      db.prepare('SELECT item_hash FROM watcher_items WHERE watcher_id = ?').all(
        watcher.id,
      ) as { item_hash: string }[]
    ).map(r => r.item_hash),
  );

  // Compute hashes for url_diff differently: each unique content hash is its own item
  // For rss/reddit the hash was already computed during fetch
  const newItems = fetchedItems.filter(item => !existingHashes.has(item.hash));

  const insertItem = db.prepare(
    'INSERT OR IGNORE INTO watcher_items (id, watcher_id, item_hash, url, title, size_bytes, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  // Baseline run: store all fetched items but publish nothing (PLAYBOOK B2)
  if (isBaseline) {
    const storeAll = db.transaction((items: FetchedItem[]) => {
      for (const item of items) {
        insertItem.run(genId('wi_'), watcher.id, item.hash, item.url || null, item.title || null, item.sizeBytes ?? null, now);
      }
    });
    storeAll(fetchedItems);

    db.prepare(`
      UPDATE watchers SET first_run_done = 1, next_run_at = ?, updated_at = ? WHERE id = ?
    `).run(computeNextRunAt(schedule.every, schedule.jitter, now), now, watcher.id);
    return;
  }

  // Normal run: score new items and publish matches
  const scored = newItems
    .map(item => {
      const text = `${isUrlDiff ? item.url : item.title} ${item.url}`;
      const result = scoreItem(text, keywords, keywordsNone);
      return { item, ...result };
    })
    .filter(s => !s.excluded && s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // Burst protection (PLAYBOOK B4): > BURST_THRESHOLD → take top BURST_TOP_N only
  const isBurst = scored.length > BURST_THRESHOLD;
  const toPublish = isBurst ? scored.slice(0, BURST_TOP_N) : scored;
  const overflowCount = isBurst ? scored.length - BURST_TOP_N : 0;

  // For url_diff, look up the previously stored page size BEFORE inserting the
  // new item, so the preview can show the delta.
  let prevSizeBytes: number | undefined;
  if (isUrlDiff && toPublish.length > 0) {
    const prev = db.prepare(
      'SELECT size_bytes FROM watcher_items WHERE watcher_id = ? AND url = ? ORDER BY first_seen DESC LIMIT 1',
    ).get(watcher.id, toPublish[0].item.url) as { size_bytes: number | null } | undefined;
    prevSizeBytes = prev?.size_bytes ?? undefined;
  }

  // Store ALL new items for dedup (even those that didn't pass the keyword filter)
  const storeNew = db.transaction((items: FetchedItem[]) => {
    for (const item of items) {
      insertItem.run(genId('wi_'), watcher.id, item.hash, item.url || null, item.title || null, item.sizeBytes ?? null, now);
    }
  });
  storeNew(newItems);

  // Create inbox actions
  for (let i = 0; i < toPublish.length; i++) {
    const s = toPublish[i];
    // Append overflow note to the last published item's title
    const effectiveTitle =
      isBurst && i === toPublish.length - 1
        ? `${s.item.title} (+${overflowCount} more)`
        : s.item.title;
    createWatcherAction(
      db,
      watcher.project_id,
      watcher.id,
      watcher.name,
      { ...s.item, title: effectiveTitle },
      s.score,
      s.matchedKeywords,
      isUrlDiff,
      prevSizeBytes,
    );
  }

  // Cleanup: 90-day retention
  db.prepare('DELETE FROM watcher_items WHERE watcher_id = ? AND first_seen < ?').run(
    watcher.id,
    now - ITEM_RETENTION_SEC,
  );

  // Cleanup: 10k cap with LRU eviction (PLAYBOOK B2)
  const itemCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM watcher_items WHERE watcher_id = ?').get(
      watcher.id,
    ) as { cnt: number }
  ).cnt;
  if (itemCount > ITEM_CAP_PER_WATCHER) {
    const excess = itemCount - ITEM_CAP_PER_WATCHER;
    db.prepare(`
      DELETE FROM watcher_items WHERE id IN (
        SELECT id FROM watcher_items WHERE watcher_id = ? ORDER BY first_seen ASC LIMIT ?
      )
    `).run(watcher.id, excess);
  }

  // Schedule next run
  db.prepare('UPDATE watchers SET next_run_at = ?, updated_at = ? WHERE id = ?').run(
    computeNextRunAt(schedule.every, schedule.jitter, now),
    now,
    watcher.id,
  );
}

/**
 * Scheduler tick: finds all due watchers and processes them.
 * Called every 60 s from main(); can also be called directly in tests.
 */
export async function runWatcherTick(db: Db): Promise<void> {
  const now = nowSec();
  const due = db.prepare(`
    SELECT * FROM watchers
    WHERE status IN ('active', 'degraded') AND next_run_at <= ?
  `).all(now) as WatcherRow[];

  for (const watcher of due) {
    try {
      await processWatcher(db, watcher);
    } catch (err) {
      // Unexpected error — log but continue processing other watchers
      console.error(`[scheduler] unexpected error for watcher ${watcher.id}:`, err);
    }
  }
}

/**
 * Start the in-process watcher scheduler.
 * Set DISABLE_WATCHER_SCHEDULER=1 to disable (used in tests).
 * Uses unref() so it doesn't hold the event loop (ARCHITECTURE.md).
 */
export function startWatcherScheduler(db: Db): ReturnType<typeof setInterval> | null {
  if (process.env.DISABLE_WATCHER_SCHEDULER === '1') {
    return null;
  }

  const interval = setInterval(() => {
    runWatcherTick(db).catch(err =>
      console.error('[scheduler] watcher tick failed:', err),
    );
  }, 60_000);

  interval.unref();
  return interval;
}
