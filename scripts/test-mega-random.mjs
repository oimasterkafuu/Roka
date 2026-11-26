import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { GameEngine } from '../src/game-engine.ts';
import { SeededRandom, resolveMapSeed } from '../src/map/map-core.ts';
import { drawMegaFamily, generateMegaRandomMap, megaFamilies } from '../src/map/mega-random-map-generator.ts';
import { encodeReplayPatchBinary } from '../src/replay-patch-binary.ts';
import { mapConfig, measureMap } from './evaluate-maze-fairness.mjs';

const dir = '/tmp/roka-mega-random';
const mode = 'mega_random';
await mkdir(dir, { recursive: true });
const config = (players, size, token, options = {}) =>
  mapConfig(players, size, token, { map_mode: mode, ...options });
const familyOf = (token) => drawMegaFamily(new SeededRandom(resolveMapSeed(mode, token)));
const cases = Object.fromEntries(megaFamilies.map((family) => [family, []]));
const seedDistribution = Object.fromEntries(megaFamilies.map((family) => [family, 0]));
for (let index = 0; index < 4096; index++) seedDistribution[familyOf(`mega-lottery-${index}`)]++;
assert.ok(megaFamilies.length >= 12 && Object.values(seedDistribution).every((count) => count > 180));

function neighbors(cell, width, length) {
  return [
    cell - width,
    cell + width,
    cell % width ? cell - 1 : -1,
    cell % width === width - 1 ? -1 : cell + 1,
  ].filter((next) => next >= 0 && next < length);
}

function assertNoChokepoint(board, token) {
  const { m, grid_type: tiles } = board;
  const adjacent = tiles.map((tile, cell) =>
    tile === 201 ? [] : neighbors(cell, m, tiles.length).filter((next) => tiles[next] !== 201),
  );
  const start = tiles.findIndex((tile) => tile !== 201);
  const parent = new Int32Array(tiles.length).fill(-1),
    order = new Int32Array(tiles.length),
    low = new Int32Array(tiles.length),
    cursor = new Uint8Array(tiles.length);
  const stack = [start];
  let time = 1,
    rootChildren = 0;
  low[start] = order[start] = time;
  while (stack.length) {
    const cell = stack.at(-1);
    if (cursor[cell] < adjacent[cell].length) {
      const next = adjacent[cell][cursor[cell]++];
      if (!order[next]) {
        parent[next] = cell;
        low[next] = order[next] = ++time;
        stack.push(next);
        if (cell === start) rootChildren++;
      } else if (next !== parent[cell]) low[cell] = Math.min(low[cell], order[next]);
    } else {
      stack.pop();
      const previous = parent[cell];
      if (previous < 0) continue;
      assert.ok(previous === start || low[cell] < order[previous], `${token} single-cell choke ${previous}`);
      low[previous] = Math.min(low[previous], low[cell]);
    }
  }
  assert.equal(rootChildren, 1, token);
  assert.equal(time, tiles.filter((tile) => tile !== 201).length, `${token} unreachable terrain`);
}

function distances(board, start, blocked = () => false) {
  const tiles = board.grid_type,
    dist = new Int32Array(tiles.length).fill(-1),
    queue = [start];
  dist[start] = 0;
  for (let head = 0; head < queue.length; head++)
    for (const next of neighbors(queue[head], board.m, tiles.length)) {
      if (tiles[next] !== 201 && !blocked(next) && dist[next] < 0) {
        dist[next] = dist[queue[head]] + 1;
        queue.push(next);
      }
    }
  return dist;
}

