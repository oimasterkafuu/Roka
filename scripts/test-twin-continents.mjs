import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { GameEngine } from '../src/game-engine.ts';
import { encodeReplayPatchBinary } from '../src/replay-patch-binary.ts';
import { MAX_MOUNTAIN_RATIO, MAX_SWAMP_RATIO, SeededRandom, resolveMapSeed } from '../src/map/map-core.ts';
import { resolveMapSizeRatioByPlayers } from '../src/map/map-size.ts';
import { generateTwinContinentsMap, repackTwinCrowns } from '../src/map/twin-continents-map-generator.ts';
import { LobbyService } from '../src/server/lobby-service.ts';
import { checkSeatConfigurations, checkIncidents, crownAudit } from './check-crown-spacing.mjs';

const REPORT_DIR = '/tmp/roka-twin-continents';
const FOCUS_PLAYERS = [2, 4, 8, 16];
const SIZES = ['normal', 'large'];
const SEED_COUNT = 256;
const BASE_CONFIG = {
  cityRatio: 0.5,
  mountainRatio: 0.5,
  swampRatio: 0.5,
};

const configFor = (
  players,
  size,
  token,
  mapMode = 'twin_continents',
  playerTeams = Array.from({ length: players }, (_, index) => index + 1),
  allowTeam = false,
) => {
  const ratio = resolveMapSizeRatioByPlayers(players) * (size === 'large' ? 2 : 1);
  return {
    width_ratio: ratio,
    height_ratio: ratio,
    city_ratio: BASE_CONFIG.cityRatio,
    mountain_ratio: BASE_CONFIG.mountainRatio,
    swamp_ratio: BASE_CONFIG.swampRatio,
    speed: 1,
    allow_team: allowTeam,
    fog_mode: 'visible',
    multi_line: false,
    map_token: token,
    map_mode: mapMode,
    map_region: 'china',
    map_size: size,
    player_names: Array.from({ length: players }, (_, index) => `Player ${index + 1}`),
    player_teams: playerTeams,
  };
};

const makeMap = (players, size, token) => {
  const config = configFor(players, size, token);
  return generateTwinContinentsMap(new SeededRandom(resolveMapSeed('twin_continents', token)), {
    widthRatio: config.width_ratio,
    heightRatio: config.height_ratio,
    cityRatio: config.city_ratio,
    mountainRatio: config.mountain_ratio,
    swampRatio: config.swamp_ratio,
    requiredPlayers: players,
  });
};

const passable = (tile) => tile !== 1;

const neighbors = (n, m, cell) => {
  const x = Math.floor(cell / m);
  const y = cell % m;
  return [
    x > 0 ? cell - m : -1,
    x + 1 < n ? cell + m : -1,
    y > 0 ? cell - 1 : -1,
    y + 1 < m ? cell + 1 : -1,
  ].filter((next) => next >= 0);
};

const flood = (map, removed = new Set()) => {
  const cells = map.gridType.flat();
  const first = cells.findIndex((tile, cell) => passable(tile) && !removed.has(cell));
  if (first < 0) return new Set();
  const seen = new Set([first]);
  const queue = [first];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of neighbors(map.n, map.m, queue[head])) {
      if (seen.has(next) || removed.has(next) || !passable(cells[next])) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
};

const distribution = (values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const cv =
    mean === 0
      ? 0
      : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean;
  return { min: Math.min(...values), max: Math.max(...values), mean, cv };
};

