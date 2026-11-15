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
  const actor = { username: 'alice', sid: 'session-a' };
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
  const actor = { username: 'alice', sid: 'sid-a' };

  const unconfigured = new GithubService({
    userStore: store,
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
    starStatus: initialStarStatus,
    starHandler: null,
  };
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/login/oauth/access_token')) {
      return jsonResponse(200, { access_token: rawToken, refresh_token: refreshToken });
    }
    if (target.endsWith('/user')) return jsonResponse(200, { id, login: `gh-${id}`, type: 'User' });
    if (target.endsWith('/user/starred/oimasterkafuu/Roka')) {
      fixture.starCalls += 1;
      if (fixture.starHandler) return fixture.starHandler(init.signal);
      if (fixture.starStatus === 'timeout') {
        return new Promise((_resolve, reject) => {
          const rejectTimeout = () => reject(new Error('aborted timeout'));
          if (init.signal.aborted) rejectTimeout();
          else init.signal.addEventListener('abort', rejectTimeout, { once: true });
        });
      }
      return emptyResponse(fixture.starStatus);
    }
    throw new Error(`unexpected URL ${target}`);
  };
  fixture.service = makeService(store, fetchImpl, nowRef);
  fixture.actor = { username, sid: `sid-${username}` };
  fixture.complete = async () => {
    const attempt = startQuery(fixture.service, fixture.actor, `star-code-${id}`);
    return fixture.service.completeLink(fixture.actor, attempt.query);
  };
  return fixture;
}

