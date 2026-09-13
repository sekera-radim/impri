#!/usr/bin/env node
// scripts/build-usecases.mjs — Impri marketing use-case pages + /agents one-pager
//
// Reads docs/use-cases/<slug>.md and renders www/use-cases/<slug>.html in the
// landing-page style (nav, hero, sections, CTA band, footer — same classes as
// www/index.html), plus the hub page www/use-cases/index.html and the
// www/agents/index.html one-pager for AI agents. Also writes
// www/use-cases/.manifest.json so scripts/build-docs.mjs can fold these pages
// into sitemap.xml and llms.txt without needing to know their format.
//
// Page source format (docs/use-cases/<slug>.md):
//   <!-- title: … -->  <!-- description: … -->  <!-- screenshot: <file> | <caption> -->
//   # H1
//   intro paragraph(s)
//   ## Problem / ## Workflow / ## MCP example / ## Result / ## CTA
//
// Run this BEFORE scripts/build-docs.mjs (which reads the manifest this
// script writes) — see the run order note in that file's header.
//
// Usage: node scripts/build-usecases.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'docs', 'use-cases');
const WWW = join(ROOT, 'www');
const ORIGIN = 'https://impri.dev';
const SHOTS_DIR = join(WWW, 'assets', 'screens');
const OG_DEFAULT = `${ORIGIN}/assets/og/og-default.png`;
const SIGNUP = 'https://app.impri.dev';
const GITLAB = 'https://gitlab.com/sekera.radim/impri';

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── markdown ──────────────────────────────────────────────────────────────
const renderer = new Renderer();
renderer.code = function (token) {
  const lang = token.lang ? token.lang.split(/\s+/)[0] : '';
  const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(token.text, { language: validLang }).value;
  return `<div class="code-block"><pre><code class="hljs language-${escHtml(validLang)}">${highlighted}</code></pre></div>\n`;
};
renderer.table = function (token) {
  const original = Renderer.prototype.table.call(this, token);
  return `<div class="table-wrap">${original}</div>\n`;
};
marked.use({ renderer });
const md = (text) => marked.parse(text.trim());

// ── parsing ───────────────────────────────────────────────────────────────
const TAG = (name) => new RegExp(`<!--\\s*${name}:\\s*(.+?)\\s*-->`, 'i');
const SECTIONS = ['Problem', 'Workflow', 'MCP example', 'Result', 'CTA'];

function parsePage(file) {
  const raw = readFileSync(file, 'utf8');
  const grab = (name) => { const m = TAG(name).exec(raw); return m ? m[1].trim() : null; };
  const title = grab('title');
  const description = grab('description');
  const shot = grab('screenshot');
  if (!title || !description) throw new Error(`${file}: missing <!-- title --> or <!-- description -->`);
  let screenshot = null;
  if (shot) {
    const [fileName, ...cap] = shot.split('|');
    screenshot = { file: fileName.trim(), caption: cap.join('|').trim() };
  }
  const body = raw.replace(/<!--[\s\S]*?-->\s*/g, '');
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (!h1) throw new Error(`${file}: missing H1`);
  const afterH1 = body.slice(h1.index + h1[0].length);
  const parts = afterH1.split(/^##\s+/m);
  const intro = parts[0].trim();
  const sections = {};
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    sections[heading] = part.slice(nl + 1).trim();
  }
  for (const key of SECTIONS) {
    if (!(key in sections)) throw new Error(`${file}: missing section "## ${key}"`);
  }
  return { title, description, screenshot, h1: h1[1].trim(), intro, sections };
}

// ── shared chrome (matches www/index.html) ─────────────────────────────────
const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%236366f1'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
const FAVICON_LINKS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="${FAVICON}">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">`;