const analyzeMap = (map, teams = map.layout.spawnPoints.map((_, seat) => seat)) => {
  const spawns = map.layout.spawnPoints;
  const spawnCells = spawns.map(([x, y]) => x * map.m + y);
  const distances = spawns.map(([sx, sy]) => {
    const distance = new Int32Array(map.n * map.m).fill(-1);
    const start = sx * map.m + sy;
    distance[start] = 0;
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      for (const next of neighbors(map.n, map.m, queue[head])) {
        const [x, y] = [Math.floor(next / map.m), next % map.m];
        if (distance[next] >= 0 || !passable(map.gridType[x][y])) continue;
        distance[next] = distance[queue[head]] + 1;
        queue.push(next);
      }
    }
    return distance;
  });
  const local = {};
  for (const radius of [6, 10]) {
    const plains = [];
    const swamps = [];
    for (const distance of distances) {
      let plainCount = 0;
      let swampCount = 0;
      for (let cell = 0; cell < distance.length; cell += 1) {
        if (distance[cell] <= 0 || distance[cell] > radius) continue;
        const tile = map.gridType[Math.floor(cell / map.m)][cell % map.m];
        if (tile === 0) plainCount += 1;
        if (tile === 2) swampCount += 1;
      }
      plains.push(plainCount);
      swamps.push(swampCount);
    }
    local[radius] = { plains: distribution(plains), swamps: distribution(swamps) };
  }
  const nearest = distances.map((distance, index) =>
    Math.min(...spawnCells.filter((_, other) => teams[other] !== teams[index]).map((cell) => distance[cell])),
  );
  const bridgeSteps = map.layout.bridges.map((bridge) =>
    distances.map((distance) => Math.min(...bridge.cells.map(([x, y]) => distance[x * map.m + y]))),
  );
  const bridgeLeaders = bridgeSteps.map((approach) => {
    const best = Math.min(...approach);
    return approach.flatMap((steps, seat) => (steps === best ? [seat] : []));
  });
  const territoryPlains = spawns.map(() => 0);
  for (let cell = 0; cell < map.n * map.m; cell += 1) {
    if (!passable(map.gridType[Math.floor(cell / map.m)][cell % map.m])) continue;
    const best = Math.min(...distances.map((distance) => distance[cell]).filter((value) => value >= 0));
    const owners = distances.flatMap((distance, index) => (distance[cell] === best ? [index] : []));
    for (const owner of owners) {
      if (map.gridType[Math.floor(cell / map.m)][cell % map.m] === 0)
        territoryPlains[owner] += 1 / owners.length;
    }
  }
  return {
    local,
    nearestSteps: nearest,
    bridgeSteps,
    bridgeLeaders,
    furthestBridgeAccess: Math.max(
      ...spawns.map((_, seat) => Math.min(...bridgeSteps.map((steps) => steps[seat]))),
    ),
    nearest: distribution(nearest),
    voronoiPlains: distribution(territoryPlains),
    exclusiveSwamp: bridgeLeaders[1].length === 1,
    exclusiveBothPlains:
      bridgeLeaders[0].length === 1 &&
      bridgeLeaders[2].length === 1 &&
      bridgeLeaders[0][0] === bridgeLeaders[2][0],
  };
};

const decodeEngineBoard = (board, layout, players) => {
  const gridType = [];
  const spawnPoints = Array.from({ length: players }, () => null);
  for (let x = 0; x < board.n; x += 1) {
    const row = [];
    for (let y = 0; y < board.m; y += 1) {
      const encoded = board.grid_type[x * board.m + y];
      if (encoded === 201) {
        row.push(1);
      } else if (encoded === 204) {
        row.push(2);
      } else if (encoded >= 101 && encoded < 101 + players) {
        assert.equal(spawnPoints[encoded - 101], null, 'duplicate live seat');
        row.push(-2);
        spawnPoints[encoded - 101] = [x, y];
      } else {
        assert.equal(encoded, 200);
        row.push(0);
      }
    }
    gridType.push(row);
  }
  assert.ok(spawnPoints.every((point) => point !== null));
  return {
    n: board.n,
    m: board.m,
    gridType,
    st: gridType.map((row) => row.map((tile) => tile !== 1)),
    layout: { ...layout, spawnPoints },
  };
};

