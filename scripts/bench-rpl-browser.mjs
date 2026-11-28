import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const [checkout, samples, gzip] = process.argv.slice(2);
if (!checkout || !samples)
  throw Error('usage: node scripts/bench-rpl-browser.mjs <checkout> <sample dir> [gzip]');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
const rows = [];
try {
  for (const name of ['human', 'ai', 'fragment', 'multiline', 'large', 'long']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const body = await readFile(path.join(samples, name + '.view'));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/getreplay/sample')
        return route.fulfill({
          body: gzip ? gunzipSync(body) : body,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Replay-Size': String(gzip ? body.readUInt32LE(body.length - 4) : body.length),
          },
        });
      if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      return route
        .fulfill({
          path: path.join(checkout, 'static', pathname === '/replays/sample' ? 'game.html' : pathname),
        })
        .catch(() => route.abort());
    });
    await page.addInitScript(() => {
      window.progressSamples = [];
      new MutationObserver(() => {
        const text = document.querySelector('#replay-loading-text')?.textContent;
        if (text && text !== progressSamples.at(-1)) progressSamples.push(text);
      }).observe(document, { subtree: true, characterData: true, childList: true });
    });
    await page.goto('http://roka.test/replays/sample', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.in_game === true, null, { polling: 10, timeout: 120000 });
    const results = await page.evaluate(() => {
      const readyMs = performance.now(),
        end = replay_data.patches.length,
        seekMs = [],
        stepsMs = [];
      for (const target of [end, 0, Math.floor(end * 0.7), Math.floor(end * 0.2), end - 1, 0]) {
        const start = performance.now();
        jumpToFrame(target);
        seekMs.push(performance.now() - start);
        if (cur_turn !== target) throw Error('seek');
      }
      for (let tick = 0; tick < 20; tick++) {
        const start = performance.now();
        nextTurn();
        stepsMs.push(performance.now() - start);
      }
      if (cur_turn !== 20) throw Error('step');
      const start = performance.now();
      if (replay_data.meta.fog_mode !== 'visible') setReplayViewTeam(1);
      const teamMs = performance.now() - start;
      return {
        readyMs,
        seekMs,
        stepsMs,
        teamMs,
        progressSamples: progressSamples.length,
        workerProgress: progressSamples.some((s) => s.includes('重建回放')),
      };
    });
    const cdp = await page.context().newCDPSession(page);
    const heap = await cdp.send('Runtime.getHeapUsage');
    assert.deepEqual(errors, []);
    if (!gzip) assert.ok(results.workerProgress);
    rows.push({ name, ...results, mainHeapAfter: heap.usedSize });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(rows, null, 2));
