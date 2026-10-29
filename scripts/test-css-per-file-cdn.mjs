import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
const requests = [];
const servers = [];
let config;
async function serve(fail) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ fail, path: url.pathname, search: url.search });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (fail) {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<head><script>window.ROKA_ASSET_CONFIG=${JSON.stringify(config)}</script><script>${runtime}</script><script>ROKA_ASSETS.stylesheet('/entry.css?v=2.1.0');</script></head><body><div id="test">font</div></body>`,
      );
      return;
    }
    const match = /@([a-f0-9]{40})\/static(\/.*)/.exec(url.pathname);
    assert(match);
    assert.equal(match[1], commits[match[2]]);
    const name = match[2];
    if (name === '/entry.css' || name === '/nested.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(
        name === '/entry.css'
          ? '@import "nested.css"; #test{color:rgb(10, 20, 30)}'
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(second, { waitUntil: 'networkidle' });
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
