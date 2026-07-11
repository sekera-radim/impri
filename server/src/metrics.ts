/**
 * Lightweight in-process Prometheus metrics registry.
 *
 * No external dependency — ~150 lines of plain TypeScript.
 * Counters live in process memory; gauges are read from SQLite at scrape time.
 *
 * SECURITY: labels must never contain raw API keys, tokens, URLs, emails,
 * or any user-supplied value. Use only enum-style values (route patterns,
 * status classes, result codes, channel types, etc.).
 */

import { statSync } from 'node:fs';
import type { Db } from './db.js';

// ---------------------------------------------------------------------------
// Logger interface — pino-compatible subset so Fastify's app.log satisfies it.
// ---------------------------------------------------------------------------
export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

interface CounterSeries {
  help: string;
  entries: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramSeries {
  help: string;
  buckets: number[];   // upper bounds, sorted ascending
  entries: Map<string, {
    labels: Record<string, string>;
    bktCounts: number[];
    sum: number;
    count: number;
  }>;
}

// Module-level singletons — one registry per process.
const counterRegistry = new Map<string, CounterSeries>();
const histogramRegistry = new Map<string, HistogramSeries>();

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function serializeLabels(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map(k => `${k}\x00${labels[k]}`).join('\x01');
}

// Per Prometheus text format spec: escape backslash, double-quote, newline.
function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabelSet(labels: Record<string, string>): string {
  const parts = Object.keys(labels).sort().map(k => `${k}="${escapeLabel(labels[k])}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function renderLabelSetWith(labels: Record<string, string>, extra: Record<string, string>): string {
  return renderLabelSet({ ...labels, ...extra });
}

// ---------------------------------------------------------------------------
// Public counter API
// ---------------------------------------------------------------------------

export function defineCounter(name: string, help: string): void {
  if (!counterRegistry.has(name)) {
    counterRegistry.set(name, { help, entries: new Map() });
  }
}

export function incCounter(name: string, labels: Record<string, string> = {}): void {
  const series = counterRegistry.get(name);
  if (!series) return;
  const key = serializeLabels(labels);
  const entry = series.entries.get(key);
  if (entry) {
    entry.value++;
  } else {
    series.entries.set(key, { labels: { ...labels }, value: 1 });
  }
}

// ---------------------------------------------------------------------------
// Public histogram API
// ---------------------------------------------------------------------------

export function defineHistogram(name: string, help: string, buckets: number[]): void {
  if (!histogramRegistry.has(name)) {
    histogramRegistry.set(name, {
      help,
      buckets: [...buckets].sort((a, b) => a - b),
      entries: new Map(),
    });
  }
}

export function obsHistogram(name: string, labels: Record<string, string>, value: number): void {
  const series = histogramRegistry.get(name);
  if (!series) return;
  const key = serializeLabels(labels);
  let entry = series.entries.get(key);
  if (!entry) {
    entry = {
      labels: { ...labels },
      bktCounts: new Array(series.buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    series.entries.set(key, entry);
  }
  for (let i = 0; i < series.buckets.length; i++) {
    if (value <= series.buckets[i]) entry.bktCounts[i]++;
  }
  entry.sum += value;
  entry.count++;
}

// ---------------------------------------------------------------------------
// Reset — clears all series data (useful in tests to isolate runs).
// ---------------------------------------------------------------------------
export function resetRegistry(): void {
  counterRegistry.clear();
  histogramRegistry.clear();
}

// ---------------------------------------------------------------------------
// Initialize all metric definitions — call once at startup (idempotent).
// ---------------------------------------------------------------------------
export function initMetrics(): void {
  // HTTP request metrics
  defineCounter('impri_http_requests_total',
    'Total HTTP requests by route, method, and status class');
  defineHistogram('impri_http_request_duration_seconds',
    'HTTP request duration in seconds',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

  // Action lifecycle
  defineCounter('impri_action_decisions_total',
    'Total action decisions committed, by verdict and channel');
  defineHistogram('impri_action_decision_latency_seconds',
    'Time from action creation to decision in seconds',
    [1, 10, 60, 300, 1800, 7200, 86400]);
  defineCounter('impri_actions_expired_total',
    'Total actions that transitioned to expired status');

  // Watcher scheduler
  defineCounter('impri_watcher_runs_total',
    'Total watcher runs by kind and result');
  defineCounter('impri_watcher_items_fetched_total',
    'Total items returned by fetch before dedup/scoring');
  defineCounter('impri_watcher_hits_total',
    'Total actions created by watcher runs');
  defineCounter('impri_watcher_burst_truncations_total',
    'Total watcher runs that triggered burst protection');

  // Webhook delivery
  defineCounter('impri_webhook_deliveries_total',
    'Total webhook delivery outcomes by result');
  defineHistogram('impri_webhook_delivery_duration_seconds',
    'Wall-clock time of webhook HTTP POST in seconds',
    [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15]);

  // Notification channels
  defineCounter('impri_notifications_total',
    'Total notification attempts by channel_type and result');
  defineCounter('impri_notification_digest_flushes_total',
    'Total digest flush attempts by channel_type');
  defineCounter('impri_channel_auto_disabled_total',
    'Total channels auto-disabled after repeated failures');

  // Rate limiting
  defineCounter('impri_rate_limited_total',
    'Total rate-limited requests by bucket name');
}

// ---------------------------------------------------------------------------
// Gauge snapshots — read from SQLite at scrape time to avoid drift.
// ---------------------------------------------------------------------------

function renderDbGauges(db: Db, dbPath: string): string[] {
  const out: string[] = [];

  const gauge = (name: string, help: string, fn: () => string[]) => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} gauge`);
    try {
      out.push(...fn());
    } catch {
      // DB temporarily unavailable — skip this gauge rather than crashing.
    }
    out.push('');
  };