function navHtml(active) {
  const isActive = (name) => (active === name ? ' active-nav' : '');
  return `<nav class="nav scrolled" id="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="mark">${LOGO_SVG}</span>Impri</a>
      <div class="nav-links">
        <a class="link" href="/#how">How it works</a>
        <a class="link${isActive('use-cases')}" href="/use-cases">Use cases</a>
        <a class="link${isActive('agents')}" href="/agents">Agents</a>
        <a class="link" href="/pricing">Pricing</a>
        <a class="link${isActive('docs')}" href="/docs">Docs</a>
        <a class="btn btn-primary btn-sm" href="${SIGNUP}">Get started</a>
      </div>
    </div>
  </nav>`;
}

function footerHtml() {
  return `<footer class="footer">
    <div class="wrap footer-inner">
      <a class="brand" href="/"><span class="mark">${LOGO_SVG}</span>Impri</a>
      <div>
        <a href="/use-cases">Use cases</a>
        <a href="/agents">Agents</a>
        <a href="${GITLAB}">GitLab</a>
        <a href="/docs">Docs</a>
        <a href="${GITLAB}/-/blob/main/LICENSE">MIT License</a>
        <a href="https://www.npmjs.com/package/@impri/mcp">@impri/mcp</a>
        <a href="/docs/privacy">Privacy</a>
        <a href="/docs/terms">Terms</a>
        <a href="https://sekera.dev">Contact</a>
      </div>
    </div>
    <div class="wrap" style="margin-top:18px"><span class="muted">© 2026 Impri · The imprimatur for your AI agents · Built by <a href="https://sekera.dev" style="color:inherit">Radim Sekera</a>.</span></div>
  </footer>`;
}

function headHtml({ title, description, path, jsonLd, ogImage = OG_DEFAULT }) {
  const url = `${ORIGIN}${path}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escHtml(description)}" />
  <meta name="theme-color" content="#06070d" />
  <meta property="og:title" content="${escHtml(title)}" />
  <meta property="og:description" content="${escHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Impri — human-in-the-loop approval inbox for AI agents" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${ogImage}" />
  <link rel="canonical" href="${url}" />
  ${FAVICON_LINKS}
  <link rel="stylesheet" href="/styles.css" />
  ${jsonLd.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n  ')}
</head>
<body>
<div class="bg-aurora"></div><div class="bg-grid"></div><div class="bg-vignette"></div>`;
}

// ── use-case page + hub ─────────────────────────────────────────────────────
function shotInfo(screenshot) {
  if (!screenshot) return null;
  const file = join(SHOTS_DIR, screenshot.file);
  if (!existsSync(file)) return null;
  return { src: `/assets/screens/${screenshot.file}`, caption: screenshot.caption };
}

