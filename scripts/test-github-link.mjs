import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GITHUB_STAR_BADGE_MAX_AGE_MS, UserStore } from '../dist/auth-store.js';
import {
  GITHUB_STAR_CACHE_TTL_MS,
  GithubService,
  GithubServiceError,
} from '../dist/server/github-service.js';
import { StargazerService } from '../dist/server/stargazer-service.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');
const JWT_SECRET = 'github-link-test-fixed-jwt-secret-2026';
const HARD_TIMEOUT_MS = 180_000;
const children = new Set();
const temporaryDirectories = new Set();
let mockServer = null;
let finished = false;

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function killChildrenSync() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function cleanupSync() {
  killChildrenSync();
  if (mockServer) {
    mockServer.closeAllConnections();
    mockServer.close();
  }
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const hardTimeout = setTimeout(() => {
  if (finished) return;
  finished = true;
  cleanupSync();
  console.error(`github-link tests failed: hard timeout ${HARD_TIMEOUT_MS}ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

process.on('SIGINT', () => {
  cleanupSync();
  process.exit(130);
});

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function cleanup() {
  for (const child of children) await stopChild(child);
  if (mockServer) {
    await new Promise((resolve) => {
      mockServer.close(() => resolve());
      mockServer.closeAllConnections();
    });
    mockServer = null;
  }
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}

function log(message) {
  console.log(`[github-link] ${message}`);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status) {
  return new Response(null, { status });
}

async function expectGithubError(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof GithubServiceError, `expected GithubServiceError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function encryptedRecord(id, token = `v1.unit.${id}.ciphertext`, overrides = {}) {
  return {
    id,
    login: `github-${id}`,
    linkedAt: 1_000_000,
    accessTokenEncrypted: token,
    ...overrides,
  };
}

function assertNoSensitiveDto(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('accessTokenEncrypted'), false);
  assert.equal(serialized.includes('refresh_token'), false);
  assert.equal(serialized.includes('raw-unit-access-token'), false);
}

async function createStoreWithUsers(names) {
  const directory = temporaryDirectory('roka-github-store-');
  const store = new UserStore(directory);
  await store.ensureReady();
  for (const name of names) await store.register(name, 'unit-test-password');
  return { directory, store };
}

async function testUserStore() {
  const { directory, store } = await createStoreWithUsers(['alice', 'bob', 'carol']);
  const rawToken = 'raw-unit-access-token';
  await store.linkGithub('alice', encryptedRecord(101, `v1.${rawToken}.cipher`));
  assert.equal(store.findUsernameByGithubId(101), 'alice');

  await assert.rejects(store.linkGithub('bob', encryptedRecord(101)), /已绑定其他/);
  assert.equal(store.findUsernameByGithubId(101), 'alice');
  assert.equal(store.getGithubCredential('bob'), null);

  const concurrent = await Promise.allSettled([
    store.linkGithub('bob', encryptedRecord(303)),
    store.linkGithub('carol', encryptedRecord(303)),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
  await store.unlinkGithub(store.findUsernameByGithubId(303));
  assert.equal(store.findUsernameByGithubId(303), null);

  await store.linkGithub('alice', encryptedRecord(202, 'v1.second.cipher'));
  assert.equal(store.findUsernameByGithubId(101), null, 'rebinding releases the previous numeric ID');
  assert.equal(store.findUsernameByGithubId(202), 'alice');
  await store.linkGithub('bob', encryptedRecord(101));

  await assert.rejects(store.linkGithub('alice', encryptedRecord(101)), /已绑定其他/);
  assert.equal(store.getGithubCredential('alice').id, 202, 'failed rebind preserves the old binding');
  assert.equal(store.findUsernameByGithubId(202), 'alice');
  assert.equal(store.findUsernameByGithubId(101), 'bob');

  assert.equal(await store.updateGithubStar('alice', 202, true, 2_000_000), true);
  assert.equal(await store.updateGithubStar('alice', 101, false, 2_000_001), false);
  assert.equal(store.getGithubCredential('alice').starred, true);
  assert.equal(store.getGithubCredential('alice').starVerifiedAt, 2_000_000);
  assert.equal(store.getGithubCredential('bob').starred, undefined, 'late update cannot touch another ID');

  assert.equal(store.getGithubPublicProfile('alice', 2_000_001).starred, true);
  const stale = store.getGithubPublicProfile('alice', 2_000_000 + GITHUB_STAR_BADGE_MAX_AGE_MS + 1);
  assert.equal(stale.starred, false);
  assert.equal(stale.starState, 'stale');

  assertNoSensitiveDto(store.getPublicProfile('alice'));
  assertNoSensitiveDto(store.listUsersForAdmin());

  const restarted = new UserStore(directory);
  await restarted.ensureReady();
  assert.equal(restarted.findUsernameByGithubId(202), 'alice');
  assert.equal(restarted.findUsernameByGithubId(101), 'bob');
  assert.equal(restarted.getGithubCredential('alice').accessTokenEncrypted, 'v1.second.cipher');
  assert.equal(restarted.getGithubCredential('alice').starred, true);

  assert.equal(await restarted.unlinkGithub('alice'), true);
  assert.equal(await restarted.unlinkGithub('alice'), false);
  assert.equal(restarted.findUsernameByGithubId(202), null);
  await restarted.linkGithub('carol', encryptedRecord(202));
  assert.equal(restarted.findUsernameByGithubId(202), 'carol', 'unlink releases the numeric ID');

  const afterUnlinkRestart = new UserStore(directory);
  await afterUnlinkRestart.ensureReady();
  assert.equal(afterUnlinkRestart.getGithubCredential('alice'), null);
  assert.equal(afterUnlinkRestart.findUsernameByGithubId(202), 'carol');
  log('passed UserStore uniqueness, conflict rollback, unlink, persistence, expected ID and DTO checks');
}

function makeService(store, fetchImpl, nowRef, extra = {}) {
  return new GithubService({
    userStore: store,
    stargazerService: { isStarred: () => true },
    jwtSecret: JWT_SECRET,
    clientId: 'unit-client-id',
    clientSecret: 'unit-client-secret',
    redirectUri: 'http://127.0.0.1/api/auth/github/callback',
    oauthBaseUrl: 'https://oauth.unit.test',
    apiBaseUrl: 'https://api.unit.test',
    fetchImpl,
    now: () => nowRef.value,
    timeoutMs: 25,
    ...extra,
  });
}

function startQuery(service, actor, code = 'unit-code') {
  const authorizationUrl = new URL(service.startLink(actor));
  return {
    authorizationUrl,
    query: { code, state: authorizationUrl.searchParams.get('state') },
  };
}

function readFilesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...readFilesRecursively(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function assertDiskDoesNotContain(directory, secrets) {
  for (const file of readFilesRecursively(directory)) {
    const content = fs.readFileSync(file);
    for (const secret of secrets) {
      assert.equal(
        content.includes(Buffer.from(secret)),
        false,
        `${path.basename(file)} contains a raw OAuth secret`,
      );
    }
  }
}

async function testOAuthSuccessAndCrypto() {
  const { directory, store } = await createStoreWithUsers(['alice']);
  const nowRef = { value: 5_000_000 };
  const rawToken = 'raw-oauth-access-token-never-persist';
  const refreshToken = 'raw-oauth-refresh-token-never-persist';
  const requests = [];
  let tokenRequestBody;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/login/oauth/access_token')) {
      tokenRequestBody = new URLSearchParams(init.body);
      return jsonResponse(200, {
        access_token: rawToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
      });
    }
    if (String(url).endsWith('/user')) {
      assert.equal(init.headers.Authorization, `Bearer ${rawToken}`);
      return jsonResponse(200, { id: 42, login: 'octocat', type: 'User' });
    }
    if (String(url).endsWith('/user/starred/oimasterkafuu/Roka')) return emptyResponse(204);
    throw new Error(`unexpected request ${url}`);
  };
  const service = makeService(store, fetchImpl, nowRef);
  const actor = { username: 'alice', sid: await store.rotateSession('alice') };
  const { authorizationUrl, query } = startQuery(service, actor);
  assert.equal(authorizationUrl.origin, 'https://oauth.unit.test');
  assert.equal(authorizationUrl.pathname, '/login/oauth/authorize');
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'unit-client-id');
  assert.equal(
    authorizationUrl.searchParams.get('redirect_uri'),
    'http://127.0.0.1/api/auth/github/callback',
  );
  assert.equal(authorizationUrl.searchParams.get('scope'), 'read:user');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(query.state.length >= 40);
  const challenge = authorizationUrl.searchParams.get('code_challenge');

  const profile = await service.completeLink(actor, query);
  assert.equal(profile.login, 'octocat');
  assert.equal(profile.starred, true);
  assert.equal(tokenRequestBody.get('code'), 'unit-code');
  assert.equal(tokenRequestBody.get('client_id'), 'unit-client-id');
  assert.equal(tokenRequestBody.get('client_secret'), 'unit-client-secret');
  assert.equal(tokenRequestBody.get('redirect_uri'), 'http://127.0.0.1/api/auth/github/callback');
  const verifier = tokenRequestBody.get('code_verifier');
  assert.ok(verifier.length >= 40);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.equal(requests[1].init.redirect, 'error');
  assert.ok(requests[1].init.signal instanceof AbortSignal);

  const credential = store.getGithubCredential('alice');
  assert.equal(credential.id, 42);
  assert.equal(Object.hasOwn(credential, 'refresh_token'), false);
  assert.equal(Object.hasOwn(credential, 'accessToken'), false);
  const encrypted = credential.accessTokenEncrypted;
  const parts = encrypted.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64url').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64url').length, 16);
  const key = createHmac('sha256', JWT_SECRET).update('roka:github-token:v1').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  assert.equal(
    Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'),
    rawToken,
  );
  assertNoSensitiveDto(profile);
  assertDiskDoesNotContain(directory, [rawToken, refreshToken]);

  await expectGithubError(() => service.completeLink(actor, query), 'state');
  const restarted = new UserStore(directory);
  await restarted.ensureReady();
  assert.equal(restarted.getGithubCredential('alice').accessTokenEncrypted, encrypted);
  assert.equal(restarted.getGithubPublicProfile('alice', nowRef.value).starred, true);
  assertDiskDoesNotContain(directory, [rawToken, refreshToken]);
  log('passed OAuth URL, PKCE verifier, numeric /user identity, replay, AES-GCM and no-token-on-disk checks');
}

async function testOAuthFailures() {
  const { store } = await createStoreWithUsers(['alice', 'bob']);
  const nowRef = { value: 10_000_000 };
  let fetchCount = 0;
  const service = makeService(
    store,
    async () => {
      fetchCount += 1;
      return jsonResponse(500, {});
    },
    nowRef,
  );
  const actor = { username: 'alice', sid: await store.rotateSession('alice') };

  const unconfigured = new GithubService({
    userStore: store,
    stargazerService: { isStarred: () => null },
    jwtSecret: JWT_SECRET,
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.equal(unconfigured.isConfigured(), false);
  assert.throws(
    () => unconfigured.startLink(actor),
    (error) => error.code === 'not-configured',
  );
  await expectGithubError(
    () => unconfigured.completeLink(actor, { code: 'x', state: 'x' }),
    'not-configured',
  );
  assert.throws(
    () => service.startLink({ username: 'alice' }),
    (error) => error.code === 'state',
  );

  await expectGithubError(() => service.completeLink(actor, { code: 'x', state: 'wrong' }), 'state');
  const expired = startQuery(service, actor);
  nowRef.value += 10 * 60 * 1000 + 1;
  await expectGithubError(() => service.completeLink(actor, expired.query), 'state');

  const otherUser = startQuery(service, actor);
  await expectGithubError(
    () => service.completeLink({ username: 'bob', sid: 'sid-b' }, otherUser.query),
    'state',
  );
  const otherSession = startQuery(service, actor);
  await expectGithubError(
    () => service.completeLink({ username: 'alice', sid: 'sid-late-login' }, otherSession.query),
    'state',
  );
  const denied = startQuery(service, actor);
  await expectGithubError(
    () => service.completeLink(actor, { ...denied.query, error: 'access_denied' }),
    'denied',
  );
  const missingCode = startQuery(service, actor);
  await expectGithubError(() => service.completeLink(actor, { state: missingCode.query.state }), 'exchange');
  const longCode = startQuery(service, actor);
  await expectGithubError(
    () => service.completeLink(actor, { state: longCode.query.state, code: 'x'.repeat(513) }),
    'exchange',
  );
  assert.equal(fetchCount, 0, 'state, denial and malformed callback errors must not call GitHub');

  let mode = '';
  const upstream = makeService(
    store,
    async (url) => {
      const target = String(url);
      if (target.endsWith('/login/oauth/access_token')) {
        if (mode === 'exchange-http') return jsonResponse(500, { message: 'upstream' });
        if (mode === 'exchange-throw') throw new Error('network down');
        if (mode === 'exchange-json') return new Response('not-json', { status: 200 });
        if (mode === 'exchange-token') return jsonResponse(200, { refresh_token: 'not-enough' });
        return jsonResponse(200, { access_token: 'raw-upstream-token' });
      }
      if (target.endsWith('/user')) {
        if (mode === 'identity-http') return jsonResponse(503, { message: 'upstream' });
        if (mode === 'identity-json') return new Response('not-json', { status: 200 });
        if (mode === 'identity-id') return jsonResponse(200, { id: '42', login: 'octocat', type: 'User' });
        if (mode === 'identity-login')
          return jsonResponse(200, { id: 42, login: 'bad--login', type: 'User' });
        if (mode === 'identity-type') return jsonResponse(200, { id: 42, login: 'octocat', type: 'Bot' });
        return jsonResponse(200, { id: 42, login: 'octocat', type: 'User' });
      }
      return emptyResponse(404);
    },
    nowRef,
  );
  const cases = [
    ['exchange-http', 'exchange'],
    ['exchange-throw', 'exchange'],
    ['exchange-json', 'exchange'],
    ['exchange-token', 'exchange'],
    ['identity-http', 'identity'],
    ['identity-json', 'identity'],
    ['identity-id', 'identity'],
    ['identity-login', 'identity'],
    ['identity-type', 'identity'],
  ];
  for (const [scenario, expected] of cases) {
    mode = scenario;
    const attempt = startQuery(upstream, actor, `code-${scenario}`);
    await expectGithubError(() => upstream.completeLink(actor, attempt.query), expected);
    assert.equal(store.getGithubCredential('alice'), null, `${scenario} must not create a partial binding`);
  }

  mode = '';
  const original = startQuery(upstream, actor, 'original-binding');
  await upstream.completeLink(actor, original.query);
  assert.equal(store.getGithubCredential('alice').id, 42);
  mode = 'exchange-http';
  const failedRebind = startQuery(upstream, actor, 'failed-rebind');
  await expectGithubError(() => upstream.completeLink(actor, failedRebind.query), 'exchange');
  assert.equal(store.getGithubCredential('alice').id, 42, 'failed OAuth rebind preserves the old identity');
  log('passed OAuth state/expiry/replay/cross-user SID/denied/malformed/upstream failure checks');
}

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  await within(
    (async () => {
      while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    message,
    timeoutMs,
  );
}

async function testStargazerService() {
  const directory = temporaryDirectory('roka-stargazers-unit-');
  const filePath = path.join(directory, 'github-stargazers.json');
  const nowRef = { value: 40_000_000 };
  const logger = { info() {}, warn() {}, error() {} };
  const requests = [];
  const first = {
    login: 'FirstUser',
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    starred_at: '2026-01-01T00:00:00Z',
  };
  const second = {
    login: 'SecondUser',
    avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
    starred_at: '2026-02-01T00:00:00Z',
  };
  const service = new StargazerService({
    filePath,
    token: 'stargazer-unit-token',
    apiBaseUrl: 'https://api.unit.test',
    now: () => nowRef.value,
    logger,
    fetchImpl: async (url, init) => {
      const target = String(url);
      requests.push({ url: target, init });
      assert.equal(init.headers.Authorization, 'Bearer stargazer-unit-token');
      if (!target.includes('page=2')) {
        return new Response(JSON.stringify([first]), {
          status: 200,
          headers: {
            Link: '<https://api.unit.test/repos/oimasterkafuu/Roka/stargazers?per_page=100&page=2>; rel="next", <https://api.unit.test/repos/oimasterkafuu/Roka/stargazers?per_page=100&page=2>; rel="last"',
          },
        });
      }
      return jsonResponse(200, [second]);
    },
  });
  assert.equal(service.isStarred('FirstUser'), null);
  await service.start();
  await waitForCondition(() => requests.length === 2 && service.getFetchedAt() !== null, 'initial pagination');
  assert.equal(requests.length, 2);
  assert.equal(service.isStarred('firstuser'), true);
  assert.equal(service.isStarred('missing'), false);
  assert.deepEqual(
    service.listStargazers().map((item) => item.login),
    ['SecondUser', 'FirstUser'],
  );
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.fetchedAt, nowRef.value);
  assert.deepEqual(Object.keys(persisted.stars).sort(), ['firstuser', 'seconduser']);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  service.stop();

  const originalDisk = fs.readFileSync(filePath, 'utf8');
  const fallback = new StargazerService({
    filePath,
    token: 'stargazer-unit-token',
    apiBaseUrl: 'https://api.unit.test',
    logger,
    fetchImpl: async () => jsonResponse(500, { message: 'limited' }),
  });
  await fallback.start();
  assert.equal(fallback.isStarred('FIRSTUSER'), true, 'old data is available before the refresh finishes');
  assert.equal(await fallback.refresh(), false);
  assert.equal(fallback.getFetchedAt(), nowRef.value);
  assert.equal(fallback.listStargazers().length, 2);
  assert.match(fallback.getLastError(), /500/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), originalDisk, 'failed refresh preserves the old table');
  fallback.stop();

  let attempts = 0;
  const retry = new StargazerService({
    filePath: path.join(directory, 'retry.json'),
    token: 'stargazer-unit-token',
    apiBaseUrl: 'https://api.unit.test',
    retryIntervalMs: 25,
    syncIntervalMs: 60_000,
    logger,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse(500, {}) : jsonResponse(200, [first]);
    },
  });
  await retry.start();
  await waitForCondition(() => attempts >= 2 && retry.getFetchedAt() !== null, 'failed sync did not retry');
  assert.equal(retry.getLastError(), null);
  assert.equal(await retry.handleStarEvent('created', 'ThirdUser', 'https://avatars.githubusercontent.com/u/3'), true);
  assert.equal(await retry.handleStarEvent('deleted', 'firstuser'), true);
  const eventDisk = JSON.parse(fs.readFileSync(path.join(directory, 'retry.json'), 'utf8'));
  assert.equal(eventDisk.stars.firstuser, undefined);
  assert.equal(eventDisk.stars.thirduser.login, 'ThirdUser');
  assert.equal(eventDisk.stars.thirduser.avatarUrl, 'https://avatars.githubusercontent.com/u/3');
  retry.stop();
  const stoppedAttempts = attempts;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, stoppedAttempts, 'stop clears the retry timer');
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('stargazer-unit-token'), false);
  log('passed stargazer pagination, bearer auth, persistence, failure fallback, retry and event updates');
}

