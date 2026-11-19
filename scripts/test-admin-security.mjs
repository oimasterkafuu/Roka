import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inspectUsername, normalizeUsernameForPolicy } = require('../dist/server/username-policy.js');
const { normalizeIpToken } = require('../dist/server/client-ip.js');
const { UserStore } = require('../dist/auth-store.js');
const { encodeBinary } = require('../dist/binary-store.js');
const {
  SecurityAuditStore,
  SECURITY_AUDIT_MAX_ENTRIES,
  SECURITY_AUDIT_MAX_BYTES,
  REGISTRATION_DENIAL_MS,
} = require('../dist/server/security-audit.js');
const { RegistrationSecurity } = require('../dist/server/registration-security.js');

const dirs = [];
async function tempDir(label) {
  const dir = await mkdtemp(path.join(tmpdir(), `roka-admin-security-${label}-`));
  dirs.push(dir);
  return dir;
}

async function testPolicy() {
  for (const username of ['fuckcheng', 'FuCkChenG', 'f_u_c_k_cheng', 'fuck123', 'sh1thead', 'p0rnuser']) {
    assert.equal(inspectUsername(username).violated, true, username);
  }
  for (const username of ['grass', 'assistant', 'classy', 'normal_user', 'scunthorpe', 'grape', 'analysis']) {
    assert.equal(inspectUsername(username).violated, false, username);
  }
  assert.equal(normalizeUsernameForPolicy('Fu7k'), 'futk');
  assert.equal(inspectUsername('fuckcheng').violated, true);
  assert.equal(normalizeIpToken('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIpToken('::FFFF:C000:0201'), '192.0.2.1');
  assert.equal(normalizeIpToken('[2001:0DB8:0:0:0:0:0:1]:443'), '2001:db8::1');
  assert.equal(normalizeIpToken('not-an-ip'), null);
  console.log('PASS username policy and IPv4/IPv6 normalization');
}

async function testIpStorage() {
  const dir = await tempDir('ip');
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register('ip_user', 'password1', undefined, '::ffff:192.0.2.1');
  let entry = store.listUsersForAdmin()[0];
  assert.equal(entry.registeredIp, '192.0.2.1');
  assert.equal(entry.lastIp, '192.0.2.1');
  assert.equal(entry.ipHistory.length, 1);
  await store.rotateSession('ip_user', '2001:0DB8:0:0:0:0:0:1');
  entry = store.listUsersForAdmin()[0];
  assert.equal(entry.lastIp, '2001:db8::1');
  assert.equal(entry.ipHistory.length, 2);
  const now = Date.now();
  assert.equal(await store.recordActivityIp('ip_user', '2001:db8::1', now), false);
  assert.equal(await store.recordActivityIp('ip_user', '2001:db8::1', now + 300_000), true);
  assert.equal(await store.recordActivityIp('ip_user', '198.51.100.254', now + 300_001), true);
  assert.equal(
    await store.recordActivityIp('ip_user', '2001:db8::1', now + 300_002),
    false,
    'per-user+IP throttle survives switching to another IP and back',
  );
  for (let index = 0; index < 25; index += 1) {
    await store.recordActivityIp('ip_user', `198.51.100.${index + 1}`, now + 300_003 + index);
  }
  entry = store.listUsersForAdmin()[0];
  assert.equal(entry.ipHistory.length, 20);
  assert.equal(
    entry.ipHistory.some((item) => item.ip === '198.51.100.1'),
    false,
  );
  assert.equal(
    entry.ipHistory.some((item) => item.ip === '198.51.100.25'),
    true,
  );
  assert.equal(JSON.stringify(store.getPublicProfile('ip_user')).includes('192.0.2.1'), false);
  assert.equal(JSON.stringify(store.getPublicProfile('ip_user')).includes('registeredIp'), false);
  const restarted = new UserStore(dir);
  await restarted.ensureReady();
  assert.equal(restarted.listUsersForAdmin()[0].ipHistory.length, 20);
  assert.equal(restarted.listUsersForAdmin()[0].lastIp, '198.51.100.25');

  const legacyDir = await tempDir('legacy');
  await writeFile(
    path.join(legacyDir, 'users.bin'),
    await encodeBinary({
      users: [
        {
          username: 'legacy_user',
          passwordSalt: '00',
          passwordHash: '00',
          sessionId: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  const legacy = new UserStore(legacyDir);
  await legacy.ensureReady();
  const legacyEntry = legacy.listUsersForAdmin()[0];
  assert.equal(legacyEntry.registeredIp, null);
  assert.equal(legacyEntry.lastIp, null);
  assert.deepEqual(legacyEntry.ipHistory, []);
  console.log('PASS IP registration/login/activity, 20-entry LRU, legacy data and restart');
}

async function registerProtected(security, username, ip) {
  const review = await security.review(username, ip);
  assert.equal(review.allowed, true);
  await security.userStore.register(username, 'password1', undefined, ip);
  await security.afterRegistration(username, ip, review.relatedBannedUsernames);
}

async function testRegistrationAndScanning() {
  const dir = await tempDir('policy');
  const store = new UserStore(dir);
  const audit = new SecurityAuditStore(dir);
  await store.ensureReady();
  await audit.ensureReady();
  let now = Date.now();
  const registration = new RegistrationSecurity(store, audit, () => now);

  await registerProtected(registration, 'fuckcheng', '203.0.113.10');
  assert.equal(store.getBanStatus('fuckcheng').banned, false);
  assert.equal(audit.list({ type: 'username_manual_review' })[0].ip, '203.0.113.10');
  for (let index = 1; index <= 30; index += 1) {
    const username = `batch_${index}`;
    await registerProtected(registration, username, '203.0.113.11');
    assert.equal(store.getBanStatus(username).banned, false);
  }
  now = Date.now();
  const limited = await registration.review('batch_31', '203.0.113.11');
  assert.equal(limited.allowed, false);
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, REGISTRATION_DENIAL_MS / 1000);
  assert.equal(store.getPublicProfile('batch_31'), null);
  const restartedAudit = new SecurityAuditStore(dir);
  await restartedAudit.ensureReady();
  const restartedRegistration = new RegistrationSecurity(store, restartedAudit, () => now + 1000);
  assert.equal((await restartedRegistration.review('batch_32', '203.0.113.11')).allowed, false);
  assert.ok(restartedAudit.count('registration_rate_limited') >= 2, 'every rejected attempt is audited');
  now += REGISTRATION_DENIAL_MS + 2000;
  assert.equal((await registration.review('batch_31', '203.0.113.11')).allowed, true);

  await registerProtected(registration, 'banned_peer', '203.0.113.12');
  await store.banUser('banned_peer', -1, '管理员手动封禁');
  const evasionReview = await registration.review('new_peer', '203.0.113.12');
  assert.deepEqual(evasionReview.relatedBannedUsernames, ['banned_peer']);
  await registerProtected(registration, 'new_peer', '203.0.113.12');
  const evasion = audit.list({ type: 'possible_ban_evasion' })[0];
  assert.equal(evasion.username, 'new_peer');
  assert.deepEqual(evasion.relatedUsernames, ['banned_peer']);
  assert.equal(store.getBanStatus('new_peer').banned, false);

  const sid = await store.rotateSession('fuckcheng');
  assert.equal(store.isSessionValid('fuckcheng', sid), true);
  assert.equal(store.getBanStatus('fuckcheng').banned, false);
  console.log('PASS registration review-only, session preservation, limits and ban-evasion review');
}

async function testAuditBounds() {
  const dir = await tempDir('bounds');
  const audit = new SecurityAuditStore(dir);
  await audit.ensureReady();
  await Promise.all(
    Array.from({ length: SECURITY_AUDIT_MAX_ENTRIES + 50 }, (_, index) =>
      audit.record({
        type: 'username_rejected',
        action: 'reject_registration',
        reason: '界'.repeat(300),
        username: `user${index}`,
        ip: '203.0.113.30',
      }),
    ),
  );
  assert.equal(audit.list({}, 100).length, 100);
  const snapshot = JSON.parse(await readFile(path.join(dir, 'security-audit.json'), 'utf8'));
  assert.ok(snapshot.entries.length <= SECURITY_AUDIT_MAX_ENTRIES);
  assert.ok((await stat(path.join(dir, 'security-audit.json'))).size <= SECURITY_AUDIT_MAX_BYTES);
  assert.equal((await stat(path.join(dir, 'security-audit.json'))).mode & 0o777, 0o600);
  console.log('PASS security audit 0600, atomic persistence, 2000 entries and 2 MiB bounds');
}

async function testHttpApi() {
  const dir = await tempDir('http');
  const secret = 'admin-security-http-secret';
  const setup = new UserStore(dir);
  await setup.ensureReady();
  await setup.register('security_admin', 'password1', undefined, '198.51.100.1');
  await setup.register('fucklegacy', 'password1', undefined, '198.51.100.2');
  const legacySid = await setup.rotateSession('fucklegacy');
  const adminCookie = `auth_token=${jwt.sign({ sub: 'security_admin', sid: await setup.rotateSession('security_admin') }, secret)}`;
  const legacyCookie = `auth_token=${jwt.sign({ sub: 'fucklegacy', sid: legacySid }, secret)}`;
  const { CaptchaService } = require('../dist/server/captcha-service.js');
  CaptchaService.prototype.verifyAndConsume = () => ({ ok: true });
  process.env.ROKA_DATA_DIR = dir;
  process.env.JWT_SECRET = secret;
  process.env.WEBHOOK_SECRET = secret;
  process.env.NODE_ENV = 'test';
  process.env.ROKA_STATIC_CDN = '0';
  const { app, boot } = require('../dist/server.js');
  await boot(false);
  const request = (method, url, { cookie, ip, body } = {}) =>
    app.inject({
      method,
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(ip ? { 'x-real-ip': ip } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const register = async (username, ip) => {
    const response = await request('POST', '/api/auth/register', {
      ip,
      body: { username, password: 'password1', captchaId: 'test', captchaCode: 'test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookies = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie']
      : [response.headers['set-cookie']];
    return cookies.find((cookie) => cookie.startsWith('auth_token=')).split(';')[0];
  };
  try {
    for (const [cookie, status] of [
      [undefined, 401],
      [legacyCookie, 403],
    ]) {
      const response = await request('GET', '/api/admin/security/dashboard', { cookie });
      assert.equal(response.statusCode, status);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    let normalCookie = await register('normal_http', '198.51.100.3');
    assert.equal(
      (await request('GET', '/api/admin/security/events', { cookie: normalCookie })).statusCode,
      403,
    );
    const denied = await request('POST', '/api/auth/register', {
      ip: '198.51.100.4',
      body: { username: 'FUCKnew', password: 'password1', captchaId: 'test', captchaCode: 'test' },
    });
    assert.equal(denied.statusCode, 200);

    const login = await request('POST', '/api/auth/login', {
      ip: '2001:0DB8::2',
      body: { username: 'normal_http', password: 'password1', captchaId: 'test', captchaCode: 'test' },
    });
    assert.equal(login.statusCode, 200);
    const loginCookies = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie']
      : [login.headers['set-cookie']];
    normalCookie = loginCookies.find((cookie) => cookie.startsWith('auth_token=')).split(';')[0];
    const activity = await request('GET', '/api/auth/me', { cookie: normalCookie, ip: '198.51.100.5' });
    assert.equal(activity.statusCode, 200);
    const users = await request('GET', '/api/admin/users', { cookie: adminCookie });
    assert.equal(users.statusCode, 200);
    assert.equal(users.headers['cache-control'], 'no-store');
    const normal = users.json().items.find((user) => user.username === 'normal_http');
    assert.equal(normal.registeredIp, '198.51.100.3');
    assert.equal(normal.lastIp, '198.51.100.5');
    assert.ok(normal.ipHistory.some((item) => item.ip === '2001:db8::2'));
    const publicProfile = await request('GET', '/api/profile/normal_http');
    assert.equal(publicProfile.statusCode, 200);
    assert.equal(JSON.stringify(publicProfile.json()).includes('198.51.100.3'), false);
    assert.equal(JSON.stringify(publicProfile.json()).includes('ipHistory'), false);
    // Periodic content scan is the only added inspection path; publishing stays available.
    const published = await request('POST', '/api/feeds', {
      cookie: normalCookie,
      body: { text: '傻逼 <script>alert(1)</script>' },
    });
    assert.equal(published.statusCode, 200, published.body);
    const postId = published.json().post.id;
    const contentEvents = await request('GET', '/api/admin/security/events?type=content_manual_review', {
      cookie: adminCookie,
    });
    assert.equal(contentEvents.headers['cache-control'], 'no-store');
    assert.ok(contentEvents.json().items.some((e) => e.content.postId === postId));
    assert.equal(contentEvents.json().items.length, 1);
    const edit = await request('POST', '/api/feeds/edit', {
      cookie: normalCookie,
      body: { id: postId, text: '草泥马' },
    });
    assert.equal(edit.statusCode, 200);
    const comment = await request('POST', '/api/feeds/comment', {
      cookie: normalCookie,
      body: { id: postId, text: 'nmsl' },
    });
    assert.equal(comment.statusCode, 200);
    const countReviews = async () =>
      (
        await request('GET', '/api/admin/security/events?type=content_manual_review', { cookie: adminCookie })
      ).json().items.length;
    assert.equal(await countReviews(), 3);
    await request('GET', '/api/feeds');
    await request('POST', '/api/feeds/like', { cookie: normalCookie, body: { id: postId } });
    const removed = await request('POST', '/api/feeds/comment/delete', {
      cookie: normalCookie,
      body: { id: postId, commentId: comment.json().comment.id },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await countReviews(), 3, 'reads, likes and deletion do not create reviews');

    const adminBefore = (await request('GET', '/api/admin/users', { cookie: adminCookie })).json().items;
    const publicFeeds = await request('GET', '/api/feeds');
    assert.ok(publicFeeds.json().items.some((p) => p.id === postId));
    for (const field of ['contentResult', 'versionTime', 'terms', 'content_manual_review'])
      assert.equal(publicFeeds.body.includes(field), false);
    assert.deepEqual(
      (await request('GET', '/api/admin/users', { cookie: adminCookie }))
        .json()
        .items.map(({ lastSeenAt, ...user }) => user),
      adminBefore.map(({ lastSeenAt, ...user }) => user),
    );
    const scan = await request('POST', '/api/admin/security/scan', { cookie: adminCookie, body: {} });
    assert.equal(scan.statusCode, 404);
    assert.equal((await request('GET', '/api/auth/me', { cookie: legacyCookie })).statusCode, 200);
    const dashboard = await request('GET', '/api/admin/security/dashboard', { cookie: adminCookie });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().summary.totalUsers, 4);
    assert.equal(dashboard.json().summary.activeBans, 0);
    assert.equal(dashboard.json().summary.usernameAutoBans, 0);
    const events = await request('GET', '/api/admin/security/events?type=username_manual_review', {
      cookie: adminCookie,
    });
    assert.ok(events.json().items.some((entry) => entry.username === 'FUCKnew'));
    assert.equal(events.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
  console.log(
    'PASS admin HTTP permissions/no-store, registration/login IP, public privacy and session revocation',
  );
}

try {
  await testPolicy();
  await testIpStorage();
  await testRegistrationAndScanning();
  await testAuditBounds();
  await testHttpApi();
} finally {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
}