function renderUseCasePage(page, slug, allPages) {
  const path = `/use-cases/${slug}`;
  const shot = shotInfo(page.screenshot);
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: page.title, description: page.description, url: `${ORIGIN}${path}`, inLanguage: 'en', isPartOf: { '@type': 'WebSite', name: 'Impri', url: ORIGIN } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Impri', item: ORIGIN },
      { '@type': 'ListItem', position: 2, name: 'Use cases', item: `${ORIGIN}/use-cases` },
      { '@type': 'ListItem', position: 3, name: page.title, item: `${ORIGIN}${path}` },
    ] },
  ];
  const related = allPages.filter((p) => p.slug !== slug).slice(0, 3)
    .map((p) => `<a class="feature uc-card" href="/use-cases/${p.slug}"><h3>${escHtml(p.page.h1)}</h3><p>${escHtml(p.page.description)}</p><span class="uc-more">Read more →</span></a>`).join('\n');
  const figure = shot ? `<figure class="uc-shot-figure reveal" data-delay="1">
      <img class="uc-shot" src="${shot.src}" alt="${escHtml(shot.caption)}" loading="lazy" width="1400" height="875">
      <figcaption>${escHtml(shot.caption)}</figcaption>
    </figure>` : '';
  return `${headHtml({ title: `${page.title} — Impri`, description: page.description, path, jsonLd })}
${navHtml('use-cases')}
  <header class="hero uc-hero" id="top">
    <div class="wrap" style="max-width:820px">
      <nav class="uc-crumbs reveal" aria-label="Breadcrumb"><a href="/">Impri</a> › <a href="/use-cases">Use cases</a></nav>
      <span class="eyebrow reveal" data-delay="1">Use case</span>
      <h1 class="reveal" data-delay="1" style="margin-top:18px">${escHtml(page.h1)}</h1>
      <div class="lede reveal uc-intro" data-delay="2">${md(page.intro)}</div>
      <div class="hero-cta reveal" data-delay="3">
        <a class="btn btn-primary magnetic" href="${SIGNUP}">Try it free ${ARROW_SVG}</a>
        <a class="btn btn-ghost magnetic" href="${GITLAB}">Self-host instead</a>
      </div>
    </div>
  </header>

  <section class="section uc-section" id="problem">
    <div class="wrap uc-wrap">
      <div class="section-head reveal"><span class="eyebrow">The problem</span><h2 style="margin-top:14px">Problem</h2></div>
      <div class="uc-prose reveal" data-delay="1">${md(page.sections['Problem'])}</div>
    </div>
  </section>

  <section class="section uc-section" id="workflow">
    <div class="wrap uc-wrap">
      <div class="section-head reveal"><span class="eyebrow">How it runs</span><h2 style="margin-top:14px">Workflow</h2></div>
      <div class="uc-prose reveal" data-delay="1">${md(page.sections['Workflow'])}</div>
    </div>
  </section>

  ${shot ? `<section class="section uc-section" id="screenshot">
    <div class="wrap">
      <div class="section-head reveal"><span class="eyebrow">What it looks like</span></div>
      ${figure}
    </div>
  </section>` : ''}

  <section class="section uc-section" id="mcp">
    <div class="wrap uc-wrap">
      <div class="section-head reveal"><span class="eyebrow">For the agent</span><h2 style="margin-top:14px">MCP example</h2></div>
      <div class="uc-prose reveal" data-delay="1">${md(page.sections['MCP example'])}</div>
      <p class="reveal" data-delay="2" style="margin-top:14px"><a class="btn btn-ghost btn-sm" href="/docs/mcp">Read the MCP docs</a></p>
    </div>
  </section>

  <section class="section uc-section" id="result">
    <div class="wrap uc-wrap">
      <div class="section-head reveal"><span class="eyebrow">What changes</span><h2 style="margin-top:14px">Result</h2></div>
      <div class="uc-prose reveal" data-delay="1">${md(page.sections['Result'])}</div>
    </div>
  </section>

  <section class="section" id="cta">
    <div class="wrap">
      <div class="cta-band reveal">
        <div class="uc-prose" style="margin:0 auto 20px;text-align:center">${md(page.sections['CTA'])}</div>
        <div class="cta-btns">
          <a class="btn btn-primary magnetic" href="${SIGNUP}">Try it free ${ARROW_SVG}</a>
          <a class="btn btn-ghost magnetic" href="${GITLAB}">Self-host instead</a>
        </div>
      </div>
    </div>
  </section>

  <section class="section uc-section" id="related">
    <div class="wrap">
      <div class="section-head reveal"><span class="eyebrow">More use cases</span></div>
      <div class="features features-3">${related}</div>
    </div>
  </section>

${footerHtml()}
<script src="/app.js" defer></script>
</body>
</html>
`;
}

