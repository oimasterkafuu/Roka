/** Browser integration/performance probe; never exports video or frame sequences.
 * ROKA_PLAYWRIGHT_MODULE=/path/to/playwright ROKA_INTRO_BASE=http://localhost:23333 node scripts/intro/benchmark-intro.mjs
 */
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const base = process.env.ROKA_INTRO_BASE || 'http://127.0.0.1:23333';
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(base + '/about');
  await page.waitForTimeout(200);
  const initial = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((r) => r.name.includes('/intro/'))
      .map((r) => r.name),
  );
  if (initial.length) throw new Error('Heavy intro resources loaded before consent');
  await page.locator('[data-intro-replay]').click();
  await page.waitForFunction(() => !document.querySelector('.intro-progress')?.disabled, { timeout: 120000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('.intro-progress').evaluate((node) => {
    node.value = '90';
    node.dispatchEvent(new Event('input'));
  });
  await page.screenshot({ path: '/tmp/roka-intro-dialog.png' });
  await page.getByRole('button', { name: '跳过并关闭' }).click();
  if (await page.locator('.intro-stage canvas').count()) throw new Error('Canvas left after close');
  // Separate player instance lets the probe collect counters without publishing global debug hooks.
  const report = await page.evaluate(async () => {
    const firstResources = performance
      .getEntriesByType('resource')
      .filter((r) => r.name.includes('/intro/'))
      .map((r) => ({
        url: r.name.split('/').pop(),
        encoded: r.encodedBodySize,
        decoded: r.decodedBodySize,
        transfer: r.transferSize,
      }));
    document.body.innerHTML = '<div id="probe" style="width:1920px;height:1080px"></div>';
    const module = await import('/intro/player.js?v=benchmark');
    const begin = performance.now(),
      player = await module.createIntroPlayer(document.querySelector('#probe')); // performance clock isolates graphics from headless audio-device starvation
    const loadMs = performance.now() - begin;
    const gl = document.createElement('canvas').getContext('webgl2'),
      debug = gl?.getExtension('WEBGL_debug_renderer_info'),
      gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    const scenes = {};
    for (const [name, t] of [
      ['march', 7],
      ['construction', 24],
      ['ascent', 38],
      ['native', 62],
      ['sixteen', 79],
      ['comparison', 90],
    ]) {
      player.seek(t);
      const before = player.getMetrics().frames,
        start = performance.now();
      await player.play();
      await new Promise((r) => setTimeout(r, 3500));
      player.pause();
      const elapsed = performance.now() - start,
        metrics = player.getMetrics();
      scenes[name] = {
        elapsedMs: elapsed,
        frames: metrics.frames - before,
        fps: (metrics.frames - before) / (elapsed / 1000),
        scene: structuredClone(metrics.scene),
      };
    }
    const metrics = player.getMetrics();
    player.destroy();

    return {
      initialRequests: 0,
      loadMs,
      gpu,
      firstResources,
      coldTransferred: firstResources.reduce((n, r) => n + r.transfer, 0),
      scenes,
      metrics,
      canvasAfterClose: document.querySelectorAll('#probe canvas').length,
    };
  });
  report.errors = errors;
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile('/tmp/roka-intro-performance.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      bytes: report.coldTransferred,
      gpu: report.gpu,
      scenes: Object.fromEntries(
        Object.entries(report.scenes).map(([k, v]) => [
          k,
          { fps: v.fps, calls: v.scene.renderer.calls, triangles: v.scene.renderer.triangles },
        ]),
      ),
    }),
  );
} finally {
  await browser.close();
}
