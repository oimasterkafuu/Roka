import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-replay-quota-'));
process.env.ROKA_DATA_DIR = dataDir;
process.env.JWT_SECRET = 'replay-quota-test-secret';
process.env.WEBHOOK_SECRET = 'replay-quota-test-secret';
process.env.NODE_ENV = 'test';
process.env.ROKA_STATIC_CDN = '0';
process.env.REPLAY_DOWNLOAD_DISABLED = '0';
delete process.env.REPLAY_DOWNLOAD_DAILY_LIMIT;
delete process.env.REPLAY_DOWNLOAD_CONCURRENCY_LIMIT;

const require = createRequire(import.meta.url);
const { ReplayStore } = require('../dist/replay-store.js');
const fixture = await readFile(new URL('./fixtures/replay-143-danrgjM9hfR7.rpl', import.meta.url));
let rawCalls = 0;
let viewCalls = 0;
let deleteCalls = 0;
let rawError = false;
let viewError = false;
let rawGate = null;
let gatedCalls = 0;
ReplayStore.prototype.readRawReplay = async function () {
  rawCalls += 1;
  if (rawError) throw new Error('read failed');
  if (rawGate) {
    gatedCalls += 1;
    await rawGate;
  }
  return fixture;
};
ReplayStore.prototype.readReplayViewGzip = async function () {
  viewCalls += 1;
  if (viewError) throw new Error('view failed');
  return { gzip: Buffer.from('view'), size: 4 };
};
ReplayStore.prototype.deleteReplay = async function () {
  deleteCalls += 1;
};

const { app, boot, lobbyService, cleanupReplayDownloadState } = require('../dist/server.js');
const request = (url, ip, options = {}) =>
  app.inject({
    method: 'GET',
    url,
    ...options,
    headers: {
      ...(ip ? { 'x-real-ip': ip } : {}),
      ...options.headers,
    },
  });
const download = (ip, url = '/api/downloadreplay/quota') => request(url, ip);
const assertRetryAfter = (response) => {
  assert.ok(Number(response.headers['retry-after']) >= 1);
  assert.equal(typeof response.json().error, 'string');
};

try {
  await boot(false);

  process.env.REPLAY_DOWNLOAD_DISABLED = '1';
  for (const url of ['/api/getreplay/disabled', '/api/downloadreplay/disabled']) {
    const response = await request(url, '198.51.100.1');
    assert.equal(response.statusCode, 503);
    assertRetryAfter(response);
  }
  assert.equal(rawCalls, 0);
  assert.equal(viewCalls, 0);
  assert.equal(deleteCalls, 0);

  process.env.REPLAY_DOWNLOAD_DISABLED = '0';
  for (let i = 0; i < 12; i++) {
    assert.equal((await download('198.51.100.1')).statusCode, 200, '503 does not consume quota');
  }
  assert.equal((await download('198.51.100.1')).statusCode, 429);
  const normal = await download();
  assert.equal(normal.statusCode, 200);
  assert.deepEqual(normal.rawPayload, fixture);

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const ip = '198.51.100.2';
    // Mutate the actual LobbyService game registry: includes games with zero humans/bots only.
    lobbyService.gameInstances.set('hosted-bot-game', {});
    for (let i = 0; i < 6; i++) {
      assert.equal(
        (await download(ip, i % 2 ? '/api/getreplay/quota' : '/api/downloadreplay/quota')).statusCode,
        200,
      );
    }
    assert.equal((await download(ip)).statusCode, 429);
    assert.equal((await download('198.51.100.3')).statusCode, 200);
    lobbyService.gameInstances.clear();
    for (let i = 0; i < 6; i++) assert.equal((await download(ip)).statusCode, 200);
    assert.equal((await download(ip)).statusCode, 429);
    lobbyService.gameInstances.set('hosted-bot-game', {});
    assert.equal((await download(ip)).statusCode, 429, 'switching preserves counts');
    now += 60_000;
    assert.equal((await download(ip)).statusCode, 200, 'window expires at boundary');
    now += 30_000;
    for (let i = 0; i < 5; i++) assert.equal((await download(ip)).statusCode, 200);
    now += 30_000;
    assert.equal((await download(ip)).statusCode, 200, 'only oldest request expires');
    assert.equal((await download(ip)).statusCode, 429, 'newer requests remain in rolling window');
    now += 60_000;
    cleanupReplayDownloadState(now);
  } finally {
    Date.now = realNow;
    lobbyService.gameInstances.clear();
  }

  // Public peers cannot select quota buckets through forged forwarding headers.
  for (let i = 0; i < 12; i++) {
    assert.equal(
      (
        await request('/api/downloadreplay/quota', null, {
          remoteAddress: '203.0.113.20',
          headers: { 'x-real-ip': `198.51.100.${i}`, 'x-forwarded-for': `198.51.100.${i}` },
        })
      ).statusCode,
      200,
    );
  }
  assert.equal(
    (await request('/api/downloadreplay/quota', null, { remoteAddress: '203.0.113.20' })).statusCode,
    429,
  );
  for (let i = 0; i < 12; i++) {
    assert.equal(
      (
        await request('/api/downloadreplay/quota', '198.51.100.30', {
          headers: { 'x-real-ip': '198.51.100.30', 'x-forwarded-for': `192.0.2.${i}` },
        })
      ).statusCode,
      200,
    );
  }
  assert.equal((await download('198.51.100.30')).statusCode, 429, 'nginx X-Real-IP wins over XFF');

  let releaseGate;
  rawGate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const concurrentIp = '198.51.100.4';
  const first = download(concurrentIp);
  const second = download(concurrentIp);
  while (gatedCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  const concurrentLimited = await download(concurrentIp);
  assert.equal(concurrentLimited.statusCode, 429);
  assertRetryAfter(concurrentLimited);
  rawGate = null;
  releaseGate();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await download(concurrentIp)).statusCode, 200, `post-concurrency request ${i + 1}`);
  }
  assert.equal((await download(concurrentIp)).statusCode, 429, 'concurrency 429 did not consume quota');

  rawError = true;
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await download('198.51.100.5')).statusCode, 404, 'read errors release concurrency');
  }
  rawError = false;
  assert.equal((await download('198.51.100.5')).statusCode, 200);

  viewError = true;
  assert.equal((await download('198.51.100.6', '/api/getreplay/broken')).statusCode, 404);
  assert.equal(deleteCalls, 0, 'an unreadable viewing replay must not delete the original archive');
  viewError = false;
  assert.equal((await download('198.51.100.6')).statusCode, 200, 'getreplay error releases concurrency');

  for (const [url, ip] of [
    ['/api/replays', '198.51.100.7'],
    ['/api/profile/missing/replays', '198.51.100.8'],
  ]) {
    for (let i = 0; i < 12; i += 1) {
      assert.notEqual((await request(url, ip)).statusCode, 429, `${url} request ${i + 1}`);
    }
    const limited = await request(url, ip);
    assert.equal(limited.statusCode, 429, `${url} request 13`);
    assertRetryAfter(limited);
  }
  assert.equal((await request('/api/rooms', '198.51.100.7')).statusCode, 200);
  assert.equal((await request('/replays/quota')).statusCode, 200);

  console.log(
    'replay quota: 503, rolling 6/12, dynamic games, trusted IP isolation, concurrency 2, release, list 12/min passed',
  );
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