async function createStarCase(username, id, initialStarStatus = 204) {
  const { directory, store } = await createStoreWithUsers([username]);
  const nowRef = { value: 20_000_000 };
  const rawToken = `raw-star-token-${id}`;
  const refreshToken = `refresh-star-token-${id}`;
  const fixture = {
    directory,
    store,
    nowRef,
    rawToken,
    starCalls: 0,
    lookupCalls: 0,
    starStatus: initialStarStatus === 204 ? true : initialStarStatus === 404 ? false : null,
  };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/login/oauth/access_token')) {
      return jsonResponse(200, { access_token: rawToken, refresh_token: refreshToken });
    }
    if (target.endsWith('/user')) return jsonResponse(200, { id, login: `gh-${id}`, type: 'User' });
    if (target.endsWith('/user/starred/oimasterkafuu/Roka')) fixture.starCalls += 1;
    throw new Error(`unexpected URL ${target}`);
  };
  fixture.service = makeService(store, fetchImpl, nowRef, {
    stargazerService: {
      isStarred: (login) => {
        assert.equal(login, `gh-${id}`);
        fixture.lookupCalls += 1;
        return fixture.starStatus;
      },
    },
  });
  fixture.actor = { username, sid: await store.rotateSession(username) };
  fixture.complete = async () => {
    const attempt = startQuery(fixture.service, fixture.actor, `star-code-${id}`);
    return fixture.service.completeLink(fixture.actor, attempt.query);
  };
  return fixture;
}

