import { chromium } from '/home/radim/esign/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;

// Each target: [html file, END seconds (must match the file's own END const), frames subdir]
const TARGETS = [
  { html: 'killer.html', end: 26.0, dir: 'frames-killer' },
  { html: 'killer-short.html', end: 10.5, dir: 'frames-killer-short' },
];

const only = process.argv[2]; // optional: 'killer' or 'killer-short'
const targets = only ? TARGETS.filter((t) => t.dir === 'frames-' + only) : TARGETS;
if (targets.length === 0) {
  console.error('No matching target for', only);
  process.exit(1);
}

const browser = await chromium.launch();

for (const target of targets) {
  const framesDir = path.join(__dirname, target.dir);
  mkdirSync(framesDir, { recursive: true });
  const totalFrames = Math.round(target.end * FPS);

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, target.html));
  await page.waitForFunction(() => typeof window.__seek === 'function');

  console.log(`--- capturing ${target.html} -> ${target.dir} (${totalFrames} frames) ---`);
  const t0 = Date.now();
  for (let i = 0; i < totalFrames; i++) {
    const t = i / FPS;
    await page.evaluate((tt) => window.__seek(tt), t);
    const fname = path.join(framesDir, 'frame_' + String(i).padStart(5, '0') + '.png');
    await page.screenshot({ path: fname });
    if (i % 30 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`frame ${i}/${totalFrames} t=${t.toFixed(2)}s elapsed=${elapsed}s`);
    }
  }
  await page.close();
  console.log(`done: ${target.html}, frames: ${totalFrames}`);
}

await browser.close();
