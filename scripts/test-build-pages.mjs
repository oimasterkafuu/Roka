import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = {
  'about.html': ['app', 'contributors-grid', 'contributors-title'],
  'admin.html': [
    'back-home-btn',
    'account-name',
    'user-search',
    'users-body',
    'users-pagination',
    'chat-audit',
    'bots-card',
    'ban-dialog-mask',
  ],
  'ambassadors.html': ['app', 'ambassador-grid', 'ambassadors-status', 'ambassador-invite-link'],
  'develop-bot.html': ['app'],
  'develop.html': ['app'],
  'game.html': [
    'disconnect-banner',
    'deploy-banner',
    'game',
    'map',
    'map_back',
    'menu',
    'teams',
    'ready-counts',
    'status-alert',
    'surrender-alert',
    'replay-loading',
    'replay-error-alert',
    'replay-stats',
    'replay-stats-canvas',
  ],
  'index.html': [
    'online-count',
    'account-name',
    'admin-entry',
    'me-card',
    'rooms-body',
    'replays-body',
    'feed-input',
    'feed-list',
    'announcement-view',
    'announcement-text',
    'announcement-edit',
    'leaderboard-list',
    'recently-online-list',
  ],
  'login.html': ['auth-username', 'auth-password', 'auth-captcha', 'captcha-image', 'login-btn'],
  'profile.html': [
    'back-home-btn',
    'account-name',
    'profile-main',
    'p-name',
    'p-rating',
    'p-rating-rank',
    'rating-chart',
    'feed-list',
    'replays-body',
  ],
  'replays.html': ['app', 'replay-query', 'replays-heading', 'replays-body', 'replays-pagination'],
  'tutorial-text.html': [
    'account-name',
    'login-btn',
    'app',
    'map-example-mode',
    'map-example-region-control',
    'map-example-region',
    'map-example-players',
    'generate-map-example-btn',
    'map-example-status',
    'map-example-single',
    'map-example-title',
    'map-example-meta',
    'map-example-board',
  ],
  'tutorial.html': [
    'game',
    'map',
    'map_back',
    'tutorial-top-left',
    'room-home-btn',
    'tutorial-reset-btn',
    'tutorial-step-banner',
    'tutorial-next-btn',
  ],
  'updating.html': [],
};
const expectedPages = Object.keys(pages).sort();
const sharedHeaderPages = [
  'about.html',
  'ambassadors.html',
  'develop-bot.html',
  'develop.html',
  'login.html',
];
const specialPages = ['index.html', 'game.html', 'tutorial.html', 'tutorial-text.html', 'replays.html'];
const sharedHeaderIds = ['site-account-name', 'site-login', 'site-logout'];
const faviconAssets = [
  '/icons/favicon.ico?v={{V}}',
  '/icons/icon-32.png?v={{V}}',
  '/icons/icon-192.png?v={{V}}',
  '/icons/icon-180.png?v={{V}}',
];

function build() {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: rootDir, stdio: 'pipe' });
}

function htmlFor(name) {
  return readFileSync(path.join(rootDir, 'static', name), 'utf8');
}

function snapshots() {
  return Object.fromEntries(
    expectedPages.map((name) => [name, createHash('sha256').update(htmlFor(name)).digest('hex')]),
  );
}

function assertScriptOrder(name, html, assets) {
  const positions = assets.map((asset) => html.indexOf(`src="${asset}"`));
  for (let index = 0; index < assets.length; index += 1) {
    assert.notEqual(positions[index], -1, `${name}: ${assets[index]}`);
    if (index > 0) {
      assert.ok(positions[index] > positions[index - 1], `${name}: script order at ${assets[index]}`);
    }
  }
}

function assertNoSharedHeader(name, html) {
  assert.ok(!/<header\b[^>]*class="site-header"/.test(html), `${name}: no shared site header`);
  for (const id of sharedHeaderIds) {
    assert.ok(!new RegExp(`\\bid="${id}"`).test(html), `${name}: no #${id}`);
  }
  for (const asset of ['/styles/site-header.css?v={{V}}', '/site-header.js?v={{V}}']) {
    assert.ok(!html.includes(asset), `${name}: must not load ${asset}`);
  }
}

const staticPages = readdirSync(path.join(rootDir, 'static'))
  .filter((name) => name.endsWith('.html'))
  .sort();
const templates = readdirSync(path.join(rootDir, 'views'))
  .filter((name) => name.endsWith('.pug') && name !== 'layout.pug')
  .sort();
assert.deepEqual(staticPages, expectedPages, 'all and only the 13 expected static HTML pages');
assert.deepEqual(
  templates,
  expectedPages.map((name) => name.replace(/\.html$/, '.pug')),
  'every static HTML page must have a same-named Pug template',
);