const engineTerrainSignature = (board, players) =>
  board.grid_type.map((encoded) =>
    encoded === 201 || encoded === 204 ? encoded : encoded >= 101 && encoded < 101 + players ? 200 : encoded,
  );

const generatedTerrainSignature = (map) =>
  map.gridType.flat().map((tile) => (tile === 1 ? 201 : tile === 2 ? 204 : 200));

const validateMap = (map, players) => {
  assert.ok(map.n >= 7 && map.m >= 7);
  const flat = map.gridType.flat();
  const cross = map.layout.orientation === 'horizontal' ? map.m : map.n;
  assert.equal(map.layout.wallStart + map.layout.wallEnd, cross - 1, 'wall must reflect onto itself');
  const terrain = (tile) => (tile === -2 ? 0 : tile);
  for (let x = 0; x < map.n; x++) {
    for (let y = 0; y < map.m; y++) {
      const [mx, my] = mirrorPoint(map, [x, y]);
      assert.equal(terrain(map.gridType[x][y]), terrain(map.gridType[mx][my]), 'reflected terrain differs');
    }
  }
  assert.equal(map.layout.bridges.length, 3);
  assert.equal(map.layout.bridges.filter((bridge) => bridge.kind === 'plain').length, 2);
  assert.equal(map.layout.bridges.filter((bridge) => bridge.kind === 'swamp').length, 1);
  assert.equal(
    new Set(map.layout.bridges.flatMap((bridge) => bridge.cells.map((cell) => cell.join(',')))).size,
    map.layout.bridges.reduce((sum, bridge) => sum + bridge.cells.length, 0),
  );

  const bridgeCells = new Set(
    map.layout.bridges.flatMap((bridge) => bridge.cells.map(([x, y]) => x * map.m + y)),
  );
  const wallCells = [];
  if (map.layout.orientation === 'horizontal') {
    for (let x = 0; x < map.n; x += 1) {
      for (let y = map.layout.wallStart; y <= map.layout.wallEnd; y += 1) wallCells.push(x * map.m + y);
    }
  } else {
    for (let x = map.layout.wallStart; x <= map.layout.wallEnd; x += 1) {
      for (let y = 0; y < map.m; y += 1) wallCells.push(x * map.m + y);
    }
  }
  assert.deepEqual(
    wallCells.filter((cell) => passable(flat[cell])).sort((left, right) => left - right),
    wallCells.filter((cell) => bridgeCells.has(cell)).sort((left, right) => left - right),
  );
  const bands = map.layout.bridges.map((bridge) => {
    const positions = bridge.cells.map(([x, y]) => (map.layout.orientation === 'horizontal' ? x : y));
    return [Math.min(...positions), Math.max(...positions)];
  });
  const length = map.layout.orientation === 'horizontal' ? map.n : map.m;
  assert.ok(
    bands.every(
      (band, index) => index === 0 || band[0] - bands[index - 1][1] >= Math.max(2, Math.floor(length * 0.16)),
    ),
  );
  for (const bridge of map.layout.bridges) {
    assert.ok(bridge.width === 2 || bridge.width === 3);
    const [low, high] = bands[bridge.index];
    assert.equal(high - low + 1, bridge.width);
    assert.equal(bridge.cells.length, bridge.width * (map.layout.wallEnd - map.layout.wallStart + 1));
    assert.equal(bridge.headlands.length, 2 * bridge.width);
    for (const [x, y] of bridge.cells) {
      assert.equal(map.gridType[x][y], bridge.kind === 'swamp' ? 2 : 0);
    }
    for (const [x, y] of bridge.headlands) assert.equal(map.gridType[x][y], 0);
    const removed = new Set(bridge.cells.map(([x, y]) => x * map.m + y));
    assert.equal(flood(map, removed).size, flat.filter(passable).length - bridge.cells.length);
    const otherBridges = new Set([...bridgeCells].filter((cell) => !removed.has(cell)));
    assert.equal(flood(map, otherBridges).size, flat.filter(passable).length - otherBridges.size);
  }
  const firstBankDepth = map.layout.wallStart;
  const bankLength = map.layout.orientation === 'horizontal' ? map.n : map.m;
  assert.equal(flood(map, bridgeCells).size, firstBankDepth * bankLength);
  assert.equal(flood(map).size, flat.filter(passable).length);
  assert.equal(map.layout.spawnPoints.length, players);
  assert.equal(new Set(map.layout.spawnPoints.map(cellKey)).size, players);
  const bankCount = map.layout.spawnPoints.filter(
    ([x, y]) => (map.layout.orientation === 'horizontal' ? y : x) < map.layout.wallStart,
  ).length;
  assert.equal(Math.abs(players - 2 * bankCount), players % 2);
  for (const [x, y] of map.layout.spawnPoints) {
    assert.equal(map.gridType[x][y], -2);
    assert.equal(map.st[x][y], true);
    assert.notEqual(map.gridType[x][y], 1);
    assert.notEqual(map.gridType[x][y], 2);
    assert.ok(neighbors(map.n, map.m, x * map.m + y).filter((cell) => flat[cell] === 0).length >= 2);
  }
  assert.ok(flat.filter((tile) => tile === 1).length <= map.n * map.m * MAX_MOUNTAIN_RATIO);
  assert.ok(flat.filter((tile) => tile === 2).length <= map.n * map.m * MAX_SWAMP_RATIO);
};

