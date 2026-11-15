import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = {
  'replays.html': ['app', 'replay-query', 'replays-heading', 'replays-body', 'replays-pagination'],
  'ambassadors.html': ['app', 'ambassador-grid', 'ambassadors-status', 'ambassador-invite-link'],
  'about.html': ['app', 'contributors-grid', 'contributors-title'],
  'login.html': ['auth-username', 'auth-password', 'auth-captcha', 'captcha-image', 'login-btn'],
};
const sharedHeaderIds = ['site-account-name', 'site-login', 'site-logout'];

function build() {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: rootDir, stdio: 'pipe' });
}

function snapshots() {
  return Object.fromEntries(
    Object.keys(pages).map((name) => {
      const html = readFileSync(path.join(rootDir, 'static', name), 'utf8');
      return [name, createHash('sha256').update(html).digest('hex')];
    }),
  );
}

build();
const first = snapshots();
build();
assert.deepEqual(snapshots(), first, 'two consecutive page builds must be byte-identical');

const normalizedHeaders = [];
for (const [name, ids] of Object.entries(pages)) {
  const html = readFileSync(path.join(rootDir, 'static', name), 'utf8');
  assert.match(html, /^<!doctype html>/);
  for (const id of [...ids, ...sharedHeaderIds]) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `${name}: #${id}`);
  }
  for (const asset of [
    '/icons/favicon.ico?v={{V}}',
    '/icons/icon-32.png?v={{V}}',
    '/icons/icon-192.png?v={{V}}',
    '/icons/icon-180.png?v={{V}}',
    '/main.css?v={{V}}',
    '/styles/site-header.css?v={{V}}',
    '/username.js?v={{V}}',
    '/site-header.js?v={{V}}',
  ]) {
    assert.ok(html.includes(asset), `${name}: ${asset}`);
  }
  assert.equal((html.match(/<header\b/g) || []).length, 1, `${name}: only the shared header`);
  const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0];
  assert.ok(header, `${name}: shared site header`);
  assert.ok(header.includes('class="brand-name">Roka</span>'), `${name}: Roka brand`);
  for (const [href, label] of [
    ['/', '首页'],
    ['/replays', '回放'],
    ['/about', '关于'],
  ]) {
    assert.ok(header.includes(`href="${href}"`), `${name}: ${label} navigation`);
  }
  normalizedHeaders.push(header.replace(/ aria-current="page"/g, '').replace(/\s+/g, ''));
}
for (const header of normalizedHeaders) {
  assert.equal(header, normalizedHeaders[0], 'all four pages must render the same shared header structure');
}

const replays = readFileSync(path.join(rootDir, 'static/replays.html'), 'utf8');
assert.ok(replays.includes('/vendor/socket.io/socket.io-4.0.1.js?v={{V}}'));
assert.ok(replays.includes('/replays.js?v={{V}}'));
assert.ok(!replays.includes('class="home-topbar"'), 'replays must not render its former private header');
assert.ok(!replays.includes('返回首页'), 'replays must not render a separate home link');
const ambassadors = readFileSync(path.join(rootDir, 'static/ambassadors.html'), 'utf8');
assert.ok(ambassadors.includes('/styles/rating.css?v={{V}}'));
const about = readFileSync(path.join(rootDir, 'static/about.html'), 'utf8');
assert.ok(!about.includes('id="account-name"'), 'about must not render its former account component');
assert.ok(!about.includes('id="login-btn"'), 'about must not render its former fixed login link');
assert.ok(!about.includes('position: fixed; top: 12px; right: 12px'));

async function runAccountState(authenticated) {
  const calls = [];
  const colorRequests = [];
  const renderedNames = [];
  const elements = {};
  function element(id) {
    const el = {
      id,
      hidden: id !== 'site-login',
      disabled: false,
      listeners: {},
      addEventListener(event, handler) {
        this.listeners[event] = handler;
      },
      replaceWith(replacement) {
        elements[this.id] = replacement;
      },
    };
    elements[id] = el;
    return el;
  }
  for (const id of sharedHeaderIds) element(id);
  const location = { href: '' };
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || null },
    location,
    fetch(url, options) {
      calls.push({ url, options });
      if (url === '/api/auth/me') {
        return Promise.resolve(
          authenticated
            ? { ok: true, json: async () => ({ username: 'Alice' }) }
            : { ok: false, json: async () => ({}) },
        );
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
    usernameLink(username, info, extraClass) {
      renderedNames.push({ username, info, extraClass });
      return [{ id: '', hidden: true }];
    },
    usernameEnsureColors(names) {
      colorRequests.push(names);
      return Promise.resolve();
    },
  });
  vm.runInContext(readFileSync(path.join(rootDir, 'static/site-header.js'), 'utf8'), context);
  await context.siteHeaderReady;
  return { calls, colorRequests, renderedNames, elements, location };
}

const guest = await runAccountState(false);
assert.equal(guest.calls[0].url, '/api/auth/me');
assert.equal(guest.calls[0].options.cache, 'no-store');
assert.equal(guest.elements['site-login'].hidden, false);
assert.equal(guest.elements['site-account-name'].hidden, true);
assert.equal(guest.elements['site-logout'].hidden, true);
assert.equal(guest.renderedNames.length, 0);

const user = await runAccountState(true);
assert.deepEqual(user.renderedNames, [
  { username: 'Alice', info: null, extraClass: 'site-account-name' },
]);
assert.deepEqual(user.colorRequests.map((names) => Array.from(names)), [['Alice']]);
assert.equal(user.elements['site-account-name'].id, 'site-account-name');
assert.equal(user.elements['site-account-name'].hidden, false);
assert.equal(user.elements['site-login'].hidden, true);
assert.equal(user.elements['site-logout'].hidden, false);
await user.elements['site-logout'].listeners.click();
assert.equal(user.calls[1].url, '/api/auth/logout');
assert.equal(user.calls[1].options.method, 'POST');
assert.equal(user.location.href, '/login');

console.log('PASS build-pages: shared header on four pages, no private headers, versioned assets, idempotent output');
console.log('PASS site-header account: guest login, component-rendered user with color refresh, POST logout');