async function testStarStatesAndCache() {
  const starred = await createStarCase('starred', 501, 204);
  assert.equal((await starred.complete()).starred, true);
  assert.equal(starred.starCalls, 0);
  assert.equal(starred.lookupCalls, 1);
  starred.nowRef.value += GITHUB_STAR_CACHE_TTL_MS - 1;
  await starred.service.refreshStar('starred');
  assert.equal(starred.lookupCalls, 1, 'fresh 15-minute result is cached');
  starred.nowRef.value += 2;
  await Promise.all([starred.service.refreshStar('starred'), starred.service.refreshStar('starred', true)]);
  assert.equal(starred.lookupCalls, 2, 'expired and forced concurrent local refreshes are deduplicated');
  assert.equal(starred.store.getGithubPublicProfile('starred', starred.nowRef.value).starred, true);

  starred.nowRef.value += GITHUB_STAR_BADGE_MAX_AGE_MS + 1;
  const stale = starred.store.getGithubPublicProfile('starred', starred.nowRef.value);
  assert.equal(stale.starred, false);
  assert.equal(stale.starState, 'stale');

  starred.starStatus = false;
  const revoked = await starred.service.refreshStar('starred', true);
  assert.equal(revoked.starred, false);
  assert.equal(revoked.starState, 'not-starred');

  starred.starStatus = null;
  const unknown = await starred.service.refreshStar('starred', true);
  assert.equal(unknown.starred, false);
  assert.equal(unknown.starState, 'unknown');
  assert.equal(unknown.starVerifiedAt, null);
  assert.equal(starred.starCalls, 0);
  assertDiskDoesNotContain(starred.directory, [starred.rawToken, `refresh-star-token-501`]);

  const notStarred = await createStarCase('notstarred', 502, 404);
  const notStarredProfile = await notStarred.complete();
  assert.equal(notStarredProfile.starred, false);
  assert.equal(notStarredProfile.starState, 'not-starred');
  assert.equal(notStarred.starCalls, 0);

  const notReady = await createStarCase('notready', 503, null);
  const notReadyProfile = await notReady.complete();
  assert.equal(notReadyProfile.starred, false);
  assert.equal(notReadyProfile.starState, 'unknown');
  assert.equal(notReadyProfile.starVerifiedAt, null);
  assert.equal(notReady.store.getGithubCredential('notready').starred, undefined);
  assert.equal(Object.hasOwn(notReady.store.getGithubCredential('notready'), 'starVerifiedAt'), false);
  assert.equal(notReady.starCalls, 0);
  assertDiskDoesNotContain(notReady.directory, [notReady.rawToken, 'refresh-star-token-503']);
  log('passed local Star true/false/unknown, no per-user API calls, cache, stale and revoke checks');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startGithubMock() {
  const state = {
    codes: new Map(),
    tokens: new Map(),
    stars: new Map(),
    exchanges: [],
    contributors: [],
    stargazers: [],
    stargazerRequests: [],
    userStarCalls: 0,
    port: 0,
    baseUrl: '',
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const sendJson = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const params = new URLSearchParams(await readRequestBody(request));
      const code = params.get('code');
      state.exchanges.push({ code, params });
      const token = state.codes.get(code);
      if (!token) return sendJson(400, { error: 'bad_verification_code' });
      return sendJson(200, {
        access_token: token,
        refresh_token: `refresh-token-for-${code}`,
        token_type: 'bearer',
      });
    }
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (request.method === 'GET' && url.pathname === '/user') {
      const identity = state.tokens.get(token);
      if (!identity) return sendJson(401, { message: 'bad credentials' });
      return sendJson(200, { ...identity, type: 'User' });
    }
    if (request.method === 'GET' && url.pathname === '/user/starred/oimasterkafuu/Roka') {
      state.userStarCalls += 1;
      return sendJson(410, { message: 'per-user star requests are disabled' });
    }
    if (request.method === 'GET' && url.pathname === '/repos/oimasterkafuu/Roka/stargazers') {
      state.stargazerRequests.push({ authorization, page: url.searchParams.get('page') ?? '1' });
      return sendJson(200, state.stargazers);
    }
    if (request.method === 'GET' && url.pathname === '/repos/oimasterkafuu/Roka/contributors') {
      return sendJson(200, state.contributors);
    }
    return sendJson(404, { message: 'unknown mock route' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  state.port = server.address().port;
  state.baseUrl = `http://127.0.0.1:${state.port}`;
  mockServer = server;
  return state;
}

function addMockIdentity(mock, code, id, login, starStatus = 204) {
  const token = `raw-integration-token-for-${code}`;
  mock.codes.set(code, token);
  mock.tokens.set(token, { id, login });
  mock.stars.set(token, starStatus);
  if (starStatus === 204 && !mock.stargazers.some((item) => item.login.toLowerCase() === login.toLowerCase())) {
    mock.stargazers.push({
      login,
      avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
      starred_at: '2026-01-01T00:00:00Z',
    });
  }
  return { token, refreshToken: `refresh-token-for-${code}` };
}

function contributor(login, id, contributions = 1) {
  return {
    ...(id === undefined ? {} : { id }),
    login,
    html_url: `https://github.com/${login}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id ?? 1}?v=4`,
    contributions,
    type: 'User',
  };
}

async function prepareIntegrationUsers(directory) {
  const store = new UserStore(directory);
  await store.ensureReady();
  const tokens = {};
  for (const username of ['alice', 'bob', 'carol']) {
    await store.register(username, 'integration-password');
    const sid = await store.rotateSession(username);
    tokens[username] = jwt.sign({ sub: username, sid }, JWT_SECRET, { expiresIn: '1h' });
  }
  return tokens;
}

function serverEnvironment(dataDir, mock, configured, port) {
  const env = {
    ...process.env,
    JWT_SECRET,
    WEBHOOK_SECRET: 'github-link-test-webhook-secret',
    NODE_ENV: 'test',
    ROKA_DATA_DIR: dataDir,
    ROKA_STATIC_CDN: '0',
    PORT: String(port),
    GITHUB_OAUTH_BASE_URL: mock.baseUrl,
    GITHUB_API_BASE_URL: mock.baseUrl,
    GITHUB_STARGAZERS_TOKEN: 'stargazer-integration-token',
    GITHUB_CLIENT_ID: configured ? 'integration-client-id' : '',
    GITHUB_CLIENT_SECRET: configured ? 'integration-client-secret' : '',
    GITHUB_REDIRECT_URI: configured ? `http://127.0.0.1:${port}/api/auth/github/callback` : '',
  };
  delete env.ROKA_BOT_TOKENS;
  return env;
}

async function startServer(dataDir, mock, configured) {
  const port = await findFreePort();
  const preloadPath = path.join(dataDir, `github-test-preload-${configured ? 'configured' : 'plain'}.mjs`);
  const mockOrigin = JSON.stringify(mock.baseUrl);
  fs.writeFileSync(
    preloadPath,
    `const originalFetch = globalThis.fetch;\n` +
      `const prefix = 'https://api.github.com/repos/oimasterkafuu/Roka/contributors';\n` +
      `globalThis.fetch = (input, init) => {\n` +
      `  const originalUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;\n` +
      `  if (originalUrl.startsWith(prefix)) {\n` +
      `    const rewritten = ${mockOrigin} + originalUrl.slice('https://api.github.com'.length);\n` +
      `    input = typeof input === 'string' ? rewritten : input instanceof URL ? new URL(rewritten) : new Request(rewritten, input);\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(preloadPath).href,
      path.join(rootDir, 'dist', 'server.js'),
      '--port',
      String(port),
    ],
    {
      cwd: rootDir,
      env: serverEnvironment(dataDir, mock, configured, port),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-30_000);
  });
  child.stderr.on('data', (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-30_000);
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited before ready\n${serverLog}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return { child, port, baseUrl: `http://127.0.0.1:${port}`, serverLog: () => serverLog };
      }
    } catch {
      // Retry until the real spawned server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server readiness timeout\n${serverLog}`);
}

function createApi(server, tokens, secretValues) {
  return async function api(pathname, { method = 'GET', user, body } = {}) {
    const headers = {};
    if (user) headers.Cookie = `auth_token=${encodeURIComponent(tokens[user])}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${server.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    for (const secret of secretValues) {
      assert.equal(text.includes(secret), false, `${method} ${pathname} leaked an OAuth secret`);
    }
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Redirects and non-JSON responses are intentionally supported.
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  };
}

function assertCallback(response, username, result) {
  assert.equal(response.status, 302, 'OAuth callback must be handled as a manual redirect');
  assert.equal(response.headers.get('location'), `/u/${username}?github=${result}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

function forbiddenDisplayKeys(value, location = '$', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (['github', 'star', 'starred', 'starState', 'starVerifiedAt', 'accessTokenEncrypted'].includes(key)) {
      found.push(`${location}.${key}`);
    }
    forbiddenDisplayKeys(child, `${location}.${key}`, found);
  }
  return found;
}

async function integrationStart(api, username) {
  const response = await api('/api/auth/github/start', { method: 'POST', user: username });
  assert.equal(response.status, 200);
  const url = new URL(response.json.url);
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'integration-client-id');
  assert.equal(url.searchParams.get('scope'), 'read:user');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('code_challenge'));
  return {
    state: url.searchParams.get('state'),
    challenge: url.searchParams.get('code_challenge'),
    redirectUri: url.searchParams.get('redirect_uri'),
  };
}

function assertExchangeVerifier(mock, code, expectedChallenge) {
  const record = mock.exchanges.find((entry) => entry.code === code);
  assert.ok(record, `missing token exchange for ${code}`);
  assert.equal(record.params.get('client_id'), 'integration-client-id');
  assert.equal(record.params.get('client_secret'), 'integration-client-secret');
  assert.equal(
    createHash('sha256').update(record.params.get('code_verifier')).digest('base64url'),
    expectedChallenge,
  );
}

async function sendStarWebhook(server, action, login, { validSignature = true } = {}) {
  const body = JSON.stringify({
    action,
    sender: { login, avatar_url: `https://avatars.githubusercontent.com/u/${login.length}?v=4` },
  });
  const secret = validSignature ? 'github-link-test-webhook-secret' : 'wrong-secret';
  const response = await fetch(`${server.baseUrl}/postreceive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'star',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
  return { status: response.status, json: await response.json() };
}

async function testIntegration() {
  const dataDir = temporaryDirectory('roka-github-integration-');
  const tokens = await prepareIntegrationUsers(dataDir);
  const mock = await startGithubMock();
  const secrets = [];
  const addIdentity = (code, id, login, star = 204) => {
    const pair = addMockIdentity(mock, code, id, login, star);
    secrets.push(pair.token, pair.refreshToken);
    return pair;
  };
  addIdentity('alice-code', 101, 'alice-github', 204);
  addIdentity('duplicate-alice', 101, 'alice-github', 204);
  addIdentity('bob-code', 202, 'bob-github', 204);
  addIdentity('rebind-conflict', 202, 'bob-github', 204);
  addIdentity('carol-code', 303, 'carol-github', 204);
  addIdentity('carol-rebind', 202, 'carol-new-github', 204);

  const unconfigured = await startServer(dataDir, mock, false);
  let api = createApi(unconfigured, tokens, secrets);
  const guestStargazers = await api('/api/stargazers');
  assert.equal(guestStargazers.status, 200);
  assert.ok(Array.isArray(guestStargazers.json.items));
  for (const [method, route] of [
    ['POST', '/api/auth/github/start'],
    ['GET', '/api/auth/github/callback?code=x&state=x'],
    ['POST', '/api/auth/github/unlink'],
    ['POST', '/api/auth/github/star/refresh'],
  ]) {
    const response = await api(route, { method });
    assert.equal(response.status, 401, `${method} ${route} must require authentication`);
  }
  const unconfiguredMe = await api('/api/auth/me', { user: 'alice' });
  assert.equal(unconfiguredMe.status, 200);
  assert.deepEqual(unconfiguredMe.json.github, { configured: false, link: null });
  const unavailableStart = await api('/api/auth/github/start', { method: 'POST', user: 'alice' });
  assert.equal(unavailableStart.status, 503);
  await stopChild(unconfigured.child);
  log('passed spawned-server protected routes and configured:false/start 503 checks');

  const server = await startServer(dataDir, mock, true);
  api = createApi(server, tokens, secrets);
  await within(
    (async () => {
      while (true) {
        const response = await api('/api/stargazers');
        assert.equal(response.status, 200);
        if (response.json.fetchedAt !== null) {
          assert.equal(response.json.items.length, mock.stargazers.length);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    'spawned server did not finish initial stargazer sync',
  );
  assert.ok(mock.stargazerRequests.length >= 2, 'both spawned servers load the full table');
  assert.ok(
    mock.stargazerRequests.every((request) => request.authorization === 'Bearer stargazer-integration-token'),
  );
  const configuredMe = await api('/api/auth/me', { user: 'alice' });
  assert.equal(configuredMe.json.github.configured, true);

  const aliceStart = await integrationStart(api, 'alice');
  assert.equal(aliceStart.redirectUri, `${server.baseUrl}/api/auth/github/callback`);
  const aliceCallback = await api(
    `/api/auth/github/callback?code=alice-code&state=${encodeURIComponent(aliceStart.state)}`,
    {
      user: 'alice',
    },
  );
  assertCallback(aliceCallback, 'alice', 'linked');
  assertExchangeVerifier(mock, 'alice-code', aliceStart.challenge);
  const replay = await api(
    `/api/auth/github/callback?code=alice-code&state=${encodeURIComponent(aliceStart.state)}`,
    {
      user: 'alice',
    },
  );
  assertCallback(replay, 'alice', 'state');

  const aliceProfile = await api('/api/profile/alice');
  assert.equal(aliceProfile.status, 200);
  assert.equal(aliceProfile.json.github.login, 'alice-github');
  assert.equal(aliceProfile.json.github.htmlUrl, 'https://github.com/alice-github');
  assert.equal(aliceProfile.json.github.starred, true);
  assert.equal(aliceProfile.json.github.starState, 'starred');
  assert.equal(aliceProfile.json.starred, true);
  assertNoSensitiveDto(aliceProfile.json);
  const starColors = await api('/api/user-colors?users=alice,bob,carol');
  assert.equal(starColors.status, 200);
  assert.deepEqual(starColors.json.colors.alice.starred, true);
  assert.deepEqual(starColors.json.colors.bob.starred, false);
  for (const appearance of Object.values(starColors.json.colors)) {
    assert.deepEqual(Object.keys(appearance).sort(), ['admin', 'banned', 'colorClass', 'starred', 'title']);
  }
  assertNoSensitiveDto(starColors.json);

  const starredPost = await api('/api/feeds', {
    method: 'POST',
    user: 'alice',
    body: { text: 'Starred feed author' },
  });
  assert.equal(starredPost.status, 200);
  assert.equal(starredPost.json.post.authorInfo.starred, starColors.json.colors.alice.starred);
  const plainComment = await api('/api/feeds/comment', {
    method: 'POST',
    user: 'bob',
    body: { id: starredPost.json.post.id, text: 'Plain feed commenter' },
  });
  assert.equal(plainComment.status, 200);
  assert.equal(plainComment.json.comment.authorInfo.starred, starColors.json.colors.bob.starred);
  const plainPost = await api('/api/feeds', {
    method: 'POST',
    user: 'bob',
    body: { text: 'Plain feed author' },
  });
  assert.equal(plainPost.status, 200);
  assert.equal(plainPost.json.post.authorInfo.starred, starColors.json.colors.bob.starred);
  const starredComment = await api('/api/feeds/comment', {
    method: 'POST',
    user: 'alice',
    body: { id: plainPost.json.post.id, text: 'Starred feed commenter' },
  });
  assert.equal(starredComment.status, 200);
  assert.equal(starredComment.json.comment.authorInfo.starred, starColors.json.colors.alice.starred);
  const feeds = await api('/api/feeds?limit=50');
  assert.equal(feeds.status, 200);
  const listedStarredPost = feeds.json.items.find((item) => item.id === starredPost.json.post.id);
  const listedPlainPost = feeds.json.items.find((item) => item.id === plainPost.json.post.id);
  assert.equal(listedStarredPost.authorInfo.starred, starColors.json.colors.alice.starred);
  assert.equal(listedStarredPost.comments[0].authorInfo.starred, starColors.json.colors.bob.starred);
  assert.equal(listedPlainPost.authorInfo.starred, starColors.json.colors.bob.starred);
  assert.equal(listedPlainPost.comments[0].authorInfo.starred, starColors.json.colors.alice.starred);
  await testProfileStarInitialBrowser(server.baseUrl, true);

  const badState = await api('/api/auth/github/callback?code=alice-code&state=definitely-wrong', {
    user: 'alice',
  });
  assertCallback(badState, 'alice', 'state');
  const crossUserStart = await integrationStart(api, 'bob');
  const crossUser = await api(
    `/api/auth/github/callback?code=bob-code&state=${encodeURIComponent(crossUserStart.state)}`,
    { user: 'alice' },
  );
  assertCallback(crossUser, 'alice', 'state');
  const crossUserReplay = await api(
    `/api/auth/github/callback?code=bob-code&state=${encodeURIComponent(crossUserStart.state)}`,
    { user: 'bob' },
  );
  assertCallback(crossUserReplay, 'bob', 'state');

  const duplicateStart = await integrationStart(api, 'bob');
  const duplicate = await api(
    `/api/auth/github/callback?code=duplicate-alice&state=${encodeURIComponent(duplicateStart.state)}`,
    { user: 'bob' },
  );
  assertCallback(duplicate, 'bob', 'conflict');
  assertExchangeVerifier(mock, 'duplicate-alice', duplicateStart.challenge);
  assert.equal((await api('/api/auth/me', { user: 'bob' })).json.github.link, null);
  assert.equal((await api('/api/profile/alice')).json.github.login, 'alice-github');

  const bobStart = await integrationStart(api, 'bob');
  assertCallback(
    await api(`/api/auth/github/callback?code=bob-code&state=${encodeURIComponent(bobStart.state)}`, {
      user: 'bob',
    }),
    'bob',
    'linked',
  );
  assertExchangeVerifier(mock, 'bob-code', bobStart.challenge);
  const carolStart = await integrationStart(api, 'carol');
  assertCallback(
    await api(`/api/auth/github/callback?code=carol-code&state=${encodeURIComponent(carolStart.state)}`, {
      user: 'carol',
    }),
    'carol',
    'linked',
  );

  const conflictStart = await integrationStart(api, 'alice');
  assertCallback(
    await api(
      `/api/auth/github/callback?code=rebind-conflict&state=${encodeURIComponent(conflictStart.state)}`,
      {
        user: 'alice',
      },
    ),
    'alice',
    'conflict',
  );
  assertExchangeVerifier(mock, 'rebind-conflict', conflictStart.challenge);
  assert.equal((await api('/api/profile/alice')).json.github.login, 'alice-github');
  assert.equal((await api('/api/profile/bob')).json.github.login, 'bob-github');

  mock.contributors = [contributor('alice-github', 101, 10), contributor('bob-github', 999, 5)];
  const contributors = await api('/api/contributors');
  assert.equal(contributors.status, 200);
  assert.equal(
    contributors.json.length,
    mock.contributors.length,
    'bound non-contributors must not be appended',
  );
  assert.equal(contributors.json[0].rokaUsername, 'alice');
  assert.equal(
    Object.hasOwn(contributors.json[1], 'rokaUsername'),
    false,
    'login alone must not resolve a Roka user',
  );
  assert.equal(
    contributors.json.some((entry) => entry.rokaUsername === 'carol'),
    false,
  );

  const deletedBob = await sendStarWebhook(server, 'deleted', 'BOB-GITHUB');
  assert.equal(deletedBob.status, 200);
  assert.equal(deletedBob.json.starred, false);
  assert.equal((await api('/api/profile/bob')).json.github.starState, 'not-starred');
  assert.equal(
    (await api('/api/stargazers')).json.items.some((item) => item.login.toLowerCase() === 'bob-github'),
    false,
  );
  assert.equal((await sendStarWebhook(server, 'created', 'bob-github', { validSignature: false })).status, 401);
  assert.equal((await api('/api/profile/bob')).json.github.starState, 'not-starred');
  const createdBob = await sendStarWebhook(server, 'created', 'BOB-GITHUB');
  assert.equal(createdBob.status, 200);
  assert.equal((await api('/api/profile/bob')).json.github.starred, true);
  assert.equal((await sendStarWebhook(server, 'created', 'outside-user')).status, 200);
  const webhookDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'github-stargazers.json'), 'utf8'));
  assert.equal(webhookDisk.stars['bob-github'].login, 'BOB-GITHUB');
  assert.equal(webhookDisk.stars['outside-user'].login, 'outside-user');

  const publicRoutes = [
    '/api/leaderboard',
    '/api/admin/users',
    '/api/contributors',
    '/api/stargazers',
    '/api/replays',
    '/api/online',
    '/api/users/search?q=',
    '/api/feeds',
    '/api/profile/alice/feeds',
    '/api/profile/alice/replays',
  ];
  for (const route of publicRoutes) {
    const response = await api(route, { user: route === '/api/admin/users' ? 'alice' : undefined });
    assert.equal(response.status, 200, route);
    const exposedKeys = forbiddenDisplayKeys(response.json).filter(
      (key) => !(route.endsWith('/feeds') && key.endsWith('.authorInfo.starred')),
    );
    assert.deepEqual(exposedKeys, [], `${route} unexpectedly exposes GitHub/Star display data`);
  }

  assert.deepEqual((await api('/api/auth/github/unlink', { method: 'POST', user: 'bob' })).json, {
    ok: true,
  });
  assert.equal((await api('/api/auth/me', { user: 'bob' })).json.github.link, null);
  assert.equal((await api('/api/profile/bob')).json.github, undefined);

  const carolRebindStart = await integrationStart(api, 'carol');
  assertCallback(
    await api(
      `/api/auth/github/callback?code=carol-rebind&state=${encodeURIComponent(carolRebindStart.state)}`,
      {
        user: 'carol',
      },
    ),
    'carol',
    'linked',
  );
  assert.equal((await api('/api/profile/carol')).json.github.login, 'carol-new-github');

  assert.equal((await sendStarWebhook(server, 'deleted', 'alice-github')).status, 200);
  const refreshed = await api('/api/auth/github/star/refresh', { method: 'POST', user: 'alice' });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.ok, true);
  assert.equal(refreshed.json.github.starred, false);
  assert.equal(refreshed.json.github.starState, 'not-starred');
  assertNoSensitiveDto(refreshed.json);
  const revokedProfile = await api('/api/profile/alice');
  assert.equal(revokedProfile.json.github.starred, false);
  assert.equal(revokedProfile.json.starred, false);
  const revokedColors = await api('/api/user-colors?users=alice,bob,carol');
  assert.equal(revokedColors.json.colors.alice.starred, false);
  assertNoSensitiveDto(revokedColors.json);
  await testProfileStarInitialBrowser(server.baseUrl, false);
  assert.equal((await api('/api/auth/github/star/refresh', { method: 'POST', user: 'bob' })).status, 404);
  assertDiskDoesNotContain(dataDir, secrets);

  await stopChild(server.child);
  const persisted = new UserStore(dataDir);
  await persisted.ensureReady();
  assert.equal(persisted.getGithubCredential('alice').id, 101);
  assert.equal(persisted.getGithubCredential('alice').starred, false);
  assert.equal(persisted.getGithubCredential('bob'), null);
  assert.equal(persisted.getGithubCredential('carol').id, 202);
  assert.equal(persisted.findUsernameByGithubId(303), null);
  assert.equal(mock.userStarCalls, 0, 'no binding, profile or refresh path may call /user/starred');
  assertDiskDoesNotContain(dataDir, secrets);
  log(
    'passed spawned OAuth, public stargazers, signed star webhooks, local refresh, DTO and persistence checks',
  );
}

async function testProfileStarInitialBrowser(baseUrl, expectedStarred) {
  const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/u/alice`);
    await page.waitForFunction(() => {
      const main = document.querySelector('#profile-main');
      const name = document.querySelector('#p-name');
      return main && getComputedStyle(main).display !== 'none' && name.textContent === 'alice';
    });
    await page.evaluate(async () => {
      window.htmlescape = (value) =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      delete usernameColorCache.alice;
      await usernameEnsureColors(['alice']);
      const host = document.createElement('div');
      host.id = 'star-public-component-fixtures';
      host.style.display = 'none';
      const domLink = usernameLink('alice').attr('id', 'star-dom-component');
      host.appendChild(domLink[0]);
      const htmlHost = document.createElement('div');
      htmlHost.innerHTML = usernameLinkHtml('alice');
      htmlHost.firstElementChild.id = 'star-html-component';
      host.appendChild(htmlHost);
      document.body.appendChild(host);
    });

    const name = page.locator('#p-name');
    assert.match(await name.getAttribute('class'), /(?:^|\s)rt-admin(?:\s|$)/);
    assert.equal(await name.getAttribute('title'), 'Headquarters');
    assert.equal(await name.evaluate((element) => getComputedStyle(element).color), 'rgb(0, 0, 0)');
    const components = [name, page.locator('#star-dom-component'), page.locator('#star-html-component')];
    for (const component of components) {
      assert.equal(await component.textContent(), 'alice');
      assert.equal(await component.locator('.username-star-initial').count(), expectedStarred ? 1 : 0);
      assert.equal(await component.evaluate((element) => getComputedStyle(element).color), 'rgb(0, 0, 0)');
      if (expectedStarred) {
        const initial = component.locator('.username-star-initial');
        assert.equal(await initial.textContent(), 'a');
        assert.equal(
          await initial.evaluate((element) => getComputedStyle(element).color),
          'rgb(184, 134, 11)',
        );
      } else {
        assert.equal(await component.evaluate((element) => element.children.length), 0);
      }
    }

    for (const starState of ['not-starred', 'unknown', 'stale']) {
      await page.evaluate((state) => {
        renderGithubProfile({
          login: 'alice-github',
          htmlUrl: 'https://github.com/alice-github',
          starred: true,
          starState: state,
          starVerifiedAt: Date.now(),
        });
      }, starState);
      for (const component of components) {
        assert.equal(
          await component.locator('.username-star-initial').count(),
          0,
          `${starState} must not be gold`,
        );
        assert.equal(await component.textContent(), 'alice');
        assert.equal(await component.evaluate((element) => element.children.length), 0);
      }
    }
    assert.deepEqual(errors, []);
    if (expectedStarred) {
      await page.route('**/api/leaderboard', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                username: 'alice',
                colorClass: 'rt-admin',
                title: 'Headquarters',
                admin: true,
                banned: false,
                rating: 1500,
                provisional: false,
              },
            ],
          }),
        }),
      );
      await page.route('**/api/online', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            count: 1,
            items: [
              {
                username: 'alice',
                colorClass: 'rt-admin',
                title: 'Headquarters',
                admin: true,
                banned: false,
                lastSeenAt: Date.now(),
              },
            ],
          }),
        }),
      );
      await page.goto(`${baseUrl}/`);
      const homeName = page.locator('#leaderboard-list [data-username="alice"]');
      await homeName.locator('.username-star-initial').waitFor();
      assert.equal(await homeName.locator('.username-star-initial').textContent(), 'a');
      assert.equal(await page.locator('#recently-online-list .username-star-initial').textContent(), 'a');
      assert.equal(await page.evaluate(() => document.cookie.includes('auth_token=')), false);
      await page.route('**/api/feeds?*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 1,
                author: 'alice',
                authorInfo: {
                  colorClass: 'rt-admin',
                  title: 'Headquarters',
                  admin: true,
                  banned: false,
                  starred: true,
                },
                text: 'hello',
                html: 'hello',
                time: Date.now(),
                likes: [],
                comments: [],
                canManage: false,
              },
            ],
            page: 1,
            pages: 1,
          }),
        }),
      );
      await page.evaluate(() => {
        delete usernameColorCache.alice;
        return loadFeeds(false);
      });
      const feedName = page.locator('#feed-list .feed-author[data-username="alice"]');
      await feedName.locator('.username-star-initial').waitFor();
      assert.equal(await feedName.locator('.username-star-initial').textContent(), 'a');
      await page.route('**/api/contributors', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([contributor('layout-contributor', 901, 1)]),
        }),
      );
      await page.route('**/api/stargazers', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              { login: 'star-supporter', avatarUrl: 'https://avatars.githubusercontent.com/u/902?v=4' },
            ],
            fetchedAt: 1,
          }),
        }),
      );
      await page.goto(`${baseUrl}/about`);
      await page.getByRole('heading', { name: 'Star 支持', exact: true }).waitFor();
      assert.match(
        await page.locator('.doc-panel').filter({ hasText: '全站公共用户名组件' }).textContent(),
        /全站公共用户名组件/,
      );
      await page.locator('#stargazers-grid .stargazer-card').waitFor();
      const supporterLink = page.locator('#stargazers-grid .contributor-link');
      assert.equal(await supporterLink.getAttribute('href'), 'https://github.com/star-supporter');
      assert.match(await supporterLink.getAttribute('rel'), /noopener/);
      assert.equal(await supporterLink.locator('.contributor-name').textContent(), 'star-supporter');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const selector of ['#contributors-grid', '#stargazers-grid']) {
          const metrics = await page.locator(selector).evaluate((grid) => ({
            gridWidth: grid.getBoundingClientRect().width,
            cardWidth: grid.querySelector('.contributor-card').getBoundingClientRect().width,
          }));
          assert.ok(Math.abs(metrics.gridWidth - metrics.cardWidth) <= 1, `${selector} at ${width}px`);
        }
      }
      await page.unroute('**/api/stargazers');
      await page.route('**/api/stargazers', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], fetchedAt: 1 }) }),
      );
      await page.goto(`${baseUrl}/about`);
      await page.getByText('暂时还没有 Star，欢迎成为第一位支持者', { exact: true }).waitFor();
      const link = page.getByRole('link', { name: '前往 GitHub 为 Roka 点 Star →' });
      assert.equal(await link.getAttribute('href'), 'https://github.com/oimasterkafuu/Roka');
      await Promise.all([
        page.waitForURL('**/ambassadors'),
        page.locator('[data-goto="/ambassadors"]').click(),
      ]);
      await page.locator('#ambassador-login [data-goto="/login"]').waitFor({ state: 'visible' });
      await Promise.all([
        page.waitForURL('**/login'),
        page.locator('#ambassador-login [data-goto="/login"]').click(),
      ]);
    }
  } finally {
    await browser.close();
  }
  log(
    `passed public DOM/HTML components and profile browser UI for ${expectedStarred ? 'starred' : 'not-starred'}`,
  );
}