const cellKey = ([x, y]) => x * 1000 + y;

const mirrorPoint = (map, [x, y]) =>
  map.layout.orientation === 'horizontal' ? [x, map.m - 1 - y] : [map.n - 1 - x, y];

const renderPreview = (map) => {
  const marks = new Map(
    map.layout.bridges.flatMap((bridge, index) =>
      bridge.cells.map((point) => [cellKey(point), ['=', '~', '+'][index]]),
    ),
  );
  const spawnLabels = new Map(
    map.layout.spawnPoints.map((point, index) => [cellKey(point), String((index + 1) % 10)]),
  );
  return map.gridType
    .map((row, x) =>
      row
        .map((tile, y) => {
          const label = spawnLabels.get(cellKey([x, y]));
          if (label) return label;
          if (marks.has(cellKey([x, y]))) return marks.get(cellKey([x, y]));
          if (tile === 1) return '#';
          if (tile === 2) return '~';
          return '.';
        })
        .join(''),
    )
    .join('\n');
};

const focusMetrics = [];
const extraMetrics = [];
const regressions = {};
const shapeHashes = new Set();
const orientationSet = new Set();
const rush = crownAudit();
const incidents = await checkIncidents('twin_continents', configFor, rush);
const checkFairness = (engineMap, token) => {
  const metrics = analyzeMap(engineMap);
  assert.ok(metrics.local[6].plains.cv <= 0.25, `${token} radius6 plain fairness`);
  assert.ok(metrics.local[10].plains.cv <= 0.25, `${token} radius10 plain fairness`);
  assert.ok(metrics.voronoiPlains.cv <= 0.25, `${token} Voronoi fairness`);
  assert.ok(metrics.nearest.cv <= 0.25, `${token} opponent distance fairness`);
  const spacing = Math.sqrt(engineMap.gridType.flat().filter(passable).length / metrics.nearestSteps.length);
  assert.ok(
    metrics.nearest.min >= Math.max(14, Math.floor(1.5 * spacing)),
    `${token} crowded seat: ${metrics.nearestSteps}`,
  );
  assert.ok(!metrics.exclusiveSwamp && !metrics.exclusiveBothPlains, `${token} uncontested bridge access`);
  assert.ok(metrics.furthestBridgeAccess <= Math.ceil(2 * spacing), `${token} isolated from bridges`);
  assert.ok(
    metrics.nearest.max <= 1.8 * metrics.nearest.min,
    `${token} outlying opponent distance: ${metrics.nearestSteps}`,
  );
  assert.ok(
    metrics.voronoiPlains.min >= 0.55 * metrics.voronoiPlains.mean,
    `${token} undersupplied territory`,
  );
  for (const radius of [6, 10]) {
    const { plains, swamps } = metrics.local[radius];
    assert.ok(
      plains.min >= 0.65 * plains.mean && plains.min >= 12,
      `${token} poor opening at radius ${radius}`,
    );
    assert.ok(swamps.max <= plains.min / 3, `${token} excessive opening swamp burden`);
  }
  assert.ok(
    metrics.bridgeLeaders.every((leaders) => leaders.length >= 2),
    `${token} single leader on a bridge`,
  );
  const { spawnPoints, orientation, wallStart } = engineMap.layout;
  if (spawnPoints.length % 2 === 0) {
    const positions = new Set(spawnPoints.map(cellKey));
    metrics.mirrorLayout = spawnPoints.every((point) =>
      positions.has(cellKey(mirrorPoint(engineMap, point))),
    );
    for (const leaders of metrics.bridgeLeaders)
      assert.equal(
        new Set(leaders.map((seat) => spawnPoints[seat][orientation === 'horizontal' ? 1 : 0] < wallStart))
          .size,
        2,
        `${token}: both banks must contest each bridge`,
      );
  }
  return metrics;
};
for (let players = 2; players <= 16; players++) {
  const repacked = repackTwinCrowns(players);
  validateMap(repacked, players);
  checkFairness(repacked, `repacked twin/${players}`);
}
for (const size of SIZES) {
  for (const players of FOCUS_PLAYERS) {
    for (let index = 0; index < SEED_COUNT; index += 1) {
      const token = `twin-fairness-${size}-${players}-${index}`;
      const map = makeMap(players, size, token);
      validateMap(map, players);
      const repeated = makeMap(players, size, token);
      assert.deepEqual(repeated, map, `${size}/${players}/${index} is deterministic`);
      const meta = configFor(players, size, token);
      const engineBoard = await GameEngine.buildReplayBaseMap(meta);
      rush.check(engineBoard, meta, `${size}/${players}`);
      assert.deepEqual(
        engineTerrainSignature(engineBoard, players),
        generatedTerrainSignature(map),
        `${size}/${players}/${index} engine terrain matches generator`,
      );
      const engineMap = decodeEngineBoard(engineBoard, map.layout, players);
      validateMap(engineMap, players);
      const metrics = checkFairness(engineMap, token);
      if (token === 'twin-fairness-normal-2-0') {
        assert.equal(metrics.bridgeSteps[1][0], metrics.bridgeSteps[1][1]);
        regressions[token] = { spawns: engineMap.layout.spawnPoints, swampSteps: metrics.bridgeSteps[1] };
      }
      focusMetrics.push({ size, players, token, ...metrics });
      orientationSet.add(map.layout.orientation);
      shapeHashes.add(createHash('sha256').update(JSON.stringify(map.gridType)).digest('hex'));
    }
    console.log(`PASS focus ${size}/${players}: ${SEED_COUNT} engine boards`);
  }
}

