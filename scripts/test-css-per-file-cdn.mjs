import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const runtime = await fs.readFile('static/asset-runtime.js', 'utf8');
const commits = {
  '/entry.css': 'a'.repeat(40),
  '/nested.css': 'b'.repeat(40),
  '/font.otf': 'c'.repeat(40),
  '/image.png': 'd'.repeat(40),
  '/dynamic.js': 'e'.repeat(40),
  '/data.json': 'f'.repeat(40),
};
const entryCss = '@import "nested.css"; #test{color:rgb(10, 20, 30)}';
const integrity = 'sha384-' + createHash('sha384').update(entryCss).digest('base64');
const requests = [];
const servers = [];
let config;
let slow = false;
let broken = false;
async function serve(fail) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ fail, path: url.pathname, search: url.search });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (fail) {
      if (url.pathname.endsWith('/entry.css')) await new Promise((resolve) => setTimeout(resolve, 600));
      res.writeHead(404).end();
      return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<head><style id="roka-initial-style">body{visibility:hidden!important}html::before{content:"Roka 加载中…"}</style><script>window.ROKA_ASSET_CONFIG=${JSON.stringify(config)}</script><script>${runtime}</script><script>ROKA_ASSETS.stylesheet('/entry.css?v=2.1.0', '${integrity}');</script></head><body><div id="test">font</div></body>`,
      );
      return;
    }
    if (broken) {
      res.writeHead(503).end();
      return;
    }
    const match = /@([a-f0-9]{40})\/static(\/.*)/.exec(url.pathname);
    if (match) assert.equal(match[1], commits[match[2]]);
    const name = match ? match[2] : url.pathname;
    if (slow && match && name === '/nested.css') await new Promise((resolve) => setTimeout(resolve, 6000));
    if (name === '/entry.css' || name === '/nested.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(
        name === '/entry.css'
          ? entryCss
          : '@font-face{font-family:fixture;src:url(font.otf)} #test{font-family:fixture;background-image:url(image.png)}',
      );
    } else if (name === '/font.otf') res.end(await fs.readFile('static/Quicksand-Regular.otf'));
    else if (name === '/image.png') res.end(await fs.readFile('static/crown.png'));
    else if (name === '/dynamic.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('export const value=42');
    } else res.end('{"value":42}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
let browser;
try {
  const first = await serve(true),
    second = await serve(false);
  config = {
    bases: [first, second]
      .map((base) => base + '/gh/oimasterkafuu/Roka@' + 'a'.repeat(40) + '/static/')
      .concat(second + '/'),
    commits,
    commit: 'a'.repeat(40),
  };
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.unstyledFrames = [];
    function sample() {
      const target = document.getElementById('test');
      if (
        target &&
        getComputedStyle(document.body).visibility === 'visible' &&
        getComputedStyle(target).color !== 'rgb(10, 20, 30)'
      )
        window.unstyledFrames.push(performance.now());
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(second, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('body').evaluate((node) => getComputedStyle(node).visibility), 'hidden');
  assert.match(
    await page.locator('html').evaluate((node) => getComputedStyle(node, '::before').content),
    /加载中/,
  );
  await page.evaluate(async () => {
    await ROKA_ASSETS.ready;
    await document.fonts.ready;
  });
  assert.equal(
    await page.locator('#test').evaluate((node) => getComputedStyle(node).color),
    'rgb(10, 20, 30)',
  );
  assert.equal(await page.evaluate(async () => (await ROKA_ASSETS.import('/dynamic.js?v=2.1.0')).value), 42);
  assert.equal(
    await page.evaluate(async () => (await (await ROKA_ASSETS.fetch('/data.json?v=2.1.0')).json()).value),
    42,
  );
  for (const [file, sha] of Object.entries(commits)) {
    const attempts = requests.filter((r) => r.path.endsWith('/static' + file));
    assert.deepEqual(
      attempts.map((r) => r.fail),
      [true, false],
      file,
    );
    assert(attempts.every((r) => r.path.includes('@' + sha + '/') && !r.search));
  }
  assert.equal(await page.locator('body').evaluate((node) => getComputedStyle(node).visibility), 'visible');
  assert.deepEqual(
    await page.evaluate(() => window.unstyledFrames),
    [],
    'no visible unstyled frame while first provider fails',
  );
  slow = true;
  const started = Date.now();
  await page.goto(second, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => ROKA_ASSETS.ready);
  assert(Date.now() - started < 6000, 'slow nested graph falls back without waiting for all CDN assets');
  assert.equal(
    await page.locator('#test').evaluate((node) => getComputedStyle(node).color),
    'rgb(10, 20, 30)',
  );
  assert.equal(await page.locator('body').evaluate((node) => getComputedStyle(node).visibility), 'visible');
  assert(
    requests.some((r) => r.path === '/entry.css' && r.search === '?v=2.1.0'),
    'deadline uses original origin query',
  );
  assert(
    requests.some((r) => r.path === '/nested.css'),
    'native fallback keeps nested CSS on origin',
  );
  assert.deepEqual(
    await page.evaluate(() => window.unstyledFrames),
    [],
    'no visible unstyled frame during origin deadline fallback',
  );
  assert.equal(
    await page.locator('link[rel=stylesheet]').getAttribute('integrity'),
    integrity,
    'origin fallback retains entry SRI',
  );
  broken = true;
  await page.goto(second, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await page.evaluate(() =>
      ROKA_ASSETS.ready.then(
        () => false,
        () => true,
      ),
    ),
    true,
    'total failure remains observable',
  );
  assert.equal(
    await page.locator('#roka-initial-style').count(),
    0,
    'total failure cannot leave a permanent loading curtain',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Browser per-file CSS imports/fonts/images, runtime fetch/import and provider SHA stability passed.',
  );
} finally {
  await browser?.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
