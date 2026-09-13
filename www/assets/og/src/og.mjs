import pkg from '/home/radim/esign/node_modules/playwright/index.js';
const { chromium } = pkg;

const variants = [
  { query: '', out: '../og-default.png' },
  { query: '?variant=docs', out: '../og-docs.png' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

for (const v of variants) {
  await page.goto('file://' + process.cwd() + '/og.html' + v.query, { waitUntil: 'networkidle' });
  if (v.query.includes('variant=docs')) {
    await page.evaluate(() => document.body.classList.add('docs'));
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: v.out, type: 'png' });
}

await browser.close();