for (let players = 2; players <= 16; players += 1) {
  for (const size of SIZES)
    for (let index = 0; index < 32; index += 1) {
      const token = `twin-odd-count-${players}-${index}`;
      const map = makeMap(players, size, token);
      const meta = configFor(players, size, token);
      const board = await GameEngine.buildReplayBaseMap(meta);
      rush.check(board, meta, `${size}/${players}`);
      assert.deepEqual(engineTerrainSignature(board, players), generatedTerrainSignature(map));
      const engineMap = decodeEngineBoard(board, map.layout, players);
      validateMap(engineMap, players);
      assert.deepEqual(
        engineMap.layout.spawnPoints.map(cellKey).sort(),
        map.layout.spawnPoints.map(cellKey).sort(),
      );
      const metrics = checkFairness(engineMap, token);
      extraMetrics.push({ size, players, token, ...metrics });
      if (size === 'normal' && token === 'twin-odd-count-3-0') {
        assert.deepEqual(
          await GameEngine.buildReplayBaseMap(configFor(players, size, token)),
          board,
          'odd layout and seat assignment reproduce',
        );
        assert.ok(
          metrics.nearest.min >= 14 && metrics.nearest.max - metrics.nearest.min <= 3,
          `three-player regression: ${metrics.nearestSteps}`,
        );
        assert.equal(new Set(metrics.bridgeLeaders.flat()).size, 3, 'each of three seats contests a bridge');
        regressions[token] = {
          spawns: engineMap.layout.spawnPoints,
          nearestSteps: metrics.nearestSteps,
          bridgeSteps: metrics.bridgeSteps,
        };
      }
    }
  console.log(`PASS extended ${players}: both sizes, 32 engine boards each`);
}
assert.equal(orientationSet.size, 2);
for (const size of SIZES) {
  for (let players = 2; players <= 16; players += 2) {
    const layouts = [...focusMetrics, ...extraMetrics].filter(
      (entry) => entry.players === players && entry.size === size,
    );
    assert.ok(
      layouts.filter((entry) => !entry.mirrorLayout).length >= layouts.length / 2,
      `${size}/${players}: too many mirror layouts`,
    );
  }
}
const cramped = await checkSeatConfigurations(configFor, rush);
assert.ok(shapeHashes.size > 32);

