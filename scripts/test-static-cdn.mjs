import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { StaticAssetDelivery } from '../dist/server/static-assets.js';

const root = process.cwd();
const commit = '0123456789abcdef0123456789abcdef01234567';
const prefix = `/gh/oimasterkafuu/Roka@${commit}/static/`;
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const artifact = path.join(root, 'static', `.cdn-build-test-${process.pid}.gz`);
try {
  await writeFile(artifact, 'generated build artifact');
  const production = new StaticAssetDelivery(version, root, {});
  assert(production.enabled, 'generated/untracked build artifacts must not disable production CDN');
  assert.match(production.commit, /^[a-f0-9]{40}$/);
} finally {
  await rm(artifact, { force: true });
}
const disabled = new StaticAssetDelivery(version, root, { ROKA_STATIC_CDN: '0' });
assert.equal(disabled.html('<head></head>'), '<head></head>');
assert.throws(() => new StaticAssetDelivery(version, root, { ROKA_STATIC_COMMIT: 'main' }));
assert.throws(
  () =>
    new StaticAssetDelivery(version, root, {
      ROKA_STATIC_COMMIT: commit,
      ROKA_STATIC_CDN_ORIGINS: 'http://example.org',
    }),
);
const delivery = new StaticAssetDelivery(version, root, { ROKA_STATIC_COMMIT: commit });
assert.equal(delivery.url('/api/users.json'), '/api/users.json');
assert.equal(delivery.url('/socket.io/socket.io.js'), '/socket.io/socket.io.js');
assert.equal(delivery.url('/../package.json'), '/../package.json');
assert.equal(delivery.url('/about'), '/about');
assert.equal(delivery.url('/crown.png'), delivery.bases[0] + 'crown.png');
const workerImports = [];
vm.runInNewContext(delivery.worker(''), {
  importScripts(url) {
    workerImports.push(url);
    if (url.startsWith('https:')) throw new Error('offline');
  },
});
assert.equal(workerImports.at(-1), '/sw.js?source=1');
assert(workerImports.slice(0, -1).every((url) => url.includes(`@${commit}/static/sw.js`)));
const html = delivery.html(
  '<head></head><img src="/crown.png" srcset="/city.png 1x, /mountain.png 2x"><script src="/notify.js"></script><a href="/api/version">API</a>',
);
assert.match(html, /sha384-/);
assert.match(html, /rel="preload" as="script"/);
assert.match(html, /crossorigin="anonymous"/);
assert(html.includes(`${delivery.bases[0]}mountain.png 2x`));
assert(html.includes('href="/api/version"'));
assert(!html.includes('<script src="/notify.js"'));