function checkRoutes(board, meta, family) {
  const { m, grid_type: tiles } = board;
  const spawns = tiles.flatMap((tile, cell) => (tile > 100 && tile < 117 ? [cell] : []));
  if (family === 'home_atolls' || family === 'team_shelves') {
    for (const cell of spawns) {
      const dry = distances(board, cell, (next) => tiles[next] === 204);
      assert.equal(
        spawns.filter((other) => dry[other] >= 0).length,
        1,
        `${family} FFA islands must be separated`,
      );
    }
  }
  if (family !== 'three_marches' && family !== 'meander') return;
  const generated = generateMegaRandomMap(
    new SeededRandom(resolveMapSeed(mode, meta.map_token)),
    meta.height_ratio,
    meta.width_ratio,
    meta.player_teams,
  );
  const fields = spawns.map((cell) => distances(board, cell));
  assert.equal(generated.crossings.length, family === 'meander' ? 1 : 2);
  for (const channels of generated.crossings) {
    const gates = channels.map((points) => points.map(([row, col]) => row * m + col));
    const blocked = new Set(gates.flat());
    const start = tiles.findIndex((tile, cell) => tile !== 201 && !blocked.has(cell));
    const separated = distances(board, start, (cell) => blocked.has(cell));
    assert.ok(tiles.some((tile, cell) => tile !== 201 && !blocked.has(cell) && separated[cell] < 0));
    const leaders = new Set();
    for (const gate of gates) {
      const closed = new Set(gate);
      const open = distances(board, start, (cell) => closed.has(cell));
      assert.ok(tiles.every((tile, cell) => tile === 201 || closed.has(cell) || open[cell] >= 0));
      const steps = fields.map((field) => Math.min(...gate.map((cell) => field[cell])));
      steps.forEach((distance, seat) => {
        if (distance === Math.min(...steps)) leaders.add(seat);
      });
    }
    assert.ok(leaders.size >= 2, `${meta.map_token}: monopolized crossings`);
  }
}

const occupied = (tile) => (tile === 201 ? '#' : tile === 204 ? '~' : '.');
function fingerprint(board) {
  const samples = 21;
  const transforms = [];
  for (const swap of [false, true])
    for (const flipRow of [false, true])
      for (const flipCol of [false, true]) {
        let signature = '';
        for (let row = 0; row < samples; row++)
          for (let col = 0; col < samples; col++) {
            const vertical = (flipRow ? samples - 1 - row : row) + 0.5,
              horizontal = (flipCol ? samples - 1 - col : col) + 0.5;
            signature += occupied(
              board.grid_type[
                Math.floor(((swap ? horizontal : vertical) * board.n) / samples) * board.m +
                  Math.floor(((swap ? vertical : horizontal) * board.m) / samples)
              ],
            );
          }
        transforms.push(signature);
      }
  return createHash('sha256').update(transforms.sort()[0]).digest('hex');
}

const witnesses = new Map();
const hashes = new Map(megaFamilies.map((family) => [family, new Set()]));
function analyze(board, players, token) {
  const family = familyOf(token),
    { grid_type: tiles, m } = board;
  const stats = measureMap(board, players);
  assert.equal(stats.actual, players, token);
  assert.equal(stats.missing + stats.duplicates + stats.illegal + stats.deadEnds, 0, token);
  assert.ok(stats.connected, token);
  assert.ok(
    tiles.every((tile) => [200, 201, 204].includes(tile) || (tile >= 101 && tile < 101 + players)),
    token,
  );
  assert.ok(
    tiles.filter((tile) => tile !== 201 && tile !== 204).length >= tiles.length * 0.5,
    `${token}: not enough ordinary land`,
  );
  for (const cell of stats.spawns)
    assert.ok(neighbors(cell, m, tiles.length).filter((next) => tiles[next] === 200).length >= 2, token);
  assertNoChokepoint(board, token);
  const spacing = Math.sqrt(tiles.filter((tile) => tile !== 201).length / players);
  const entry = {
    nearCV: stats.local[6].plains.cv,
    wideCV: stats.local[10].plains.cv,
    territoryCV: stats.voronoi.plains.cv,
    enemyCV: stats.nearest.cv,
    enemyRatio: stats.nearest.max / stats.nearest.min,
    minEnemy: stats.nearest.min,
    landShare: stats.voronoi.plains.min / stats.voronoi.plains.mean,
  };
  for (const key of ['nearCV', 'wideCV', 'territoryCV', 'enemyCV'])
    assert.ok(entry[key] <= 0.25, `${token} ${key}=${entry[key]}`);
  assert.ok(
    entry.minEnemy >= Math.floor(spacing * 0.5) && entry.enemyRatio <= 1.8 && entry.landShare >= 0.55,
    token,
  );
  for (const radius of [6, 10]) {
    const { plains, swamps } = stats.local[radius];
    entry[`minPlain${radius}`] = plains.min;
    entry[`plainShare${radius}`] = plains.min / plains.mean;
    entry[`swampBurden${radius}`] = swamps.max / plains.min;
    assert.ok(
      plains.min >= 12 && plains.min >= 0.65 * plains.mean && swamps.max <= plains.min / 3,
      `${token} radius ${radius}`,
    );
  }
  cases[family].push(entry);
}

