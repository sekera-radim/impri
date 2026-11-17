/**
 * scripts/related-docs.mjs — picks "Related guides" links for the unlisted
 * docs pages (the long-tail articles readers land on from search).
 *
 * Most of those articles were linked from no other page, only from
 * sitemap.xml and llms.txt: a reader who finished one had no path to the
 * next, and crawlers saw no internal link to them. The picker is
 * deterministic (same docs in, same links out) so a rebuild doesn't reshuffle
 * every page and push ~170 "changed" URLs to IndexNow for nothing.
 *
 * Similarity is TF-IDF cosine over the words of each page's H1 (weighted up),
 * lead paragraph and h2/h3 headings. IDF makes words that every article shares
 * ("agent", "approval", "human") count for almost nothing, so pages match on
 * what they are specifically about (a framework, a channel, a kind of action).
 */

// Short function words only; domain words are left to IDF.
const STOPWORDS = new Set(`
a about after all also an and any are as at be before but by can do does
for from get gets how if in into is it its not of on or out over so than
that the their them then there these they this those to too up use using
via was way what when where which while who why will with without you your
yours we our us vs versus
next step steps getting started cover doesn isn don actually usually
worth still just more most only each every one two three side same
add adding added guide
`.split(/\s+/).filter(Boolean));

// The H1 says what the page is about; headings are partly boilerplate.
const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 0.5;

/** Lowercase words of `text`, without stopwords, numbers and plural -s. */
export function terms(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

// Titles are short English phrases: folding plurals is enough to match
// "agents" with "agent", without adding a stemming dependency to the build.
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function termCounts(page) {
  const counts = new Map();
  const add = (text, weight) => {
    for (const t of terms(text)) counts.set(t, (counts.get(t) || 0) + weight);
  };
  add(page.title, TITLE_WEIGHT);
  add(page.lead || '', 1);
  for (const h of page.headings || []) add(h, HEADING_WEIGHT);
  return counts;
}

/** Unit-length TF-IDF vector per slug. */
function vectors(pages) {
  const counts = new Map(pages.map(p => [p.slug, termCounts(p)]));
  const df = new Map();
  for (const c of counts.values()) {
    for (const t of c.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = pages.length;
  const vecs = new Map();
  for (const [slug, c] of counts) {
    const v = new Map();
    let norm = 0;
    for (const [t, tf] of c) {
      const w = tf * Math.log(n / df.get(t));
      if (w > 0) { v.set(t, w); norm += w * w; }
    }
    norm = Math.sqrt(norm);
    for (const [t, w] of v) v.set(t, w / norm);
    vecs.set(slug, v);
  }
  return vecs;
}

function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o) sum += w * o;
  }
  return sum;
}

/**
 * pages: [{ slug, title, lead, headings: string[], linked: string[] }]
 *   `linked` = slugs the page already links in its body; those aren't
 *   repeated in its block.
 * Returns Map<slug, slug[]>: each page's `count` most similar pages, then a
 * second pass gives every page that is still linked from nowhere (no block,
 * no body link) one link from its most similar page with fewer than `max`.
 */
export function pickRelated(pages, { count = 4, max = 5 } = {}) {
  const vecs = vectors(pages);
  const slugs = pages.map(p => p.slug);
  const bodyLinks = new Map(pages.map(p => [p.slug, new Set(p.linked || [])]));

  // Candidates per page, most similar first; ties broken by slug.
  const ranked = new Map();
  for (const a of slugs) {
    const list = [];
    for (const b of slugs) {
      if (a === b) continue;
      const score = cosine(vecs.get(a), vecs.get(b));
      if (score > 0) list.push({ slug: b, score });
    }
    list.sort((x, y) => y.score - x.score || (x.slug < y.slug ? -1 : 1));
    ranked.set(a, list);
  }

  const related = new Map();
  for (const a of slugs) {
    related.set(a, ranked.get(a)
      .filter(r => !bodyLinks.get(a).has(r.slug))
      .slice(0, count)
      .map(r => r.slug));
  }

  const linkedFromElsewhere = new Set();
  for (const [source, links] of bodyLinks) {
    for (const s of links) if (s !== source) linkedFromElsewhere.add(s);
  }
  for (const links of related.values()) for (const s of links) linkedFromElsewhere.add(s);

  for (const target of [...slugs].sort()) {
    if (linkedFromElsewhere.has(target)) continue;
    // Cosine is symmetric: the pages most similar to the target are its best sources.
    for (const { slug: source } of ranked.get(target)) {
      const links = related.get(source);
      if (links.length >= max || links.includes(target)) continue;
      links.push(target);
      linkedFromElsewhere.add(target);
      break;
    }
  }
  return related;
}
