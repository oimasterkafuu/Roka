import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { GameEngine } from '../dist/game-engine.js';
import { ReplayStore } from '../dist/replay-store.js';
import { decodeBinary } from '../dist/binary-store.js';
import { LobbyService, SIMPLE_AI_RATING_PENALTY } from '../dist/server/lobby-service.js';

const players = ['human', 'hosted', 'third_party'];
const config = {
  width_ratio: 0.6,
  height_ratio: 0.6,
  city_ratio: 0.5,
  mountain_ratio: 0.5,
  swamp_ratio: 0.5,
  speed: 1,
  allow_team: false,
  fog_mode: 'visible',
  multi_line: false,
  map_token: 'ai-difficulty-test',
  map_mode: 'random',
  map_region: 'han',
  map_size: 'normal',
  player_names: players,
  player_teams: [1, 2, 3],
  server_bot_seats: [2],
};
const createGame = (overrides, callbacks) =>
  GameEngine.create({ ...config, ...overrides }, players, players, 'test-arena', {
    emitInitMap() {},
    update() {},
    chatMessage() {},
    endGame() {},
    md5: (sid) => sid,
    ...callbacks,
  });

const neighbors = ({ n, m }, [row, col]) =>
  [
    [row - 1, col],
    [row + 1, col],
    [row, col - 1],
    [row, col + 1],
  ].filter(([x, y]) => x >= 0 && y >= 0 && x < n && y < m);

for (const multiLine of [false, true]) {
  test(`only hosted crowns change, at every tick (${multiLine ? 'multi-line' : 'single-line'})`, async () => {
    const normal = await createGame({ ai_difficulty: 'normal', multi_line: multiLine });
    const simple = await createGame({ ai_difficulty: 'simple', multi_line: multiLine });
    assert.deepEqual(normal.generals, simple.generals);
    const [crownRow, crownCol] = simple.generals[1];
    const [[plainRow, plainCol], [cityRow, cityCol], [secondCrownRow, secondCrownCol]] = neighbors(simple, [
      crownRow,
      crownCol,
    ]).filter(([row, col]) => simple.owner[row][col] === 0);
    const cells = [
      [plainRow, plainCol, 0],
      [cityRow, cityCol, -1],
      [secondCrownRow, secondCrownCol, -2],
    ];
    const isolated = simple.owner
      .flatMap((row, x) => row.flatMap((owner, y) => (owner ? [] : [[x, y]])))
      .find(([row, col]) => simple.generals.every(([x, y]) => Math.abs(row - x) + Math.abs(col - y) > 3));
    const [isolatedRow, isolatedCol] = isolated;
    for (const engine of [normal, simple]) {
      for (const [row, col, tile] of [...cells, [isolatedRow, isolatedCol, 0]]) {
        engine.owner[row][col] = 2;
        engine.gridType[row][col] = tile;
        engine.armyCnt[row][col] = 80;
      }
    }
    let isolatedDecay = false;
    for (let tick = 1; tick <= 105; tick++) {
      assert.equal(await normal.gameTick(), false);
      assert.equal(await simple.gameTick(), false);
      for (const [index, [row, col]] of simple.generals.entries()) {
        assert.equal(normal.armyCnt[row][col], 1 + tick);
        assert.equal(simple.armyCnt[row][col], 1 + (index === 1 ? Math.floor(tick / 2) : tick));
      }
      const base = Math.floor(tick / 50);
      const burst = multiLine ? 0 : Math.max(0, Math.min(50, tick) - 25);
      for (const engine of [normal, simple]) {
        assert.equal(engine.armyCnt[plainRow][plainCol], 80 + base + burst, `plain tick ${tick}`);
        assert.equal(engine.armyCnt[cityRow][cityCol], 80 + base, `city tick ${tick}`);
      }
      assert.equal(normal.armyCnt[secondCrownRow][secondCrownCol], 80 + tick);
      assert.equal(simple.armyCnt[secondCrownRow][secondCrownCol], 80 + Math.floor(tick / 2));
      assert.equal(simple.isolated[isolatedRow][isolatedCol], simple.armyCnt[isolatedRow][isolatedCol] > 0);
      assert.deepEqual(simple.isolated, normal.isolated);
      assert.equal(simple.armyCnt[isolatedRow][isolatedCol], normal.armyCnt[isolatedRow][isolatedCol]);
      isolatedDecay ||= simple.armyCnt[isolatedRow][isolatedCol] < 80;
    }
    assert.equal(isolatedDecay, true);
  });
}

function checkPlayback(initial, patches, live) {
  const fields = ['army_cnt', 'grid_type', 'isolated'];
  const state = Object.fromEntries(fields.map((field) => [field, [...initial[field]]]));
  assert.equal(patches.length, live.length - 1);
  for (const [tick, frame] of live.entries()) {
    for (const field of fields) {
      const diff = tick ? patches[tick - 1].forward[field] : [];
      for (let index = 0; index < diff.length; index += 2) state[field][diff[index]] = diff[index + 1];
      assert.deepEqual(state[field], frame[field], `${field} at Tick ${tick}`);
    }
  }
}

