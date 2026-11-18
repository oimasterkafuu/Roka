import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { StaticAssetDelivery } from '../dist/server/static-assets.js';

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const game = await readFile('static/game.html', 'utf8');
const main = await readFile('static/main.js', 'utf8');
const runtime = await readFile('static/asset-runtime.js', 'utf8');
const loading = main.slice(
  main.indexOf('function formatReplaySize'),
  main.indexOf('function base64ToArrayBuffer'),
);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const delivery = new StaticAssetDelivery(version, process.cwd(), {
  ROKA_STATIC_COMMIT: '0123456789abcdef0123456789abcdef01234567',
});
function removeScriptElements(html) {
  const retained = [];
  let previousEnd = 0;
  for (const match of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script(?:\s[^>]*)?>/gi)) {
    retained.push(html.slice(previousEnd, match.index));
    previousEnd = match.index + match[0].length;
  }
  retained.push(html.slice(previousEnd));
  return retained.join('');
}

assert.equal(
  removeScriptElements(`
    <main id="before">before</main>
    <SCRIPT SRC="/external.js"></SCRIPT>
    <ScRiPt>const mixedCase = true;</sCrIpT>
    <script>const closingAttributes = true;</script foo="bar">
    <script src="/empty.js"></script>
    <script></script>
    <section id="after">after</section>
  `),
  [
    '',
    '    <main id="before">before</main>',
    '    ',
    '    ',
    '    ',
    '    ',
    '    ',
    '    <section id="after">after</section>',
    '  ',
  ].join('\n'),
  'script removal handles every script element and preserves surrounding non-script markup',
);