const lobby = Object.create(LobbyService.prototype);
assert.equal(lobby.formatConfValue('map_mode', 'twin_continents'), '双陆通衢');
const [roomControls, gameHtml, tutorialHtml] = await Promise.all([
  readFile('static/main/room-controls.js', 'utf8'),
  readFile('static/game.html', 'utf8'),
  readFile('static/tutorial-text.html', 'utf8'),
]);
assert.match(roomControls, /双陆通衢.*twin_continents/s);
assert.match(roomControls, /twin_continents.*双陆通衢/s);
assert.match(gameHtml, /data-map-mode="twin_continents">双陆通衢/);
assert.match(tutorialHtml, /<option value="twin_continents">双陆通衢<\/option>/);

for (const [players, size] of [
  [2, 'normal'],
  [4, 'large'],
  [8, 'normal'],
  [16, 'large'],
]) {
  const board = await GameEngine.buildReplayBaseMap(
    configFor(players, size, `twin-engine-${players}-${size}`),
  );
  const encodedSpawns = board.grid_type.filter((tile) => tile >= 101 && tile < 101 + players);
  assert.equal(encodedSpawns.length, players, `engine initializes ${players} seats`);
  assert.deepEqual(
    [...new Set(encodedSpawns)].sort((left, right) => left - right),
    Array.from({ length: players }, (_, index) => 101 + index),
  );
  assert.ok(board.grid_type.includes(201));
  assert.ok(board.grid_type.includes(204));
}

const groupedConfig = configFor(4, 'normal', 'twin-team-init', 'twin_continents', [1, 1, 2, 2], true);
const groupedIds = groupedConfig.player_names.map((_, index) => `group-sid-${index}`);
const groupedSeats = [];
const groupedLive = await GameEngine.create(groupedConfig, groupedIds, groupedIds, 'twin-team-test', {
  update() {},
  chatMessage() {},
  endGame() {},
  md5: (value) => value,
  emitInitMap(_sid, data) {
    groupedSeats.push(data.general);
  },
  replayStore: { saveReplay: async () => '' },
});
assert.equal(groupedSeats.length, 4);
assert.ok(groupedSeats.every(([x, y]) => x >= 0 && y >= 0));
assert.deepEqual(groupedLive.replayMeta.player_teams, [1, 1, 2, 2]);
const groupedBoard = await GameEngine.buildReplayBaseMap(groupedConfig);
rush.check(groupedBoard, groupedConfig);
const groupedMap = decodeEngineBoard(groupedBoard, makeMap(4, 'normal', 'twin-team-init').layout, 4);
assert.deepEqual(groupedMap.layout.spawnPoints, groupedSeats);
const groupedNearest = analyzeMap(groupedMap, groupedConfig.player_teams).nearestSteps;
assert.ok(groupedNearest.every((steps) => steps > 0));

