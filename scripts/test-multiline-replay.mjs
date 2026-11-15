import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { GameEngine } from '../dist/game-engine.js';
import { ReplayStore } from '../dist/replay-store.js';

const fixturePath = new URL('./fixtures/multiline-replay.json', import.meta.url);
const keys = ['grid_type', 'army_cnt', 'isolated'];
const config = {
  width_ratio: 0.5,
  height_ratio: 0.5,
  city_ratio: 0,
  mountain_ratio: 0,
  swamp_ratio: 0,
  speed: 1,
  allow_team: false,
  fog: false,
  multi_line: true,
  map_token: 'multiline-replay-fixture',
  map_mode: 'random',
  map_region: 'china',
  map_size: 'normal',
  player_names: ['alice', 'bob'],
  player_teams: [1, 2],
};

async function record(multiLine) {
  let saved;
  const updates = [];
  const e = await GameEngine.create({ ...config, multi_line: multiLine }, ['a', 'b'], ['a', 'b'], 'fixture', {
    update(sid, frame) {
      if (sid === 'a') updates.push(structuredClone(frame));
    },
    emitInitMap() {},
    chatMessage() {},
    endGame() {},
    disciplineEvent() {},
    md5: (x) => x,
    replayStore: {
      async saveReplay(raw) {
        saved = structuredClone(raw);
        return 'fixture';
      },
    },
  });
  // No wall-clock waits, map edits, or mocked combat/build/growth functions.
  const frames = [e.buildReplayFrame(false)];
  async function tick() {
    await e.gameTick();
    frames.push(e.buildReplayFrame(false));
  }
  for (let i = 0; i < 240; i++) await tick();
  let crown;
  for (let x = 0; x < e.n; x++)
    for (let y = 0; y < e.m; y++) {
      if (e.owner[x][y] === 1 && e.gridType[x][y] === -2) crown = [x, y];
    }
  const [x, y] = crown;
  const neighbors = [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].filter(
    ([a, b]) => a >= 0 && a < e.n && b >= 0 && b < e.m && e.owner[a][b] === 0 && e.gridType[a][b] === 0,
  );
  assert.ok(neighbors.length >= 2);
  const a = neighbors.find(([a, b]) => e.chkxy(2 * a - x, 2 * b - y) && e.owner[2 * a - x][2 * b - y] === 0);
  assert.ok(a);
  const b = neighbors.find((pos) => pos !== a);
  const chain = [a[0] + a[0] - x, a[1] + a[1] - y];
  assert.ok(e.chkxy(...chain) && e.owner[chain[0]][chain[1]] === 0);
  e.addMove('a', x, y, ...a, 1);
  e.addMove('a', ...a, ...chain, 2); // blocked until next tick
  e.addMove('a', x, y, ...b, 2); // independent head, same tick
  e.addBuild('a', ...b, 'b');
  e.addBuild('a', ...b, 'c'); // ordered move -> build -> upgrade in one tick
  e.addMove('a', -1, -1, -1, 0, 2); // invalid, acknowledged but never recorded
  await tick();
  const first = updates.at(-1).lst_moves;
  if (multiLine) {
    assert.equal(e.executedTurnMoves[0].length, 4);
    assert.equal(e.gridType[b[0]][b[1]], -2);
    assert.deepEqual(first, [1, 3, 4, 5, 6]);
    assert.ok(
      e.pmove[0].some((op) => op.seq === 2),
      'chain waits for next tick',
    );
  } else assert.equal(e.executedTurnMoves[0].length, 1);
  // A neutral in-bounds source is accepted into the queue, then discarded at execution.
  e.addMove('a', e.n - 1, e.m - 1, e.n - 1, e.m - 2, 2);
  for (let i = 0; i < 7; i++) {
    await tick();
    if (!multiLine) assert.ok(e.executedTurnMoves[0].length <= 1);
    if (multiLine && i === 0) {
      assert.deepEqual(updates.at(-1).lst_moves, [2, 7]);
      assert.equal(e.executedTurnMoves[0].length, 1, 'invalid dequeue is absent from recording');
      // Two distinct sources transfer independently in the same tick.
      e.addMove('a', ...b, ...crown, 0);
      e.addMove('a', ...chain, ...a, 2);
    }
    if (multiLine && i === 1) {
      assert.deepEqual(updates.at(-1).lst_moves, [8, 9]);
      assert.equal(e.executedTurnMoves[0].length, 2, 'distinct sources advance on the same tick');
    }
  }
  assert.equal(e.pmove[0].length, 0);
  assert.ok(updates.slice(241).some((frame) => frame.lst_moves.length > 0));
  e.surrender('b');
  await tick();
  frames.at(-1).game_end = true;
  assert.ok(saved, 'the real live end path saves raw operations');
  return { raw: saved, frames, first, crown, branches: [a, b, chain] };
}