const requests = [];
const servers = [];
const mime = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.gltf': 'model/gltf+json',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
};
async function provider(fail) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ fail, path: url.pathname });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (fail || !url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const file = path.resolve(root, 'static', url.pathname.slice(prefix.length));
    if (!file.startsWith(path.join(root, 'static') + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const data = await mkdtemp(path.join(os.tmpdir(), 'roka-static-cdn-'));
let child;
let browser;
try {
  const first = await provider(true),
    second = await provider(false),
    port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { UserStore } = await import('../dist/auth-store.js');
  const { ensureRuntimeEnv } = await import('../dist/runtime-env.js');
  const require = createRequire(import.meta.url);
  const store = new UserStore(data);
  await store.ensureReady();
  await store.register('cdn_tester', 'cdn-browser-pass-1');
  const sid = await store.rotateSession('cdn_tester');
  const token = require('jsonwebtoken').sign({ sub: 'cdn_tester', sid }, ensureRuntimeEnv().jwtSecret, {
    expiresIn: '1h',
  });
  child = spawn(process.execPath, ['dist/server.js', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ROKA_DATA_DIR: data,
      ROKA_STATIC_COMMIT: commit,
      ROKA_STATIC_CDN_ORIGINS: `${first},${second}`,
    },
  });
  let logs = '';
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs || 'Server exited');
    try {
      ready = (await fetch(base + '/api/version')).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, 'server ready');
  for (const page of ['/', '/about', '/login', '/login.html', '/updating.html']) {
    const response = await fetch(base + page),
      body = await response.text();
    assert.equal(response.status, 200, page);
    assert(body.includes(`@${commit}/static/`), page);
    assert(body.includes('window.ROKA_ASSETS.enqueue'), page);
    assert(!body.includes('{{V}}'), page);
    for (const match of body.matchAll(/https?:\/\/[^\s"'<>]+/gi))
      assert.notEqual(new URL(match[0]).hostname, 'cdnjs.cloudflare.com', page);
    if (page === '/') {
      const etag = response.headers.get('etag');
      assert.equal((await fetch(base + page, { headers: { 'If-None-Match': etag } })).status, 304);
    }
  }
  const wrapper = await (await fetch(base + `/sw.js?v=${version}`)).text();
  assert(wrapper.includes(first + prefix + 'sw.js'));
  const core = await (await fetch(base + '/sw.js?source=1')).text();
  assert(!core.includes('importScripts'));
  assert(core.includes("self.addEventListener('fetch'"));
  const css = await readFile('static/main.css', 'utf8');
  assert(!css.includes('{{V}}'));
  const imports = [...css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)/g)];
  assert.equal(imports.length, 6);
  for (const [, relative] of imports) {
    assert(!relative.startsWith('/'));
    const url = new URL(relative, second + prefix + 'main.css');
    assert(url.pathname.startsWith(prefix));
    assert.equal((await fetch(url)).status, 200);
  }
  const fonts = await readFile('static/styles/base.css', 'utf8');
  assert(!fonts.includes('https://'));
  assert.match(fonts, /url\(['"]\.\.\/HYMaQi/);

  if (process.env.ROKA_PLAYWRIGHT_MODULE) {
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('roka_intro_offered_v1', '1'));
    const page = await context.newPage(),
      errors = [],
      network = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => network.push(request.url()));
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.ROKA_ASSETS.ready);
    assert.equal(await page.evaluate(() => typeof window.jQuery), 'function');
    assert.equal(await page.evaluate(() => typeof window.io), 'function');
    assert(network.some((url) => url.startsWith(base + '/api/')));
    const originStatic = network.filter(
      (url) =>
        url.startsWith(base + '/') &&
        /\.(?:js|css|png|otf|woff2?)(?:\?|$)/.test(url) &&
        !url.startsWith(base + '/sw.js?'),
    );
    assert.deepEqual(originStatic, [], 'healthy secondary serves all static requests');
    const workerUrl = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active.scriptURL;
    });
    assert.equal(workerUrl, base + `/sw.js?v=${version}`);
    await page.goto(base + '/about', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.ROKA_ASSETS.ready);
    assert.equal(await page.locator('[data-intro-replay]').count(), 1);
    await context.addCookies([{ name: 'auth_token', value: token, url: base }]);
    await page.goto(base + '/games/cdn-test', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.ROKA_ASSETS.ready);
    assert(await page.locator('meta[name="roka-session-stamp"]').getAttribute('content'));
    assert.equal(await page.evaluate(() => typeof htmlescape), 'function');
    assert(network.some((url) => url.startsWith(second + prefix + 'main.js?')));
    assert(network.some((url) => url.startsWith(base + '/socket.io/')));
    assert.deepEqual(errors, [], 'actual home/about execute without JS errors');
    assert(requests.filter((request) => !request.fail).length > 10);
    assert(requests.every((request) => request.path.startsWith(prefix)));
    await context.close();
  }
  console.log(
    'Static CDN server integration passed: pinned HTML/CSS/fonts, origin APIs, SRI queue, worker fallback' +
      (browser ? ', real home/about browser.' : '.'),
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(data, { recursive: true, force: true });
}