const liveConfig = configFor(4, 'normal', 'twin-replay-regression');
const ids = liveConfig.player_names.map((_, index) => `sid-${index}`);
const initSeats = [];
const live = await GameEngine.create(liveConfig, ids, ids, 'twin-live-test', {
  update() {},
  chatMessage() {},
  endGame() {},
  md5: (value) => value,
  emitInitMap(_sid, data) {
    initSeats.push(data.general);
  },
  replayStore: { saveReplay: async () => '' },
});
assert.equal(initSeats.length, 4);
const liveFrame = live.buildReplayFrame(false);
const rebuilt = await GameEngine.buildReplayFromActions({
  version: 'ops-v3',
  exploration: [],
  meta: live.replayMeta,
  total_turns: 1,
  player_ops: ids.map(() => [{ op: 'w', n: 1 }]),
});
assert.deepEqual(rebuilt.initial.grid_type, liveFrame.grid_type);
assert.deepEqual(rebuilt.initial.army_cnt, liveFrame.army_cnt);
const viewer = vm.createContext({
  replay_binary_magic: [...Buffer.from('RPB5')],
  replay_text_decoder: new TextDecoder(),
  replay_class_from_code: ['', 'dead', 'afk'],
});
vm.runInContext(await readFile('static/main/replay-binary.js', 'utf8'), viewer);
const decoded = viewer.decodeReplayBinary(Uint8Array.from(encodeReplayPatchBinary(rebuilt)).buffer);
assert.equal(decoded.patches.length, 1);
await live.gameTick();
const liveNext = live.buildReplayFrame(false);
for (const field of ['grid_type', 'army_cnt', 'isolated']) {
  const actual = Array.from(decoded.initial[field]);
  assert.deepEqual(actual, liveFrame[field]);
  const diff = decoded.patches[0].forward[field];
  for (let offset = 0; offset < diff.length; offset += 2) actual[diff[offset]] = diff[offset + 1];
  assert.deepEqual(actual, liveNext[field]);
}

process.env.ROKA_DATA_DIR = `${REPORT_DIR}/api-data`;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'twin-continents-test-secret';
process.env.WEBHOOK_SECRET = 'twin-continents-test-secret';
process.env.ROKA_STATIC_CDN = '0';
const { app, boot } = await import('../src/server.ts');
await boot(false);
const mapExampleResponse = await app.inject({
  method: 'GET',
  url: '/api/map-examples?map_mode=twin_continents&players=4',
});
assert.equal(mapExampleResponse.statusCode, 200);
const example = mapExampleResponse.json().example;
assert.equal(example.map_mode, 'twin_continents');
assert.equal(example.grid_type.length, example.n * example.m);
assert.deepEqual(example.grid_type.filter((tile) => tile >= 101 && tile <= 104).sort(), [101, 102, 103, 104]);
assert.ok(example.grid_type.includes(201) && example.grid_type.includes(204));
await app.close();