// Retain the final server-injected HTML/style; hold scripts so the initial overlay
// can be inspected before the asset runtime removes it.
const initial = removeScriptElements(delivery.html(game));
const fixture = removeScriptElements(game);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const measurements = [];
if (process.env.ROKA_LOADING_OUTPUT) await mkdir(process.env.ROKA_LOADING_OUTPUT, { recursive: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://roka.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fixture });
      try {
        const file = url.pathname.slice(1);
        assert(!file.includes('..'));
        await route.fulfill({
          contentType: file.endsWith('.css') ? 'text/css' : undefined,
          body: await readFile(`static/${file}`),
        });
      } catch {
        await route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto('http://roka.test/');
    await page.addScriptTag({ content: loading });
    await page.evaluate(() => {
      // Minimal DOM adapter for the unchanged loading function's jQuery API.
      window.$ = (selector) => {
        const node = document.querySelector(selector);
        const api = {
          removeClass(name) {
            node.classList.remove(name);
            return api;
          },
          addClass(name) {
            node.classList.add(name);
            return api;
          },
          css(name, value) {
            node.style[name] = value;
            return api;
          },
          text(value) {
            node.textContent = value;
            return api;
          },
        };
        return api;
      };
      document.querySelector('#replay-loading').style.display = '';
    });
    const data = await page.evaluate(() => {
      const bar = document.querySelector('#replay-loading-bar');
      const fill = document.querySelector('#replay-loading-fill');
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      };
      const track = rect(bar);
      updateReplayLoading(0, 0);
      const animation = fill.getAnimations()[0];
      if (!animation) throw new Error('missing indeterminate animation');
      animation.pause();
      const duration = animation.effect.getTiming().duration;
      const phases = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((phase) => {
        animation.currentTime = phase * duration - (phase === 1 ? 0.001 : 0);
        return { phase, ...rect(fill), scrollWidth: document.documentElement.scrollWidth };
      });
      // Switch while the bar is displaced, then sample immediately and at the
      // deterministic midpoint/end of any width transition.
      const progress = [0, 25, 75, 100].map((percent) => {
        updateReplayLoading(1, 0);
        fill.getAnimations()[0].pause();
        fill.getAnimations()[0].currentTime = duration * 0.75;
        void fill.getBoundingClientRect();
        updateReplayLoading(percent, 100);
        const immediate = rect(fill);
        const states = [immediate];
        for (const a of fill.getAnimations()) {
          a.pause();
          a.currentTime = a.effect.getTiming().duration / 2;
          states.push(rect(fill));
          a.finish();
        }
        const style = getComputedStyle(fill);
        return {
          percent,
          states,
          ...rect(fill),
          transform: style.transform,
          marginLeft: style.marginLeft,
          animation: style.animationName,
          marginRight: style.marginRight,
          textAlign: style.textAlign,
          display: style.display,
        };
      });
      const card = rect(document.querySelector('#replay-loading'));
      const text = rect(document.querySelector('#replay-loading-text'));
      return {
        track,
        finalTrack: rect(bar),
        phases,
        progress,
        card,
        text,
        scrollWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      };
    });
    const near = (actual, expected) => assert(Math.abs(actual - expected) < 0.1, `${actual} != ${expected}`);
    for (const sample of data.progress) {
      near(sample.left, data.track.left);
      near(sample.width, (data.track.width * sample.percent) / 100);
      for (const state of sample.states) near(state.left, data.track.left);
      assert.equal(sample.transform, 'none');
      assert.equal(sample.marginLeft, '0px');
      assert.equal(sample.animation, 'none');
    }
    assert(data.phases[0].right <= data.track.left + 0.1);
    assert(
      data.phases.some((r) => r.right > data.track.left && r.left < data.track.left + data.track.width / 2),
    );
    assert(data.phases.some((r) => r.right >= data.track.right && r.left < data.track.right));
    assert(data.phases.at(-1).left >= data.track.right - 0.1);
    for (let i = 1; i < data.phases.length; i++) assert(data.phases[i].left > data.phases[i - 1].left);
    assert(data.card.left >= 0 && data.card.right <= width);
    assert(data.text.top >= data.finalTrack.bottom);
    for (const phase of data.phases) assert(phase.scrollWidth <= width);
    assert(data.scrollWidth <= width);
    if (process.env.ROKA_LOADING_OUTPUT)
      await page.screenshot({ path: `${process.env.ROKA_LOADING_OUTPUT}/replay-${width}.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => updateReplayLoading(0, 0));
    assert.equal(
      await page.locator('#replay-loading-fill').evaluate((el) => getComputedStyle(el).animationName),
      'none',
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent(initial);
    const spinner = await page.evaluate(() => {
      const html = document.documentElement;
      const before = getComputedStyle(html, '::before');
      const after = getComputedStyle(html, '::after');
      const animation = document.getAnimations().find((a) => a.animationName === 'roka-initial-spin');
      if (!animation) throw new Error('missing spinner animation');
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(html, '::before').transform;
      animation.currentTime = 200;
      const rotated = getComputedStyle(html, '::before').transform;
      return {
        content: before.content,
        text: after.content,
        animation: before.animationName,
        size: before.width,
        top: before.top,
        left: before.left,
        start,
        rotated,
        bodyVisibility: getComputedStyle(document.body).visibility,
      };
    });
    assert.equal(spinner.content, '""');
    assert.match(spinner.text, /Roka 加载中…/);
    assert.equal(spinner.animation, 'roka-initial-spin');
    assert.equal(spinner.size, '32px');
    assert.notEqual(spinner.start, spinner.rotated);
    assert.equal(spinner.bodyVisibility, 'hidden');
    if (process.env.ROKA_LOADING_OUTPUT)
      await page.screenshot({ path: `${process.env.ROKA_LOADING_OUTPUT}/initial-${width}.png` });
    // Resume the real asset runtime with an empty inline job after inspection.
    await page.evaluate(runtime);
    await page.evaluate(() => window.ROKA_ASSETS.enqueue({}, ''));
    await page.waitForFunction(() => !document.querySelector('#roka-initial-style'));
    const removed = await page.evaluate(() => ({
      before: getComputedStyle(document.documentElement, '::before').content,
      after: getComputedStyle(document.documentElement, '::after').content,
      visibility: getComputedStyle(document.body).visibility,
    }));
    assert(['none', 'normal'].includes(removed.before));
    assert(['none', 'normal'].includes(removed.after));
    assert.equal(removed.visibility, 'visible');
    assert.deepEqual(errors, []);
    measurements.push({ width, ...data, spinner, removed, pageerrors: errors });
    await page.close();
  }
  if (process.env.ROKA_LOADING_OUTPUT) {
    await mkdir(process.env.ROKA_LOADING_OUTPUT, { recursive: true });
    await writeFile(
      `${process.env.ROKA_LOADING_OUTPUT}/measurements.json`,
      JSON.stringify(measurements, null, 2),
    );
  }
  console.log(JSON.stringify(measurements, null, 2));
  console.log('Replay loading Chromium regression passed (1440/390).');
} finally {
  await browser.close();
}
