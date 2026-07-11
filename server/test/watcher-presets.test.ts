/**
 * Tests for the watcher preset catalog + endpoints.
 *
 * Coverage:
 *  - GET /v1/watcher-presets — catalog listing, auth, cache header
 *  - buildConfig — per-preset URL construction, param validation, security checks
 *  - POST /v1/watchers/from-preset — full creation path incl. tier guards + SSRF
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createDb } from '../src/db.js';
import { bootstrapAdminKey } from '../src/auth.js';
import { createApp } from '../src/index.js';
import { PRESET_CATALOG, PRESET_MAP, buildConfig } from '../src/watcherPresets.js';

process.env.DISABLE_WATCHER_SCHEDULER = '1';

async function setup() {
  const db = createDb(':memory:');
  const bootstrap = await bootstrapAdminKey(db);
  const app = await createApp(db);
  await app.ready();
  return { db, app, adminKey: bootstrap!.key, projectId: bootstrap!.projectId };
}

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

// ─── GET /v1/watcher-presets ──────────────────────────────────────────────────

describe('GET /v1/watcher-presets', () => {
  it('returns 200 with all 18 presets', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/watcher-presets', headers: auth(adminKey) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets).toHaveLength(18);
  });

  it('includes required fields on every preset', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/watcher-presets', headers: auth(adminKey) });
    const { presets } = res.json();
    for (const p of presets) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.category).toBe('string');
      expect(['rss', 'reddit_search', 'url_diff']).toContain(p.kind);
      expect(Array.isArray(p.params)).toBe(true);
      expect(typeof p.defaultScheduleEvery).toBe('string');
      expect(typeof p.buildNotes).toBe('string');
    }
  });

  it('sets Cache-Control: max-age=3600', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/watcher-presets', headers: auth(adminKey) });
    expect(res.headers['cache-control']).toContain('max-age=3600');
  });

  it('returns 403 without auth', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/watcher-presets' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 with a token that has no "watch" scope', async () => {
    const { app, adminKey } = await setup();
    // Create a key with only the "actions" scope (no "watch")
    const keyRes = await app.inject({
      method: 'POST', url: '/v1/keys',
      headers: auth(adminKey),
      payload: { name: 'actions-only', scopes: ['actions'] },
    });
    const actionsOnlyKey: string = keyRes.json().key;
    // Request with the actions-only key — should be rejected for missing "watch" scope
    const res = await app.inject({ method: 'GET', url: '/v1/watcher-presets', headers: auth(actionsOnlyKey) });
    expect(res.statusCode).toBe(403);
  });

  it('PRESET_CATALOG and PRESET_MAP are in sync', () => {
    expect(PRESET_CATALOG).toHaveLength(18);
    expect(PRESET_MAP.size).toBe(18);
    for (const p of PRESET_CATALOG) {
      expect(PRESET_MAP.get(p.id)).toBe(p);
    }
  });
});

// ─── buildConfig — unit tests ─────────────────────────────────────────────────

describe('buildConfig — static presets (no params)', () => {
  it('hn-front-page builds static HN RSS URL', () => {
    const r = buildConfig('hn-front-page', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.kind).toBe('rss');
    expect(r.body.config.url).toBe('https://news.ycombinator.com/rss');
    expect(r.body.keywords).toHaveLength(0);
    expect(r.body.min_score).toBe(0);
    expect(r.primaryParam).toBeUndefined();
  });

  it('product-hunt builds static PH RSS URL', () => {
    const r = buildConfig('product-hunt', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://www.producthunt.com/feed');
    expect(r.body.keywords).toHaveLength(0);
  });
});

describe('buildConfig — hn-keyword', () => {
  it('builds URL with keyword and default min_points=10', () => {
    const r = buildConfig('hn-keyword', { keyword: 'rust programming' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('hnrss.org/newest');
    expect(r.body.config.url).toContain(encodeURIComponent('rust programming'));
    expect(r.body.config.url).toContain('points=10');
    expect(r.body.keywords).toEqual([{ pattern: 'rust programming', points: 10 }]);
  });

  it('builds URL with custom min_points', () => {
    const r = buildConfig('hn-keyword', { keyword: 'AI', min_points: '25' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('points=25');
  });

  it('rejects keyword longer than 200 chars', () => {
    const r = buildConfig('hn-keyword', { keyword: 'a'.repeat(201) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.param === 'keyword')).toBe(true);
  });

  it('rejects missing keyword', () => {
    const r = buildConfig('hn-keyword', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.param === 'keyword')).toBe(true);
  });

  it('rejects min_points out of range', () => {
    const r1 = buildConfig('hn-keyword', { keyword: 'ai', min_points: '0' });
    expect(r1.ok).toBe(false);
    const r2 = buildConfig('hn-keyword', { keyword: 'ai', min_points: '501' });
    expect(r2.ok).toBe(false);
  });

  it('rejects non-integer min_points', () => {
    const r = buildConfig('hn-keyword', { keyword: 'ai', min_points: 'abc' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — hn-show-ask', () => {
  it('builds show URL', () => {
    const r = buildConfig('hn-show-ask', { type: 'show' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://hnrss.org/show');
  });

  it('builds ask URL', () => {
    const r = buildConfig('hn-show-ask', { type: 'ask' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://hnrss.org/ask');
  });

  it('rejects any type not in allowlist', () => {
    const r = buildConfig('hn-show-ask', { type: 'front' });
    expect(r.ok).toBe(false);
  });

  it('rejects empty type', () => {
    const r = buildConfig('hn-show-ask', {});
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — reddit-subreddit (path traversal)', () => {
  it('builds valid subreddit RSS URL', () => {
    const r = buildConfig('reddit-subreddit', { subreddit: 'MachineLearning' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://www.reddit.com/r/MachineLearning/new.rss');
    expect(r.body.kind).toBe('rss');
  });

  it('SECURITY: rejects subreddit with slash (path traversal)', () => {
    const r = buildConfig('reddit-subreddit', { subreddit: 'foo/../settings' });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: rejects subreddit longer than 21 chars', () => {
    const r = buildConfig('reddit-subreddit', { subreddit: 'a'.repeat(22) });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: rejects subreddit with URL metacharacters', () => {
    const r = buildConfig('reddit-subreddit', { subreddit: 'foo?bar=1' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — reddit-keyword', () => {
  it('builds reddit_search config for a query across all Reddit', () => {
    const r = buildConfig('reddit-keyword', { query: 'self-hosting AI' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.kind).toBe('reddit_search');
    expect(r.body.config.subreddit).toBe('all');
    expect(r.body.config.query).toBe('self-hosting AI');
    expect(r.body.keywords).toEqual([{ pattern: 'self-hosting AI', points: 10 }]);
  });

  it('builds reddit_search config scoped to a subreddit', () => {
    const r = buildConfig('reddit-keyword', { query: 'AI agents', subreddit: 'selfhosted' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.subreddit).toBe('selfhosted');
  });

  it('treats subreddit="all" as search across Reddit', () => {
    const r = buildConfig('reddit-keyword', { query: 'LLM', subreddit: 'all' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.subreddit).toBe('all');
  });

  it('rejects query with control characters', () => {
    const r = buildConfig('reddit-keyword', { query: 'ai\nnews' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.param === 'query')).toBe(true);
  });

  it('rejects query longer than 500 chars', () => {
    const r = buildConfig('reddit-keyword', { query: 'a'.repeat(501) });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: rejects subreddit with path traversal characters', () => {
    const r = buildConfig('reddit-keyword', { query: 'AI', subreddit: '../admin' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — github-releases and github-commits', () => {
  it('builds GitHub releases Atom URL', () => {
    const r = buildConfig('github-releases', { owner: 'fastify', repo: 'fastify' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://github.com/fastify/fastify/releases.atom');
  });

  it('SECURITY: rejects owner with slash (path traversal)', () => {
    const r = buildConfig('github-releases', { owner: 'foo/bar', repo: 'repo' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.param === 'owner')).toBe(true);
  });

  it('SECURITY: rejects repo with slash', () => {
    const r = buildConfig('github-releases', { owner: 'org', repo: 'foo/../../etc' });
    expect(r.ok).toBe(false);
  });

  it('builds commits Atom URL (default feed)', () => {
    const r = buildConfig('github-commits', { owner: 'torvalds', repo: 'linux' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('commits.atom');
  });

  it('builds tags Atom URL when feed=tags', () => {
    const r = buildConfig('github-commits', { owner: 'torvalds', repo: 'linux', feed: 'tags' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('tags.atom');
  });

  it('rejects unknown feed type', () => {
    const r = buildConfig('github-commits', { owner: 'a', repo: 'b', feed: 'branches' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — npm-package', () => {
  it('builds unscoped npm registry URL', () => {
    const r = buildConfig('npm-package', { package: 'lodash' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://registry.npmjs.org/lodash/latest');
    expect(r.body.kind).toBe('url_diff');
  });

  it('builds scoped npm registry URL (@ + / preserved)', () => {
    const r = buildConfig('npm-package', { package: '@types/react' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://registry.npmjs.org/@types/react/latest');
  });

  it('rejects uppercase in package name', () => {
    const r = buildConfig('npm-package', { package: 'Lodash' });
    expect(r.ok).toBe(false);
  });

  it('rejects package name with spaces', () => {
    const r = buildConfig('npm-package', { package: 'my package' });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: rejects package name with path injection characters', () => {
    const r = buildConfig('npm-package', { package: '../../../etc/passwd' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — pypi-package', () => {
  it('normalizes package name to lowercase', () => {
    const r = buildConfig('pypi-package', { package: 'Requests' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('requests');
    expect(r.body.config.url).not.toContain('Requests');
  });

  it('builds correct PyPI RSS URL', () => {
    const r = buildConfig('pypi-package', { package: 'django' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://pypi.org/rss/project/django/releases.xml');
  });

  it('rejects package with invalid characters', () => {
    const r = buildConfig('pypi-package', { package: 'my package!' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — rss-feed, url-changed, changelog-status', () => {
  it('rss-feed passes URL through directly', () => {
    const url = 'https://martinfowler.com/feed.atom';
    const r = buildConfig('rss-feed', { url });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe(url);
    expect(r.body.kind).toBe('rss');
  });

  it('url-changed: kind=url_diff', () => {
    const r = buildConfig('url-changed', { url: 'https://example.com/pricing' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.kind).toBe('url_diff');
  });

  it('changelog-status: kind=url_diff', () => {
    const r = buildConfig('changelog-status', { url: 'https://www.githubstatus.com/' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.kind).toBe('url_diff');
  });

  it('rejects non-http URLs in rss-feed', () => {
    const r = buildConfig('rss-feed', { url: 'ftp://example.com/feed.xml' });
    expect(r.ok).toBe(false);
  });

  it('rejects missing URL', () => {
    const r = buildConfig('rss-feed', {});
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — youtube-channel', () => {
  it('builds YouTube Atom feed URL for valid channel_id', () => {
    const channelId = 'UCnUYZLuoy1rq1aVMwx4aTzw'; // 24 chars, starts with UC
    const r = buildConfig('youtube-channel', { channel_id: channelId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    );
  });

  it('SECURITY: rejects channel_id that does not start with UC', () => {
    const r = buildConfig('youtube-channel', { channel_id: 'AB' + 'a'.repeat(22) });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: rejects channel_id with query-string injection characters', () => {
    const r = buildConfig('youtube-channel', { channel_id: 'UCaaaaaaaaaaaaaaaaaaaaa&evil=1' });
    expect(r.ok).toBe(false);
  });

  it('rejects channel_id that is too short', () => {
    const r = buildConfig('youtube-channel', { channel_id: 'UC' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — arxiv-papers', () => {
  it('category only: builds arxiv RSS URL', () => {
    const r = buildConfig('arxiv-papers', { category: 'cs.AI' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://rss.arxiv.org/cs.AI');
    expect(r.body.keywords).toHaveLength(0);
  });

  it('query only: builds arXiv API URL', () => {
    const r = buildConfig('arxiv-papers', { query: 'large language models' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('export.arxiv.org/api/query');
    expect(r.body.config.url).toContain(encodeURIComponent('large language models'));
  });

  it('both category and query: uses category URL and scores by query', () => {
    const r = buildConfig('arxiv-papers', { category: 'cs.AI', query: 'LLM' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://rss.arxiv.org/cs.AI');
    expect(r.body.keywords).toEqual([{ pattern: 'LLM', points: 10 }]);
  });

  it('rejects when neither category nor query is provided', () => {
    const r = buildConfig('arxiv-papers', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('rejects invalid arXiv category', () => {
    const r = buildConfig('arxiv-papers', { category: 'not valid category!' });
    expect(r.ok).toBe(false);
  });

  it('rejects query with newline (HTTP header injection)', () => {
    const r = buildConfig('arxiv-papers', { query: 'ai\r\nevil: header' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — google-news', () => {
  it('builds Google News RSS URL with default en-US language', () => {
    const r = buildConfig('google-news', { query: 'AI regulation Europe' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('news.google.com/rss/search');
    expect(r.body.config.url).toContain(encodeURIComponent('AI regulation Europe'));
    expect(r.body.config.url).toContain('hl=en-US');
    expect(r.body.config.url).toContain('gl=US');
    expect(r.body.keywords).toEqual([{ pattern: 'AI regulation Europe', points: 10 }]);
  });

  it('builds Google News URL with specific language', () => {
    const r = buildConfig('google-news', { query: 'KI Regulierung', language: 'de-DE' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toContain('hl=de-DE');
    expect(r.body.config.url).toContain('gl=DE');
  });

  it('rejects invalid language format', () => {
    const r = buildConfig('google-news', { query: 'news', language: 'english' });
    expect(r.ok).toBe(false);
  });

  it('rejects unsupported language code (valid format, not in allowlist)', () => {
    const r = buildConfig('google-news', { query: 'news', language: 'xx-YY' });
    expect(r.ok).toBe(false);
  });

  it('rejects query with control characters', () => {
    const r = buildConfig('google-news', { query: 'ai\nnews' });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — stackoverflow-tag', () => {
  it('builds Stack Overflow tag RSS URL', () => {
    const r = buildConfig('stackoverflow-tag', { tag: 'typescript' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.config.url).toBe('https://stackoverflow.com/feeds/tag/typescript');
  });

  it('rejects uppercase tags (SO tags are always lowercase)', () => {
    const r = buildConfig('stackoverflow-tag', { tag: 'TypeScript' });
    expect(r.ok).toBe(false);
  });

  it('rejects tag longer than 35 chars', () => {
    const r = buildConfig('stackoverflow-tag', { tag: 'a'.repeat(36) });
    expect(r.ok).toBe(false);
  });
});

describe('buildConfig — blog-newsletter', () => {
  it('all-posts mode when no keywords', () => {
    const r = buildConfig('blog-newsletter', { url: 'https://newsletter.pragmaticengineer.com/feed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.keywords).toHaveLength(0);
    expect(r.body.min_score).toBe(0);
  });

  it('keyword-filter mode when keywords provided', () => {
    const r = buildConfig('blog-newsletter', {
      url: 'https://newsletter.pragmaticengineer.com/feed',
      keywords: 'AI, LLM, architecture',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.keywords).toHaveLength(3);
    expect(r.body.keywords[0].pattern).toBe('AI');
    expect(r.body.keywords.every(k => k.points === 10)).toBe(true);
    expect(r.body.min_score).toBe(10);
  });

  it('ignores empty keyword entries from extra commas', () => {
    const r = buildConfig('blog-newsletter', {
      url: 'https://example.com/feed',
      keywords: 'AI, , LLM',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.keywords).toHaveLength(2);
  });
});

describe('buildConfig — unknown preset', () => {
  it('returns error for unknown preset_id', () => {
    const r = buildConfig('no-such-preset', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].param).toBe('preset_id');
  });
});

// ─── POST /v1/watchers/from-preset — integration tests ───────────────────────

describe('POST /v1/watchers/from-preset — basic creation', () => {
  it('creates an RSS watcher from hn-front-page preset (no params)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: { preset_id: 'hn-front-page', params: {} },
    });
    expect(res.statusCode).toBe(201);
    const w = res.json();
    expect(w.id).toMatch(/^wat_/);
    expect(w.kind).toBe('rss');
    expect(w.config.url).toBe('https://news.ycombinator.com/rss');
    expect(w.status).toBe('active');
    expect(w.name).toBe('Hacker News Front Page'); // no primaryParam → just title
  });

  it('creates a reddit_search watcher from reddit-keyword preset', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'reddit-keyword',
        params: { query: 'self-hosting', subreddit: 'selfhosted' },
      },
    });
    expect(res.statusCode).toBe(201);
    const w = res.json();
    expect(w.kind).toBe('reddit_search');
    expect(w.config.subreddit).toBe('selfhosted');
    expect(w.config.query).toBe('self-hosting');
  });

  it('creates a url_diff watcher from url-changed preset', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'url-changed',
        params: { url: 'https://example.com/pricing' },
      },
    });
    expect(res.statusCode).toBe(201);
    const w = res.json();
    expect(w.kind).toBe('url_diff');
    expect(w.config.url).toBe('https://example.com/pricing');
  });

  it('creates watcher with custom name', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-front-page',
        params: {},
        name: 'My HN Feed',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('My HN Feed');
  });

  it('uses primary param in default name (hn-keyword)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-keyword',
        params: { keyword: 'rust' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toContain('rust');
  });

  it('applies custom schedule when provided', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-front-page',
        params: {},
        schedule: { every: '2h' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule.every).toBe('2h');
  });

  it('falls back to preset defaultScheduleEvery when no schedule given', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: { preset_id: 'hn-front-page', params: {} },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule.every).toBe('30m'); // hn-front-page default
  });

  it('github-releases preset creates watcher with correct Atom URL', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'github-releases',
        params: { owner: 'fastify', repo: 'fastify' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().config.url).toBe('https://github.com/fastify/fastify/releases.atom');
  });

  it('caps default name at 200 chars when primary param is near-max length', async () => {
    // hn-keyword allows keyword up to 200 chars; combined with the preset
    // title "Hacker News – Keyword: " (23 chars) the raw default would be
    // 223 chars, which exceeds the CreateWatcherBody name limit of 200.
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-keyword',
        params: { keyword: 'a'.repeat(200) },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name.length).toBeLessThanOrEqual(200);
  });
});

describe('POST /v1/watchers/from-preset — error cases', () => {
  it('returns 404 for unknown preset_id', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: { preset_id: 'does-not-exist', params: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('preset_not_found');
  });

  it('returns 400 for missing required param', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: { preset_id: 'reddit-subreddit', params: {} }, // missing subreddit
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid param value', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'reddit-subreddit',
        params: { subreddit: 'foo/../admin' }, // path traversal
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid schedule duration', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-front-page',
        params: {},
        schedule: { every: '0m' }, // fails min-60s check in CreateWatcherBody
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 without auth', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      payload: { preset_id: 'hn-front-page', params: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/watchers/from-preset — SSRF guard', () => {
  it('SECURITY: rejects private IP literal in rss-feed URL (10.x)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'rss-feed',
        params: { url: 'http://10.0.0.1/feed.xml' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SECURITY: rejects metadata endpoint IP in url-changed (169.254.169.254)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'url-changed',
        params: { url: 'http://169.254.169.254/latest/meta-data' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SECURITY: rejects loopback address in changelog-status (127.0.0.1)', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'changelog-status',
        params: { url: 'http://127.0.0.1:8080/status' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SECURITY: rejects non-http scheme in blog-newsletter URL', async () => {
    const { app, adminKey } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'blog-newsletter',
        params: { url: 'file:///etc/passwd' },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/watchers/from-preset — tier enforcement (billing enabled)', () => {
  it('returns 402 when watcher count limit is reached on free plan', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; // enable billing
    const { app, adminKey } = await setup();

    // Fill up the free tier (3 watchers)
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/watchers', headers: auth(adminKey),
        payload: { name: `w${i}`, kind: 'rss', config: { url: 'https://example.com/f.xml' }, schedule: { every: '30m' } },
      });
      expect(r.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: { preset_id: 'hn-front-page', params: {} },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().tier).toBe('free');
  });

  it('returns 402 when schedule is too frequent for the tier', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; // enable billing
    const { app, adminKey } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/from-preset',
      headers: auth(adminKey),
      payload: {
        preset_id: 'hn-front-page',
        params: {},
        schedule: { every: '1m' }, // 60s < free tier minimum (15 min)
      },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('schedule_too_frequent');
  });

  it('allows creation on self-host (no billing) regardless of tier limits', async () => {
    // billing NOT enabled (no STRIPE_SECRET_KEY)
    const { app, adminKey } = await setup();

    // Create 10 watchers — would fail on free billing plan but self-host is unlimited
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/watchers/from-preset', headers: auth(adminKey),
        payload: { preset_id: 'hn-front-page', params: {} },
      });
      expect(r.statusCode).toBe(201);
    }
  });
});
