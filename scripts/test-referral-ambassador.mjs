import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import jwt from 'jsonwebtoken';
import { UserStore, getAmbassadorBadgeLevel, getGamePoints } from '../dist/auth-store.js';
import { AuthService } from '../dist/server/auth-service.js';
import { LobbyService, REFERRAL_MIN_DURATION_MS, REFERRAL_MIN_TURNS } from '../dist/server/lobby-service.js';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [count, level] of [
  [0, 0],
  [1, 1],
  [2, 1],
  [3, 2],
  [9, 2],
  [10, 3],
  [25, 4],
  [100, 4],
]) {
  assert.equal(getAmbassadorBadgeLevel(count), level);
}

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-referral-store-'));
try {
  const store = new UserStore(storeDir);
  await store.ensureReady();
  await store.register('Alpha', 'password');
  await store.register('Beta', 'password');
  await store.register('OldUser', 'password');
  assert.equal(await store.recordReferralClick('Missing'), null);
  assert.equal(await store.recordReferralClick('alpha'), 'Alpha');
  await store.recordReferralClick('Alpha');
  await store.register('Selfie', 'password', 'Selfie');
  await store.register('Invited', 'password', 'alpha');
  await store.register('Second', 'password', 'Alpha');
  await store.register('Third', 'password', 'Beta');
  await store.register('Plain', 'password');
  assert.deepEqual(
    store.listReferralsForAdmin().map((item) => item.invitee),
    ['Invited', 'Second', 'Third'],
    'self, missing and organic registration are not attributed',
  );
  assert.equal(store.listReferralsForAdmin()[0].status, 'pending');

  const ratingBefore = store.getRating('Invited');
  const pointsBefore = store.getPoints('Invited');
  const activationResults = await Promise.all([
    store.activateReferral('Invited', 'room-one'),
    store.activateReferral('Invited', 'room-one'),
    store.activateReferral('Invited', 'room-one'),
  ]);
  assert.deepEqual(activationResults.sort(), ['activated', 'duplicate', 'duplicate']);
  assert.equal(await store.activateReferral('Invited', 'room-two'), 'ineligible');
  assert.equal(await store.activateReferral('OldUser', 'room-one'), 'ineligible');
  assert.equal(await store.activateReferral('Plain', 'room-one'), 'ineligible');
  assert.deepEqual(store.getRating('Invited'), ratingBefore, 'activation never changes rating');
  assert.equal(store.getPoints('Invited'), pointsBefore, 'activation never changes points');
  assert.equal(await store.activateReferral('Second', 'room-one'), 'activated');
  assert.equal(await store.activateReferral('Third', 'room-one'), 'activated');
  assert.deepEqual(store.getAmbassadorSummary('Alpha'), { activatedCount: 2, badgeLevel: 1 });
  assert.deepEqual(store.getAmbassadorSummary('Beta'), { activatedCount: 1, badgeLevel: 1 });
  assert.equal(await store.excludeReferral('Second', 'abnormal attribution'), true);
  assert.equal(await store.excludeReferral('Second', 'duplicate review'), false);
  assert.equal(await store.activateReferral('Second', 'room-three'), 'ineligible');
  assert.deepEqual(store.getAmbassadorSummary('Alpha'), { activatedCount: 1, badgeLevel: 1 });
  assert.deepEqual(store.getReferralConversion(), {
    clicks: 2,
    registrations: 3,
    activations: 2,
    excluded: 1,
  });
  assert.deepEqual(
    store.listAmbassadorWall().map((item) => item.username),
    ['Alpha', 'Beta'],
    'wall is alphabetical rather than competitive ranking',
  );
  for (const item of store.listAmbassadorWall()) {
    assert.deepEqual(Object.keys(item).sort(), ['activatedCount', 'badgeLevel', 'username']);
  }
  const publicProfile = store.getPublicProfile('Alpha');
  assert.deepEqual(publicProfile.ambassador, { activatedCount: 1, badgeLevel: 1 });
  const serializedProfile = JSON.stringify(publicProfile);
  for (const privateField of ['invitee', 'referrer', 'activationGameId', 'exclusionReason']) {
    assert.equal(serializedProfile.includes(privateField), false);
  }

  const restarted = new UserStore(storeDir);
  await restarted.ensureReady();
  assert.deepEqual(restarted.getReferralConversion(), store.getReferralConversion());
  assert.deepEqual(restarted.listReferralsForAdmin(), store.listReferralsForAdmin());
  assert.deepEqual(restarted.getAmbassadorSummary('Alpha'), { activatedCount: 1, badgeLevel: 1 });
  assert.equal(await restarted.activateReferral('Invited', 'room-one'), 'duplicate');
  assert.equal(await restarted.activateReferral('Invited', 'another-room'), 'ineligible');
} finally {
  await fs.rm(storeDir, { recursive: true, force: true });
}

const lobbyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-referral-lobby-'));
try {
  const store = new UserStore(lobbyDir);
  await store.ensureReady();
  await store.register('Alpha', 'password');
  await store.register('Existing', 'password');
  await store.register('NewPlayer', 'password', 'Alpha');
  const lobby = new LobbyService({}, store);
  const result = [
    { uid: 'NewPlayer', team: 1, rank: 1 },
    { uid: 'Existing', team: 2, rank: 2 },
  ];
  const validGame = {
    gameId: 'valid-room',
    turn: REFERRAL_MIN_TURNS,
    elapsedMs: REFERRAL_MIN_DURATION_MS,
    humanUsernames: new Set(['newplayer', 'existing']),
  };
  await lobby.applyGameResult(result, { ...validGame, turn: REFERRAL_MIN_TURNS - 1 });
  assert.equal(store.listReferralsForAdmin()[0].status, 'pending', 'short turn count does not activate');
  await lobby.applyGameResult(result, { ...validGame, elapsedMs: REFERRAL_MIN_DURATION_MS - 1 });
  assert.equal(store.listReferralsForAdmin()[0].status, 'pending', 'short duration does not activate');
  await lobby.applyGameResult(result, { ...validGame, humanUsernames: new Set(['newplayer']) });
  assert.equal(store.listReferralsForAdmin()[0].status, 'pending', 'bot match does not activate');
  const newRatingBefore = store.getRating('NewPlayer').rating;
  const existingRatingBefore = store.getRating('Existing').rating;
  const expectedDelta = 128 * (1 - 1 / (1 + 10 ** ((existingRatingBefore - newRatingBefore) / 400)));
  await lobby.applyGameResult(result, validGame);
  assert.equal(store.listReferralsForAdmin()[0].status, 'active');
  assert.equal(
    store.getPoints('NewPlayer'),
    getGamePoints(1, 2) * 4,
    'normal game points are unchanged by activation',
  );
  assert.equal(store.getRating('NewPlayer').ratingGames, 4, 'normal rating settlement is unchanged');
  const expectedRating = Math.round((newRatingBefore + expectedDelta) * 10) / 10;
  assert.equal(store.getRating('NewPlayer').rating, expectedRating, 'no ambassador rating bonus');
  await lobby.applyGameResult(result, validGame);
  await lobby.applyGameResult(result, { ...validGame, gameId: 'later-room' });
  assert.deepEqual(store.getAmbassadorSummary('Alpha'), { activatedCount: 1, badgeLevel: 1 });
  assert.equal(store.listReferralsForAdmin()[0].activationGameId, 'valid-room');
} finally {
  await fs.rm(lobbyDir, { recursive: true, force: true });
}

const auth = new AuthService({});
assert.equal(auth.isPublicPath('/ambassadors', 'GET'), true);
assert.equal(auth.isPublicPath('/api/ambassadors', 'GET'), true);
assert.equal(auth.isPublicPath('/api/referrals/click', 'POST'), true);
assert.equal(auth.isPublicPath('/api/referrals/click', 'GET'), false);
assert.equal(auth.isPublicPath('/api/admin/referrals', 'GET'), false);

