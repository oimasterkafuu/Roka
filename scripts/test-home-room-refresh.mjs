import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:1';
const home = await readFile(process.argv[2] ?? new URL('../static/index.html', import.meta.url), 'utf8');
const scriptPaths = [
  '/vendor/jquery/jquery-3.6.0.min.js',
  '/vendor/socket.io/socket.io-4.0.1.js',
  '/notify.js',
  '/username.js',
  '/main/replay-controls.js',
];
const scripts = new Map(
  await Promise.all(
    scriptPaths.map(async (path) => [
      path,
      await readFile(new URL(`../static${path}`, import.meta.url), 'utf8'),
    ]),
  ),
);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: home });
    if (url.pathname === '/games/restored') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<button id="room-home-btn" onclick="_exit()">Home</button>
               <script src="/main/replay-controls.js"></script>`,
      });
    }
    if (scripts.has(url.pathname)) {
      return route.fulfill({ contentType: 'application/javascript', body: scripts.get(url.pathname) });
    }
    return route.fulfill({ status: 204 });
  });
  await context.addInitScript(() => {
    const handlers = new Map();
    const test = (window.homeTest = {
      rooms: ['initial'],
      starts: [],
      mode: 'normal',
      active: 0,
      maxActive: 0,
      canceled: 0,
      notifications: [],
      emit(event) {
        for (const handler of handlers.get(event) ?? []) handler();
      },
    });
    const ioStub = (options) => {
      test.socketQuery = options.query;
      return {
        on(event, handler) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event).push(handler);
        },
      };
    };
    Object.defineProperty(window, 'io', { get: () => ioStub, set() {} });
    document.hasFocus = () => false;
    window.Notification = class {
      static permission = 'granted';
      constructor(_title, { tag, body }) {
        test.notifications.push({ tag, body });
      }
    };
    window.fetch = async (url) => {
      const path = new URL(url, location.href).pathname;
      if (path === '/api/auth/me') {
        if (sessionStorage.getItem('hold-home-auth')) {
          sessionStorage.removeItem('hold-home-auth');
          await new Promise((resolve) => (test.resumeAuth = resolve));
        }
        return Response.json({ username: 'GuestTester' });
      }
      if (path === '/api/user-colors') {
        return Response.json({ colors: { Alice: { colorClass: 'rt-blue' } } });
      }
      if (path !== '/api/rooms') return new Response(null, { status: 404 });

      const mode = test.mode;
      test.mode = 'normal';
      test.starts.push(performance.now());
      test.maxActive = Math.max(test.maxActive, ++test.active);
      const rooms = test.rooms.map((room) => ({ room, host: 'Alice', playing: 1 }));
      if (mode === 'network-error') {
        test.active--;
        throw new TypeError('fixture network error');
      }
      if (mode === '429') {
        return {
          ok: false,
          status: 429,
          body: {
            async cancel() {
              test.canceled++;
              test.active--;
            },
          },
        };
      }
      if (mode === 'slow') await new Promise((resolve) => (test.sendHeaders = resolve));
      return {
        ok: true,
        async json() {
          if (mode === 'slow') await new Promise((resolve) => (test.sendBody = resolve));
          test.active--;
          return rooms;
        },
      };
    };
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: 1_000_000 });
  await page.clock.pauseAt(1_010_000);
  const step = (ms) => page.clock.runFor(ms);
  const expectCount = async (expected, message) => {
    assert.equal(await page.evaluate(() => homeTest.starts.length), expected, message);
  };
  const signal = (event, count = 1) =>
    page.evaluate(
      ({ event, count }) => {
        for (let index = 0; index < count; index++) homeTest.emit(event);
      },
      { event, count },
    );
  const pageshow = (persisted) =>
    page.evaluate(
      (persisted) => dispatchEvent(new PageTransitionEvent('pageshow', { persisted })),
      persisted,
    );
  const setRooms = (room) => page.evaluate((room) => (homeTest.rooms = [room]), room);
  const expectRoom = async (name) => {
    assert.deepEqual(await page.locator('#rooms-body td:first-child').allTextContents(), [name]);
  };

  await page.goto(origin);
  await expectCount(1, 'initial room request starts without waiting for a socket signal');
  await expectRoom('initial');
  assert.deepEqual(await page.evaluate(() => homeTest.socketQuery), { home: '1' });
  assert.deepEqual(await page.evaluate(() => homeTest.notifications), []);
  await signal('connect');
  await pageshow(false);
  await step(200);
  await setRooms('burst-latest');
  await signal('home_rooms', 20);
  await expectCount(1, '20 notifications must not start more requests inside the initial cooldown');
  await step(799);
  await expectCount(1, 'still cooling down at 999 ms');
  await step(1);
  await expectCount(2, 'one trailing refresh at 1000 ms');
  await expectRoom('burst-latest');
  assert.equal(await page.locator('#rooms-body a.rt-blue[href="/u/Alice"]').count(), 1);
  assert.deepEqual(await page.evaluate(() => homeTest.notifications), [
    { tag: 'home-rooms', body: '有新的房间：burst-latest' },
  ]);
  console.log('PASS initial + 20 notifications: 1 request before 1000 ms, 2 total after cooldown');

  for (let index = 1; index <= 23; index++) {
    await step(100);
    await setRooms(`stream-${index}`);
    await signal('home_rooms');
  }
  await expectCount(4, 'continuous signals refresh twice while the stream is active');
  await step(700);
  await expectCount(5, 'continuous signals retain the final update');
  await expectRoom('stream-23');
  await step(1000);
  await expectCount(5, 'idle after the trailing refresh');

  await page.evaluate(() => (homeTest.mode = 'slow'));
  await signal('home_rooms');
  await step(1500);
  await signal('home_rooms', 3);
  await expectCount(6, 'no new request while headers are pending');
  await page.evaluate(() => homeTest.sendHeaders());
  await step(1500);
  await setRooms('slow-latest');
  await signal('home_rooms', 5);
  await pageshow(true);
  await expectCount(6, 'no new request while the response body is pending');
  await page.evaluate(() => homeTest.sendBody());
  await expectCount(7, 'all pending signals coalesce into one refresh after the slow body');
  await expectRoom('slow-latest');
  await step(4000);
  await expectCount(7, 'no additional trailing refresh');
  console.log('PASS sustained notifications and slow headers/body: periodic progress, one final refresh');

  for (const [index, mode] of ['429', 'network-error'].entries()) {
    await page.evaluate((mode) => (homeTest.mode = mode), mode);
    await signal('home_rooms');
    await step(5000);
    await expectCount(8 + index, `${mode} must not retry without a signal`);
    await expectRoom('slow-latest');
  }
  assert.equal(await page.evaluate(() => homeTest.canceled), 1);
  await setRooms('recovered');
  await signal('home_rooms');
  await expectCount(10, 'normal signal resumes refresh after failures');
  await expectRoom('recovered');

  await step(1000);
  await signal('disconnect');
  await signal('connect_error');
  await expectCount(10, 'failed connection attempts do not refresh');
  await setRooms('reconnected');
  await signal('connect');
  await expectCount(11, 'successful reconnect refreshes');
  await expectRoom('reconnected');
  await step(1000);
  await setRooms('restored');
  await pageshow(true);
  await expectCount(12, 'simulated BFCache restoration refreshes');
  await expectRoom('restored');
  const { starts, maxActive } = await page.evaluate(() => ({
    starts: homeTest.starts,
    maxActive: homeTest.maxActive,
  }));
  assert.equal(maxActive, 1);
  assert.ok(
    starts.slice(1).every((start, index) => start - starts[index] >= 1000),
    starts.join(', '),
  );
  console.log(
    'PASS 429/network failure recovery, reconnect, simulated BFCache; max in flight 1, gaps >= 1000 ms',
  );

  await page.evaluate(() => sessionStorage.setItem('hold-home-auth', '1'));
  await page.locator('#rooms-body td:first-child').click();
  await page.waitForURL(`${origin}/games/restored`);
  await page.locator('#room-home-btn').click();
  await page.waitForURL(`${origin}/`);
  await page.waitForLoadState();
  await expectCount(1, 'the new homepage refreshes immediately even with auth still pending');
  await expectRoom('initial');
  await page.evaluate(() => homeTest.resumeAuth());
  assert.deepEqual(await page.evaluate(() => homeTest.socketQuery), { home: '1' });
  await signal('connect');
  await pageshow(false);
  await step(3000);
  await expectCount(1, 'initial connect and normal pageshow do not duplicate the first request');
  assert.deepEqual(errors, []);
  console.log('PASS room row opens stub room; real _exit returns home; fresh document makes one request');
} finally {
  await browser.close();
}
