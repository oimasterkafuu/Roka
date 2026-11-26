import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encodeReplayPatchBinary } from '../dist/replay-patch-binary.js';

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const boardSize = 12;
const lastFrame = 24;
const leaderboard = Array.from({ length: 14 }, (_, index) => ({
  uid: `Participant_with_a_long_name_${index + 1}`,
  id: index + 1,
  team: Math.floor(index / 2) + 1,
  army: (index + 1) * 12000,
  land: index + 1,
  dead: 0,
  class_: '',
}));
const frameData = (turn) => ({
  turn,
  leaderboard: leaderboard.map((entry) => ({ ...entry, army: entry.army + turn * 2000 * entry.id })),
  grid_type: [],
  army_cnt: [],
  isolated: [],
  game_end: turn === lastFrame,
});
const replay = encodeReplayPatchBinary({
  n: boardSize,
  m: boardSize,
  initial: {
    ...frameData(0),
    grid_type: Array(boardSize ** 2).fill(200),
    army_cnt: Array(boardSize ** 2).fill(0),
    isolated: Array(boardSize ** 2).fill(0),
  },
  patches: Array.from({ length: lastFrame }, (_, index) => ({
    forward: frameData(index + 1),
    backward: frameData(index),
  })),
  meta: {
    fog_mode: 'explored',
    player_names: leaderboard.map(({ uid }) => uid),
    player_teams: leaderboard.map(({ team }) => team),
  },
  vision: new Map(leaderboard.map(({ team }) => [team, { omniscientFrom: null, cells: new Map() }])),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://roka.test') return route.abort();
    if (url.pathname === '/replays/local') return route.fulfill({ path: 'static/game.html' });
    if (url.pathname === '/api/user-colors') return route.fulfill({ json: {} });
    return route.fulfill({ path: `static${url.pathname}` }).catch(() => route.fulfill({ status: 404 }));
  });
  await page.addInitScript((fixture) => {
    sessionStorage.setItem('roka_local_replay', fixture);
    localStorage.scale = '3';
    document.addEventListener('gotpointercapture', (event) => {
      if (event.target.id === 'replay-stats-canvas') window.chartPointerId = event.pointerId;
    });
  }, replay.toString('base64'));
  await page.goto('http://roka.test/replays/local');
  const chart = page.locator('#replay-stats-canvas');
  const chartPanel = page.locator('#replay-stats');
  const title = page.locator('#replay-title');
  const ranking = page.locator('#game-leaderboard-scroll');
  const leftControls = page.locator('#replay-top-left');
  const bottom = page.locator('#replay-bottom');
  const autoplay = page.locator('#replay-autoplay-btn');
  const rates = page.locator('#tabs-replay-autoplay');
  const [back, toggle, next] = await page.locator('#replay-bottom-bar > div').all();
  const getFrame = () => page.evaluate(() => window.cur_turn);
  const mapPosition = () => page.locator('#map').evaluate(({ style }) => [style.left, style.top]);

  await page.waitForFunction(() => window.replay_stats_base);
  await title.waitFor({ state: 'visible' });
  assert.match(await title.textContent(), /队伍/);
  assert.equal(await ranking.locator('tr.lb-member').count(), leaderboard.length);
  assert(await page.locator('#replay-error-alert').isHidden());

  async function assertMobileLayout() {
    const [titleBox, listBox, panelBox, leftBox, bottomBox] = await Promise.all(
      [title, ranking, chartPanel, leftControls, bottom].map((locator) => locator.boundingBox()),
    );
    assert(titleBox.y + titleBox.height <= listBox.y, 'title is above the leaderboard');
    assert(titleBox.y + titleBox.height <= leftBox.y, 'title is above the left controls');
    assert(listBox.y + listBox.height <= panelBox.y, 'chart is below the leaderboard');
    const leftEdge = leftBox.x + leftBox.width;
    const chartBottom = panelBox.y + panelBox.height;
    assert(leftEdge <= panelBox.x, `HUD columns do not overlap (${leftEdge} <= ${panelBox.x})`);
    assert(
      chartBottom <= bottomBox.y,
      `chart clears the playback controls (${chartBottom} <= ${bottomBox.y})`,
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), page.viewportSize().width);
  }

  await assertMobileLayout();
  assert(await ranking.evaluate((element) => element.scrollHeight > element.clientHeight));
  const originalMap = await mapPosition();
  for (let cycle = 0; cycle < 3; cycle++) {
    await autoplay.tap();
    await rates.getByText('0.5x', { exact: true }).tap();
    await rates.getByText('0.75x', { exact: true }).tap();
    await rates.getByText('0.75x', { exact: true }).tap();
    assert.equal(await page.evaluate(() => window.autoplay_speed), 0.75);
    await toggle.tap();
    assert(await rates.isHidden());
  }
  const startFrame = await getFrame();
  for (let step = 0; step < 3; step++) await next.tap();
  assert.equal(await getFrame(), startFrame + 3);
  for (let step = 0; step < 3; step++) await back.tap();
  assert.equal(await getFrame(), startFrame);
  await page.locator('#tabs-replay-stats').getByText('领土').tap();
  assert.equal(await page.evaluate(() => window.replayStatsMetric()), 'land');
  assert.deepEqual(await mapPosition(), originalMap);

  const { x, y, width, height } = await chart.boundingBox();
  const midY = Math.round(y + height / 2);
  const chartX = (fraction) => Math.round(x + width * fraction);
  const cdp = await context.newCDPSession(page);
  const touch = (type, ...touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  await touch('touchStart', { x: chartX(0.25), y: midY, id: 1 });
  assert.equal(await getFrame(), 6);
  await touch('touchMove', { x: chartX(0.75), y: midY, id: 1 });
  assert.equal(await getFrame(), 18);
  assert(
    await chart.evaluate((canvas) => {
      const cursorX = Math.floor(((2 + 0.75 * 244) / 248) * canvas.width);
      const [red, green, blue, alpha] = canvas
        .getContext('2d')
        .getImageData(cursorX, 8 * devicePixelRatio, 1, 1).data;
      return red === 0 && green === 128 && blue === 128 && alpha > 0;
    }),
    'chart draws the cursor at the displayed frame',
  );
  await touch('touchCancel');
  await chart.evaluate((canvas, clientX) => {
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: window.chartPointerId, clientX }));
  }, chartX(0.1));
  assert.equal(await getFrame(), 18, 'cancellation clears the seeking pointer');
  await touch('touchStart', { x: chartX(0.5), y: midY, id: 2 });
  assert.equal(await getFrame(), 12, 'a new touch works after cancellation');
  await touch('touchMove', { x: chartX(0.9), y: Math.round(y + height + 20), id: 2 });
  assert.equal(await getFrame(), 22, 'chart retains touch capture outside its bounds');
  await touch('touchEnd');
  await chart.evaluate((canvas, clientX) => {
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: window.chartPointerId, clientX }));
  }, chartX(0.1));
  assert.equal(await getFrame(), 22, 'pointerup clears the seeking pointer');

  await page.mouse.move(chartX(0.5), midY);
  await page.mouse.down();
  await page.mouse.move(Math.round(x - 20), Math.round(y + height + 25));
  assert.equal(await getFrame(), 0, 'chart retains mouse capture outside its bounds');
  await page.mouse.up();
  await page.mouse.move(chartX(0.5), midY);
  await page.mouse.down();
  await page.mouse.move(chartX(0.75), midY);
  assert.equal(await getFrame(), 18);
  await chart.evaluate((canvas) => canvas.releasePointerCapture(window.chartPointerId));
  await page.mouse.move(chartX(0.25), midY);
  assert.equal(await getFrame(), 18, 'lost capture clears the seeking pointer');
  await page.mouse.up();
  assert.deepEqual(await mapPosition(), originalMap, 'neither chart pointer type pans the map');

  const button = await autoplay.boundingBox();
  const buttonX = Math.round(button.x + button.width / 2);
  const buttonY = Math.round(button.y + button.height / 2);
  await page.mouse.move(buttonX, buttonY);
  await page.mouse.down();
  await page.mouse.move(80, 370);
  await page.mouse.up();
  await touch('touchStart', { x: buttonX, y: buttonY, id: 1 });
  await touch('touchMove', { x: 80, y: 370, id: 1 });
  await touch('touchEnd');
  assert.deepEqual(await mapPosition(), originalMap, 'neither button pointer type pans the map');
  await next.tap();
  assert.equal(await getFrame(), 19, 'controls keep working after all gesture end paths');

  await page.locator('#t6_6').tap();
  assert.deepEqual(await page.evaluate(() => window.getSelectedCells()), [[6, 6]]);
  await page.mouse.move(30, 420);
  await page.mouse.down();
  await page.mouse.move(55, 439);
  await page.mouse.up();
  assert.deepEqual(
    await mapPosition(),
    originalMap.map((value, index) => `${parseFloat(value) + [25, 19][index]}px`),
  );
  const mouseMap = await mapPosition();
  await touch('touchStart', { x: 22, y: 510, id: 1 });
  await touch('touchMove', { x: 46, y: 525, id: 1 });
  await touch('touchEnd');
  assert.deepEqual(
    await mapPosition(),
    mouseMap.map((value, index) => `${parseFloat(value) + [24, 15][index]}px`),
  );
  await touch('touchStart', { x: 45, y: 540, id: 1 }, { x: 85, y: 540, id: 2 });
  await touch('touchMove', { x: 22, y: 540, id: 1 }, { x: 120, y: 540, id: 2 });
  await touch('touchEnd');
  assert(await page.evaluate(() => window.scale > 3), 'two map contacts still zoom');

  await page.setViewportSize({ width: 320, height: 568 });
  await autoplay.tap();
  await assertMobileLayout();
  assert(
    await ranking
      .locator('td.lb-army, td.lb-land')
      .evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth)),
    'large scores stay inside their columns at 320 px',
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await assertMobileLayout();
  await page.setViewportSize({ width: 1440, height: 900 });
  await autoplay.tap();
  await page.waitForFunction(() => {
    const leaderboard = document.querySelector('#game-leaderboard').getBoundingClientRect();
    const stats = document.querySelector('#replay-stats').getBoundingClientRect();
    return stats.top === leaderboard.bottom + 8 && stats.width === 264;
  });
  await page.evaluate(() => {
    window.deploy_queued = true;
    window.refreshDeployBanner();
  });
  const bannerBox = await page.locator('#deploy-banner').boundingBox();
  const leaderboardBox = await page.locator('#game-leaderboard').boundingBox();
  assert.equal(leaderboardBox.y, bannerBox.height);
  assert.equal((await chartPanel.boundingBox()).y, leaderboardBox.y + leaderboardBox.height + 8);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertMobileLayout();
  assert.equal((await title.boundingBox()).y, bannerBox.height);
  assert.deepEqual(errors, []);
  console.log('replay mobile browser tests passed (390, 320, 844 and 1440 px)');
} finally {
  await browser.close();
}