let focus = 0,
  extended = 0;
for (const size of ['normal', 'large'])
  for (let players = 2; players <= 16; players++) {
    const focused = [2, 4, 8, 16].includes(players),
      quota = focused ? 8 : 2;
    const seen = new Map();
    for (
      let index = 0;
      [...seen.values()].reduce((sum, count) => sum + count, 0) < quota * megaFamilies.length;
      index++
    ) {
      const token = `mega-${size}-${players}-${index}`,
        family = familyOf(token),
        count = seen.get(family) ?? 0;
      if (count >= quota) continue;
      seen.set(family, count + 1);
      const meta = config(players, size, token);
      const board = await GameEngine.buildReplayBaseMap(meta);
      analyze(board, players, token);
      if (count === 0) checkRoutes(board, meta, family);
      if (size === 'normal' && players === 8) {
        hashes.get(family).add(fingerprint(board));
        if (!witnesses.has(family)) {
          assert.deepEqual(await GameEngine.buildReplayBaseMap(meta), board, token);
          witnesses.set(family, { token, signature: fingerprint(board) });
          const art = Array.from({ length: board.n }, (_, row) =>
            board.grid_type
              .slice(row * board.m, (row + 1) * board.m)
              .map((tile) =>
                tile >= 101 && tile <= 116 ? (tile - 100).toString(17).toUpperCase() : occupied(tile),
              )
              .join(''),
          ).join('\n');
          await writeFile(
            `${dir}/preview-${family}.txt`,
            `${family} | ${token} | ${board.n} x ${board.m}\n${art}\n`,
          );
        }
      }
      if (focused) focus++;
      else extended++;
    }
    console.log(`PASS ${size}/${players}: ${quota} seeds per family`);
  }
assert.equal(new Set([...witnesses.values()].map((witness) => witness.signature)).size, megaFamilies.length);
for (const [family, variants] of hashes)
  assert.ok(variants.size >= 3, `${family} lacks distinct secondary variants`);

const viewer = vm.createContext({
  replay_binary_magic: [...Buffer.from('RPB5')],
  replay_text_decoder: new TextDecoder(),
  replay_class_from_code: ['', 'dead', 'afk'],
});

