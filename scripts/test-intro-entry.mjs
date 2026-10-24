// Browser lifecycle checks for the lightweight intro entry. Install Playwright separately,
// or set ROKA_PLAYWRIGHT_MODULE to its absolute module path; no server/data directory needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const root = fileURLToPath(new URL('../', import.meta.url));
const bootstrap = await fs.readFile(root + 'static/intro.js', 'utf8');
const css = await fs.readFile(root + 'static/styles/intro.css', 'utf8');
const siteCss =
  (await fs.readFile(root + 'static/styles/base.css', 'utf8')).split('/* 字体优先')[0] +
  (await fs.readFile(root + 'static/styles/chat-and-alert.css', 'utf8')) +
  (await fs.readFile(root + 'static/styles/home.css', 'utf8'));
for (const name of ['index', 'about']) {
  const html = await fs.readFile(root + 'static/' + name + '.html', 'utf8');
  assert.match(html, /<script defer src="\/intro\.js\?v=\{\{V\}\}" data-version="\{\{V\}\}"><\/script>/);
  assert.match(html, /href="\/styles\/intro\.css\?v=\{\{V\}\}"/);
}
const engine = `
export async function createIntroPlayer(stage, options) {
  const state = window.__introTest;
  state.created++;
  state.logicalSize = [stage.clientWidth, stage.clientHeight];
  state.options = options;
  options.onLoadProgress(0, 35);
  if (state.delayCreate) await new Promise(resolve => setTimeout(resolve, state.delayCreate));
  if (state.failCreate) throw new Error('test renderer failure');
  options.onLoadProgress(35, 35);
  let playRequest = 0;
  const player = {
    duration: 120,
    async play() {
      const request = ++playRequest;
      state.played++;
      if (state.delayPlay) await new Promise(resolve => setTimeout(resolve, state.delayPlay));
      if (request === playRequest) options.onStateChange('playing');
    },
    pause() { playRequest++; state.paused++; options.onStateChange('paused'); },
    resume() { state.resumed++; options.onStateChange('playing'); },
    setMuted(value) { state.muted = value; },
    seek(value) { state.seeked = value; options.onProgress(value, 120); },
    destroy() { playRequest++; state.destroyed++; },
  };
  return player;
}
`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/intro.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(bootstrap);
  } else if (url.pathname === '/site.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(siteCss);
  } else if (url.pathname === '/styles/intro.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(css);
  } else if (url.pathname === '/intro/player.js') {
    response.setHeader('Content-Type', 'application/javascript');
    const rendererDelay = url.searchParams.get('v') === '200' ? 200 : 0;
    setTimeout(() => response.end(engine), rendererDelay);
  } else {
    const home = url.pathname === '/';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html data-intro-home-ready="true"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/site.css">
      <link rel="stylesheet" href="/styles/intro.css?v=test">
      <script>window.__introTest = {created:0,played:0,paused:0,resumed:0,destroyed:0,audio:0,fullscreenRequests:0};
      const nativeFullscreen = Element.prototype.requestFullscreen;
      if (nativeFullscreen) Element.prototype.requestFullscreen = function(options) {
        const state = window.__introTest;
        state.fullscreenRequests++;
        state.fullscreenSnapshot = {created:state.created,audio:state.audio,active:navigator.userActivation.isActive,tag:this.tagName};
        if (state.denyFullscreen) return Promise.reject(new Error('Denied fullscreen'));
        return nativeFullscreen.call(this,options);
      };
      window.AudioContext = class {constructor(){this.state='running';window.__introTest.audio++}
      resume(){return Promise.resolve()} close(){this.state='closed';window.__introTest.audioClosed=true;return Promise.resolve()}};
      </script><script defer src="/intro.js?v=test" data-version="${escapeHtml(url.searchParams.get('delay') || 'test')}"></script>
      </head><body class="${home ? 'home' : ''}">
      <button id="outside">Outside</button><button data-intro-replay>重播游戏介绍片</button>
      ${url.searchParams.has('notify') ? '<div class="notify-permission-backdrop">Notifications</div>' : ''}
      </body></html>`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const runtimeRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/intro/player.js')) runtimeRequests.push(request.url());
  });
  await page.goto(origin + '/?notify');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('dialog').count(), 0, 'notification explanation takes priority');
  assert.equal(runtimeRequests.length, 0, 'no renderer download before consent');
  // The real card markup notify.js injects must keep the teal/white primary
  // button under the later same-specificity `body.home *` cascade of home.css.
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.className = 'notify-permission-backdrop';
    const card = document.createElement('div');
    card.className = 'alert center notify-permission-card';
    const primary = document.createElement('button');
    primary.className = 'small inverted';
    primary.textContent = '开启通知';
    card.appendChild(primary);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
  });
  assert.deepEqual(
    await page.locator('.notify-permission-card button.inverted').evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.color, style.backgroundColor];
    }),
    ['rgb(255, 255, 255)', 'rgb(0, 128, 128)'],
    'notify primary button stays white-on-teal under the body.home cascade',
  );
  await page.evaluate(() => {
    document.querySelectorAll('.notify-permission-backdrop').forEach((node) => node.remove());
  });
  await page.getByRole('heading', { name: '是否观看游戏介绍片' }).waitFor();
  assert.equal(
    await page.locator('.intro-description').evaluate((node) => getComputedStyle(node).color),
    'rgb(37, 48, 66)',
    'home universal color does not override intro text',
  );
  assert.equal(
    await page
      .getByRole('button', { name: '观看介绍片' })
      .evaluate((node) => getComputedStyle(node).outlineStyle),
    'solid',
    'keyboard focus outline survives global button reset',
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('roka_intro_offered_v1')), '1');
  await page.reload();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('dialog').count(), 0, 'dismissed offer stays dismissed');
  assert.equal(runtimeRequests.length, 0, 'dismissal never downloads the renderer');

  await page.goto(origin + '/about');
  await page.evaluate(() => {
    window.__introTest.delayCreate = 200;
  });
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.created === 1);
  assert.equal(await page.locator('.intro-progress').count(), 1);
  assert.equal(await page.locator('input.intro-progress[type="range"]').count(), 1);
  await page.locator('.intro-progress').evaluate((node) => {
    node.dataset.testIdentity = 'shared-loading-playback-range';
  });
  assert.deepEqual(
    await page
      .locator('.intro-progress')
      .evaluate((node) => [node.disabled, node.max, node.value, node.getAttribute('aria-label')]),
    [true, '35', '0', '介绍片加载进度'],
  );
  assert.equal(await page.locator('.intro-time').textContent(), '0%');
  await page.evaluate(() => window.__introTest.options.onLoadProgress(17, 35));
  assert.equal(await page.locator('.intro-progress').inputValue(), '17');
  assert.equal(await page.locator('.intro-time').textContent(), '48%');
  assert.equal(await page.locator('.intro-progress').getAttribute('aria-valuetext'), '素材加载 48%');
  await page.waitForFunction(() => window.__introTest.played === 1);
  assert.equal(await page.locator('.intro-progress').count(), 1, 'loading and playback share one range');
  assert.deepEqual(
    await page
      .locator('.intro-progress')
      .evaluate((node) => [
        node.dataset.testIdentity,
        node.disabled,
        node.max,
        node.value,
        node.getAttribute('aria-label'),
      ]),
    ['shared-loading-playback-range', false, '120', '0', '介绍片播放进度'],
  );
  assert.equal(await page.locator('.intro-time').textContent(), '0:00 / 2:00');
  assert.equal(await page.evaluate(() => window.__introTest.audio), 1);
  assert.deepEqual(await page.evaluate(() => window.__introTest.logicalSize), [1920, 1080]);
  assert.equal(runtimeRequests.length, 1);
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('intro-screen'));
  assert.deepEqual(
    await page.evaluate(() => window.__introTest.fullscreenSnapshot),
    { created: 0, audio: 1, active: true, tag: 'DIV' },
    'watch requests real fullscreen in the original click, before runtime initialization',
  );
  assert.equal(await page.locator('.intro-player .intro-header').count(), 0, 'no playback header/card');
  const playerStyle = await page.locator('.intro-player').evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.paddingTop, style.borderTopWidth, style.borderRadius];
  });
  assert.deepEqual(playerStyle, ['0px', '0px', '0px']);
  await page.waitForFunction(() =>
    document.querySelector('.intro-screen').classList.contains('intro-controls-hidden'),
  );
  await page.locator('.intro-viewport').dispatchEvent('pointerdown', { pointerType: 'touch' });
  assert.equal(await page.locator('.intro-controls-hidden').count(), 0, 'touch restores video controls');
  await page.waitForFunction(() =>
    document.querySelector('.intro-screen').classList.contains('intro-controls-hidden'),
  );
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.intro-controls-hidden').count(), 0, 'keyboard restores video controls');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '继续播放' }).click();
  await page.getByRole('button', { name: '静音', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__introTest.muted), true);
  await page.getByRole('slider').evaluate((node) => {
    node.value = '61';
    node.dispatchEvent(new Event('input'));
  });
  assert.equal(await page.evaluate(() => window.__introTest.seeked), 61);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '继续播放' }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await page.evaluate(() => window.__introTest.options.onEnded());
  await page.getByRole('button', { name: '重新播放' }).click();
  assert.equal(await page.evaluate(() => window.__introTest.played), 2);
  await page.getByRole('button', { name: '跳过并关闭' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '关闭介绍片');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '跳过并关闭');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('dialog').count(), 0, 'Escape closes the fullscreen presentation');
  assert.equal(await page.evaluate(() => window.__introTest.destroyed), 1);
  assert.equal(await page.evaluate(() => window.__introTest.audioClosed), true);
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-intro-replay')), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/about');
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.played === 1);
  const screenSize = await page.locator('.intro-screen').boundingBox();
  assert.deepEqual([screenSize.x, screenSize.y, screenSize.width, screenSize.height], [0, 0, 390, 844]);
  const size = await page.locator('.intro-viewport').boundingBox();
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.01, 'mobile remains 16:9');
  assert.deepEqual(
    await page.locator('.intro-stage').evaluate((node) => [node.clientWidth, node.clientHeight]),
    [1920, 1080],
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__introTest.destroyed), 1);
  assert.equal(await page.evaluate(() => window.__introTest.audioClosed), true);
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-intro-replay')), true);

  await page.goto(origin + '/about?delay=200');
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  assert.equal(
    await page.evaluate(() => window.__introTest.created),
    0,
    'cancelled import never initializes scene',
  );
  assert.equal(await page.evaluate(() => window.__introTest.audioClosed), true);
  await page.waitForFunction(() => !document.fullscreenElement);

  await page.goto(origin + '/about');
  await page.evaluate(() => {
    window.__introTest.delayCreate = 150;
  });
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.created === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => window.__introTest.destroyed),
    1,
    'late scene destroyed after cancellation',
  );
  assert.equal(await page.evaluate(() => window.__introTest.played), 0);

  await page.goto(origin + '/about');
  await page.evaluate(() => {
    window.__introTest.failCreate = true;
  });
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.getByRole('button', { name: '重新加载' }).waitFor();
  await page.evaluate(() => {
    window.__introTest.failCreate = false;
  });
  await page.getByRole('button', { name: '重新加载' }).click();
  await page.waitForFunction(() => window.__introTest.played === 1);
  await page.keyboard.press('Escape');

  await page.goto(origin + '/about');
  await page.evaluate(() => {
    window.__introTest.delayPlay = 150;
  });
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.played === 1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: '继续播放' }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__introTest.paused),
    1,
    'delayed play cannot overwrite a user pause',
  );
  await page.keyboard.press('Escape');

  await page.goto(origin + '/about');
  await page.evaluate(() => {
    window.__introTest.delayPlay = 150;
  });
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.played === 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '继续播放' }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__introTest.paused),
    1,
    'play resolving in background pauses immediately',
  );
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await page.evaluate(() => window.__introTest.options.onStateChange('error'));
  await page.getByRole('button', { name: '重新加载' }).waitFor();
  assert.equal(await page.evaluate(() => window.__introTest.destroyed), 1, 'runtime failure releases player');
  assert.equal(await page.evaluate(() => window.__introTest.audioClosed), true);
  await page.keyboard.press('Escape');

  for (const fallback of ['denied', 'unavailable']) {
    await page.goto(origin + '/about');
    await page.evaluate((mode) => {
      if (mode === 'denied') window.__introTest.denyFullscreen = true;
      else {
        Element.prototype.requestFullscreen = undefined;
        Element.prototype.webkitRequestFullscreen = undefined;
      }
    }, fallback);
    await page.getByRole('button', { name: '重播游戏介绍片' }).click();
    await page.waitForFunction(() => window.__introTest.played === 1);
    assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
    const fallbackSize = await page.locator('.intro-screen').boundingBox();
    const browserSize = page.viewportSize();
    assert.deepEqual(
      [fallbackSize.x, fallbackSize.y, fallbackSize.width, fallbackSize.height],
      [0, 0, browserSize.width, browserSize.height],
      fallback + ' API keeps edge-to-edge viewport playback',
    );
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForTimeout(2300);
    assert.equal(await page.locator('.intro-controls-hidden').count(), 0, 'pause keeps controls visible');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__introTest.destroyed), 1);
  }

  await page.goto(origin + '/about');
  await page.getByRole('button', { name: '重播游戏介绍片' }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('intro-screen'));
  await page.getByRole('button', { name: '静音', exact: true }).evaluate((node) => {
    node.addEventListener('click', () => document.getElementById('outside').requestFullscreen());
  });
  await page.getByRole('button', { name: '静音', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'outside');
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog').count(), 0, 'fullscreen loss closes the player');
  assert.equal(
    await page.evaluate(() => document.fullscreenElement?.id),
    'outside',
    'cleanup never exits another element fullscreen',
  );
  await page.evaluate(() => document.exitFullscreen());

  await page.evaluate(() => localStorage.clear());
  await page.goto(origin + '/');
  await page.getByRole('button', { name: '暂不观看' }).click();
  await page.reload();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('dialog').count(), 0, 'explicit decline persists');
  await page.evaluate(() => localStorage.clear());
  await page.goto(origin + '/games/test');
  await page.waitForTimeout(80);
  assert.equal(await page.locator('dialog').count(), 0, 'no automatic prompt in live game route');
  assert.equal(await page.evaluate(() => window.__introTest.created), 0);
  await page.goto(origin + '/');
  await page.getByRole('button', { name: '观看介绍片' }).click();
  await page.waitForFunction(() => window.__introTest.played === 1);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('dialog').count(), 0, 'affirmative choice also persists');
  console.log(
    'intro entry: consent, fullscreen/fallback, controls, accessibility, mobile, cancellation and retry passed',
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
