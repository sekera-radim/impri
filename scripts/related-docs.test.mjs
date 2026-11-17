// Run: node --test scripts/related-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRelated, terms } from './related-docs.mjs';

const page = (slug, title, extra = {}) => ({ slug, title, lead: '', headings: [], linked: [], ...extra });

const PAGES = [
  page('slack-a', 'Slack approval for AI agent messages'),
  page('slack-b', 'Slack approval buttons for AI agents'),
  page('slack-c', 'Slack approval for AI agent refunds'),
  page('payments', 'Approve AI agent payments and refunds'),
  page('invoices', 'Approve AI agent invoices and payments'),
  page('langgraph', 'Human in the loop for LangGraph agents'),
  page('mastra', 'Human in the loop for Mastra agents'),
];

test('terms drops stopwords, numbers and plural -s', () => {
  assert.deepEqual(terms('How to approve the 3 Slack messages'), ['approve', 'slack', 'message']);
  assert.deepEqual(terms('Policies vs. access'), ['policy', 'access']);
});

test('picks the most similar pages first, never the page itself', () => {
  const related = pickRelated(PAGES, { count: 2 });
  assert.deepEqual(related.get('slack-a').slice(0, 2).sort(), ['slack-b', 'slack-c']);
  assert.equal(related.get('payments')[0], 'invoices');
  for (const [slug, links] of related) assert.ok(!links.includes(slug));
});

test('does not repeat a link the body already has', () => {
  const pages = PAGES.map(p => (p.slug === 'payments' ? { ...p, linked: ['invoices'] } : p));
  assert.ok(!pickRelated(pages, { count: 2 }).get('payments').includes('invoices'));
});

test('every page that shares a term gets a link from somewhere, within max', () => {
  const related = pickRelated(PAGES, { count: 1, max: 2 });
  const linked = new Set([...related.values()].flat());
  for (const p of PAGES) assert.ok(linked.has(p.slug), `${p.slug} is linked from nowhere`);
  for (const links of related.values()) assert.ok(links.length <= 2);
});

test('a body link from another page counts as an inbound link', () => {
  // count 0: only the second pass adds links, one per page linked from nowhere.
  const linksTo = (rel, target) => [...rel.values()].filter(l => l.includes(target)).length;
  assert.equal(linksTo(pickRelated(PAGES, { count: 0, max: 1 }), 'mastra'), 1);
  const pages = PAGES.map(p => (p.slug === 'slack-a' ? { ...p, linked: ['mastra'] } : p));
  assert.equal(linksTo(pickRelated(pages, { count: 0, max: 1 }), 'mastra'), 0);
});

test('same input gives the same output, in any input order', () => {
  const a = pickRelated(PAGES);
  const b = pickRelated([...PAGES].reverse());
  for (const p of PAGES) assert.deepEqual(a.get(p.slug), b.get(p.slug));
});
