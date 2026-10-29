// Browser runtime checks are independent of the app server and CDN availability.
// Provide Playwright separately, or set ROKA_PLAYWRIGHT_MODULE to its module path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const runtime = await fs.readFile(new URL('../static/asset-runtime.js', import.meta.url), 'utf8');
const commit = '0123456789abcdef0123456789abcdef01234567';
const version = '1.2.3';
const prefix = '/repo@' + commit + '/static/';
const requests = [];
const servers = [];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhGQAAAAASUVORK5CYII=',
  'base64',
);
const integrityCode =
  "window.scriptOrder.push('integrity');window.integrityRuns=(window.integrityRuns||0)+1;";
const integrity = 'sha384-' + createHash('sha384').update(integrityCode).digest('base64');
const implicitCorsCode =
  "window.scriptOrder.push('implicit-cors');window.implicitCors=document.currentScript.crossOrigin;";
const implicitCorsIntegrity = 'sha384-' + createHash('sha384').update(implicitCorsCode).digest('base64');
const externalCode = `window.scriptOrder.push('external');window.externalRuns=(window.externalRuns||0)+1;
window.scriptAttrs={version:document.currentScript.dataset.version,crossorigin:document.currentScript.getAttribute('crossorigin'),referrer:document.currentScript.referrerPolicy};
window.domWasReady=!!document.getElementById('dom-target')&&document.readyState!=='loading';`;
const assets = {
  'external.js': ['application/javascript', externalCode],
  'tail.js': ['application/javascript', "window.scriptOrder.push('tail');"],
  'defer.js': ['application/javascript', "window.scriptOrder.push('defer');"],
  'module.js': ['application/javascript', "window.scriptOrder.push('module');export const ready=true;"],
  'integrity.js': ['application/javascript', integrityCode],
  'implicit-cors.js': ['application/javascript', implicitCorsCode],
  'style.css': ['text/css', '#dom-target { color: rgb(18, 171, 52); }'],
  'data.json': ['application/json', JSON.stringify({ commit })],
  'dynamic.js': [
    'application/javascript',
    `window.dynamicRuns=(window.dynamicRuns||0)+1;export const commit='${commit}';`,
  ],
  'broken.js': [
    'application/javascript',
    "window.brokenRuns=(window.brokenRuns||0)+1;throw new Error('Module execution failed');",
  ],
  'nomodule.js': ['application/javascript', 'window.nomoduleExecuted=true;'],
  'origin-only.json': ['application/json', JSON.stringify({ origin: true, commit })],
  'origin-only.js': ['application/javascript', 'window.originOnlyRuns=(window.originOnlyRuns||0)+1;'],
};

