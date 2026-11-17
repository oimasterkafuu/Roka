import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = await mkdtemp(path.join(os.tmpdir(), 'roka-session-'));
const secret = 'session-browser-test-secret';
process.env.ROKA_DATA_DIR = dir;
process.env.JWT_SECRET = secret;
process.env.NODE_ENV = 'test';
process.env.ROKA_STATIC_CDN = '0';
process.env.WEBHOOK_SECRET = 'session-browser-webhook';
// Captcha OCR is outside this regression; HTTP login/session/socket/pages are real.
require('../dist/server/captcha-service.js').CaptchaService.prototype.verifyAndConsume = () => ({ ok: true });
const { UserStore, SESSION_TTL_MS } = require('../dist/auth-store.js');
const { decodeBinary, encodeBinary } = require('../dist/binary-store.js');
const jwt = require('jsonwebtoken');
const users = new UserStore(dir);
await users.ensureReady();
await users.register('session_user', 'password1');
const userFile = path.join(dir, 'users.bin');
const data = await decodeBinary(await readFile(userFile));
data.users[0].sessions.push({
  sid: 'expired-server-sid',
  createdAt: Date.now() - SESSION_TTL_MS - 1000,
  expiresAt: Date.now() - 1000,
});
await writeFile(userFile, await encodeBinary(data));
const { app, boot } = require('../dist/server.js');
const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
let browser;
try {
  await boot(false);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const expired = jwt.sign({ sub: 'session_user', sid: 'expired-server-sid' }, secret, { expiresIn: '1h' });
  assert.equal(
    (await fetch(base + '/api/auth/me', { headers: { cookie: `auth_token=${expired}` } })).status,
    401,
    'server expiry rejects even an unexpired JWT',
  );
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const a = await browser.newContext(),
    b = await browser.newContext();
  const errors = [],
    navigations = [];
  const login = async (context) => {
    const response = await context.request.post(base + '/api/auth/login', {
      data: { username: 'session_user', password: 'password1', captchaId: 'test', captchaCode: 'test' },
    });
    assert.equal(response.status(), 200, await response.text());
  };
  const me = async (context) => (await context.request.get(base + '/api/auth/me')).status();
  const open = async (context, route = '/') => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await page.goto(base + route);
    if (route === '/') await page.waitForFunction(() => currentUsername === 'session_user');
    else await page.waitForFunction(() => socket.connected);
    // Allow home notification handshake to settle before asserting the session's activity.
    await page.waitForTimeout(150);
    return page;
  };
  const close = async (page) => {
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  await login(a);
  const firstHome = await open(a);
  await close(firstHome);
  await login(b);
  assert.equal(await me(a), 200);
  assert.equal(await me(b), 200);
  const bHome = await open(b);
  await close(bHome);
  assert.equal(await me(a), 200, 'closed A survives B opening and closing');
  const reopenedA = await open(a);
  assert.equal(await me(a), 200, 'A reopens without logging in again');
  await close(reopenedA);
  console.log(
    'PASS two contexts: A close, B login/open/close, A reopen; both independent sessions return 200',
  );

  // Cross-sid socket conflict: B game is active, A's existing session opens home.
  const bGame = await open(b, '/games/session-test');
  const aHome = await open(a);
  await bGame.waitForURL('**/login');
  assert.equal(await me(b), 401);
  assert.equal(await me(a), 200);
  console.log('PASS existing A home socket evicts active B game sid: game navigates /login, B 401, A 200');

  // Same sid home + game + normal refresh/reconnect must not revoke the session.
  const aGame = await open(a, '/games/session-test');
  await aHome.reload();
  await aHome.waitForFunction(() => currentUsername === 'session_user');
  await aGame.evaluate(() => {
    socket.disconnect();
    socket.connect();
  });
  await aGame.waitForFunction(() => socket.connected);
  assert.equal(await me(a), 200);
  const oldCookie = (await a.cookies(base)).find((c) => c.name === 'auth_token').value;
  const beforeNavigation = navigations.length;
  // Login path also evicts both active old-sid pages before the new device opens a page.
  await login(b);
  await aGame.waitForURL('**/login');
  await aHome.waitForFunction(
    () => getComputedStyle(document.querySelector('#login-btn')).display !== 'none',
  );
  assert.ok(navigations.length >= beforeNavigation + 2, 'old home and game actually navigated');
  assert.equal(
    (await fetch(base + '/api/auth/me', { headers: { cookie: `auth_token=${oldCookie}` } })).status,
    401,
  );
  assert.equal(await me(b), 200);
  assert.deepEqual(errors, []);
  console.log(
    'PASS B login evicts active A home + game, actual reload/navigation, old cookie 401, B 200, no pageerror',
  );

  // No active A page: new A login and B logout must not revoke A's independent sid.
  await close(aHome);
  await close(aGame);
  await close(bGame);
  await login(a);
  assert.equal(await me(a), 200);
  assert.equal(await me(b), 200);
  assert.equal((await b.request.post(base + '/api/auth/logout')).status(), 200);
  assert.equal(await me(b), 401);
  assert.equal(await me(a), 200);
  const finalA = await open(a);
  await close(finalA);
  await a.close();
  await b.close();
  console.log(
    'PASS logout deletes only current sid; other closed-device session remains 200; same-sid reconnect and server seven-day rejection passed',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
