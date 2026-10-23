/** Isolate Canvas composition from WebGL and audio-clock scheduling.
 * ROKA_PLAYWRIGHT_MODULE=/path/to/playwright ROKA_INTRO_BASE=http://localhost:23333 node scripts/intro/benchmark-intro-canvas.mjs
 * Uses a still Canvas as the scene source; creates no video or frame sequence.
 */
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
try {
  // Read current source during development, including before sidecars are rebuilt.
  await page.setExtraHTTPHeaders({ 'Accept-Encoding': 'identity' });
  await page.goto((process.env.ROKA_INTRO_BASE || 'http://127.0.0.1:23333') + '/about');
  const report = await page.evaluate(async () => {
    const manifest = await (await fetch('/intro/assets/manifest.json')).json();
    const [plan, replays] = await Promise.all(
      ['plan.json', 'replays.json'].map((key) => fetch(manifest.files[key]).then((r) => r.json())),
    );
    const assets = {};
    await Promise.all(
      Object.entries(manifest.images).map(async ([key, url]) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        assets[key] = image;
      }),
    );
    for (const [key, url] of Object.entries(manifest.fonts)) {
      const family = {
        serif: 'RokaIntroSerif',
        cn: 'RokaIntroCN',
        latin: 'RokaIntroLatin',
        sans: 'RokaIntroSans',
        quicksand: 'Quicksand',
      }[key];
      const font = new FontFace(family, `url(${url})`, {
        weight: ['serif', 'cn', 'quicksand'].includes(key) ? '700' : '400',
      });
      await font.load();
      document.fonts.add(font);
    }
    const { createDirector } = await import('/intro/director.js?canvas-benchmark');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const mock = document.createElement('canvas');
    mock.width = 1600;
    mock.height = 900;
    mock.getContext('2d', { willReadFrequently: true }).fillRect(0, 0, 1600, 900);
    const start = performance.now(),
      director = createDirector(canvas, { plan, replays, assets, scene: { renderAt: () => mock } });
    const result = {
      initMs: performance.now() - start,
      clock: 'performance.now; no AudioContext or WebGL',
      sections: {},
    };
    for (const [name, time] of [
      ['native', 62],
      ['sixteen', 79],
      ['comparison', 90],
    ]) {
      const samples = [];
      for (let k = 0; k < 31; k++) {
        const begin = performance.now();
        director.renderAt(time + k / 30);
        const submitMs = performance.now() - begin;
        // Explicit readback includes pending Canvas raster work in the measurement.
        canvas.getContext('2d').getImageData(0, 0, 1, 1);
        samples.push({ submitMs, flushedMs: performance.now() - begin });
      }
      const hot = samples
        .slice(1)
        .map((s) => s.flushedMs)
        .sort((a, b) => a - b);
      result.sections[name] = {
        cold: samples[0],
        hotMeanMs: hot.reduce((a, b) => a + b, 0) / hot.length,
        hotP95Ms: hot[Math.floor(hot.length * 0.95)],
        maxMs: Math.max(...samples.map((s) => s.flushedMs)),
      };
    }
    director.dispose();
    return result;
  });
  await fs.writeFile('/tmp/roka-intro-canvas-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