function testStaticStarInitialPlacement() {
  const profileHtml = fs.readFileSync(path.join(rootDir, 'static', 'profile.html'), 'utf8');
  const profileJs = fs.readFileSync(path.join(rootDir, 'static', 'profile.js'), 'utf8');
  const profileCss = fs.readFileSync(path.join(rootDir, 'static', 'styles', 'profile.css'), 'utf8');
  const usernameJs = fs.readFileSync(path.join(rootDir, 'static', 'username.js'), 'utf8');
  const ratingCss = fs.readFileSync(path.join(rootDir, 'static', 'styles', 'rating.css'), 'utf8');
  const aboutHtml = fs.readFileSync(path.join(rootDir, 'static', 'about.html'), 'utf8');
  const aboutJs = fs.readFileSync(path.join(rootDir, 'static', 'about-contributors.js'), 'utf8');
  const starMarker = /github-star|username-star-initial|profile-star-initial|starred|starState/i;
  assert.equal(profileHtml.includes('p-github-star-badge'), false, 'redundant Star badge is removed');
  assert.equal(profileHtml.includes('profile-star-initial'), false);
  assert.equal(profileJs.includes('renderProfileName'), false, 'profile must reuse the public component');
  assert.equal(profileCss.includes('profile-star-initial'), false);
  assert.match(usernameJs, /function usernameTextHtml/);
  assert.match(usernameJs, /function usernameRenderText/);
  assert.match(ratingCss, /\.username-star-initial/);
  assert.match(aboutHtml, /Star 支持/);
  assert.match(aboutHtml, /全站公共用户名组件/);
  assert.match(aboutHtml, /id="stargazers-grid" class="contributors-grid"/);
  assert.equal((aboutHtml.match(/repeat\(auto-fit,/g) ?? []).length, 2);
  assert.match(aboutJs, /暂时还没有 Star，欢迎成为第一位支持者/);
  assert.match(aboutJs, /function aboutStargazerCard/);
  assert.match(aboutJs, /fetch\('\/api\/stargazers'/);
  assert.match(aboutHtml, /https:\/\/github\.com\/oimasterkafuu\/Roka/);
  const mainJs = fs.readFileSync(path.join(rootDir, 'static', 'main.js'), 'utf8');
  assert.equal(starMarker.test(mainJs), false, 'Star initial implementation leaked into static/main.js');
  const staticFiles = readFilesRecursively(path.join(rootDir, 'static')).filter((file) =>
    /\.(?:js|html|css)$/i.test(file),
  );
  for (const file of staticFiles) {
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    if (!starMarker.test(fs.readFileSync(file, 'utf8'))) continue;
    assert.ok(
      /^static\/(?:index\.html|username\.js|profile\.(?:js|html)|about\.html|about-contributors\.js|styles\/(?:profile|rating)\.css)$/.test(
        relative,
      ),
      `Star initial implementation belongs to the public component, found ${relative}`,
    );
  }
  log('passed static global Star initial placement, supporter wall and adaptive grid checks');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within(promise, message, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function testOAuthCancellationAndBodyTimeouts() {
  const { directory, store } = await createStoreWithUsers(['alice']);
  const nowRef = { value: 30_000_000 };
  const actor = { username: 'alice', sid: await store.rotateSession('alice') };
  const paths = {
    exchange: '/login/oauth/access_token',
    identity: '/user',
  };
  let held = null;
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    request.resume();
    if (request.url === '/user/starred/oimasterkafuu/Roka') {
      throw new Error('per-user Star request is forbidden');
    }
    if (held && request.url === paths[held.stage]) {
      const fixture = held;
      fixture.response = response;
      response.on('close', () => fixture.closed.resolve());
      response.writeHead(fixture.status, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{');
      return;
    }
    if (request.url === paths.exchange) {
      response.end(JSON.stringify({ access_token: 'local-http-regression-token' }));
    } else if (request.url === paths.identity) {
      response.end(JSON.stringify({ id: 9001, login: 'local-alice', type: 'User' }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = async (url, init) => {
    const response = await fetch(url, init);
    if (held && new URL(url).pathname === paths[held.stage]) {
      held.signal = init.signal;
      held.headers.resolve();
    }
    return response;
  };
  const service = makeService(store, nativeFetch, nowRef, {
    oauthBaseUrl: baseUrl,
    apiBaseUrl: baseUrl,
    timeoutMs: 2000,
  });
  const hold = (stage, status = 200) => {
    held = { stage, status, headers: deferred(), closed: deferred(), response: null, signal: null };
    return held;
  };
  const assertUnbound = async () => {
    assert.equal(store.getGithubCredential('alice'), null);
    assert.equal(store.findUsernameByGithubId(9001), null);
    const restarted = new UserStore(directory);
    await restarted.ensureReady();
    assert.equal(restarted.getGithubCredential('alice'), null, 'no late binding persisted');
  };
  try {
    const pending = startQuery(service, actor);
    await service.unlink('alice');
    const before = requestCount;
    await expectGithubError(() => service.completeLink(actor, pending.query), 'state');
    assert.equal(requestCount, before, 'cancelled pending state never calls GitHub');
    await assertUnbound();

    for (const stage of ['exchange', 'identity']) {
      const fixture = hold(stage);
      const attempt = startQuery(service, actor);
      const completion = service.completeLink(actor, attempt.query);
      const rejected = expectGithubError(() => completion, 'state');
      await within(fixture.headers.promise, `missing ${stage} response headers`);
      assert.equal(fixture.signal.aborted, false);
      await service.unlink('alice');
      await within(rejected, `unlink did not cancel ${stage}`);
      assert.equal(fixture.signal.aborted, true, `unlink aborts native fetch at ${stage}`);
      await within(fixture.closed.promise, `${stage} HTTP response not closed by abort`);
      await assertUnbound();
      held = null;
    }

    const superseded = hold('exchange');
    const old = startQuery(service, actor);
    const oldCompletion = service.completeLink(actor, old.query);
    const oldRejected = expectGithubError(() => oldCompletion, 'state');
    await within(superseded.headers.promise, 'old generation headers missing');
    const replacement = startQuery(service, actor);
    await within(oldRejected, 'old generation was not cancelled');
    await within(superseded.closed.promise, 'superseded request not closed');
    assert.equal(superseded.signal.aborted, true);
    held = null;
    assert.equal((await service.completeLink(actor, replacement.query)).login, 'local-alice');
    await service.unlink('alice');

    const oldSid = actor.sid;
    const stale = startQuery(service, actor);
    actor.sid = await store.rotateSession('alice');
    const beforeStale = requestCount;
    await expectGithubError(
      () => service.completeLink({ username: 'alice', sid: oldSid }, stale.query),
      'state',
    );
    assert.equal(requestCount, beforeStale);

    for (const invalidate of ['logout', 'rotate']) {
      actor.sid = await store.rotateSession('alice');
      const fixture = hold('identity');
      const attempt = startQuery(service, actor);
      const completion = service.completeLink(actor, attempt.query);
      const rejected = expectGithubError(() => completion, 'state');
      await within(fixture.headers.promise, 'session race response headers missing');
      if (invalidate === 'logout') await store.clearSession('alice');
      else await store.rotateSession('alice');
      fixture.response.end();
      await within(rejected, `${invalidate} session allowed late binding`);
      await within(fixture.closed.promise, 'completed response did not close');
      assert.equal(fixture.signal.aborted, false, 'successful HTTP response reaches pre-write check');
      await assertUnbound();
      held = null;
    }

    actor.sid = await store.rotateSession('alice');
    const timed = makeService(store, nativeFetch, nowRef, {
      oauthBaseUrl: baseUrl,
      apiBaseUrl: baseUrl,
      timeoutMs: 200,
    });
    for (const stage of ['exchange', 'identity']) {
      const fixture = hold(stage);
      const attempt = startQuery(timed, actor);
      const completion = timed.completeLink(actor, attempt.query);
      const rejected = expectGithubError(() => completion, stage);
      await within(fixture.headers.promise, `${stage} headers were not received`);
      assert.equal(fixture.signal.aborted, false, 'headers arrive before deadline');
      await within(rejected, `${stage} body timeout did not reject`);
      assert.equal(fixture.signal.aborted, true, `${stage} body timeout aborts real fetch`);
      await within(fixture.closed.promise, `${stage} body socket remained open`);
      await assertUnbound();
      held = null;
    }
    log('passed native HTTP cancellation, generation/session races and exchange/identity body aborts');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function main() {
  await testUserStore();
  await testOAuthSuccessAndCrypto();
  await testOAuthFailures();
  await testStargazerService();
  await testStarStatesAndCache();
  await testOAuthCancellationAndBodyTimeouts();
  await testIntegration();
  testStaticStarInitialPlacement();
  log('all unit, mocked-integration, browser UI and static tests passed (no live GitHub OAuth was used)');
}

try {
  await main();
  finished = true;
  clearTimeout(hardTimeout);
  await cleanup();
} catch (error) {
  finished = true;
  clearTimeout(hardTimeout);
  await cleanup();
  console.error('github-link tests failed:', error);
  process.exitCode = 1;
}