function compareReplay(replay, frames) {
  assert.equal(replay.patches.length + 1, frames.length);
  const state = Object.fromEntries(keys.map((k) => [k, [...replay.initial[k]]]));
  for (let t = 0; t < frames.length; t++) {
    const payload = t ? replay.patches[t - 1].forward : replay.initial;
    for (const key of keys) {
      if (t)
        for (let i = 0; i < payload[key].length; i += 2) state[key][payload[key][i]] = payload[key][i + 1];
      assert.deepEqual(state[key], frames[t][key], `${key} tick ${t}`);
    }
    assert.deepEqual(payload.leaderboard, frames[t].leaderboard, `leaderboard tick ${t}`);
    assert.equal(payload.game_end, frames[t].game_end, `end tick ${t}`);
  }
  for (let t = frames.length - 2; t >= 0; t--) {
    for (const key of keys) {
      const diff = replay.patches[t].backward[key];
      for (let i = 0; i < diff.length; i += 2) state[key][diff[i]] = diff[i + 1];
      assert.deepEqual(state[key], frames[t][key], `reverse ${key} tick ${t}`);
    }
  }
}

const live = await record(true);
const single = await record(false);
if (process.argv.includes('--write-fixture'))
  await writeFile(fixturePath, JSON.stringify(live.raw, null, 2) + '\n');
assert.deepEqual(
  live.raw,
  JSON.parse(await readFile(fixturePath, 'utf8')),
  'fixture is reproduced by real play',
);
for (const result of [live, single])
  compareReplay(await GameEngine.buildReplayFromActions(result.raw), result.frames);

// Legacy selected-cell streams, including ignored historical line metadata.
const legacy = structuredClone(single.raw);
legacy.version = 'ops-v1';
legacy.player_ops = legacy.player_ops.map((ops) =>
  ops.flatMap((op) => {
    if (op.op !== 'q') return [{ ...op, line: 2 }];
    return op.actions.flatMap((a) => {
      const selected = { op: 's', x: a.x, y: a.y, line: 2 };
      if (a.kind !== 'm') return [selected, { op: a.kind, line: 2 }];
      const d = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ].findIndex(([x, y]) => a.x + x === a.dx && a.y + y === a.dy);
      return [selected, { op: 'm', d, ...(a.mode === 2 ? { a: 1 } : a.mode === 1 ? { h: 1 } : {}), line: 2 }];
    });
  }),
);
compareReplay(await GameEngine.buildReplayFromActions(legacy), single.frames);
const malformed = structuredClone(live.raw);
malformed.meta.multi_line = false;
await assert.rejects(GameEngine.buildReplayFromActions(malformed), /Single-line replay/);