test('recorded ops-v3 and cached RPB5 reconstruct the simple match board at every tick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'roka-difficulty-replay-'));
  try {
    const replayStore = new ReplayStore(dir, { buildReplayFromActions: GameEngine.buildReplayFromActions });
    await replayStore.ensureReady();
    const engine = await createGame({ ai_difficulty: 'simple', fog_mode: 'normal' }, { replayStore });
    const live = [engine.buildReplayFrame(false)];
    const [row, col] = engine.generals[1];
    const [targetRow, targetCol] = neighbors(engine, [row, col]).find(
      ([targetX, targetY]) => engine.gridType[targetX][targetY] === 0,
    );
    for (let tick = 1; tick <= 55; tick++) {
      if (tick === 4) engine.addMove('hosted', row, col, targetRow, targetCol, 2);
      assert.equal(await engine.gameTick(), false);
      live.push(engine.buildReplayFrame(false));
    }
    assert.equal(engine.owner[targetRow][targetCol], 2);
    engine.surrender('human');
    engine.surrender('third_party');
    assert.equal(await engine.gameTick(), true);
    live.push(engine.buildReplayFrame(true));
    assert.deepEqual(
      engine
        .buildGameResult()
        .filter((entry) => entry.server_bot)
        .map((entry) => entry.uid),
      ['hosted'],
    );
    const [entry] = await replayStore.listReplays();
    const raw = await replayStore.readRawReplay(entry.id);
    const actions = await decodeBinary(raw);
    assert.equal(actions.version, 'ops-v3');
    assert.equal(actions.meta.ai_difficulty, 'simple');
    assert.deepEqual(actions.meta.server_bot_seats, [2]);
    const { initial, patches } = await replayStore.buildReplayFromRaw(raw);
    checkPlayback(initial, patches, live);

    const { gzip } = await replayStore.readReplayViewGzip(entry.id);
    const cached = await replayStore.readReplayViewGzip(entry.id);
    assert.deepEqual(cached.gzip, gzip);
    const context = {
      buffer: Uint8Array.from(gunzipSync(gzip)).buffer,
      replay_binary_magic: [...Buffer.from('RPB5')],
      replay_text_decoder: new TextDecoder(),
      replay_class_from_code: ['', 'dead', 'afk'],
    };
    vm.runInNewContext(
      await readFile(new URL('../static/main/replay-binary.js', import.meta.url), 'utf8'),
      context,
    );
    const viewed = vm.runInNewContext('decodeReplayBinary(buffer)', context);
    checkPlayback(viewed.initial, viewed.patches, live);

    const invalidMeta = { ...actions.meta, server_bot_seats: undefined };
    await assert.rejects(GameEngine.buildReplayFromActions({ ...actions, meta: invalidMeta }), /不兼容/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Elo uses only the hosted seat discount and floors only its effective Rating', async () => {
  const result = [
    { uid: 'human', team: 1, rank: 1 },
    { uid: 'hosted', team: 2, rank: 2, server_bot: true },
  ];
  const ratings = new Map([
    ['human', 1200],
    ['hosted', 1200],
  ]);
  const updates = [];
  const lobby = new LobbyService(null, {
    getRating: (uid) => ({ rating: ratings.get(uid) }),
    applyPointsUpdates: async () => {},
    applyRatingUpdates: async (items) => updates.push(...items),
  });
  const check = async (difficulty, effective, entries = result) => {
    await lobby.applyGameResult(entries, undefined, difficulty);
    const expected = 1 / (1 + 10 ** ((1200 - effective) / 400));
    assert.ok(Math.abs(updates[0].delta - 128 * expected) < 1e-9);
    assert.ok(Math.abs(updates[1].delta + 128 * expected) < 1e-9);
    assert.deepEqual(
      updates.map((item) => item.username),
      ['human', 'hosted'],
    );
    updates.length = 0;
  };
  assert.equal(SIMPLE_AI_RATING_PENALTY, 400);
  await check('normal', 1200);
  await check('simple', 1200 - SIMPLE_AI_RATING_PENALTY);
  assert.equal(ratings.get('hosted'), 1200);
  ratings.set('hosted', SIMPLE_AI_RATING_PENALTY + 1);
  await check('simple', 1);
  ratings.set('hosted', SIMPLE_AI_RATING_PENALTY);
  await check('simple', 0);
  ratings.set('hosted', 50);
  await check('simple', 0);
  await check('normal', 50);
  await check('simple', 50, [result[0], { uid: 'hosted', team: 2, rank: 2 }]);
});
