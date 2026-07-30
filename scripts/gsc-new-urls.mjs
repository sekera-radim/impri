#!/usr/bin/env node
// Vypíše veřejné URL docs stránek, které přibyly/změnily se od dané git reference — vstup pro
// „Požádat o indexování" v Google Search Console.
//
// Samotné klikání v GSC tenhle skript NEDĚLÁ. Google nemá API na request-indexing běžných
// stránek (Indexing API umí jen JobPosting/BroadcastEvent, Search Console API jen čte), takže
// jedinou cestou je UI — a to řídí workflow `gsc-index` v orchestrátoru přes Claude in Chrome
// v Radimově přihlášeném profilu. Workflow tenhle soubor VYŽADUJE: když chybí, indexaci webu
// rovnou odmítne (a je to tak správně — neimprovizuje si vlastní seznam URL).
//
// POZOR: impri.dev je v GSC DOMÉNOVÁ property (`sc-domain:impri.dev`), ne URL-prefix. Volající
// proto workflow předává `property`, jinak by skončil na neexistující property.
//
// Usage:
//   node scripts/gsc-new-urls.mjs                  # nové docs stránky proti origin/main
//   node scripts/gsc-new-urls.mjs --base <ref>     # proti jiné referenci (např. HEAD~1)
//   node scripts/gsc-new-urls.mjs <cesta|url> ...  # explicitní cesty/URL
//   (env: GSC_MAX=11 — denní kvóta GSC)
// Exit 0 vždy; prázdný výstup = není co indexovat.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://impri.dev';
const MAX = Number(process.env.GSC_MAX || '11');

// Jen docs/<slug>.md — publikované SEO/use-case stránky. Ostatní markdown v repu (README,
// interní poznámky) veřejnou URL nemá.
const PAGE_PATH = /^docs\/([^/]+)\.md$/;

function changedPages(base) {
  try {
    const out = execFileSync(
      'git',
      ['-C', ROOT, 'diff', '--diff-filter=AM', '--name-only', `${base}..HEAD`],
      { encoding: 'utf8' },
    );
    return out.split('\n').map((s) => s.trim()).filter((p) => PAGE_PATH.test(p));
  } catch {
    return []; // neplatná reference / mimo git → nemáme co nabídnout
  }
}

function toUrl(p) {
  if (/^https?:\/\//i.test(p)) return p;
  const m = p.replace(/^\.?\//, '').match(PAGE_PATH);
  if (m) return `${ORIGIN}/docs/${m[1]}`;
  // Holý slug (tak ho předává publish-approved.mjs) — ber ho jako docs stránku.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(p)) return `${ORIGIN}/docs/${p}`;
  return null;
}

const argv = process.argv.slice(2);
let base = 'origin/main';
const explicit = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') base = argv[++i];
  else explicit.push(argv[i]);
}

const paths = explicit.length ? explicit : changedPages(base);
const urls = [...new Set(paths.map(toUrl).filter(Boolean))].slice(0, MAX);
for (const u of urls) console.log(u);