function renderHub(pages) {
  const path = '/use-cases';
  const title = 'Use cases — Impri';
  const description = 'What people gate behind Impri: overnight coding agents, destructive database writes, outbound email and messages, deploys and infra changes, refunds and payments, and AI-generated content before it publishes.';
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url: `${ORIGIN}${path}`, inLanguage: 'en' },
  ];
  const cards = pages.map((p, i) => `<a class="feature uc-card reveal" data-delay="${(i % 3) + 1}" href="/use-cases/${p.slug}"><h3>${escHtml(p.page.h1)}</h3><p>${escHtml(p.page.description)}</p><span class="uc-more">Read more →</span></a>`).join('\n');
  return `${headHtml({ title, description, path, jsonLd })}
${navHtml('use-cases')}
  <header class="hero uc-hero" id="top">
    <div class="wrap" style="max-width:820px">
      <span class="eyebrow reveal">Use cases</span>
      <h1 class="reveal" data-delay="1" style="margin-top:18px">What people use Impri for</h1>
      <p class="lede reveal" data-delay="2" style="max-width:38em">Six places where a human decision belongs between an AI agent and a real-world side effect — pick the one closest to what your agent does.</p>
    </div>
  </header>
  <section class="section uc-section">
    <div class="wrap"><div class="features features-3">${cards}</div></div>
  </section>
  <section class="section" id="cta">
    <div class="wrap"><div class="cta-band reveal">
      <h2 style="font-size:clamp(24px,3.2vw,34px)">Not seeing your case?</h2>
      <p>The pattern is the same everywhere — propose, wait for a human, then act. <a href="/docs/how-to-add-human-approval-to-an-ai-agent" style="color:#a5b4fc">Read the general pattern</a>.</p>
      <div class="cta-btns">
        <a class="btn btn-primary magnetic" href="${SIGNUP}">Try it free ${ARROW_SVG}</a>
        <a class="btn btn-ghost magnetic" href="${GITLAB}">Self-host instead</a>
      </div>
    </div></div>
  </section>
${footerHtml()}
<script src="/app.js" defer></script>
</body>
</html>
`;
}

// ── /agents one-pager ────────────────────────────────────────────────────
// Facts verified against mcp/README.md, docs/mcp.md and mcp/src/index.ts:
// env vars IMPRI_API_KEY (required) + IMPRI_BASE_URL (optional, defaults to
// http://localhost:8484; cloud is https://api.impri.dev), package @impri/mcp,
// and the 8 tool names below.
const INSTALLS = [
  { name: 'Claude Code', code: 'claude mcp add impri \\\n  -e IMPRI_API_KEY=im_your_key_here \\\n  -e IMPRI_BASE_URL=https://api.impri.dev \\\n  -- npx @impri/mcp', note: 'Self-hosted? Drop IMPRI_BASE_URL — it defaults to http://localhost:8484.', guide: '/docs/claude-code-human-approval' },
  { name: 'OpenAI Codex', code: 'codex mcp add impri \\\n  --env IMPRI_API_KEY=im_your_key_here \\\n  --env IMPRI_BASE_URL=https://api.impri.dev \\\n  -- npx -y @impri/mcp', note: 'Self-hosted? Drop IMPRI_BASE_URL — it defaults to http://localhost:8484.', guide: '/docs/codex-human-approval' },
  { name: 'Cursor', code: '{\n  "mcpServers": {\n    "impri": {\n      "command": "npx",\n      "args": ["-y", "@impri/mcp"],\n      "env": {\n        "IMPRI_API_KEY": "im_your_key_here",\n        "IMPRI_BASE_URL": "https://api.impri.dev"\n      }\n    }\n  }\n}', note: 'Save as .cursor/mcp.json. Self-hosted? Drop IMPRI_BASE_URL — it defaults to http://localhost:8484.', guide: '/docs/cursor-human-approval' },
  { name: 'Windsurf', code: '{\n  "mcpServers": {\n    "impri": {\n      "command": "npx",\n      "args": ["-y", "@impri/mcp"],\n      "env": {\n        "IMPRI_API_KEY": "im_your_key_here",\n        "IMPRI_BASE_URL": "https://api.impri.dev"\n      }\n    }\n  }\n}', note: 'Save to ~/.codeium/windsurf/mcp_config.json. Self-hosted? Drop IMPRI_BASE_URL — it defaults to http://localhost:8484.', guide: '/docs/windsurf-human-approval' },
];