  gauge('impri_actions_total', 'Current action counts by status (snapshot)', () => {
    const rows = db.prepare('SELECT status, COUNT(*) as cnt FROM actions GROUP BY status').all() as
      { status: string; cnt: number }[];
    return rows.map(r => `impri_actions_total{status="${escapeLabel(r.status)}"} ${r.cnt}`);
  });

  gauge('impri_active_watchers', 'Active watchers count (snapshot)', () => {
    const r = db.prepare("SELECT COUNT(*) as cnt FROM watchers WHERE status = 'active'").get() as { cnt: number };
    return [`impri_active_watchers ${r.cnt}`];
  });

  gauge('impri_degraded_watchers', 'Degraded watchers count (snapshot)', () => {
    const r = db.prepare("SELECT COUNT(*) as cnt FROM watchers WHERE status = 'degraded'").get() as { cnt: number };
    return [`impri_degraded_watchers ${r.cnt}`];
  });

  gauge('impri_pending_actions', 'Pending actions count (snapshot)', () => {
    const r = db.prepare("SELECT COUNT(*) as cnt FROM actions WHERE status = 'pending'").get() as { cnt: number };
    return [`impri_pending_actions ${r.cnt}`];
  });

  gauge('impri_webhook_dlq_size', 'Webhook deliveries in dead-letter queue (snapshot)', () => {
    const r = db.prepare("SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE status = 'dlq'").get() as { cnt: number };
    return [`impri_webhook_dlq_size ${r.cnt}`];
  });

  gauge('impri_db_size_bytes', 'SQLite database file size in bytes', () => {
    try {
      const size = statSync(dbPath).size;
      return [`impri_db_size_bytes ${size}`];
    } catch {
      return ['impri_db_size_bytes 0'];
    }
  });

  gauge('impri_uptime_seconds', 'Process uptime in seconds', () => {
    return [`impri_uptime_seconds ${process.uptime().toFixed(6)}`];
  });

  return out;
}

// ---------------------------------------------------------------------------
// Prometheus text format serializer
// ---------------------------------------------------------------------------

export function renderMetrics(db: Db, version: string, dbPath: string): string {
  const lines: string[] = [];

  // Build info — always emitted so dashboards can identify the running build.
  lines.push('# HELP impri_build_info Build information gauge, always 1');
  lines.push('# TYPE impri_build_info gauge');
  lines.push(`impri_build_info{version="${escapeLabel(version)}",node_version="${escapeLabel(process.version)}"} 1`);
  lines.push('');

  // In-process counters
  for (const [name, series] of counterRegistry) {
    lines.push(`# HELP ${name} ${series.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const entry of series.entries.values()) {
      lines.push(`${name}${renderLabelSet(entry.labels)} ${entry.value}`);
    }
    lines.push('');
  }

  // In-process histograms
  for (const [name, series] of histogramRegistry) {
    lines.push(`# HELP ${name} ${series.help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const entry of series.entries.values()) {
      for (let i = 0; i < series.buckets.length; i++) {
        lines.push(`${name}_bucket${renderLabelSetWith(entry.labels, { le: String(series.buckets[i]) })} ${entry.bktCounts[i]}`);
      }
      lines.push(`${name}_bucket${renderLabelSetWith(entry.labels, { le: '+Inf' })} ${entry.count}`);
      lines.push(`${name}_sum${renderLabelSet(entry.labels)} ${entry.sum}`);
      lines.push(`${name}_count${renderLabelSet(entry.labels)} ${entry.count}`);
    }
    lines.push('');
  }

  // DB gauge snapshots
  lines.push(...renderDbGauges(db, dbPath));

  return lines.join('\n');
}