const dir = await mkdtemp(path.join(tmpdir(), 'roka-multiline-replay-'));
try {
  const store = new ReplayStore(dir, {
    buildReplayFromActions: (raw) => GameEngine.buildReplayFromActions(raw),
  });
  await store.ensureReady();
  const id = await store.saveReplay(live.raw, { rank: ['alice', 'bob'], teams: [], turn: 124 });
  const rawBytes = await store.readRawReplay(id);
  if (process.env.ROKA_REPLAY_ARTIFACT_DIR)
    await writeFile(
      path.join(process.env.ROKA_REPLAY_ARTIFACT_DIR, 'multiline-replay-fixture.rpl'),
      rawBytes,
    );
  compareReplay(await store.buildReplayFromRaw(rawBytes), live.frames);
  const { gzip } = await store.readReplayViewGzip(id);
  const cached = await store.readReplayViewGzip(id);
  assert.deepEqual(cached.gzip, gzip);
  const binary = gunzipSync(gzip);
  if (process.env.ROKA_REPLAY_ARTIFACT_DIR)
    await writeFile(path.join(process.env.ROKA_REPLAY_ARTIFACT_DIR, 'multiline-replay-fixture.rpb'), binary);
  const context = vm.createContext({
    ArrayBuffer,
    Uint8Array,
    DataView,
    replay_binary_magic_v1: [82, 80, 66, 49],
    replay_binary_magic_v2: [82, 80, 66, 50],
    replay_binary_magic_v3: [82, 80, 66, 51],
    replay_binary_magic: [82, 80, 66, 52],
    replay_text_decoder: new TextDecoder(),
    replay_class_from_code: ['', 'dead', 'afk'],
  });
  vm.runInContext(
    await readFile(new URL('../static/main/replay-binary.js', import.meta.url), 'utf8'),
    context,
  );
  const decoded = context.decodeReplayBinary(
    binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
  );
  compareReplay(JSON.parse(JSON.stringify(decoded)), live.frames);
  for (const version of [1, 2]) {
    const bytes = encodeLegacyView(await GameEngine.buildReplayFromActions(legacy), version);
    const old = context.decodeReplayBinary(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    compareReplay(
      JSON.parse(JSON.stringify(old)),
      version === 1
        ? single.frames.map((frame) => ({ ...frame, isolated: frame.isolated.map(() => 0) }))
        : single.frames,
    );
  }
  console.log(
    'PASS: legacy ops-v1 with line metadata, RPB1/RPB2 decoders, malformed single-line batch rejected',
  );
  if (process.argv.includes('--browser')) {
    await browserCheck(binary, live, rawBytes);
  }
  console.log(
    `PASS: live -> raw ops -> ReplayStore raw upload/cache -> RPB4 decoder; ${live.frames.length} frames forward/backward; single-line <=1 action/tick`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function browserCheck(binary, live, rawBytes) {
  const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-replay-browser-'));
  const secret = 'local-replay-browser-test';
  Object.assign(process.env, {
    ROKA_DATA_DIR: dataDir,
    JWT_SECRET: secret,
    WEBHOOK_SECRET: secret,
    ROKA_STATIC_CDN: '0',
    NODE_ENV: 'test',
    ROKA_BOT_TOKENS: '',
  });
  const require = createRequire(import.meta.url);
  const { UserStore } = require('../dist/auth-store.js');
  const users = new UserStore(dataDir);
  await users.ensureReady();
  await users.register('replay_viewer', 'local-test-password');
  const sid = await users.rotateSession('replay_viewer');
  const token = require('jsonwebtoken').sign({ sub: 'replay_viewer', sid }, secret);
  const { app, boot } = require('../dist/server.js');
  await boot(false);
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.context().addCookies([{ name: 'auth_token', value: token, url: base }]);
    const uploaded = await page.request.post(`${base}/api/replay-upload`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: rawBytes,
    });
    assert.equal(uploaded.status(), 200, 'real authenticated raw upload route');
    const uploadedBinary = await uploaded.body();
    assert.deepEqual(uploadedBinary, binary, 'HTTP transcode matches ReplayStore view');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(
      (b64) => sessionStorage.setItem('roka_local_replay', b64),
      uploadedBinary.toString('base64'),
    );
    await page.goto(`${base}/replays/local`);
    await page.waitForFunction(() => window.in_game && window.replay_data?.patches?.length);
    for (const t of [240, 241, 242, 243, 0, 248, 241, 249, 0]) {
      const state = await page.evaluate((t) => {
        jumpToFrame(t);
        return {
          grid_type: grid_type.flat(),
          army_cnt: army_cnt.flat(),
          isolated: isolated.flat(),
          turn: cur_turn,
        };
      }, t);
      assert.equal(state.turn, t);
      for (const key of keys) assert.deepEqual(state[key], live.frames[t][key], `browser seek ${key} ${t}`);
    }
    await page.evaluate(() => jumpToFrame(240));
    await page.click('#replay-autoplay-btn');
    await page.waitForFunction(() => cur_turn >= 244);
    await page.evaluate(() => {
      if (is_autoplaying) switchAutoplay();
      jumpToFrame(241);
    });
    if (process.env.ROKA_REPLAY_SCREENSHOT)
      await page.screenshot({ path: process.env.ROKA_REPLAY_SCREENSHOT });
    // Historical frame objects may carry a scalar lst_move and line. Viewer maps are authoritative.
    const oldState = await page.evaluate(() => {
      jumpToFrame(240);
      const patch = structuredClone(replay_data.patches[240].forward);
      delete patch.lst_moves;
      patch.lst_move = { x: 23, y: 1, dx: 24, dy: 1, mode: 2, line: 3 };
      update(patch);
      return { grid_type: grid_type.flat(), army_cnt: army_cnt.flat(), isolated: isolated.flat() };
    });
    for (const key of keys)
      assert.deepEqual(oldState[key], live.frames[241][key], `legacy scalar browser ${key}`);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: real authenticated HTTP upload -> Chromium game.html/main scripts, forward/reverse seek, autoplay ticks 241–244, zero page errors',
    );
  } finally {
    await browser?.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export { live, compareReplay };

// Historical wire layout: legacy surrender-progress pairs, no fog meta;
// RPB1 has no isolated arrays. These fixtures use a connected real game.
function encodeLegacyView(replay, version) {
  const chunks = [];
  const u8 = (n) => chunks.push(Buffer.from([n]));
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    chunks.push(b);
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    chunks.push(b);
  };
  const str = (s) => {
    const b = Buffer.from(s);
    u16(b.length);
    chunks.push(b);
  };
  chunks.push(Buffer.from(`RPB${version}`));
  u16(replay.n);
  u16(replay.m);
  u32(replay.patches.length);
  function payload(p, diff) {
    u32(p.turn);
    u8(p.game_end ? 1 : 0);
    u16(p.leaderboard.length);
    for (const a of p.leaderboard) {
      u8(a.team);
      str(a.uid);
      u32(a.army);
      u32(a.land);
      u8(a.class_ === 'dead' ? 1 : a.class_ === 'afk' ? 2 : 0);
      u16(a.dead);
      u8(a.id);
    }
    u16(1);
    u8(1);
    u8(0); // real nonempty historical surrender-progress field
    for (const key of version === 1 ? ['grid_type', 'army_cnt'] : keys) {
      const values = p[key];
      u32(diff ? values.length / 2 : values.length);
      for (let i = 0; i < values.length; i++) {
        if (diff) u16(values[i++]);
        (key === 'army_cnt' ? u32 : u8)(values[i]);
      }
    }
  }
  payload(replay.initial, false);
  for (const patch of replay.patches) {
    payload(patch.forward, true);
    payload(patch.backward, true);
  }
  u8(1);
  u16(replay.meta.player_names.length);
  replay.meta.player_names.forEach((name, i) => {
    str(name);
    u8(replay.meta.player_teams[i]);
  });
  return Buffer.concat(chunks);
}