async function testStarStatesAndCache() {
  const starred = await createStarCase('starred', 501, 204);
  assert.equal((await starred.complete()).starred, true);
  assert.equal(starred.starCalls, 1);
  starred.nowRef.value += GITHUB_STAR_CACHE_TTL_MS - 1;
  await starred.service.refreshStar('starred');
  assert.equal(starred.starCalls, 1, 'fresh 15-minute result is cached');
  starred.nowRef.value += 2;

  let releaseStar;
  starred.starHandler = () =>
    new Promise((resolve) => {
      releaseStar = () => resolve(emptyResponse(204));
    });
  const firstRefresh = starred.service.refreshStar('starred');
  const forcedDuplicate = starred.service.refreshStar('starred', true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starred.starCalls, 2, 'expired and forced concurrent refreshes are deduplicated');
  releaseStar();
  await Promise.all([firstRefresh, forcedDuplicate]);
  starred.starHandler = null;
  assert.equal(starred.store.getGithubPublicProfile('starred', starred.nowRef.value).starred, true);

  starred.nowRef.value += GITHUB_STAR_BADGE_MAX_AGE_MS + 1;
  const stale = starred.store.getGithubPublicProfile('starred', starred.nowRef.value);
  assert.equal(stale.starred, false);
  assert.equal(stale.starState, 'stale');

  starred.starStatus = 404;
  const revoked = await starred.service.refreshStar('starred', true);
  assert.equal(revoked.starred, false);
  assert.equal(revoked.starState, 'not-starred');

  starred.starStatus = 500;
  await expectGithubError(() => starred.service.refreshStar('starred', true), 'star');
  assert.equal(starred.store.getGithubPublicProfile('starred', starred.nowRef.value).starred, false);

  starred.starStatus = 401;
  await expectGithubError(() => starred.service.refreshStar('starred', true), 'star');
  const unknown = starred.store.getGithubPublicProfile('starred', starred.nowRef.value);
  assert.equal(unknown.starred, false);
  assert.equal(unknown.starState, 'unknown');
  assert.equal(unknown.starVerifiedAt, null);
  assertDiskDoesNotContain(starred.directory, [starred.rawToken, `refresh-star-token-501`]);

  const notStarred = await createStarCase('notstarred', 502, 404);
  const notStarredProfile = await notStarred.complete();
  assert.equal(notStarredProfile.starred, false);
  assert.equal(notStarredProfile.starState, 'not-starred');

  let nextId = 503;
  for (const status of [401, 403, 429, 500, 'timeout']) {
    const failure = await createStarCase(`failure${nextId}`, nextId, status);
    const profile = await failure.complete();
    assert.equal(profile.starred, false, `initial ${status} must not award a badge`);
    assert.equal(profile.starState, 'unknown', `initial ${status} has no verified negative result`);
    assert.equal(profile.starVerifiedAt, null);
    assert.equal(failure.store.getGithubCredential(`failure${nextId}`).starred, undefined);
    assertDiskDoesNotContain(failure.directory, [failure.rawToken, `refresh-star-token-${nextId}`]);
    nextId += 1;
  }
  log('passed Star 204/404, initial 401/403/429/500/timeout, 15-minute cache, stale/revoke/unknown checks');
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
      if (!state.tokens.has(token)) return sendJson(401, { message: 'bad credentials' });
      const status = state.stars.get(token) ?? 404;
      if (status === 204) {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      return sendJson(status, { message: `mock star status ${status}` });
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
  const aliceToken = mock.codes.get('alice-code');

  const unconfigured = await startServer(dataDir, mock, false);
  let api = createApi(unconfigured, tokens, secrets);
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
  assertNoSensitiveDto(aliceProfile.json);

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

  const publicRoutes = [
    '/api/leaderboard',
    '/api/user-colors?users=alice,bob,carol',
    '/api/admin/users',
    '/api/contributors',
    '/api/replays',
    '/api/online',
    '/api/users/search?q=',
    '/api/profile/alice/feeds',
    '/api/profile/alice/replays',
  ];
  for (const route of publicRoutes) {
    const response = await api(route, { user: route === '/api/admin/users' ? 'alice' : undefined });
    assert.equal(response.status, 200, route);
    assert.deepEqual(
      forbiddenDisplayKeys(response.json),
      [],
      `${route} unexpectedly exposes GitHub/Star display data`,
    );
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

  mock.stars.set(aliceToken, 404);
  const refreshed = await api('/api/auth/github/star/refresh', { method: 'POST', user: 'alice' });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.ok, true);
  assert.equal(refreshed.json.github.starred, false);
  assert.equal(refreshed.json.github.starState, 'not-starred');
  assertNoSensitiveDto(refreshed.json);
  assert.equal((await api('/api/profile/alice')).json.github.starred, false);
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
  assertDiskDoesNotContain(dataDir, secrets);
  log(
    'passed spawned OAuth binding/conflict/rebind/unlink/refresh, contributor mapping, DTO and persistence checks',
  );
}

function testStaticBadgePlacement() {
  const profileHtml = fs.readFileSync(path.join(rootDir, 'static', 'profile.html'), 'utf8');
  const profileJs = fs.readFileSync(path.join(rootDir, 'static', 'profile.js'), 'utf8');
  const badgeMarker = /github-star|profile-github-star|starred|starState/i;
  assert.ok(badgeMarker.test(profileHtml), 'profile.html contains the Star badge');
  assert.ok(
    /github\.starred|starState|p-github-star-badge/.test(profileJs),
    'profile.js controls the Star badge',
  );
  for (const relative of ['username.js', 'about.html', 'about-contributors.js', 'main.js']) {
    const source = fs.readFileSync(path.join(rootDir, 'static', relative), 'utf8');
    assert.equal(badgeMarker.test(source), false, `Star badge implementation leaked into static/${relative}`);
  }
  const staticFiles = readFilesRecursively(path.join(rootDir, 'static')).filter((file) =>
    /\.(?:js|html)$/i.test(file),
  );
  for (const file of staticFiles) {
    const relative = path.relative(rootDir, file).split(path.sep).join('/');
    if (!badgeMarker.test(fs.readFileSync(file, 'utf8'))) continue;
    assert.ok(
      /^static\/profile\.(?:js|html)$/.test(relative),
      `Star badge implementation is only allowed in static/profile.*, found ${relative}`,
    );
  }
  log('passed static Star badge placement checks');
}

async function main() {
  await testUserStore();
  await testOAuthSuccessAndCrypto();
  await testOAuthFailures();
  await testStarStatesAndCache();
  await testIntegration();
  testStaticBadgePlacement();
  log('all unit, mocked-integration and static tests passed (no live GitHub OAuth was used)');
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