await mkdir(REPORT_DIR, { recursive: true });
const summary = {
  seedsPerFocusCase: SEED_COUNT,
  focusCases: SIZES.length * FOCUS_PLAYERS.length,
  allFocusMaps: focusMetrics.length,
  extraEngineMaps: extraMetrics.length,
  regressions,
  incidents,
  cramped,
  crownRush: rush.summary(),
  orientationSet: [...orientationSet],
  distinctTerrainHashes: shapeHashes.size,
  fairnessSource: 'GameEngine.buildReplayBaseMap() decoded initial output',
  worstByCase: Object.fromEntries(
    SIZES.flatMap((size) =>
      Array.from({ length: 15 }, (_, index) => {
        const players = index + 2;
        const rows = [...focusMetrics, ...extraMetrics].filter(
          (row) => row.size === size && row.players === players,
        );
        return [
          `${size}/${players}`,
          {
            maps: rows.length,
            radius6PlainCv: Math.max(...rows.map((row) => row.local[6].plains.cv)),
            radius10PlainCv: Math.max(...rows.map((row) => row.local[10].plains.cv)),
            radius6SwampMax: Math.max(...rows.map((row) => row.local[6].swamps.max)),
            radius10SwampMax: Math.max(...rows.map((row) => row.local[10].swamps.max)),
            voronoiPlainCv: Math.max(...rows.map((row) => row.voronoiPlains.cv)),
            nearestCv: Math.max(...rows.map((row) => row.nearest.cv)),
            minimumSeparation: Math.min(...rows.map((row) => row.nearest.min)),
            maximumNearestRatio: Math.max(...rows.map((row) => row.nearest.max / row.nearest.min)),
            minimumTerritoryShareOfMean: Math.min(
              ...rows.map((row) => row.voronoiPlains.min / row.voronoiPlains.mean),
            ),
            furthestBridgeAccess: Math.max(...rows.map((row) => row.furthestBridgeAccess)),
            uniqueFirstByBridge: [0, 1, 2].map(
              (bridge) => rows.filter((row) => row.bridgeLeaders[bridge].length === 1).length,
            ),
          },
        ];
      }),
    ),
  ),
  byCase: Object.fromEntries(
    SIZES.flatMap((size) =>
      FOCUS_PLAYERS.map((players) => {
        const rows = focusMetrics.filter((metric) => metric.size === size && metric.players === players);
        const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
        return [
          `${size}/${players}`,
          {
            radius6PlainCv: mean(rows.map((row) => row.local[6].plains.cv)),
            radius10PlainCv: mean(rows.map((row) => row.local[10].plains.cv)),
            radius6SwampCv: mean(rows.map((row) => row.local[6].swamps.cv)),
            radius10SwampCv: mean(rows.map((row) => row.local[10].swamps.cv)),
            voronoiPlainCv: mean(rows.map((row) => row.voronoiPlains.cv)),
            nearestMean: mean(rows.map((row) => row.nearest.mean)),
            nearestCv: mean(rows.map((row) => row.nearest.cv)),
            exclusiveSwampMaps: rows.filter((row) => row.exclusiveSwamp).length,
            exclusiveBothPlainsMaps: rows.filter((row) => row.exclusiveBothPlains).length,
          },
        ];
      }),
    ),
  ),
  teamInitialization: {
    teams: groupedConfig.player_teams,
    seats: groupedSeats,
    nearestOpponentSteps: groupedNearest,
  },
  replay: 'live, ops-v3 rebuild and RPB5 viewer initial/Tick 1 checked',
  api: 'GET /api/map-examples?map_mode=twin_continents&players=4 verified',
};
await writeFile(`${REPORT_DIR}/metrics.json`, JSON.stringify(summary, null, 2));
for (const players of [2, 8]) {
  await writeFile(
    `${REPORT_DIR}/preview-${players}.txt`,
    renderPreview(
      decodeEngineBoard(
        await GameEngine.buildReplayBaseMap(configFor(players, 'normal', `twin-preview-${players}`)),
        makeMap(players, 'normal', `twin-preview-${players}`).layout,
        players,
      ),
    ),
  );
}
console.log(JSON.stringify(summary, null, 2));
const firstMonopoly = focusMetrics.find((row) => row.exclusiveSwamp || row.exclusiveBothPlains);
assert.ok(!firstMonopoly, `uncontested bridge access: ${firstMonopoly?.token}`);