const TOOLS = [
  ['impri_push_action', 'Submit a proposed action with a preview; returns an action_id and inbox_url.'],
  ['impri_await_decision', 'Long-poll until a human approves, rejects, or the timeout elapses.'],
  ['impri_report_result', 'Report whether the approved action executed; closes the audit loop.'],
  ['impri_inbox_status', 'Check how many actions are pending before starting a new batch.'],
  ['impri_create_watcher', 'Create a monitoring watcher from a full hand-written spec.'],
  ['impri_list_watchers', 'List configured watchers, optionally filtered by status.'],
  ['impri_list_watcher_presets', 'List ready-made watcher templates (Reddit, GitHub releases, HN, RSS…).'],
  ['impri_create_watcher_from_preset', 'Create a watcher from a preset by id, with just the params filled in.'],
];

const FLOW = [
  'Before an action leaves the sandbox — a send, a deploy, a write, a publish — the agent calls impri_push_action with a short title and a preview.',
  'The agent calls impri_await_decision and blocks. The action shows up in the web inbox, and on your phone if a notification channel is configured.',
  'A human approves, rejects, or edits the draft. The decision (and any edit, as a signed diff) comes back from the poll.',
  'On approved, the agent executes — never before — and calls impri_report_result so the inbox shows the real outcome, not just the decision.',
];

function installTabsHtml() {
  const tabs = INSTALLS.map((i, idx) => `<button class="install-tab${idx === 0 ? ' active' : ''}" type="button" data-tab="${idx}">${escHtml(i.name)}</button>`).join('\n');
  const panels = INSTALLS.map((i, idx) => `<div class="install-panel${idx === 0 ? ' active' : ''}" data-panel="${idx}">
    <div class="code-block"><pre>${escHtml(i.code)}</pre></div>
    <p class="uc-prose" style="font-size:14px;margin-top:6px">${escHtml(i.note)} <a href="${i.guide}">Full guide →</a></p>
  </div>`).join('\n');
  return `<div class="install-tabs" role="tablist">${tabs}</div>
  <div class="install-panels">${panels}</div>
  <script>(function(){
    var tabs=document.querySelectorAll('.install-tab'),panels=document.querySelectorAll('.install-panel');
    tabs.forEach(function(t){t.addEventListener('click',function(){
      tabs.forEach(function(x){x.classList.remove('active')});
      panels.forEach(function(x){x.classList.remove('active')});
      t.classList.add('active');
      document.querySelector('.install-panel[data-panel="'+t.dataset.tab+'"]').classList.add('active');
    });});
  })();</script>`;
}

