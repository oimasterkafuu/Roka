import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serialize } from 'node:v8';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { ReplayStore, sweepReplayViewCaches, DEFAULT_REPLAY_VIEW_CACHE_MAX_AGE_MS } = require('../dist/replay-store.js');
const { REPLAY_BINARY_MAGIC } = require('../dist/replay-patch-binary.js');
const { UserStore } = require('../dist/auth-store.js');
const { buildReplayStats } = require('../dist/server/replay-stats.js');
const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-replays-page-'));
const replayDir = path.join(dataDir, 'replays');
let app;
try {
  await mkdir(replayDir);
  const old = new Date(Date.now() - DEFAULT_REPLAY_VIEW_CACHE_MAX_AGE_MS - 60000);
  const cached = gzipSync(Buffer.from(REPLAY_BINARY_MAGIC + 'cached'));
  for (const name of ['hit.rpb.gz', 'expired.rpb.gz', 'fresh.rpb.gz', 'archive.rpl', 'index.bin']) {
    await writeFile(path.join(replayDir, name), name.endsWith('.gz') ? cached : Buffer.from(name));
    if (name !== 'fresh.rpb.gz') await utimes(path.join(replayDir, name), old, old);
  }
  const store = new ReplayStore(replayDir, { buildReplayFromActions: async () => { throw new Error('cache should hit'); } });
  const view = await store.readReplayViewGzip('hit');
  assert.deepEqual(view.gzip, cached);
  for (let i = 0; i < 100 && (await stat(path.join(replayDir, 'hit.rpb.gz'))).mtimeMs <= old.getTime(); i++) await delay(10);
  assert.ok((await stat(path.join(replayDir, 'hit.rpb.gz'))).mtimeMs > Date.now() - 10000);
  await sweepReplayViewCaches(replayDir);
  await assert.rejects(stat(path.join(replayDir, 'expired.rpb.gz')), { code: 'ENOENT' });
  for (const name of ['hit.rpb.gz', 'fresh.rpb.gz']) assert.deepEqual(await readFile(path.join(replayDir, name)), cached);
  for (const name of ['archive.rpl', 'index.bin']) assert.equal(await readFile(path.join(replayDir, name), 'utf8'), name);
  console.log('PASS cache: hit refreshes mtime; expired removed; fresh cache, .rpl and index bytes intact');

  const users = new UserStore(dataDir);
  await users.ensureReady();
  await users.register('Alice', 'test-password-123');
  const now = Math.floor(Date.now() / 1000);
  const items = Array.from({ length: 105 }, (_, i) => ({ id: 'replay' + i, time: now - i, turn: i, rank: [i < 102 ? 'Alice' : 'Bob'], teams: [] }));
  await writeFile(path.join(replayDir, 'index.bin'), serialize(items));
  // Startup must honor the configured age, without touching original archives.
  await writeFile(path.join(replayDir, 'boot.rpb.gz'), cached);
  const bootOld = new Date(Date.now() - 5000);
  await utimes(path.join(replayDir, 'boot.rpb.gz'), bootOld, bootOld);
  Object.assign(process.env, { ROKA_DATA_DIR: dataDir, JWT_SECRET: 'replays-page-test-secret', WEBHOOK_SECRET: 'replays-page-test-secret', NODE_ENV: 'test', ROKA_STATIC_CDN: '0', ROKA_REPLAY_VIEW_CACHE_MAX_AGE_MS: '1000' });
  const server = require('../dist/server.js');
  app = server.app;
  await server.boot(false);
  await assert.rejects(stat(path.join(replayDir, 'boot.rpb.gz')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(replayDir, 'archive.rpl'), 'utf8'), 'archive.rpl');
  let ip = 1;
  const get = async (url) => {
    const response = await app.inject({ method: 'GET', url, headers: { 'x-real-ip': '198.51.100.' + ip++ } });
    assert.equal(response.statusCode, 200, url);
    return response.json();
  };
  const plain = await get('/api/replays');
  assert.deepEqual(plain.items, items.slice(0, 50));
  assert.equal(plain.total, 105);
  assert.equal(plain.next_offset, 50);
  assert.equal(plain.has_more, true);
  assert.deepEqual(plain.stats, buildReplayStats(items));
  assert.equal((await get('/api/replays?limit=10')).items.length, 10);
  assert.equal((await get('/api/replays?limit=999')).items.length, 50);
  const normalized = await get('/api/replays?username=aLiCe');
  assert.equal(normalized.total, 102);
  assert.deepEqual(normalized.stats, buildReplayStats(items.slice(0, 102)));
  const missing = await get('/api/replays?username=Nobody');
  assert.deepEqual(missing.items, []);
  assert.equal(missing.total, 0);
  assert.equal(missing.has_more, false);
  const bounds = await get(`/api/replays?from=${now - 20}&to=${now - 10}`);
  assert.deepEqual(bounds.items, items.slice(10, 21));
  assert.equal(bounds.total, 11);
  assert.equal((await get(`/api/replays?username=ALICE&from=${now - 104}&to=${now - 100}`)).total, 2);
  assert.equal((await get(`/api/replays?from=${now}&to=${now}`)).total, 1);
  assert.equal((await get('/api/replays?from=invalid&to=Infinity')).total, 105);
  assert.equal((await get('/api/replays?from=&to=NaN')).total, 105);
  const second = await get('/api/replays?username=alice&offset=50&limit=50');
  assert.deepEqual(second.items, items.slice(50, 100));
  assert.equal(second.total, 102);
  assert.equal(second.has_more, true);
  const third = await get('/api/replays?username=alice&offset=100&limit=50');
  assert.deepEqual(third.items, items.slice(100, 102));
  assert.equal(third.next_offset, 102);
  assert.equal(third.has_more, false);
  const page = await app.inject('/replays');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /replays\.js/);
  assert.match(page.body, /查询回放/);
  for (const url of ['/replays/local', '/replays/example', '/replays.js']) assert.equal((await app.inject(url)).statusCode, 200, url);
  assert.equal((await app.inject({ method: 'POST', url: '/api/replay-upload', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('invalid') })).statusCode, 401);
  console.log('PASS API: normalized/unknown username, inclusive from/to, invalid dates, total, 50/page, unfiltered stats regression');
  console.log('PASS guest: /replays, viewer routes and script 200; upload 401; startup cache sweep honors env');

  // Run the actual page controller with inert DOM handles to check URL, local-day and socket semantics.
  const calls = [];
  const props = [];
  const socketHandlers = {};
  const location = { search: '', href: '/replays' };
  let popstate;
  let refreshCallback;
  let refreshDelay;
  const context = vm.createContext({
    $, Date, URLSearchParams, Uint8Array, String, Number, Object,
    location,
    history: { pushState(_state, _title, url) { location.search = new URL(url, 'http://localhost').search; } },
    window: { addEventListener(event, handler) { if (event === 'popstate') popstate = handler; } },
    io(options) {
      assert.equal(options.query.home, '1');
      return { on(event, handler) { socketHandlers[event] = handler; } };
    },
    setTimeout(callback, delay) { refreshCallback = callback; refreshDelay = delay; return 1; },
    fetch(url) { calls.push(url); return new Promise(() => {}); },
  });
  function $(selector) {
    return {
      on() { return this; },
      val() { return this; },
      prop(name, value) { props.push({ selector, name, value }); return this; },
      text() { return this; },
      empty() { return this; },
    };
  }
  const paginationHidden = () => props.filter((entry) => entry.selector === '#replays-pagination' && entry.name === 'hidden').at(-1).value;
  vm.runInContext(await readFile(new URL('../static/replays.js', import.meta.url), 'utf8'), context);
  let query = new URL(calls[0], 'http://localhost').searchParams;
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('offset'), '0');
  assert.equal(context.replayState.searching, false);
  assert.equal(paginationHidden(), false);
  assert.equal(context.replayDateSeconds('2026-10-02', false), String(Math.floor(new Date(2026, 9, 2, 0, 0, 0).getTime() / 1000)));
  assert.equal(context.replayDateSeconds('2026-10-02', true), String(Math.floor(new Date(2026, 9, 2, 23, 59, 59).getTime() / 1000)));
  context.navigateReplays({ searching: false, page: 2 });
  assert.equal(location.search, '?page=2');
  assert.equal(context.replayState.searching, false);
  query = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(query.get('offset'), '50');
  assert.equal(query.get('limit'), '50');
  assert.equal(paginationHidden(), false);
  context.navigateReplays({ searching: true, username: 'Alice', from: '100', to: '200', page: 2 });
  assert.equal(location.search, '?username=Alice&from=100&to=200&page=2');
  query = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(query.get('offset'), '50');
  assert.equal(query.get('limit'), '50');
  assert.equal(paginationHidden(), false);
  location.search = '?username=Bob&page=3';
  popstate();
  assert.equal(context.replayState.username, 'Bob');
  assert.equal(context.replayState.page, 3);
  const callsBeforeRefresh = calls.length;
  socketHandlers.home_leaderboard();
  socketHandlers.home_leaderboard();
  assert.equal(refreshDelay, 2000);
  assert.equal(calls.length, callsBeforeRefresh, 'events coalesce into one delayed refresh');
  refreshCallback();
  assert.equal(calls.length, callsBeforeRefresh + 1);
  query = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(query.get('username'), 'Bob');
  assert.equal(query.get('offset'), '100');
  assert.equal(query.get('limit'), '50');
  location.search = '?page=2';
  popstate();
  assert.equal(context.replayState.searching, false);
  assert.equal(context.replayState.page, 2);
  const pagedLatestCallsBeforeRefresh = calls.length;
  socketHandlers.home_leaderboard();
  refreshCallback();
  assert.equal(calls.length, pagedLatestCallsBeforeRefresh + 1);
  query = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(query.get('offset'), '50');
  assert.equal(query.get('limit'), '50');
  context.navigateReplays({ searching: false });
  assert.equal(location.search, '');
  assert.equal(context.replayState.searching, false);
  const latestCallsBeforeRefresh = calls.length;
  socketHandlers.home_leaderboard();
  refreshCallback();
  assert.equal(calls.length, latestCallsBeforeRefresh + 1);
  query = new URL(calls.at(-1), 'http://localhost').searchParams;
  assert.equal(query.get('offset'), '0');
  assert.equal(query.get('limit'), '50');
  console.log('PASS page controller: latest 50, second-page offset 50, visible pagination, local-day endpoints, query/page URL, popstate, current-page socket refresh');

} finally {
  if (app) await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