for (const pathname of ['/invite', '/invite/Admin1']) {
  assert.equal(auth.isPublicPath(pathname, 'GET'), true);
  assert.equal(auth.isPublicPath(pathname, 'POST'), false);
}

const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const httpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-referral-http-'));
const secret = 'referral-test-secret';
const setup = new UserStore(httpDir);
await setup.ensureReady();
await setup.register('Admin1', 'password');
await setup.register('Other1', 'password');
await setup.register('OldUser', 'password');
const adminSid = await setup.rotateSession('Admin1');
const adminCookie = `auth_token=${jwt.sign({ sub: 'Admin1', sid: adminSid }, secret)}`;
const server = spawn(
  process.execPath,
  [
    '-e',
    "const {CaptchaService}=require('./dist/server/captcha-service.js');CaptchaService.prototype.verifyAndConsume=()=>({ok:true});require('./dist/server.js').boot().catch((error)=>{console.error(error);process.exit(1);});",
  ],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: secret,
      WEBHOOK_SECRET: secret,
      ROKA_DATA_DIR: httpDir,
      ROKA_STATIC_CDN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLogs = '';
server.stdout.on('data', (chunk) => {
  serverLogs += chunk;
});
server.stderr.on('data', (chunk) => {
  serverLogs += chunk;
});
const timeout = setTimeout(() => server.kill('SIGKILL'), 30000);
timeout.unref();

function cookieFrom(response, name) {
  const values = response.headers.getSetCookie();
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

async function post(pathname, body, cookie = '', ip = '') {
  return fetch(base + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(ip ? { 'x-real-ip': ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function authBody(username) {
  return { username, password: 'password', captchaId: 'test', captchaCode: 'TEST', website: '' };
}

try {
  let ready = false;
  for (let index = 0; index < 200; index += 1) {
    try {
      ready = (await fetch(`${base}/api/version`)).ok;
      if (ready) break;
    } catch {}
    await sleep(50);
  }
  assert.equal(ready, true, `server did not start: ${serverLogs}`);

  for (const username of ['Admin1', 'aDmIn1']) {
    const response = await fetch(`${base}/invite/${username}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login?ref=Admin1');
  }
  for (const pathname of ['/invite/Missing', '/invite']) {
    const response = await fetch(base + pathname, { redirect: 'manual' });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /完整/);
  }
  console.log('invite HTTP: anonymous redirect, canonical username and 404 hints passed');

  const firstClick = await post('/api/referrals/click', { referrer: 'Admin1' });
  assert.equal(firstClick.status, 200);
  const referralCookie = cookieFrom(firstClick, 'roka_referral');
  assert.equal(referralCookie, 'roka_referral=Admin1');
  const clickCookie = firstClick.headers.getSetCookie().find((value) => value.startsWith('roka_referral='));
  assert.match(clickCookie, /HttpOnly/);
  assert.match(clickCookie, /SameSite=Lax/);
  const secondClick = await post('/api/referrals/click', { referrer: 'Other1' }, referralCookie);
  assert.deepEqual(secondClick.headers.getSetCookie(), [], 'first valid invitation cookie wins');
  const invalidClick = await post('/api/referrals/click', { referrer: 'Missing' });
  assert.deepEqual(await invalidClick.json(), { ok: false });

  const registration = await post(
    '/api/auth/register',
    await authBody('InvitedHttp'),
    referralCookie,
    '198.51.100.101',
  );
  assert.equal(registration.status, 200, await registration.text());
  const registrationCookies = registration.headers.getSetCookie();
  assert.equal(
    registrationCookies.some((value) => value.startsWith('roka_referral=;')),
    true,
  );
  assert.equal(
    registrationCookies.some((value) => value.startsWith('auth_token=')),
    true,
  );
  const invitedAuthCookie = cookieFrom(registration, 'auth_token');
  const publicAdmin = await (await fetch(`${base}/api/profile/Admin1`)).json();
  assert.deepEqual(publicAdmin.ambassador, { activatedCount: 0, badgeLevel: 0 });
  assert.equal(JSON.stringify(publicAdmin).includes('InvitedHttp'), false);

  const anonymousWallResponse = await fetch(`${base}/api/ambassadors`);
  assert.equal(anonymousWallResponse.status, 200);
  const pendingWall = await anonymousWallResponse.json();
  assert.deepEqual(pendingWall.conversion, { clicks: 1, registrations: 1, activations: 0, excluded: 0 });
  assert.deepEqual(pendingWall.items, []);
  assert.equal(JSON.stringify(pendingWall).includes('InvitedHttp'), false);
  assert.equal((await fetch(`${base}/ambassadors`)).status, 200);
  assert.equal((await fetch(`${base}/api/admin/referrals`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/admin/referrals`, {
        headers: { cookie: invitedAuthCookie },
      })
    ).status,
    403,
  );
  const adminRelations = await (
    await fetch(`${base}/api/admin/referrals`, { headers: { cookie: adminCookie } })
  ).json();
  assert.equal(adminRelations.items.length, 1);
  assert.equal(adminRelations.items[0].invitee, 'InvitedHttp');
  assert.equal(adminRelations.items[0].referrer, 'Admin1');

  const oldLogin = await post('/api/auth/login', await authBody('OldUser'), 'roka_referral=Other1');
  assert.equal(oldLogin.status, 200);
  assert.equal(
    oldLogin.headers.getSetCookie().some((value) => value.startsWith('roka_referral=;')),
    true,
  );
  const selfRegistration = await post(
    '/api/auth/register',
    await authBody('SelfHttp'),
    'roka_referral=SelfHttp',
    '198.51.100.102',
  );
  assert.equal(selfRegistration.status, 200);
  const organicRegistration = await post(
    '/api/auth/register',
    await authBody('PlainHttp'),
    '',
    '198.51.100.103',
  );
  assert.equal(organicRegistration.status, 200);
  const afterBoundaries = await (
    await fetch(`${base}/api/admin/referrals`, { headers: { cookie: adminCookie } })
  ).json();
  assert.equal(afterBoundaries.items.length, 1, 'login, self and organic registration add no attribution');

  const excluded = await post(
    '/api/admin/referrals/exclude',
    { invitee: 'InvitedHttp', reason: 'review' },
    adminCookie,
  );
  assert.equal(excluded.status, 200);
  assert.equal(
    (await post('/api/admin/referrals/exclude', { invitee: 'InvitedHttp' }, adminCookie)).status,
    404,
    'review exclusion is idempotent',
  );
  const finalWall = await (await fetch(`${base}/api/ambassadors`)).json();
  assert.deepEqual(finalWall.conversion, { clicks: 1, registrations: 1, activations: 0, excluded: 1 });
  assert.deepEqual(finalWall.items, []);
  assert.equal(JSON.stringify(finalWall).includes('InvitedHttp'), false);
} finally {
  clearTimeout(timeout);
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, sleep(2000)]);
  }
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await fs.rm(httpDir, { recursive: true, force: true });
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.textContent = '';
  }
  addEventListener(event, handler) {
    this[event] = handler;
  }
  select() {
    this.selected = true;
  }
  focus() {
    this.focused = true;
  }
  set innerHTML(_value) {
    throw new Error('innerHTML is forbidden in ambassador rendering');
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
}

const nodes = Object.fromEntries(
  [
    'ambassadors-status',
    'ambassador-grid',
    'referral-clicks',
    'referral-registrations',
    'referral-activations',
    'referral-excluded',
    'ambassador-invite-link',
    'ambassador-invite-copy',
    'ambassador-share',
    'ambassador-login',
    'ambassador-share-hint',
  ].map((id) => [id, new FakeElement('div')]),
);
const documentStub = {
  getElementById: (id) => nodes[id],
  createElement: (tagName) => new FakeElement(tagName),
};
const context = vm.createContext({
  console,
  document: documentStub,
  encodeURIComponent,
  location: { origin: 'https://roka.example' },
  navigator: {
    clipboard: {
      writeText: async (value) => {
        context.copied = value;
      },
    },
  },
  setTimeout: (callback, delay) => {
    assert.equal(delay, 1500);
    context.resetCopy = callback;
  },
  usernameLink: (username, _info, extraClass, options) => {
    assert.equal(options.element, 'span');
    const element = new FakeElement('span');
    element.className = extraClass;
    element.textContent = username;
    element.attributes['data-username'] = username;
    return [element];
  },
  usernameEnsureColors: (names) => {
    context.ambassadorColorNames = names;
  },
  fetch: async (url) => ({
    ok: true,
    json: async () =>
      url === '/api/auth/me'
        ? { username: 'Admin1' }
        : {
            conversion: { clicks: 2, registrations: 1, activations: 1, excluded: 0 },
            items: [
              { username: 'Admin1', activatedCount: 1, badgeLevel: 1, invitee: 'Secret' },
              { username: '<img>', activatedCount: 99, badgeLevel: 4 },
            ],
          },
  }),
});
const frontendSource = await fs.readFile(path.join(rootDir, 'static/ambassadors.js'), 'utf8');
vm.runInContext(frontendSource, context, { filename: 'static/ambassadors.js' });
await context.ambassadorWallReady;
await context.ambassadorInviteReady;
assert.equal(nodes['ambassador-share'].hidden, false);
assert.equal(nodes['ambassador-login'].hidden, true);
assert.equal(nodes['ambassador-invite-link'].value, 'https://roka.example/invite/Admin1');
const copyButton = nodes['ambassador-invite-copy'];
await copyButton.click();
assert.equal(context.copied, nodes['ambassador-invite-link'].value);
assert.equal(copyButton.textContent, '已复制');
context.resetCopy();
assert.equal(copyButton.textContent, '复制');
context.navigator.clipboard = undefined;
documentStub.execCommand = (command) => command === 'copy';
await copyButton.click();
assert.equal(nodes['ambassador-invite-link'].selected, true);
assert.equal(copyButton.textContent, '已复制');
documentStub.execCommand = () => false;
await copyButton.click();
assert.equal(copyButton.textContent, '请手动复制');
for (const fetchAuth of [
  async () => ({ ok: false, status: 401 }),
  async () => {
    throw new Error('offline');
  },
]) {
  nodes['ambassador-share'].hidden = true;
  nodes['ambassador-login'].hidden = false;
  nodes['ambassador-share-hint'].textContent = '登录后进入自己的个人主页';
  context.fetch = fetchAuth;
  await context.loadAmbassadorInvite();
  assert.equal(nodes['ambassador-share'].hidden, true);
  assert.equal(nodes['ambassador-login'].hidden, false);
  assert.match(nodes['ambassador-share-hint'].textContent, /登录后/);
}
console.log('ambassador sharing: authenticated, guest, clipboard, fallback and failure passed');
assert.equal(nodes['ambassador-grid'].children.length, 1);
const renderedCard = nodes['ambassador-grid'].children[0];
assert.equal(renderedCard.href, '/u/Admin1');
assert.equal(renderedCard.children[0].tagName, 'SPAN');
assert.equal(renderedCard.children[0].className, 'ambassador-name');
assert.equal(renderedCard.children[0].attributes['data-username'], 'Admin1');
assert.equal(renderedCard.children[0].textContent, 'Admin1');
assert.equal(context.ambassadorColorNames.join(','), 'Admin1');
assert.equal(renderedCard.children[1].textContent, '推广大使 · Lv 1');
assert.equal(nodes['referral-activations'].textContent, '1');
assert.equal(frontendSource.includes('innerHTML'), false);
assert.equal(frontendSource.includes('Secret'), false);

console.log('referral ambassador tests passed');