build();
const first = snapshots();
build();
assert.deepEqual(snapshots(), first, 'two consecutive page builds must be byte-identical');

const normalizedHeaders = [];
for (const name of expectedPages) {
  const html = htmlFor(name);
  for (const id of pages[name]) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `${name}: #${id}`);
  }
  for (const asset of faviconAssets) {
    assert.ok(html.includes(asset), `${name}: ${asset}`);
  }

  if (sharedHeaderPages.includes(name)) {
    assert.match(html, /^<!doctype html>/, `${name}: standards mode`);
    for (const id of sharedHeaderIds) {
      assert.match(html, new RegExp(`\\bid="${id}"`), `${name}: #${id}`);
    }
    for (const asset of [
      '/main.css?v={{V}}',
      '/styles/site-header.css?v={{V}}',
      '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
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
  } else {
    assertNoSharedHeader(name, html);
  }

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((source) => source.trim());
  for (const [index, source] of inlineScripts.entries()) {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: `${name} inline script ${index + 1}` }),
      `${name}: inline script ${index + 1} must parse`,
    );
  }
}
assert.equal(normalizedHeaders.length, 5, 'exactly five pages use the shared header');
for (const header of normalizedHeaders) {
  assert.equal(header, normalizedHeaders[0], 'all five shared-header pages render the same structure');
}
for (const name of specialPages) {
  assertNoSharedHeader(name, htmlFor(name));
}
for (const name of expectedPages.filter(
  (name) =>
    !sharedHeaderPages.includes(name) &&
    !['replays.html', 'tutorial-text.html', 'updating.html'].includes(name),
)) {
  assert.ok(!htmlFor(name).startsWith('<!doctype html>'), `${name}: preserve quirks mode`);
}
for (const name of ['replays.html', 'tutorial-text.html', 'updating.html']) {
  assert.match(htmlFor(name), /^<!doctype html>/, `${name}: preserve standards mode`);
}

const index = htmlFor('index.html');
assert.ok(index.includes('class="home-topbar"'), 'index: private home topbar');
for (const id of ['online-count', 'account-name', 'login-btn', 'logout-btn', 'admin-entry']) {
  assert.match(index, new RegExp(`\\bid="${id}"`), `index: private control #${id}`);
}
assertScriptOrder('index.html', index, [
  '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
  '/vendor/socket.io/socket.io-4.0.1.js?v={{V}}',
  '/notify.js?v={{V}}',
  '/intro.js?v={{V}}',
  '/sw-register.js?v={{V}}',
  '/username.js?v={{V}}',
  '/mention-autocomplete.js?v={{V}}',
]);

const game = htmlFor('game.html');
assert.match(game, /<meta name="roka-session-stamp" content="" \/>/);
assertScriptOrder('game.html', game, [
  '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
  '/vendor/socket.io/socket.io-4.0.1.js?v={{V}}',
  '/vendor/lodash/lodash-4.17.21.min.js?v={{V}}',
  '/crown.js?v={{V}}',
  '/sw-register.js?v={{V}}',
  '/username.js?v={{V}}',
  '/main/core-globals.js?v={{V}}',
  '/notify.js?v={{V}}',
  '/main/replay-binary.js?v={{V}}',
  '/main/replay-cache.js?v={{V}}',
  '/main/room-controls.js?v={{V}}',
  '/main/replay-controls.js?v={{V}}',
  '/main/replay-stats.js?v={{V}}',
  '/main/render-update.js?v={{V}}',
  '/main/blink-clock.js?v={{V}}',
  '/main.js?v={{V}}',
]);

const tutorial = htmlFor('tutorial.html');
assert.ok(tutorial.includes('class="tutorial-back-link" href="/tutorial"'));
assertScriptOrder('tutorial.html', tutorial, ['/main/blink-clock.js?v={{V}}', '/tutorial.js?v={{V}}']);

const tutorialText = htmlFor('tutorial-text.html');
assert.ok(tutorialText.includes('data-goto="/"'), 'tutorial-text: private home control');
assert.ok(tutorialText.includes('返回首页'), 'tutorial-text: private home label');
assert.ok(tutorialText.includes('position: fixed; top: 12px; left: 12px'));
assert.ok(tutorialText.includes('position: fixed; top: 12px; right: 12px'));
for (const asset of [
  '/styles/docs.css?v={{V}}',
  '/vendor/katex/katex.min.css?v={{V}}',
  '/vendor/katex/katex.min.js?v={{V}}',
  '/vendor/katex/auto-render.min.js?v={{V}}',
  '/docs.js?v={{V}}',
]) {
  assert.ok(tutorialText.includes(asset), `tutorial-text.html: ${asset}`);
}