async function serverFor(provider) {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const parsed = new URL(request.url, 'http://localhost');
    requests.push({ provider, path: parsed.pathname, query: parsed.search });
    const name = parsed.pathname.startsWith(prefix)
      ? parsed.pathname.slice(prefix.length)
      : parsed.pathname.slice(1);
    if (provider === 'first' && name === 'slow.json') return;
    if (provider === 'first' && name === 'stream.bin') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('partial');
      return;
    }
    if (provider === 'first' && name === 'integrity.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('window.tamperedScriptExecuted=true;');
      return;
    }
    if (provider === 'first' || (provider === 'second' && name.startsWith('origin-only'))) {
      response.writeHead(404);
      response.end('Unavailable on this provider');
      return;
    }
    if (provider === 'origin' && parsed.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(pageHtml());
      return;
    }
    if (provider === 'origin' && name === 'api/test') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"api":true}');
      return;
    }
    if (name.endsWith('.png') && name !== 'api/pixel.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(png);
      return;
    }
    const asset = assets[name];
    if (!asset) {
      response.writeHead(404);
      response.end('Missing');
      return;
    }
    response.setHeader('Content-Type', asset[0]);
    response.end(asset[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}
const first = await serverFor('first');
const second = await serverFor('second');
const origin = await serverFor('origin');
const bases = [first + prefix, second + prefix, origin + '/'];

function pageHtml() {
  const config = { bases, version, commit };
  return `<!doctype html><html><head><script>window.ROKA_ASSET_CONFIG=${JSON.stringify(config)};window.scriptOrder=[];</script>
  <script>${runtime}</script>
  <link id="stylesheet" rel="stylesheet" href="${bases[0]}style.css?v=${version}" crossorigin="anonymous" data-keep="css">
  <script>ROKA_ASSETS.enqueue({src:'/external.js?v=${version}',attrs:{'data-version':'${version}',crossorigin:'anonymous',referrerpolicy:'no-referrer'}});</script>
  <script>ROKA_ASSETS.enqueue({src:'/defer.js?v=${version}',attrs:{defer:''}});</script>
  <script>ROKA_ASSETS.enqueue({attrs:{}},"var sharedGlobal='global';window.scriptOrder.push('inline-head');");</script>
  <script>ROKA_ASSETS.enqueue({src:'/integrity.js',attrs:{crossorigin:'anonymous'},integrity:'${integrity}'});</script>
  <script>ROKA_ASSETS.enqueue({src:'/implicit-cors.js',integrity:'${implicitCorsIntegrity}'});</script>
  <script>ROKA_ASSETS.enqueue({src:'/module.js',attrs:{type:'module',defer:true,crossorigin:'anonymous'}});</script>
  </head><body><div id="dom-target">DOM exists before any queued script</div>
  <img id="image" src="${bases[0]}small.png?v=${version}" srcset="${bases[0]}small.png?v=${version} 1x, ${bases[0]}large.png?v=${version} 2x" alt="Keep image metadata" decoding="async" width="20" data-keep="image">
  <picture><source id="picture-source" media="(min-width: 1px)" srcset="${bases[0]}picture.png 1x, ${bases[0]}picture-large.png 2x"><img id="picture" src="${bases[0]}fallback.png" alt="Picture"></picture>
  <img id="api-image" src="/api/pixel.png" alt="API must not be retried">
  <a id="navigation" href="/about">About</a>
  <script>ROKA_ASSETS.enqueue({src:'/nomodule.js',attrs:{nomodule:true}});ROKA_ASSETS.enqueue({src:'/tail.js'});ROKA_ASSETS.enqueue({src:'${bases[0]}external.js?v=${version}',attrs:{'data-version':'${version}',crossorigin:'anonymous',referrerpolicy:'no-referrer'}});</script>
  <script>ROKA_ASSETS.enqueue({attrs:{}},"window.scriptOrder.push('inline-body:'+sharedGlobal);window.inlineBodySawDom=!!document.getElementById('dom-target');");</script>
  </body></html>`;
}

// Exercise the actual 8-second abort branch without an 8-second test delay.
async function checkTimeout() {
  const calls = [];
  let expire;
  const sandbox = {
    URL,
    Map,
    WeakMap,
    Promise,
    AbortController,
    AbortSignal,
    DOMException,
    setTimeout(callback, delay) {
      assert.equal(delay, 8000);
      expire = callback;
      return 1;
    },
    clearTimeout() {},
    document: { readyState: 'complete', addEventListener() {} },
    window: {
      location: { origin },
      ROKA_ASSET_CONFIG: { bases, version, commit },
      fetch(url, options) {
        calls.push(url);
        if (calls.length === 1)
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
          });
        return Promise.resolve({ ok: true, status: 200 });
      },
    },
  };
  vm.runInNewContext(runtime, sandbox);
  const pending = sandbox.window.ROKA_ASSETS.fetch('/timeout.json?v=1');
  expire();
  await pending;
  assert.deepEqual(calls, [bases[0] + 'timeout.json', bases[1] + 'timeout.json']);
}

