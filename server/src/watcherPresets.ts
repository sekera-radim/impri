/**
 * Watcher preset catalog — static, in-process, no DB read.
 *
 * buildConfig() validates caller-supplied param values and returns a partial
 * CreateWatcherBody (kind + config + keywords/scoring) ready to be merged with
 * name + schedule before passing through CreateWatcherBody.safeParse().
 *
 * SECURITY: every param value is untrusted user input.  Each preset's builder
 * validates with an allowlist regex before interpolating into a URL.  After
 * buildConfig returns, the caller MUST still pass the full body through
 * CreateWatcherBody.safeParse() — that re-runs the WatcherConfig SSRF check
 * (literal private-IP rejection) so that net-guard changes automatically apply
 * to preset-created watchers.  DNS-resolution SSRF is closed at fetch time by
 * fetchGuarded (PLAYBOOK B1).
 */

// ─── Type definitions ────────────────────────────────────────────────────────

export interface PresetParam {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

export interface Preset {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: 'rss' | 'reddit_search' | 'url_diff';
  params: PresetParam[];
  defaultScheduleEvery: string;
  buildNotes: string;
}

export interface ScoringRule {
  pattern: string;
  points: number;
}

/** Fields produced by buildConfig — merged with name+schedule before safeParse. */
export interface PresetBuildBody {
  kind: 'rss' | 'reddit_search' | 'url_diff';
  config: { url?: string; query?: string; subreddit?: string };
  keywords: ScoringRule[];
  keywords_none: string[];
  min_score: number;
}

export type BuildConfigReturn =
  | { ok: true; body: PresetBuildBody; primaryParam: string | undefined }
  | { ok: false; issues: Array<{ param: string; message: string }> };

// ─── Validation helpers ───────────────────────────────────────────────────────

// Control characters in query strings enable HTTP header injection when the
// server naively forwards them (SAFETY NOTE 9).
const CONTROL_RE = /[\r\n]/;

// Per-preset allowlist regexes — see SAFETY NOTES 5, 6, 8.
const SUBREDDIT_RE = /^[A-Za-z0-9_]{1,21}$/;
const GITHUB_IDENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const ARXIV_CATEGORY_RE = /^[a-z-]+(?:\.[A-Z]{2,4})?$/;
// npm: optional scope (@org/) + unscoped name
const NPM_PACKAGE_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9._-]+$/;
const SO_TAG_RE = /^[a-z0-9.#+_-]{1,35}$/;
const LANG_CODE_RE = /^[a-z]{2}-[A-Z]{2}$/;

// Google News supports a broad but bounded set of language-region codes.
// The allowlist is exhaustive for the languages Google News officially offers.
const GOOGLE_NEWS_LANG_ALLOWLIST = new Set([
  'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN',
  'fr-FR', 'fr-CA', 'fr-BE',
  'de-DE', 'de-AT', 'de-CH',
  'es-ES', 'es-MX', 'es-AR', 'es-US', 'es-CO', 'es-CL',
  'pt-BR', 'pt-PT',
  'it-IT',
  'nl-NL', 'nl-BE',
  'pl-PL',
  'ru-RU',
  'ja-JP',
  'zh-CN', 'zh-TW', 'zh-HK',
  'ko-KR',
  'ar-SA', 'ar-AE', 'ar-EG',
  'sv-SE',
  'nb-NO',
  'da-DK',
  'fi-FI',
  'cs-CZ',
  'sk-SK',
  'ro-RO',
  'tr-TR',
  'hu-HU',
  'uk-UA',
  'vi-VN',
  'th-TH',
  'id-ID',
  'ms-MY',
  'he-IL',
  'el-GR',
  'bg-BG',
  'hr-HR',
  'lt-LT',
  'lv-LV',
  'et-EE',
  'sl-SI',
  'sr-RS',
]);

// ─── Static catalog ───────────────────────────────────────────────────────────

export const PRESET_CATALOG: Preset[] = [
  {
    id: 'hn-front-page',
    title: 'Hacker News Front Page',
    description: 'New posts as they appear on the HN front page',
    category: 'Community',
    kind: 'rss',
    params: [],
    defaultScheduleEvery: '30m',
    buildNotes:
      'config.url = "https://news.ycombinator.com/rss". keywords = [] (no filtering — user may add ScoringRules later). min_score = 0 so every non-excluded item is delivered. No param interpolation; URL is static and safe.',
  },
  {
    id: 'hn-keyword',
    title: 'Hacker News – Keyword',
    description: 'HN posts mentioning a keyword, pre-filtered by minimum upvote points via hnrss.org',
    category: 'Community',
    kind: 'rss',
    params: [
      {
        name: 'keyword',
        required: true,
        description: 'Word or phrase to search for in HN post titles and text',
        example: 'rust programming',
      },
      {
        name: 'min_points',
        required: false,
        description: 'Minimum upvote points; defaults to 10 to reduce noise',
        example: '25',
      },
    ],
    defaultScheduleEvery: '30m',
    buildNotes:
      'config.url = `https://hnrss.org/newest?q=${encodeURIComponent(keyword)}&points=${min_points ?? 10}`. hnrss.org already filters server-side, so keyword matching in Impri is informational: keywords = [{pattern: keyword, points: 10}], min_score = 0. Validate min_points as integer 1–500 before interpolation. keyword must be non-empty and <= 200 chars.',
  },
  {
    id: 'hn-show-ask',
    title: 'Hacker News – Show/Ask HN',
    description: 'Show HN or Ask HN posts from Hacker News',
    category: 'Community',
    kind: 'rss',
    params: [
      {
        name: 'type',
        required: true,
        description: 'Feed type: "show" for Show HN posts, "ask" for Ask HN posts',
        example: 'show',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'Validate type is exactly "show" or "ask" (allowlist, reject anything else). config.url = type === "show" ? "https://hnrss.org/show" : "https://hnrss.org/ask". URL is static after selection. keywords = [], min_score = 0.',
  },
  {
    id: 'reddit-subreddit',
    title: 'Reddit – Subreddit New Posts',
    description: 'New posts from a specific subreddit, sorted by new',
    category: 'Community',
    kind: 'rss',
    params: [
      {
        name: 'subreddit',
        required: true,
        description: 'Subreddit name without the r/ prefix',
        example: 'MachineLearning',
      },
    ],
    defaultScheduleEvery: '30m',
    buildNotes:
      'Validate subreddit against /^[A-Za-z0-9_]{1,21}$/ before interpolation (Reddit\'s actual naming rules; rejects path traversal and injection). config.url = `https://www.reddit.com/r/${subreddit}/new.rss`. Uses the rss kind (not reddit_search) so no query field is required. keywords = [], min_score = 0.',
  },
  {
    id: 'reddit-keyword',
    title: 'Reddit – Keyword Search',
    description: 'Reddit posts matching a keyword, optionally scoped to a single subreddit',
    category: 'Community',
    kind: 'reddit_search',
    params: [
      {
        name: 'query',
        required: true,
        description: 'Search query; supports Reddit search operators like title:, flair:, etc.',
        example: 'self-hosting AI',
      },
      {
        name: 'subreddit',
        required: false,
        description: 'Subreddit to search within; omit or use "all" to search all of Reddit',
        example: 'selfhosted',
      },
    ],
    defaultScheduleEvery: '30m',
    buildNotes:
      'config.subreddit = (subreddit && subreddit !== "all") ? subreddit : "all"; validate subreddit against /^[A-Za-z0-9_]{1,21}$/ when provided. config.query = query; validate query is non-empty and <= 500 chars. The scheduler builds: `https://www.reddit.com/r/${subreddit}/search.rss?q=${query}&sort=new&restrict_sr=1&limit=25`. keywords = [{pattern: query, points: 10}], min_score = 0.',
  },
  {
    id: 'github-releases',
    title: 'GitHub – Repository Releases',
    description: 'New releases published to a GitHub repository',
    category: 'Developer',
    kind: 'rss',
    params: [
      {
        name: 'owner',
        required: true,
        description: 'GitHub username or organization name',
        example: 'fastify',
      },
      {
        name: 'repo',
        required: true,
        description: 'Repository name',
        example: 'fastify',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'Validate owner and repo each against /^[A-Za-z0-9._-]{1,100}$/ — no slashes, no URL metacharacters. config.url = `https://github.com/${owner}/${repo}/releases.atom`. This is a standard GitHub Atom feed; no auth required for public repos. keywords = [], min_score = 0.',
  },
  {
    id: 'github-commits',
    title: 'GitHub – Repository Commits',
    description: 'New commits pushed to a GitHub repository (default branch)',
    category: 'Developer',
    kind: 'rss',
    params: [
      {
        name: 'owner',
        required: true,
        description: 'GitHub username or organization name',
        example: 'torvalds',
      },
      {
        name: 'repo',
        required: true,
        description: 'Repository name',
        example: 'linux',
      },
      {
        name: 'feed',
        required: false,
        description: 'Feed type: "commits" (default) for commit history, "tags" for new tags',
        example: 'commits',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'Validate owner and repo against /^[A-Za-z0-9._-]{1,100}$/. Validate feed against allowlist ["commits", "tags"]; default "commits". config.url = feed === "tags" ? `https://github.com/${owner}/${repo}/tags.atom` : `https://github.com/${owner}/${repo}/commits.atom`. keywords = [], min_score = 0.',
  },
  {
    id: 'npm-package',
    title: 'npm – Package New Version',
    description: 'Watch for new versions of an npm package via the registry API',
    category: 'Developer',
    kind: 'url_diff',
    params: [
      {
        name: 'package',
        required: true,
        description: 'npm package name; use the full name including scope for scoped packages',
        example: '@types/react',
      },
    ],
    defaultScheduleEvery: '6h',
    buildNotes:
      'Validate package against npm naming rules: /^(@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*$/ (scoped or unscoped). config.url = `https://registry.npmjs.org/${package}/latest` — for scoped packages like @types/react, keep the literal @ and / (the registry API accepts them). The /latest endpoint returns stable metadata (version, dist, dependencies) that changes only when a new version is published, making it a reliable url_diff trigger. min_score = 0. keywords = [].',
  },
  {
    id: 'pypi-package',
    title: 'PyPI – Package New Release',
    description: 'Watch for new releases of a Python package on PyPI using the official release RSS feed',
    category: 'Developer',
    kind: 'rss',
    params: [
      {
        name: 'package',
        required: true,
        description: 'PyPI package name (case-insensitive, normalized to lowercase)',
        example: 'requests',
      },
    ],
    defaultScheduleEvery: '6h',
    buildNotes:
      'Validate package against /^[A-Za-z0-9._-]+$/ and max length 200. Normalize to lowercase. config.url = `https://pypi.org/rss/project/${encodeURIComponent(package.toLowerCase())}/releases.xml`. PyPI provides official per-project RSS at this stable path; no third-party service needed. keywords = [], min_score = 0.',
  },
  {
    id: 'rss-feed',
    title: 'Generic RSS / Atom Feed',
    description: 'Follow any RSS 2.0 or Atom feed by URL',
    category: 'Content',
    kind: 'rss',
    params: [
      {
        name: 'url',
        required: true,
        description: 'Full http/https URL of the RSS or Atom feed',
        example: 'https://martinfowler.com/feed.atom',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'config.url = url. The URL must be http/https; pass it through the existing WatcherConfig Zod schema (which calls isIP + isPrivateIp) before creating the watcher — no special bypass. keywords = [], min_score = 0. Both RSS 2.0 and Atom formats are supported by the scheduler\'s parseRssItems function.',
  },
  {
    id: 'url-changed',
    title: 'Website Page Changed',
    description: 'Get notified when the full content of any web page changes',
    category: 'Monitoring',
    kind: 'url_diff',
    params: [
      {
        name: 'url',
        required: true,
        description: 'Full http/https URL of the page to monitor',
        example: 'https://example.com/pricing',
      },
    ],
    defaultScheduleEvery: '6h',
    buildNotes:
      'config.url = url (http/https, SSRF-guarded). url_diff computes SHA-256 of the full fetched page text; any content change triggers a watcher.triage action regardless of keyword scoring. Set min_score = 0 and keywords = []. The scheduler respects robots.txt: if the Impri-Watcher UA is disallowed, the watcher is degraded with error robots_disallowed rather than crawling anyway.',
  },
  {
    id: 'changelog-status',
    title: 'Changelog / Status Page',
    description: 'Watch a changelog or incident/status page for updates; tighter default schedule than the generic page watcher',
    category: 'Monitoring',
    kind: 'url_diff',
    params: [
      {
        name: 'url',
        required: true,
        description: 'URL of the changelog or status page, e.g. a /changelog path or a hosted status dashboard',
        example: 'https://www.githubstatus.com/',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'config.url = url (http/https, SSRF-guarded). Identical to url-changed in construction; the 1h default schedule (vs 6h for url-changed) reflects the operational urgency of status/changelog pages. min_score = 0, keywords = [].',
  },
  {
    id: 'youtube-channel',
    title: 'YouTube Channel – New Videos',
    description: 'New video uploads from a YouTube channel via the official Atom feed',
    category: 'Content',
    kind: 'rss',
    params: [
      {
        name: 'channel_id',
        required: true,
        description: 'YouTube channel ID (starts with UC, 24 characters). Find it in the URL youtube.com/channel/UC... or the channel\'s About page.',
        example: 'UCnUYZLuoy1rq1aVMwx4aTzw',
      },
    ],
    defaultScheduleEvery: '6h',
    buildNotes:
      'Validate channel_id against /^UC[A-Za-z0-9_-]{22}$/ — exactly 24 chars, starts with UC. config.url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel_id}`. This is YouTube\'s official public Atom feed; no API key or auth required. keywords = [], min_score = 0.',
  },
  {
    id: 'arxiv-papers',
    title: 'arXiv – New Papers',
    description: 'New preprints on arXiv by subject category or full-text keyword query',
    category: 'Research',
    kind: 'rss',
    params: [
      {
        name: 'category',
        required: false,
        description: 'arXiv subject category code, e.g. cs.AI, stat.ML, math.AG, hep-th. At least one of category or query is required.',
        example: 'cs.AI',
      },
      {
        name: 'query',
        required: false,
        description: 'Keyword or phrase to search across all arXiv metadata. At least one of category or query is required.',
        example: 'large language models',
      },
    ],
    defaultScheduleEvery: '6h',
    buildNotes:
      'At least one param required; reject if both are absent. If category provided: validate against /^[a-z-]+(?:\\.[A-Z]{2,4})?$/ (e.g. cs.AI, math, hep-th, q-bio.NC); config.url = `https://rss.arxiv.org/${category}`. If only query: config.url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=25` (arXiv API returns Atom which the scheduler\'s parseRssItems handles). If both provided: use the category URL and add keywords = [{pattern: query, points: 10}] with min_score = 0 to score results. When only category: keywords = [], min_score = 0.',
  },
  {
    id: 'google-news',
    title: 'Google News – Keyword',
    description: 'News articles matching a search query from Google News RSS',
    category: 'News',
    kind: 'rss',
    params: [
      {
        name: 'query',
        required: true,
        description: 'News search query; supports boolean operators like AND, OR, site:, "exact phrase"',
        example: 'AI regulation Europe',
      },
      {
        name: 'language',
        required: false,
        description: 'Language and region code in hl-gl format; defaults to en-US',
        example: 'de-DE',
      },
    ],
    defaultScheduleEvery: '1h',
    buildNotes:
      'Validate query is non-empty and <= 500 chars. Validate language (if provided) against /^[a-z]{2}-[A-Z]{2}$/ and allowlist of known BCP 47 codes; default "en-US". Parse language into parts: hl = language (e.g. "en-US"), gl = region part ("US"), ceid = "US:en". config.url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`. keywords = [{pattern: query, points: 10}], min_score = 0.',
  },
  {
    id: 'product-hunt',
    title: 'Product Hunt – Daily Posts',
    description: 'New products launched on Product Hunt via the public RSS feed',
    category: 'News',
    kind: 'rss',
    params: [],
    defaultScheduleEvery: '6h',
    buildNotes:
      'config.url = "https://www.producthunt.com/feed". No param interpolation; URL is static. keywords = [], min_score = 0. The public RSS feed lists recently submitted products. Users should add ScoringRule keywords for topics of interest (e.g. {pattern: "developer", points: 10}) to surface relevant launches from the high-volume feed.',
  },
  {
    id: 'stackoverflow-tag',
    title: 'Stack Overflow – Tag Questions',
    description: 'New questions tagged with a specific tag on Stack Overflow',
    category: 'Developer',
    kind: 'rss',
    params: [
      {
        name: 'tag',
        required: true,
        description: 'Stack Overflow tag to watch, e.g. python, typescript, fastapi',
        example: 'typescript',
      },
    ],
    defaultScheduleEvery: '30m',
    buildNotes:
      'Validate tag against /^[a-z0-9.#+_-]{1,35}$/ (Stack Overflow tag naming rules; max 35 chars, lowercase, alphanumeric plus . # + _ -). config.url = `https://stackoverflow.com/feeds/tag/${encodeURIComponent(tag)}`. This pattern also works for other Stack Exchange sites by replacing the hostname (e.g. serverfault.com, superuser.com). keywords = [], min_score = 0.',
  },
  {
    id: 'blog-newsletter',
    title: 'Blog / Newsletter',
    description: 'Follow a blog or newsletter via its RSS or Atom feed, with optional topic keyword filtering',
    category: 'Content',
    kind: 'rss',
    params: [
      {
        name: 'url',
        required: true,
        description: 'RSS or Atom feed URL of the blog or newsletter',
        example: 'https://newsletter.pragmaticengineer.com/feed',
      },
      {
        name: 'keywords',
        required: false,
        description: 'Comma-separated list of topic keywords to filter posts; omit to receive all posts',
        example: 'AI, LLM, architecture',
      },
    ],
    defaultScheduleEvery: '12h',
    buildNotes:
      'config.url = url (http/https, SSRF-guarded via WatcherConfig schema). If keywords param is provided: split on commas, strip whitespace, filter out empty strings, build keywords array as [{pattern: k, points: 10} for each k]; set min_score = 10 so only posts matching at least one keyword are delivered. If keywords is absent or empty: keywords = [], min_score = 0 (all posts delivered). 12h default suits typical blog publishing cadence (once or a few times per week) and keeps free-tier costs low.',
  },
];

// Fast lookup map (preset_id → Preset)
export const PRESET_MAP = new Map<string, Preset>(
  PRESET_CATALOG.map(p => [p.id, p]),
);

// ─── buildConfig ─────────────────────────────────────────────────────────────

/**
 * Validate `params` for the given `presetId` and return the partial
 * CreateWatcherBody fields (kind, config, keywords, keywords_none, min_score).
 *
 * Returns `{ ok: false, issues }` on any validation failure — the caller MUST
 * not proceed to DB insert and MUST return 400 to the client.
 *
 * After a successful return, the caller MUST still run
 * `CreateWatcherBody.safeParse(fullBody)` to re-check the SSRF guard and
 * schedule constraints before inserting.
 */
export function buildConfig(
  presetId: string,
  params: Record<string, string>,
): BuildConfigReturn {
  const preset = PRESET_MAP.get(presetId);
  if (!preset) {
    // Caller should have already checked; guard here for direct usage.
    return { ok: false, issues: [{ param: 'preset_id', message: 'Unknown preset_id' }] };
  }

  const issues: Array<{ param: string; message: string }> = [];

  // Helper: get required param
  function req(name: string): string {
    const v = (params[name] ?? '').trim();
    if (!v) issues.push({ param: name, message: `"${name}" is required` });
    return v;
  }

  // Helper: get optional param (trimmed, undefined when absent/empty)
  function opt(name: string): string | undefined {
    const v = (params[name] ?? '').trim();
    return v || undefined;
  }

  switch (presetId) {
    // ── Community ───────────────────────────────────────────────────────────

    case 'hn-front-page': {
      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: 'https://news.ycombinator.com/rss' },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: undefined,
      };
    }

    case 'hn-keyword': {
      const keyword = req('keyword');
      const minPointsRaw = opt('min_points');

      let minPoints = 10;
      if (minPointsRaw !== undefined) {
        const n = parseInt(minPointsRaw, 10);
        if (!Number.isInteger(n) || n < 1 || n > 500 || String(n) !== minPointsRaw) {
          issues.push({ param: 'min_points', message: '"min_points" must be an integer between 1 and 500' });
        } else {
          minPoints = n;
        }
      }
      if (keyword && keyword.length > 200) {
        issues.push({ param: 'keyword', message: '"keyword" must be 200 characters or fewer' });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: {
            url: `https://hnrss.org/newest?q=${encodeURIComponent(keyword)}&points=${minPoints}`,
          },
          keywords: [{ pattern: keyword, points: 10 }],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: keyword,
      };
    }

    case 'hn-show-ask': {
      const type = req('type');
      if (type && type !== 'show' && type !== 'ask') {
        issues.push({ param: 'type', message: '"type" must be "show" or "ask"' });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: type === 'show' ? 'https://hnrss.org/show' : 'https://hnrss.org/ask' },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: type,
      };
    }

    case 'reddit-subreddit': {
      const subreddit = req('subreddit');
      if (subreddit && !SUBREDDIT_RE.test(subreddit)) {
        issues.push({
          param: 'subreddit',
          message: '"subreddit" must be 1–21 characters (letters, digits, underscore only)',
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: `https://www.reddit.com/r/${subreddit}/new.rss` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: subreddit,
      };
    }

    case 'reddit-keyword': {
      const query = req('query');
      const subredditRaw = opt('subreddit');

      if (query && query.length > 500) {
        issues.push({ param: 'query', message: '"query" must be 500 characters or fewer' });
      }
      if (query && CONTROL_RE.test(query)) {
        issues.push({ param: 'query', message: '"query" must not contain newline characters' });
      }

      let subreddit = 'all';
      if (subredditRaw && subredditRaw !== 'all') {
        if (!SUBREDDIT_RE.test(subredditRaw)) {
          issues.push({
            param: 'subreddit',
            message: '"subreddit" must be 1–21 characters (letters, digits, underscore only)',
          });
        } else {
          subreddit = subredditRaw;
        }
      }

      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'reddit_search',
          config: { subreddit, query },
          keywords: [{ pattern: query, points: 10 }],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: query,
      };
    }

    // ── Developer ────────────────────────────────────────────────────────────

    case 'github-releases': {
      const owner = req('owner');
      const repo = req('repo');

      if (owner && !GITHUB_IDENT_RE.test(owner)) {
        issues.push({
          param: 'owner',
          message: '"owner" must be 1–100 characters (letters, digits, dots, hyphens, underscores only)',
        });
      }
      if (repo && !GITHUB_IDENT_RE.test(repo)) {
        issues.push({
          param: 'repo',
          message: '"repo" must be 1–100 characters (letters, digits, dots, hyphens, underscores only)',
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: `https://github.com/${owner}/${repo}/releases.atom` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: `${owner}/${repo}`,
      };
    }

    case 'github-commits': {
      const owner = req('owner');
      const repo = req('repo');
      const feedRaw = opt('feed');

      if (owner && !GITHUB_IDENT_RE.test(owner)) {
        issues.push({
          param: 'owner',
          message: '"owner" must be 1–100 characters (letters, digits, dots, hyphens, underscores only)',
        });
      }
      if (repo && !GITHUB_IDENT_RE.test(repo)) {
        issues.push({
          param: 'repo',
          message: '"repo" must be 1–100 characters (letters, digits, dots, hyphens, underscores only)',
        });
      }

      let feed = 'commits';
      if (feedRaw !== undefined) {
        if (feedRaw !== 'commits' && feedRaw !== 'tags') {
          issues.push({ param: 'feed', message: '"feed" must be "commits" or "tags"' });
        } else {
          feed = feedRaw;
        }
      }
      if (issues.length > 0) return { ok: false, issues };

      const url = feed === 'tags'
        ? `https://github.com/${owner}/${repo}/tags.atom`
        : `https://github.com/${owner}/${repo}/commits.atom`;

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: `${owner}/${repo}`,
      };
    }

    case 'npm-package': {
      const pkg = req('package');
      if (pkg && !NPM_PACKAGE_RE.test(pkg)) {
        issues.push({
          param: 'package',
          message: '"package" is not a valid npm package name (use lowercase; scoped names like @org/name are allowed)',
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      // Keep @ and / literal — the npm registry API accepts them in the URL path.
      return {
        ok: true,
        body: {
          kind: 'url_diff',
          config: { url: `https://registry.npmjs.org/${pkg}/latest` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: pkg,
      };
    }

    case 'pypi-package': {
      const pkg = req('package');
      if (pkg && !PYPI_PACKAGE_RE.test(pkg)) {
        issues.push({
          param: 'package',
          message: '"package" may only contain letters, digits, dots, hyphens, and underscores',
        });
      }
      if (pkg && pkg.length > 200) {
        issues.push({ param: 'package', message: '"package" must be 200 characters or fewer' });
      }
      if (issues.length > 0) return { ok: false, issues };

      const normalized = pkg.toLowerCase();
      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: `https://pypi.org/rss/project/${encodeURIComponent(normalized)}/releases.xml` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: normalized,
      };
    }

    // ── Content ──────────────────────────────────────────────────────────────

    case 'rss-feed': {
      const url = req('url');
      if (url && !/^https?:\/\//i.test(url)) {
        issues.push({ param: 'url', message: '"url" must start with http:// or https://' });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: url,
      };
    }

    // ── Monitoring ───────────────────────────────────────────────────────────

    case 'url-changed': {
      const url = req('url');
      if (url && !/^https?:\/\//i.test(url)) {
        issues.push({ param: 'url', message: '"url" must start with http:// or https://' });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'url_diff',
          config: { url },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: url,
      };
    }

    case 'changelog-status': {
      const url = req('url');
      if (url && !/^https?:\/\//i.test(url)) {
        issues.push({ param: 'url', message: '"url" must start with http:// or https://' });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'url_diff',
          config: { url },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: url,
      };
    }

    // ── Content (continued) ──────────────────────────────────────────────────

    case 'youtube-channel': {
      const channelId = req('channel_id');
      if (channelId && !YT_CHANNEL_ID_RE.test(channelId)) {
        issues.push({
          param: 'channel_id',
          message: '"channel_id" must be exactly 24 characters starting with "UC" (e.g. UCnUYZLuoy1rq1aVMwx4aTzw)',
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: channelId,
      };
    }

    // ── Research ─────────────────────────────────────────────────────────────

    case 'arxiv-papers': {
      const category = opt('category');
      const query = opt('query');

      if (!category && !query) {
        issues.push({ param: 'category', message: 'At least one of "category" or "query" is required' });
        issues.push({ param: 'query', message: 'At least one of "category" or "query" is required' });
      }
      if (category && !ARXIV_CATEGORY_RE.test(category)) {
        issues.push({
          param: 'category',
          message: '"category" is not a valid arXiv subject code (e.g. cs.AI, math, hep-th)',
        });
      }
      if (query && query.length > 500) {
        issues.push({ param: 'query', message: '"query" must be 500 characters or fewer' });
      }
      if (query && CONTROL_RE.test(query)) {
        issues.push({ param: 'query', message: '"query" must not contain newline characters' });
      }
      if (issues.length > 0) return { ok: false, issues };

      let url: string;
      let keywords: ScoringRule[] = [];

      if (category && query) {
        // Both: use category RSS, score by keyword
        url = `https://rss.arxiv.org/${category}`;
        keywords = [{ pattern: query, points: 10 }];
      } else if (category) {
        // Category only
        url = `https://rss.arxiv.org/${category}`;
      } else {
        // Query only: use arXiv API (returns Atom, handled by parseRssItems)
        url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query!)}&sortBy=submittedDate&sortOrder=descending&max_results=25`;
      }

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url },
          keywords,
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: category ?? query,
      };
    }

    // ── News ─────────────────────────────────────────────────────────────────

    case 'google-news': {
      const query = req('query');
      const languageRaw = opt('language') ?? 'en-US';

      if (query && query.length > 500) {
        issues.push({ param: 'query', message: '"query" must be 500 characters or fewer' });
      }
      if (query && CONTROL_RE.test(query)) {
        issues.push({ param: 'query', message: '"query" must not contain newline characters' });
      }
      if (!LANG_CODE_RE.test(languageRaw)) {
        issues.push({
          param: 'language',
          message: '"language" must be in hl-GL format (e.g. en-US, de-DE)',
        });
      } else if (!GOOGLE_NEWS_LANG_ALLOWLIST.has(languageRaw)) {
        issues.push({
          param: 'language',
          message: `"${languageRaw}" is not a supported Google News language code`,
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      // Parse "en-US" → hl="en-US", gl="US", ceid="US:en"
      const dashIdx = languageRaw.indexOf('-');
      const langBase = languageRaw.slice(0, dashIdx);   // "en"
      const region = languageRaw.slice(dashIdx + 1);    // "US"
      const hl = languageRaw;                           // "en-US"
      const gl = region;                                // "US"
      const ceid = `${region}:${langBase}`;             // "US:en"

      const url =
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
        `&hl=${hl}&gl=${gl}&ceid=${encodeURIComponent(ceid)}`;

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url },
          keywords: [{ pattern: query, points: 10 }],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: query,
      };
    }

    case 'product-hunt': {
      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: 'https://www.producthunt.com/feed' },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: undefined,
      };
    }

    case 'stackoverflow-tag': {
      const tag = req('tag');
      if (tag && !SO_TAG_RE.test(tag)) {
        issues.push({
          param: 'tag',
          message: '"tag" must be 1–35 lowercase alphanumeric characters (dots, #, +, _, - also allowed)',
        });
      }
      if (issues.length > 0) return { ok: false, issues };

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url: `https://stackoverflow.com/feeds/tag/${encodeURIComponent(tag)}` },
          keywords: [],
          keywords_none: [],
          min_score: 0,
        },
        primaryParam: tag,
      };
    }

    case 'blog-newsletter': {
      const url = req('url');
      const keywordsRaw = opt('keywords');

      if (url && !/^https?:\/\//i.test(url)) {
        issues.push({ param: 'url', message: '"url" must start with http:// or https://' });
      }
      if (issues.length > 0) return { ok: false, issues };

      let keywords: ScoringRule[] = [];
      let minScore = 0;

      if (keywordsRaw) {
        const kws = keywordsRaw
          .split(',')
          .map(k => k.trim())
          .filter(k => k.length > 0);
        if (kws.length > 0) {
          keywords = kws.map(k => ({ pattern: k, points: 10 }));
          minScore = 10;
        }
      }

      return {
        ok: true,
        body: {
          kind: 'rss',
          config: { url },
          keywords,
          keywords_none: [],
          min_score: minScore,
        },
        primaryParam: url,
      };
    }

    default:
      return { ok: false, issues: [{ param: 'preset_id', message: 'Unknown preset_id' }] };
  }
}