for (const [token, minority] of [
  ['qa-12', 1],
  ['qa-18', 1],
  ['qa-22', 1],
  ['skew-smoke-16-5', 6],
]) {
  const teams = Array.from({ length: 16 }, (_, index) =>
    (minority === 1 ? index === 2 : index < minority) ? 2 : 1,
  );
  const board = await GameEngine.buildReplayBaseMap(
    config(16, 'normal', token, { player_teams: teams, allow_team: true }),
  );
  const cells = teams.map((_, index) => board.grid_type.indexOf(index + 101));
  const nearest = cells.map((cell, index) => {
    const field = distances(board, cell);
    return Math.min(...cells.flatMap((other, seat) => (teams[seat] !== teams[index] ? [field[other]] : [])));
  });
  const mean = nearest.reduce((sum, value) => sum + value, 0) / teams.length;
  assert.ok(
    Math.sqrt(nearest.reduce((sum, value) => sum + (value - mean) ** 2, 0) / teams.length) / mean <= 0.25,
  );
  assert.ok(Math.min(...nearest) > 0 && Math.max(...nearest) <= 1.8 * Math.min(...nearest));
}
vm.runInContext(await readFile('static/main/replay-binary.js', 'utf8'), viewer);
for (const [family, { token }] of witnesses) {
  const teams = [2, 0, 1, 2, 1],
    meta = config(4, 'normal', token, {
      allow_team: true,
      fog_mode: 'normal',
      player_names: ['A', 'Observer', 'B', 'C', 'D'],
      player_teams: teams,
    });
  const ids = meta.player_names;
  const live = await GameEngine.create(meta, ids, ids, 'mega-test', {
    update() {},
    emitInitMap() {},
    chatMessage() {},
    endGame() {},
    md5: (value) => value,
    replayStore: { saveReplay: async () => '' },
  });
  const board = await GameEngine.buildReplayBaseMap(meta);
  assert.deepEqual(live.generals[1], [-1, -1]);
  assert.deepEqual(live.buildReplayFrame(false).grid_type, board.grid_type);
  if (family === 'team_shelves') {
    const dry = distances(board, board.grid_type.indexOf(101), (next) => board.grid_type[next] === 204);
    assert.ok(
      dry[board.grid_type.indexOf(104)] >= 0 &&
        dry[board.grid_type.indexOf(103)] < 0 &&
        dry[board.grid_type.indexOf(105)] < 0,
    );
  }
  assert.ok(live.buildSnapshotFor(0).fog.includes(2));
  assert.equal(live.buildSnapshotFor(0), live.buildSnapshotFor(3));
  const frames = [],
    vision = [];
  for (let tick = 0; tick <= 3; tick++) {
    if (tick === 2) {
      const [row, col] = live.generals[0];
      const dest = neighbors(row * board.m + col, board.m, board.grid_type.length).find(
        (next) => board.grid_type[next] === 200,
      );
      live.addMove(ids[0], row, col, Math.floor(dest / board.m), dest % board.m, 2);
    }
    if (tick) await live.gameTick();
    frames.push(live.buildReplayFrame(false));
    vision.push(live.buildSnapshotFor(0).fog.slice());
  }
  assert.notDeepEqual(frames[0].grid_type, frames[3].grid_type, `${family} move executed`);
  const actions = {
    version: 'ops-v3',
    meta: live.replayMeta,
    total_turns: 3,
    player_ops: live.buildReplayPlayerOps(),
    exploration: live.fogVision.archive(),
  };
  const rebuilt = await GameEngine.buildReplayFromActions(actions);
  const decoded = viewer.decodeReplayBinary(Uint8Array.from(encodeReplayPatchBinary(rebuilt)).buffer);
  for (const field of ['grid_type', 'army_cnt', 'isolated']) {
    const actual = Array.from(decoded.initial[field]);
    assert.deepEqual(actual, frames[0][field]);
    for (const [index, patch] of decoded.patches.entries()) {
      const changes = patch.forward[field];
      for (let offset = 0; offset < changes.length; offset += 2)
        actual[changes[offset]] = changes[offset + 1];
      assert.deepEqual(actual, frames[index + 1][field], `${family}/${field}/${index + 1}`);
    }
  }
  for (const [tick, fog] of vision.entries())
    for (const [cell, state] of fog.entries())
      assert.equal(viewer.replayFogAt(decoded.vision.get(2), 'normal', cell, tick), state);
}

process.env.ROKA_DATA_DIR = `${dir}/api-data`;
process.env.JWT_SECRET = 'mega-random-test-secret';
process.env.WEBHOOK_SECRET = 'mega-random-test-secret';
process.env.ROKA_STATIC_CDN = '0';
const { app, boot } = await import('../src/server.ts');
await boot(false);
try {
  const response = await app.inject({
    method: 'GET',
    url: '/api/map-examples?map_mode=mega_random&players=8',
  });
  assert.equal(response.statusCode, 200);
  const { example } = response.json();
  assert.equal(example.map_mode, mode);
  assert.equal(example.grid_type.filter((tile) => tile >= 101 && tile <= 108).length, 8);
  assert.ok(!('family' in example));
} finally {
  await app.close();
}
const worstByFamily = Object.fromEntries(
  Object.entries(cases).map(([family, entries]) => [
    family,
    {
      maps: entries.length,
      variants: hashes.get(family).size,
      ...Object.fromEntries(
        Object.keys(entries[0]).map((key) => [
          key,
          (/^(min|plainShare|landShare)/.test(key) ? Math.min : Math.max)(
            ...entries.map((entry) => entry[key]),
          ),
        ]),
      ),
    },
  ]),
);
await writeFile(
  `${dir}/metrics.json`,
  JSON.stringify(
    { focus, extended, seedDistribution, worstByFamily, witnesses: Object.fromEntries(witnesses) },
    null,
    2,
  ),
);
console.log(
  `PASS ${focus + extended} engine boards, ${witnesses.size} family previews, team/fog/ops-v3/RPB5 and public example`,
);