let browser;
try {
  await checkTimeout();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => ROKA_ASSETS.ready);
  assert.deepEqual(await page.evaluate(() => window.scriptOrder), [
    'external',
    'inline-head',
    'integrity',
    'implicit-cors',
    'tail',
    'inline-body:global',
    'defer',
    'module',
  ]);
  assert.equal(await page.evaluate(() => window.domWasReady && window.inlineBodySawDom), true);
  assert.equal(
    await page.evaluate(() => window.sharedGlobal),
    'global',
    'inline declarations execute globally',
  );
  assert.equal(
    await page.evaluate(() => window.externalRuns),
    1,
    'duplicate descriptors never execute twice',
  );
  assert.equal(await page.evaluate(() => window.integrityRuns), 1);
  assert.equal(
    await page.evaluate(() => window.implicitCors),
    'anonymous',
    'SRI scripts default to anonymous CORS without explicit attrs',
  );
  assert.equal(
    requests.filter((request) => request.provider === 'origin' && request.path === '/implicit-cors.js')
      .length,
    0,
    'healthy secondary serves SRI scripts without origin fallback',
  );
  assert.equal(
    await page.evaluate(() => !!window.nomoduleExecuted),
    false,
    'nomodule is skipped without blocking the queue',
  );
  assert.equal(
    await page.evaluate(() => !!window.tamperedScriptExecuted),
    false,
    'SRI is preserved on every provider',
  );
  assert.deepEqual(await page.evaluate(() => window.scriptAttrs), {
    version,
    crossorigin: 'anonymous',
    referrer: 'no-referrer',
  });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('dom-target')).color === 'rgb(18, 171, 52)',
  );
  assert.equal(await page.locator('#stylesheet').getAttribute('data-keep'), 'css');
  assert.ok((await page.locator('#stylesheet').getAttribute('href')).startsWith(bases[1]));
  for (const id of ['image', 'picture']) {
    await page.waitForFunction((name) => {
      const node = document.getElementById(name);
      return node.complete && node.naturalWidth > 0;
    }, id);
    assert.ok((await page.locator('#' + id).evaluate((node) => node.currentSrc)).startsWith(bases[1]));
  }
  assert.equal(await page.locator('#image').getAttribute('alt'), 'Keep image metadata');
  assert.equal(await page.locator('#image').getAttribute('decoding'), 'async');
  assert.equal(await page.locator('#image').getAttribute('width'), '20');
  for (const id of ['image', 'picture-source']) {
    const srcset = await page.locator('#' + id).getAttribute('srcset');
    assert.ok(
      srcset.includes(bases[1]) && !srcset.includes(bases[0]),
      'responsive image candidates use fallback provider',
    );
    assert.match(srcset, / 1x, .* 2x$/);
  }
  assert.equal(await page.locator('#navigation').getAttribute('href'), '/about');
  assert.equal(await page.locator('#api-image').getAttribute('src'), '/api/pixel.png');
  assert.deepEqual(
    await page.evaluate(() => ROKA_ASSETS.fetch('/api/test').then((response) => response.json())),
    { api: true },
  );
  const result = await page.evaluate(async () => {
    const regular = await ROKA_ASSETS.fetch('/data.json?v=1').then((response) => response.json());
    const final = await ROKA_ASSETS.fetch('/origin-only.json?v=1').then((response) => response.json());
    const [one, two] = await Promise.all([
      ROKA_ASSETS.import('/dynamic.js?v=1'),
      ROKA_ASSETS.import('/dynamic.js?v=1'),
    ]);
    return { regular, final, moduleCommit: one.commit, sameModule: one === two, runs: window.dynamicRuns };
  });
  assert.deepEqual(result, {
    regular: { commit },
    final: { origin: true, commit },
    moduleCommit: commit,
    sameModule: true,
    runs: 1,
  });
  assert.equal(
    await page.evaluate(async () => {
      try {
        await ROKA_ASSETS.import('/broken.js');
        return 'unexpected';
      } catch (error) {
        return error.message;
      }
    }),
    'Module execution failed',
  );
  assert.equal(
    await page.evaluate(() => window.brokenRuns),
    1,
    'module evaluation errors never rerun side effects on another provider',
  );
  const canceled = await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = ROKA_ASSETS.fetch('/slow.json', { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    try {
      await pending;
      return 'unexpected';
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(canceled, 'AbortError');
  assert.deepEqual(
    requests.filter((request) => request.path.endsWith('/slow.json')).map((request) => request.provider),
    ['first'],
  );
  const canceledBody = await page.evaluate(async () => {
    const controller = new AbortController();
    const response = await ROKA_ASSETS.fetch('/stream.bin', { signal: controller.signal });
    const pending = response.text();
    controller.abort();
    try {
      await pending;
      return 'unexpected';
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(canceledBody, 'AbortError', 'caller cancellation stays linked after response headers');
  const beforeCanceled = requests.length;
  assert.equal(
    await page.evaluate(async () => {
      const controller = new AbortController();
      controller.abort();
      try {
        await ROKA_ASSETS.fetch('/never.json', { signal: controller.signal });
      } catch (error) {
        return error.name;
      }
    }),
    'AbortError',
  );
  assert.equal(requests.length, beforeCanceled, 'already canceled fetch never touches providers');
  await page.evaluate(async () => {
    await ROKA_ASSETS.enqueue({ src: '/origin-only.js' });
    await ROKA_ASSETS.ready;
  });
  assert.equal(await page.evaluate(() => window.originOnlyRuns), 1);
  assert.deepEqual(
    requests
      .filter((request) => request.path.endsWith('/origin-only.json'))
      .map((request) => request.provider),
    ['first', 'second', 'origin'],
  );
  assert.equal(
    requests.filter((request) => request.provider === 'origin' && request.path === '/data.json').length,
    0,
    'origin is not used when a CDN succeeds',
  );
  assert.equal(
    requests.filter((request) => request.provider !== 'origin' && request.path.includes('/api/')).length,
    0,
  );
  assert.ok(
    requests
      .filter((request) => request.provider !== 'origin')
      .every((request) => request.path.startsWith(prefix)),
    'every provider uses the identical pinned commit/static prefix',
  );
  assert.equal(
    requests.filter((request) => request.provider === 'second' && request.path.endsWith('/external.js'))
      .length,
    1,
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    'cdn runtime: pinned failover, script order/SRI/dedup, CSS/images, import, timeout, cancellation and origin-last fallback passed',
  );
} finally {
  if (browser) await browser.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