function renderAgents() {
  const path = '/agents';
  const title = 'Impri for AI agents — human approval over MCP';
  const description = 'Install the Impri MCP server in Claude Code, Codex, Cursor or Windsurf, and give your agent 8 tools to propose actions, await a human decision, and report the outcome.';
  const jsonLd = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: `${ORIGIN}${path}`, inLanguage: 'en' },
  ];
  const toolRows = TOOLS.map(([name, desc]) => `<tr><td>${escHtml(name)}</td><td>${escHtml(desc)}</td></tr>`).join('\n');
  const flowItems = FLOW.map((f) => `<li>${escHtml(f)}</li>`).join('\n');
  const loopCode = `impri_push_action({ kind, title, preview: { format, body }, editable })
  // -> { action_id, status: "pending", inbox_url }

impri_await_decision({ action_id, timeout_s })
  // -> { status: "approved" | "rejected", preview, edited_by_human }

impri_report_result({ action_id, status: "executed" | "execute_failed", detail })`;
  return `${headHtml({ title, description, path, jsonLd })}
${navHtml('agents')}
  <header class="hero uc-hero" id="top">
    <div class="wrap" style="max-width:820px">
      <span class="eyebrow reveal">For Claude Code, Codex, Cursor, Windsurf and any MCP agent</span>
      <h1 class="reveal" data-delay="1" style="margin-top:18px">Give your agent a way to ask a human first.</h1>
      <div class="lede reveal" data-delay="2">Impri is an MCP server with 8 tools: propose an action, wait for a decision, report what happened. Your agent keeps doing everything else at full speed — it only stops at the door marked "real side effect."</div>
      <div class="hero-cta reveal" data-delay="3">
        <a class="btn btn-primary magnetic" href="${SIGNUP}">Get started free ${ARROW_SVG}</a>
        <a class="btn btn-ghost magnetic" href="${GITLAB}">Self-host instead</a>
      </div>
    </div>
  </header>

  <section class="section uc-section" id="install">
    <div class="wrap uc-wrap" style="max-width:820px">
      <div class="section-head reveal"><span class="eyebrow">Install</span><h2 style="margin-top:14px">One line per agent</h2></div>
      ${installTabsHtml()}
    </div>
  </section>

  <section class="section uc-section" id="tools">
    <div class="wrap uc-wrap" style="max-width:820px">
      <div class="section-head reveal"><span class="eyebrow">What the agent gets</span><h2 style="margin-top:14px">8 tools</h2></div>
      <div class="table-wrap reveal" data-delay="1"><table class="tools-table">
        <thead><tr><th>Tool</th><th>Purpose</th></tr></thead>
        <tbody>${toolRows}</tbody>
      </table></div>
    </div>
  </section>

  <section class="section uc-section" id="loop">
    <div class="wrap uc-wrap" style="max-width:820px">
      <div class="section-head reveal"><span class="eyebrow">How it runs</span><h2 style="margin-top:14px">Propose → await → report</h2></div>
      <ol class="flow-list reveal" data-delay="1">${flowItems}</ol>
      <div class="code-block reveal" data-delay="2"><pre>${escHtml(loopCode)}</pre></div>
    </div>
  </section>

  <section class="section uc-section" id="usecases">
    <div class="wrap uc-wrap" style="max-width:820px">
      <div class="section-head reveal"><span class="eyebrow">Use cases</span><h2 style="margin-top:14px">See it applied</h2></div>
      <p class="uc-prose">Overnight coding runs, destructive database writes, outbound email, deploys, refunds, content publishing — <a href="/use-cases">see what people use it for</a>. Full API reference: <a href="/docs/mcp">MCP server docs</a> and the <a href="https://api.impri.dev/v1/openapi.json">OpenAPI spec</a>.</p>
    </div>
  </section>

  <section class="section" id="cta">
    <div class="wrap"><div class="cta-band reveal">
      <h2>Give your agent hands — <span class="gradient-text">and a conscience.</span></h2>
      <div class="cta-btns">
        <a class="btn btn-primary magnetic" href="${SIGNUP}">Get started free</a>
        <a class="btn btn-ghost magnetic" href="${GITLAB}">Self-host instead</a>
      </div>
    </div></div>
  </section>
${footerHtml()}
<script src="/app.js" defer></script>
</body>
</html>
`;
}

// ── main ─────────────────────────────────────────────────────────────────
function main() {
  mkdirSync(join(WWW, 'use-cases'), { recursive: true });
  mkdirSync(join(WWW, 'agents'), { recursive: true });

  const files = existsSync(SRC) ? readdirSync(SRC).filter((f) => f.endsWith('.md')) : [];
  const pages = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    const page = parsePage(join(SRC, f));
    pages.push({ slug, page });
  }
  pages.sort((a, b) => a.slug.localeCompare(b.slug));

  for (const { slug, page } of pages) {
    const html = renderUseCasePage(page, slug, pages);
    writeFileSync(join(WWW, 'use-cases', `${slug}.html`), html, 'utf8');
    console.log(`  ✓  use-cases/${slug}.html`);
  }

  writeFileSync(join(WWW, 'use-cases', 'index.html'), renderHub(pages), 'utf8');
  console.log(`  ✓  use-cases/index.html (hub)`);

  writeFileSync(join(WWW, 'agents', 'index.html'), renderAgents(), 'utf8');
  console.log(`  ✓  agents/index.html`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    useCases: pages.map(({ slug, page }) => ({ slug, title: page.title, description: page.description })),
    agents: { title: 'Impri for AI agents — human approval over MCP' },
  };
  writeFileSync(join(WWW, 'use-cases', '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`  ✓  use-cases/.manifest.json`);

  console.log(`\nDone — ${pages.length} use-case pages + hub + /agents.`);
}

main();