const replays = htmlFor('replays.html');
assert.ok(replays.includes('class="home-topbar"'), 'replays: private topbar');
assert.ok(replays.includes('返回首页'), 'replays: private home control');
for (const id of ['replay-login', 'replay-upload', 'replay-upload-file', 'replay-upload-view']) {
  assert.match(replays, new RegExp(`\\bid="${id}"`), `replays: account/upload control #${id}`);
}
assertScriptOrder('replays.html', replays, [
  '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
  '/username.js?v={{V}}',
  '/vendor/socket.io/socket.io-4.0.1.js?v={{V}}',
  '/replays.js?v={{V}}',
]);

const profile = htmlFor('profile.html');
assert.ok(profile.includes('class="profile-topbar"'));
assertScriptOrder('profile.html', profile, [
  '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
  '/vendor/socket.io/socket.io-4.0.1.js?v={{V}}',
  '/username.js?v={{V}}',
  '/mention-autocomplete.js?v={{V}}',
  '/profile.js?v={{V}}',
]);
const admin = htmlFor('admin.html');
assert.ok(admin.includes('class="admin-topbar"'));
assertScriptOrder('admin.html', admin, [
  '/vendor/jquery/jquery-3.6.0.min.js?v={{V}}',
  '/username.js?v={{V}}',
  '/admin.js?v={{V}}',
]);

const developBot = htmlFor('develop-bot.html');
for (const text of [
  'Roka 机器人开发协议',
  '1. 快速开始',
  '3. 房间阶段协议',
  '4. 对局阶段协议',
  '9. 常见坑',
  'join_game_room',
  'init_map',
  'lst_moves',
]) {
  assert.ok(developBot.includes(text), `develop-bot.html: ${text}`);
}
for (const asset of [
  '/styles/docs.css?v={{V}}',
  '/vendor/katex/katex.min.css?v={{V}}',
  '/vendor/katex/katex.min.js?v={{V}}',
  '/vendor/katex/auto-render.min.js?v={{V}}',
  '/docs.js?v={{V}}',
]) {
  assert.ok(developBot.includes(asset), `develop-bot.html: ${asset}`);
}
assert.ok(!developBot.includes('id="account-name"'), 'develop-bot: former private account removed');
assert.ok(!developBot.includes('position: fixed; top: 12px; left: 12px'));
assert.ok(!developBot.includes('position: fixed; top: 12px; right: 12px'));
assertScriptOrder('develop-bot.html', developBot, [
  '/vendor/katex/katex.min.js?v={{V}}',
  '/vendor/katex/auto-render.min.js?v={{V}}',
  '/docs.js?v={{V}}',
]);

const ambassadors = htmlFor('ambassadors.html');
assert.ok(ambassadors.includes('/styles/rating.css?v={{V}}'));
const about = htmlFor('about.html');
assert.ok(!about.includes('id="account-name"'), 'about must not render its former account component');
assert.ok(!about.includes('id="login-btn"'), 'about must not render its former fixed login link');
assert.ok(!about.includes('position: fixed; top: 12px; right: 12px'));
assert.ok(!about.includes('Closed-source（闭源，未发布源码）'));
const develop = htmlFor('develop.html');
assert.ok(develop.includes('/styles/docs.css?v={{V}}'));
assert.ok(develop.includes('/docs.js?v={{V}}'));
const updating = htmlFor('updating.html');
assert.ok(updating.includes("fetch('/', { cache: 'no-store' })"));
assert.ok(updating.includes('}, 3000);'), 'updating: 3000ms recovery polling');
assert.ok(!updating.includes('/main.css?v={{V}}'), 'updating remains independent of the site framework');

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
assert.deepEqual(user.renderedNames, [{ username: 'Alice', info: null, extraClass: 'site-account-name' }]);
assert.deepEqual(
  user.colorRequests.map((names) => Array.from(names)),
  [['Alice']],
);
assert.equal(user.elements['site-account-name'].id, 'site-account-name');
assert.equal(user.elements['site-account-name'].hidden, false);
assert.equal(user.elements['site-login'].hidden, true);
assert.equal(user.elements['site-logout'].hidden, false);
await user.elements['site-logout'].listeners.click();
assert.equal(user.calls[1].url, '/api/auth/logout');
assert.equal(user.calls[1].options.method, 'POST');
assert.equal(user.location.href, '/login');

console.log('PASS build-pages: 13 same-named Pug/HTML pages, idempotent output, key DOM and script order');
console.log('PASS headers: shared on five pages; private controls and no shared assets on eight pages');
console.log('PASS inline scripts and site-header account state');
