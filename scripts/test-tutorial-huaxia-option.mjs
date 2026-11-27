import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-tutorial-huaxia-'));
const opens = Date.parse('2026-09-30T16:00:00Z');
const closes = Date.parse('2026-10-07T16:00:00Z');
const regularModes = ['random', 'maze', 'archipelago', 'mediterranean', 'mega_random'];
const huaxiaLabel = /华夏系列/;
const apiPath = '/api/map-examples';
let app;
let browser;

try {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ROKA_DATA_DIR: dataDir,
    ROKA_STATIC_CDN: '0',
    JWT_SECRET: 'tutorial-huaxia-test-secret',
    WEBHOOK_SECRET: 'tutorial-huaxia-test-secret',
  });
  const server = require('../dist/server.js');
  app = server.app;
  await server.boot(false);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  mock.timers.enable({ apis: ['Date'], now: opens - 30_000 });
  assert.equal((await app.inject(`${apiPath}?map_mode=huaxia`)).statusCode, 403);

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const expectedGuestResponse =
      message.location().url === `${origin}/api/auth/me` && message.text().includes('401 (Unauthorized)');
    if (message.type() === 'error' && !expectedGuestResponse) errors.push(message.text());
  });
  await page.clock.install({ time: opens - 60_000 });
  await page.clock.pauseAt(opens - 30_000);

  const mode = page.locator('#map-example-mode');
  const region = page.locator('#map-example-region-control');
  const openTutorial = () => page.goto(`${origin}/tutorial`);
  const generate = () => page.locator('#generate-map-example-btn').click();
  const assertModes = async (active) => {
    const values = await mode
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value));
    assert.deepEqual(values, active ? [...regularModes, 'huaxia'] : regularModes);
  };
  const openModes = async (active) => {
    await mode.press('Alt+ArrowDown');
    assert.equal(await mode.evaluate((select) => select.matches(':open')), true, 'native select opens');
    const options = await mode.ariaSnapshot();
    if (active) assert.match(options, huaxiaLabel);
    else assert.doesNotMatch(options, huaxiaLabel);
  };
  const assertMap = async (action, expectedMode, expectedRegion) => {
    const [response] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === apiPath),
      action(),
    ]);
    assert.equal(response.status(), 200);
    const { searchParams } = new URL(response.url());
    assert.equal(searchParams.get('map_mode'), expectedMode);
    if (expectedRegion) assert.equal(searchParams.get('map_region'), expectedRegion);
    const { example, players } = await response.json();
    assert.equal(example.map_mode, expectedMode);
    await page.waitForFunction(() => document.querySelector('#map-example-status').textContent === '');
    const table = page.locator('#map-example-board table');
    assert.equal(await table.isVisible(), true);
    assert.equal(await table.locator('tr').count(), example.n);
    assert.equal(await table.locator('td').count(), example.n * example.m);
    assert.equal(await table.locator('td.general').count(), players);
    return `${example.n}×${example.m}`;
  };

  const initialMap = await assertMap(openTutorial, 'random');
  await assertModes(false);
  assert.equal(await region.isVisible(), false);
  await openModes(false);
  await page.keyboard.press('Escape');
  console.log(`PASS 非活动期加载：原生下拉展开后无华夏选项；标准棋盘 ${initialMap}；API 403`);

  await page.clock.runFor(59_999);
  await assertModes(false);
  await page.clock.runFor(1);
  await assertModes(true);
  assert.equal(await mode.inputValue(), 'random');
  mock.timers.setTime(opens);
  await assertMap(openTutorial, 'random');
  await assertModes(true);
  await openModes(true);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await mode.inputValue(), 'huaxia');
  assert.equal(await region.isVisible(), true);
  await region.locator('select').selectOption('han');
  const activeMap = await assertMap(generate, 'huaxia', 'han');
  assert.match(await page.locator('#map-example-title').innerText(), huaxiaLabel);
  console.log(`PASS 跨开放边界恢复末项；活动期重新加载后可键盘选中；华夏棋盘 ${activeMap}`);

  await page.clock.setSystemTime(closes - 30_000);
  await page.clock.runFor(60_000);
  mock.timers.setTime(closes);
  await assertModes(false);
  assert.equal(await mode.inputValue(), 'random');
  assert.equal(await region.isVisible(), false);
  await openModes(false);
  await page.keyboard.press('Escape');
  const fallbackMap = await assertMap(generate, 'random');
  assert.equal((await app.inject(`${apiPath}?map_mode=huaxia`)).statusCode, 403);
  assert.deepEqual(errors, [], 'browser console errors and uncaught exceptions');
  console.log(
    `PASS 跨结束边界移除并回退：请求 random，棋盘 ${fallbackMap}，直请求华夏仍为 403；Chromium ${browser.version()} 无新增控制台错误`,
  );
} finally {
  await browser?.close();
  await app?.close();
  mock.timers.reset();
  await rm(dataDir, { recursive: true, force: true });
}
