import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = 'http://roka.test';
const start = Date.UTC(2026, 0, 2, 3, 4, 5);
const replay = { id: 'initial', time: start / 1000, turn: 42, rank: ['Alice', 'Bob'] };
const replacement = { ...replay, id: 'replacement', time: (start + 65_000) / 1000 };
const replayRequests = [];
let items = [
  replay,
  { ...replay, id: 'invalid', time: 'invalid' },
  { ...replay, id: 'missing', time: undefined },
  { ...replay, id: 'null', time: null },
  { ...replay, id: 'overflow', time: 1e20 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/replays') {
      replayRequests.push(url.search);
      return route.fulfill({ json: { items } });
    }
    if (url.pathname === '/api/rooms') return route.fulfill({ json: [] });
    if (url.pathname === '/api/feeds' || url.pathname === '/api/user-colors') {
      return route.fulfill({ json: { items: [], colors: {} } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404 });
    if (url.pathname === '/replays/replacement') return route.fulfill({ body: 'Replay' });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    return route.fulfill({ path: fileURLToPath(new URL(`../static${path}`, import.meta.url)) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('roka_intro_offered_v1', '1');
    const handlers = new Map();
    const ioStub = () => ({ on: (event, handler) => handlers.set(event, handler) });
    Object.defineProperty(window, 'io', {
      get: () => ioStub,
      set() {},
    });
    window.emitHomeEvent = (event) => handlers.get(event)();
  });
  await page.clock.install({ time: start - 1000 });
  await page.clock.pauseAt(start);
  await page.goto(origin);

  const timeCells = page.locator('#replays-body tr > td:first-child');
  const timeCell = timeCells.first();
  await timeCells.last().waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  const initialCell = await timeCell.elementHandle();
  const title = '2026-01-02 03:04';
  assert.deepEqual(await timeCells.allTextContents(), ['刚刚', '-', '-', '-', '-']);
  assert.equal(await timeCell.getAttribute('data-replay-time-ms'), String(start));
  assert.equal(await timeCell.getAttribute('title'), title);
  for (const invalidCell of (await timeCells.all()).slice(1)) {
    assert.equal(await invalidCell.getAttribute('data-replay-time-ms'), null);
    assert.equal(await invalidCell.getAttribute('title'), null);
  }

  for (const [elapsed, label] of [
    [9000, '刚刚'],
    [1000, '10 秒前'],
    [1000, '11 秒前'],
    [48_000, '59 秒前'],
    [1000, '1 分钟前'],
  ]) {
    await page.clock.runFor(elapsed);
    assert.equal(await timeCell.textContent(), label);
    assert.equal(await timeCell.getAttribute('title'), title);
  }
  assert.equal(await initialCell.evaluate((cell) => cell.isConnected), true, 'ticks keep the original cell');
  assert.deepEqual(await timeCells.allTextContents(), ['1 分钟前', '-', '-', '-', '-']);
  assert.deepEqual(replayRequests, ['?limit=10&offset=0'], 'ticks do not fetch the replay list');

  assert.equal(await timeCell.isVisible(), true);
  const layout = await timeCell.evaluate((cell) => {
    const table = cell.closest('table').getBoundingClientRect();
    const card = cell.closest('.card').getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const text = range.getBoundingClientRect();
    const bounds = cell.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      pageFits: document.scrollingElement.scrollWidth <= document.documentElement.clientWidth,
      tableFits: table.left >= card.left && table.right <= card.right,
      textFits: text.width > 0 && text.left >= bounds.left && text.right <= bounds.right,
    };
  });
  assert.deepEqual(layout, { viewport: 390, pageFits: true, tableFits: true, textFits: true });

  const setHidden = (hidden) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      return { hidden: document.hidden, now: Date.now() };
    }, hidden);
  await setHidden(true);
  await page.clock.setSystemTime(start + 120_000);
  assert.equal(await timeCell.textContent(), '1 分钟前', 'a clock jump alone does not run the timer');
  assert.deepEqual(await setHidden(false), { hidden: false, now: start + 120_000 });
  assert.equal(await timeCell.textContent(), '2 分钟前', 'visible event updates without waiting for a tick');
  assert.equal(await timeCell.getAttribute('title'), title);
  assert.equal(replayRequests.length, 1);

  items = [replacement];
  await page.evaluate(() => window.emitHomeEvent('home_replays'));
  const replacementCell = page.locator(`td[data-replay-time-ms="${replacement.time * 1000}"]`);
  await replacementCell.waitFor({ state: 'visible' });
  assert.equal(await timeCells.count(), 1);
  assert.equal(await initialCell.evaluate((cell) => cell.isConnected), false);
  assert.equal(await replacementCell.textContent(), '55 秒前');
  await page.clock.runFor(5000);
  assert.equal(await replacementCell.textContent(), '1 分钟前');
  assert.equal(await replacementCell.getAttribute('title'), '2026-01-02 03:05');
  assert.deepEqual(replayRequests, ['?limit=10&offset=0', '?limit=10&offset=0']);

  await replacementCell.click();
  await page.waitForURL(`${origin}/replays/replacement`);
  assert.deepEqual(errors, []);
  console.log(
    'PASS home replay time: second/minute ticks, visibility, replacement, invalid time, mobile and navigation',
  );
} finally {
  await browser.close();
}
