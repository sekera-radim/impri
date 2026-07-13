#!/usr/bin/env node
/**
 * scripts/build-docs.mjs — Impri docs static site generator
 *
 * Reads every docs/*.md (excluding llms.txt and research/launch files),
 * renders each to www/docs/<slug>.html wrapped in a shared template that
 * matches the site style, and regenerates www/docs.html (hub page).
 *
 * Usage:  node scripts/build-docs.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..');
const DOCS_SRC   = join(ROOT, 'docs');
const DOCS_OUT   = join(ROOT, 'www', 'docs');
const WWW        = join(ROOT, 'www');

// ── Nav structure (section order + page order within sections) ─────────────

const NAV = [
  {
    section: 'Getting started',
    icon: '⚡',
    pages: [
      { slug: 'quickstart',                              title: 'Quickstart' },
      { slug: 'how-to-add-human-approval-to-an-ai-agent', title: 'Human approval pattern' },
      { slug: 'self-hosting',                            title: 'Self-hosting' },
      { slug: 'observability',                           title: 'Observability' },
    ],
  },
  {
    section: 'API reference',
    icon: '⬡',
    pages: [
      { slug: 'api-keys',          title: 'API keys & scopes' },
      { slug: 'rules',             title: 'Rules engine' },
      { slug: 'watcher-presets',   title: 'Watcher presets' },
      { slug: 'notifications',     title: 'Notification channels' },
      { slug: 'telegram-approval', title: 'Telegram approval' },
      { slug: 'slack-approval',    title: 'Slack approval' },
      { slug: 'discord-approval',  title: 'Discord approval' },
      { slug: 'audit-log',         title: 'Audit log' },
      { slug: 'billing',           title: 'Billing & tiers' },
      { slug: 'gdpr',              title: 'GDPR & data export' },
      { slug: 'privacy',           title: 'Privacy policy' },
      { slug: 'terms',             title: 'Terms of service' },
      { slug: 'operator',          title: 'Operator / admin' },
      { slug: 'account-recovery',  title: 'Account recovery' },
    ],
  },
  {
    section: 'SDKs',
    icon: '◈',
    pages: [
      { slug: 'sdk-python',     title: 'Python SDK' },
      { slug: 'sdk-typescript', title: 'TypeScript SDK' },
    ],
  },
  {
    section: 'Integrations',
    icon: '◎',
    pages: [
      { slug: 'mcp',              title: 'MCP server' },
      { slug: 'integrations',     title: 'LangChain / CrewAI / n8n' },
      { slug: 'claude-agent-sdk', title: 'Claude Agent SDK' },
    ],
  },
  {
    section: 'Inbox & webhooks',
    icon: '◫',
    pages: [
      { slug: 'inbox',    title: 'Inbox UX & bulk decisions' },
      { slug: 'webhooks', title: 'Webhooks' },
      { slug: 'web-push', title: 'Web push' },
    ],
  },
  {
    section: 'CLI',
    icon: '❯',
    pages: [
      { slug: 'cli', title: 'CLI reference' },
    ],
  },
  {
    section: 'Cookbook',
    icon: '◻',
    pages: [
      { slug: 'cookbook', title: 'Cookbook' },
    ],
  },
];

// Flat map for slug → title + section lookup
const PAGE_MAP = new Map();
for (const group of NAV) {
  for (const page of group.pages) {
    PAGE_MAP.set(page.slug, { ...page, section: group.section });
  }
}

// ── Marked + highlight.js setup ────────────────────────────────────────────

const renderer = new Renderer();

renderer.code = function (token) {
  const lang = token.lang ? token.lang.split(/\s+/)[0] : '';
  const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(token.text, { language: validLang }).value;
  const label = lang && lang !== 'plaintext'
    ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
  return `<div class="code-block">${label}<pre><code class="hljs">${highlighted}</code></pre></div>\n`;
};

renderer.link = function (token) {
  let href = token.href || '';
  // Rewrite relative docs/*.md links to .html so cross-page navigation works
  if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('#')) {
    href = href.replace(/\.md(\s*#.*)?$/, (_, hash) => `.html${hash || ''}`);
  }
  const title  = token.title ? ` title="${escHtml(token.title)}"` : '';
  const target = href.startsWith('http') ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${href}"${title}${target}>${token.text}</a>`;
};

renderer.table = function (token) {
  // Wrap tables in overflow container so they don't bleed on narrow viewports
  const original = Renderer.prototype.table.call(this, token);
  return `<div class="table-wrap">${original}</div>\n`;
};

marked.use({ renderer });

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── HTML helpers ──────────────────────────────────────────────────────────

/** Add id attributes to h2/h3 headings for in-page anchors. */
function addHeadingIds(html) {
  const seen = new Map();
  return html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, level, attrs, inner) => {
    if (attrs.includes('id=')) return _; // already has an id
    const text = inner.replace(/<[^>]+>/g, '');
    let id = text.toLowerCase()
      .replace(/[`'"]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    // Deduplicate ids on the same page
    const count = (seen.get(id) || 0) + 1;
    seen.set(id, count);
    if (count > 1) id = `${id}-${count}`;
    return `<h${level} id="${id}"${attrs}>${inner}</h${level}>`;
  });
}

/** Decode the handful of HTML entities marked emits, so TOC text is clean. */
function decodeEntities(s) {
  return s
    .replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Extract { level, id, text } for each h2/h3 heading in rendered HTML. */
function extractHeadings(html) {
  const headings = [];
  const re = /<h([23])[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    headings.push({
      level: parseInt(m[1], 10),
      id:    m[2],
      text:  decodeEntities(m[3].replace(/<[^>]+>/g, '')),
    });
  }
  return headings;
}

/** Build the sticky in-page TOC from headings. Returns empty string when few headings. */
function buildPageToc(headings) {
  if (headings.length < 2) return '';
  const items = headings.map(h =>
    `<li class="ptoc-h${h.level}"><a href="#${h.id}">${escHtml(h.text)}</a></li>`
  ).join('\n');
  return `<nav class="ptoc" aria-label="On this page">
<div class="ptoc-label">On this page</div>
<ul>${items}</ul>
</nav>`;
}

/** Build the left sidebar nav HTML, marking activeSlug as current. */
function buildSidebar(activeSlug, root) {
  return NAV.map(group => {
    const links = group.pages.map(page => {
      const isActive = page.slug === activeSlug;
      return `<a href="${root}docs/${page.slug}.html" class="sl${isActive ? ' active' : ''}">${escHtml(page.title)}</a>`;
    }).join('\n');
    return `<div class="sg">
<div class="sg-label">${escHtml(group.section)}</div>
${links}
</div>`;
  }).join('\n');
}

/** Extract plain-text title from H1 in rendered HTML. */
function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : 'Impri Docs';
}

/** Extract a short description from the first paragraph. */
function extractDesc(html) {
  const m = html.match(/<p>([\s\S]*?)<\/p>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : 'Impri documentation.';
}

// ── Shared assets ─────────────────────────────────────────────────────────

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%236366f1'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Custom hljs dark theme tuned to the Impri palette (background matches terminal in styles.css)
const HLJS_CSS = `
pre code.hljs{display:block;overflow-x:auto}
.hljs{color:#cdd3e1;background:transparent}
.hljs-comment,.hljs-quote{color:#5a6170;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-meta.hljs-keyword{color:#a78bfa}
.hljs-string,.hljs-addition,.hljs-meta .hljs-string,.hljs-regexp{color:#86efac}
.hljs-literal{color:#fbbf24}
.hljs-number,.hljs-attr,.hljs-template-variable,.hljs-variable,.hljs-selector-class{color:#fbbf24}
.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#22d3ee}
.hljs-title,.hljs-section,.hljs-selector-id{color:#818cf8}
.hljs-name,.hljs-deletion{color:#f87171}
.hljs-attribute,.hljs-link{color:#a5b4fc}
.hljs-meta{color:#a78bfa}
.hljs-symbol,.hljs-bullet{color:#22d3ee}
.hljs-strong{font-weight:700}
.hljs-emphasis{font-style:italic}
.hljs-link{text-decoration:underline}
`.trim();

// Docs-specific CSS (supplementing styles.css)
const DOCS_CSS = `
/* ── docs layout ── */
.docs-shell{display:grid;grid-template-columns:220px 1fr 180px;gap:0;max-width:1280px;margin:0 auto;padding:84px 0 120px}
.docs-sidebar{padding:24px 20px 40px 24px;position:sticky;top:68px;align-self:start;max-height:calc(100vh - 80px);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
.docs-sidebar::-webkit-scrollbar{width:4px}
.docs-sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:2px}
.sg{margin-bottom:22px}
.sg-label{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);padding:0 8px;margin-bottom:6px}
.sl{display:block;font-size:13.5px;color:var(--muted);text-decoration:none;padding:5px 8px;border-radius:7px;transition:color .15s,background .15s;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl:hover{color:var(--text);background:rgba(255,255,255,.05)}
.sl.active{color:#c7cbff;background:rgba(99,102,241,.14);font-weight:500}
.sl.active::before{content:"";display:inline-block;width:3px;height:3px;border-radius:50%;background:var(--indigo);margin-right:5px;vertical-align:middle}
/* ── doc content ── */
.doc-main{padding:24px 36px 40px;min-width:0}
.breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--faint);margin-bottom:32px;flex-wrap:wrap}
.breadcrumb a{color:var(--muted);text-decoration:none}
.breadcrumb a:hover{color:var(--text)}
.breadcrumb .bc-sep{opacity:.4}
.doc-main h1{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.03em;margin:0 0 10px;text-wrap:balance}
.doc-main .doc-lede{font-size:17px;color:#aeb7c6;margin:0 0 40px;line-height:1.7;max-width:42em}
.doc-main h2{font-size:22px;font-weight:700;margin:52px 0 12px;scroll-margin-top:84px;letter-spacing:-.02em;text-wrap:balance}
.doc-main h3{font-size:17px;font-weight:700;margin:32px 0 8px;scroll-margin-top:84px;letter-spacing:-.01em}
.doc-main h4{font-size:14px;font-weight:700;margin:24px 0 6px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
.doc-main p,.doc-main li{color:#c4ccd8;line-height:1.75;font-size:15px}
.doc-main p{margin:0 0 14px}
.doc-main a{color:#a5b4fc;text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.doc-main a:hover{color:#c7cbff}
.doc-main ul,.doc-main ol{padding-left:22px;margin:6px 0 14px}
.doc-main li{margin:4px 0}
.doc-main hr{border:none;border-top:1px solid var(--border);margin:40px 0}
.doc-main strong{color:var(--text);font-weight:600}
.doc-main blockquote{border-left:3px solid rgba(99,102,241,.5);padding:2px 16px;margin:0 0 14px;color:var(--muted)}
/* code */
.code-block{position:relative;background:rgba(0,0,0,.38);border:1px solid rgba(255,255,255,.08);border-radius:12px;margin:14px 0;overflow:hidden}
.code-block pre{margin:0;padding:16px 18px;overflow-x:auto;font-size:13px;line-height:1.6;font-family:var(--mono)}
.code-lang{position:absolute;top:10px;right:13px;font-size:11px;font-family:var(--mono);color:var(--faint);letter-spacing:.04em;pointer-events:none;user-select:none}
.doc-main :not(pre)>code{background:rgba(124,140,255,.14);padding:2px 6px;border-radius:5px;font-size:.875em;font-family:var(--mono);color:#c7cbff}
/* tables */
.table-wrap{overflow-x:auto;margin:14px 0}
.doc-main table{width:100%;border-collapse:collapse;font-size:14px;min-width:420px}
.doc-main th,.doc-main td{text-align:left;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.07)}
.doc-main th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);background:rgba(255,255,255,.02)}
.doc-main tr:hover td{background:rgba(255,255,255,.02)}
/* page toc (right column) */
.ptoc{position:sticky;top:84px;align-self:start;padding:24px 16px 24px 0}
.ptoc-label{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
.ptoc ul{list-style:none;padding:0;margin:0}
.ptoc li{margin:0}
.ptoc a{display:block;font-size:12.5px;color:var(--faint);text-decoration:none;padding:4px 0 4px 8px;border-left:1px solid rgba(255,255,255,.07);transition:color .15s,border-color .15s;line-height:1.4}
.ptoc a:hover{color:var(--muted);border-color:rgba(99,102,241,.5)}
.ptoc-h3 a{padding-left:18px;font-size:12px}
/* ── hub page ── */
.docs-hub{max-width:1080px;margin:0 auto;padding:100px 24px 120px}
.hub-hero{margin-bottom:60px}
.hub-hero h1{font-size:clamp(34px,5vw,52px);font-weight:800;letter-spacing:-.035em;margin:0 0 12px}
.hub-hero p{font-size:17px;color:var(--muted);max-width:36em;line-height:1.7}
.hub-sections{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.hub-card{border:1px solid var(--border);border-radius:16px;padding:24px 26px;background:var(--surface);transition:border-color .25s,transform .25s;display:block;text-decoration:none;color:inherit}
.hub-card:hover{border-color:rgba(129,140,248,.4);transform:translateY(-2px)}
.hub-card-title{font-size:16px;font-weight:700;margin:0 0 14px;color:var(--text)}
.hub-card-pages{list-style:none;padding:0;margin:0;display:grid;gap:4px}
.hub-card-pages li a{font-size:13.5px;color:var(--muted);text-decoration:none;display:flex;align-items:center;gap:6px;padding:3px 0;transition:color .15s}
.hub-card-pages li a:hover{color:#c7cbff}
.hub-card-pages li a::before{content:"";display:inline-block;width:4px;height:4px;border-radius:50%;background:rgba(129,140,248,.5);flex-shrink:0}
/* ── responsive ── */
@media(max-width:1100px){.docs-shell{grid-template-columns:200px 1fr;}.ptoc{display:none}}
@media(max-width:800px){.docs-shell{grid-template-columns:1fr;padding-top:72px}.docs-sidebar{display:none}.doc-main{padding:16px 18px 40px}}
@media(max-width:560px){.hub-sections{grid-template-columns:1fr}}
`.trim();

// ── Shared nav HTML (used in all pages) ───────────────────────────────────

function buildNav(root) {
  return `<nav class="nav scrolled" id="nav">
<div class="wrap nav-inner">
  <a class="brand" href="/">
    <span class="mark">${LOGO_SVG}</span>
    Impri
  </a>
  <div class="nav-links">
    <a class="link" href="/#how">How it works</a>
    <a class="link" href="/#pricing">Pricing</a>
    <a class="link active-nav" href="${root}docs.html">Docs</a>
    <a class="btn btn-primary btn-sm" href="https://gitlab.com/sekera.radim/impri">GitLab</a>
  </div>
</div>
</nav>`;
}

function buildFooter() {
  return `<footer class="footer">
<div class="wrap footer-inner">
  <a class="brand" href="/">
    <span class="mark">${LOGO_SVG}</span>Impri
  </a>
  <div>
    <a href="https://gitlab.com/sekera.radim/impri">GitLab</a>
    <a href="/docs.html">Docs</a>
    <a href="https://gitlab.com/sekera.radim/impri/-/blob/main/LICENSE">MIT License</a>
    <a href="https://www.npmjs.com/package/@impri/mcp">@impri/mcp</a>
    <a href="/docs/privacy.html">Privacy</a>
    <a href="/docs/terms.html">Terms</a>
    <a href="https://sekera.dev">Contact</a>
  </div>
</div>
<div class="wrap" style="margin-top:18px"><span class="muted">© 2026 Impri · The imprimatur for your AI agents · Built by <a href="https://sekera.dev" style="color:inherit">Radim Sekera</a>.</span></div>
</footer>`;
}

// ── Page template (individual doc pages) ─────────────────────────────────

function renderDocPage({ slug, title, desc, section, contentHtml, sidebarHtml, pageTocHtml, root }) {
  // Cloudflare Pages serves the clean URL (/docs/slug) and 308-redirects the
  // .html form to it, so canonical/OG/JSON-LD must point at the clean URL.
  const canonical = `https://impri.dev/docs/${slug}`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description: desc,
    url: canonical,
    inLanguage: 'en',
    author:    { '@type': 'Organization', name: 'Impri', url: 'https://impri.dev' },
    publisher: { '@type': 'Organization', name: 'Impri', url: 'https://impri.dev' },
  });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — Impri Docs</title>
<meta name="description" content="${escHtml(desc)}">
<meta name="theme-color" content="#06070d">
<meta property="og:title" content="${escHtml(title)} — Impri Docs">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${canonical}">
<script type="application/ld+json">${jsonLd}</script>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${root}styles.css">
<style>
${HLJS_CSS}
${DOCS_CSS}
.nav-links .active-nav{color:var(--text)!important}
</style>
</head>
<body>
<div class="bg-aurora"></div>
<div class="bg-grid"></div>
<div class="bg-vignette"></div>

${buildNav(root)}

<div class="docs-shell">
  <aside class="docs-sidebar" aria-label="Documentation navigation">
    ${sidebarHtml}
  </aside>

  <main class="doc-main" id="main-content">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="${root}docs.html">Docs</a>
      <span class="bc-sep">/</span>
      <span>${escHtml(section)}</span>
      <span class="bc-sep">/</span>
      <span>${escHtml(title)}</span>
    </nav>
    ${contentHtml}
  </main>

  <aside aria-label="On this page">
    ${pageTocHtml}
  </aside>
</div>

${buildFooter()}
</body>
</html>`;
}

// ── Hub page template ──────────────────────────────────────────────────────

function renderHubPage(pages) {
  // pages: Map<slug, { title, desc }>

  const cards = NAV.map(group => {
    const pageLinks = group.pages.map(p => {
      const info = pages.get(p.slug) || {};
      return `<li><a href="docs/${p.slug}.html">${escHtml(p.title)}</a></li>`;
    }).join('\n');
    return `<div class="hub-card">
<div class="hub-card-title">${escHtml(group.section)}</div>
<ul class="hub-card-pages">
${pageLinks}
</ul>
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Impri Docs — human approval for AI agents</title>
<meta name="description" content="Impri documentation: add a human approval step to any AI agent. Self-host in 5 minutes, integrate over REST or MCP, use watchers to surface work with no code.">
<meta name="theme-color" content="#06070d">
<meta property="og:title" content="Impri Docs — human approval for AI agents">
<meta property="og:description" content="Complete reference for Impri: quickstart, API, SDKs, integrations, CLI, and self-hosting.">
<meta property="og:type" content="website">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="styles.css">
<style>
${DOCS_CSS}
.nav-links .active-nav{color:var(--text)!important}
</style>
</head>
<body>
<div class="bg-aurora"></div>
<div class="bg-grid"></div>
<div class="bg-vignette"></div>

${buildNav('')}

<div class="docs-hub">
  <div class="hub-hero">
    <span class="eyebrow">Reference</span>
    <h1 style="margin-top:16px">Impri documentation</h1>
    <p>Add a human approval step to any AI agent. An agent proposes an action, a person approves or rejects it in the inbox, and only then does it run. Everything you need to get started and go deep.</p>
    <div style="display:flex;gap:12px;margin-top:28px;flex-wrap:wrap">
      <a class="btn btn-primary btn-sm" href="docs/quickstart.html">Quickstart</a>
      <a class="btn btn-ghost btn-sm" href="docs/how-to-add-human-approval-to-an-ai-agent.html">Human approval pattern</a>
      <a class="btn btn-ghost btn-sm" href="docs/mcp.html">MCP server</a>
    </div>
  </div>

  <div class="hub-sections">
    ${cards}
  </div>
</div>

${buildFooter()}
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Ensure output directory exists
  mkdirSync(DOCS_OUT, { recursive: true });

  // Collect all .md files to render
  const files = readdirSync(DOCS_SRC)
    .filter(f => {
      if (!f.endsWith('.md')) return false;
      // Skip research/launch files and llms.txt
      if (f.startsWith('research-') || f.startsWith('launch')) return false;
      return true;
    })
    .map(f => join(DOCS_SRC, f));

  const pageIndex = new Map(); // slug → { title, desc }

  let rendered = 0;
  for (const file of files) {
    const slug = basename(file, '.md');

    const meta = PAGE_MAP.get(slug);
    if (!meta) {
      // File exists on disk but not in NAV — still render it, just unlisted
      console.log(`  note: ${slug}.md not in NAV — rendering unlisted`);
    }

    const section = meta ? meta.section : 'Reference';
    const root = '../'; // individual pages live in www/docs/, one level below www/

    // Parse markdown
    const md = readFileSync(file, 'utf8');
    let contentHtml = marked.parse(md);
    contentHtml = addHeadingIds(contentHtml);

    const title = extractTitle(contentHtml);
    const desc  = extractDesc(contentHtml);

    // Strip H1 from content (it's shown in the page heading already via the md)
    // Actually — keep the H1 as the visible document heading. The markdown files
    // have H1 at top; we just render it as-is. The breadcrumb gives context.

    const headings    = extractHeadings(contentHtml);
    const pageTocHtml = buildPageToc(headings);
    const sidebarHtml = buildSidebar(slug, root);

    const html = renderDocPage({
      slug, title, desc, section, contentHtml,
      sidebarHtml, pageTocHtml, root,
    });

    const outPath = join(DOCS_OUT, `${slug}.html`);
    writeFileSync(outPath, html, 'utf8');
    pageIndex.set(slug, { title, desc });
    rendered++;
    console.log(`  ✓  docs/${slug}.html`);
  }

  // ── Hub page: www/docs.html ────────────────────────────────────────────
  const hubHtml = renderHubPage(pageIndex);
  writeFileSync(join(WWW, 'docs.html'), hubHtml, 'utf8');
  console.log(`  ✓  docs.html (hub)`);

  // ── Also write www/docs/index.html for /docs/ URL ─────────────────────
  // Same content as hub but with root = '../' for CSS/nav links
  // (Re-render the hub pointing at root = '../')
  const hubIndexHtml = renderHubPage(pageIndex)
    // Patch relative asset paths for the /docs/ sub-directory
    .replace(/href="styles\.css"/g, 'href="../styles.css"')
    // Patch nav/breadcrumb "Docs" link so it doesn't resolve to the
    // non-existent www/docs/docs.html (BL-1 fix).
    .replace(/href="docs\.html"/g, 'href="../docs.html"')
    .replace(/href="docs\//g, 'href="./');
  writeFileSync(join(DOCS_OUT, 'index.html'), hubIndexHtml, 'utf8');
  console.log(`  ✓  docs/index.html`);

  // ── sitemap.xml ──────────────────────────────────────────────────────────
  // So search engines discover every doc page, including unlisted SEO pages
  // that are not in the NAV sidebar.
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = ['https://impri.dev/', 'https://impri.dev/docs'];
  for (const slug of pageIndex.keys()) {
    urls.push(`https://impri.dev/docs/${slug}`);
  }
  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`;
  writeFileSync(join(WWW, 'sitemap.xml'), sitemap, 'utf8');
  console.log(`  ✓  sitemap.xml (${urls.length} urls)`);

  // ── llms.txt: keep an auto-generated index of use-case guides (unlisted pages) ──
  // Curated content above the marker is preserved; the marker section to EOF is
  // regenerated each build so new SEO/use-case pages stay discoverable to AI crawlers.
  const GUIDES_MARKER = '## Use-case guides (auto-generated)';
  try {
    const llmsPath = join(WWW, 'llms.txt');
    let llms = readFileSync(llmsPath, 'utf8');
    const cut = llms.indexOf(GUIDES_MARKER);
    if (cut !== -1) llms = llms.slice(0, cut);
    const guideLines = [];
    for (const [slug, info] of pageIndex.entries()) {
      if (PAGE_MAP.has(slug)) continue; // NAV pages already listed in the curated section
      guideLines.push(`- ${info.title}: https://impri.dev/docs/${slug}.html`);
    }
    if (guideLines.length) {
      llms = llms.replace(/\s+$/, '') + `\n\n${GUIDES_MARKER}\n` + guideLines.sort().join('\n') + '\n';
      writeFileSync(llmsPath, llms, 'utf8');
      console.log(`  ✓  llms.txt (+${guideLines.length} guide links)`);
    }
  } catch (e) {
    console.log(`  note: llms.txt not updated (${e.message})`);
  }

  console.log(`\nDone — ${rendered} doc pages + hub index + sitemap + llms index.`);
}

main();
