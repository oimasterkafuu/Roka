import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { GameEngine } from '../dist/game-engine.js';
import { computeTeamVisibility, FogVision } from '../dist/game-engine/fog-vision.js';
import { buildFullVisionArrays } from '../dist/game-engine/map-encoding.js';
import { encodeReplayPatchBinary } from '../dist/replay-patch-binary.js';

const grid = (rows, cols, value) => Array.from({ length: rows }, () => Array(cols).fill(value));
const visibilityBoard = {
  n: 7,
  m: 7,
  owner: grid(7, 7, 0),
  isolated: grid(7, 7, false),
  gridType: grid(7, 7, 0),
};
visibilityBoard.owner[3][3] = 1;
visibilityBoard.gridType[3][3] = -2;
visibilityBoard.owner[1][1] = 2;
visibilityBoard.gridType[1][1] = -1;
visibilityBoard.owner[0][6] = 3;
visibilityBoard.gridType[0][6] = -1;
visibilityBoard.isolated[0][6] = true;
const visibility = new Uint8Array(49);
visibilityBoard.owner[1][1] = 0;
visibilityBoard.gridType[1][1] = 0;
computeTeamVisibility(visibilityBoard, [1, 1, 2], new Map([[1, visibility]]));
for (let row = 1; row <= 5; row += 1) {
  for (let col = 1; col <= 5; col += 1) assert.equal(visibility[row * 7 + col], 1);
}
assert.equal(visibility[0], 0, 'a building view is exactly 5x5');
assert.equal(visibility[6], 0, 'a building view is exactly 5x5');
assert.equal(visibility[0 * 7 + 6], 0, 'an enemy building does not provide this team vision');
visibilityBoard.owner[1][1] = 2;
visibilityBoard.gridType[1][1] = -1;
computeTeamVisibility(visibilityBoard, [1, 1, 2], new Map([[1, visibility]]));
assert.equal(visibility[0], 1, 'teammate buildings contribute to the shared union');
visibilityBoard.owner[3][3] = 0;
visibilityBoard.gridType[3][3] = 0;
visibilityBoard.owner[0][6] = 0;
visibilityBoard.gridType[0][6] = 0;
visibilityBoard.owner[1][1] = 0;
visibilityBoard.gridType[1][1] = 0;
visibilityBoard.owner[3][3] = 1;
computeTeamVisibility(visibilityBoard, [1, 1, 2], new Map([[1, visibility]]));
assert.equal(visibility[2 * 7 + 2], 1, 'an ordinary cell provides a 3x3 view');
assert.equal(visibility[1 * 7 + 1], 0, 'an ordinary cell does not provide a 5x5 view');
visibilityBoard.owner[3][3] = 0;
visibilityBoard.owner[0][0] = 1;
visibilityBoard.gridType[0][0] = -1;
computeTeamVisibility(visibilityBoard, [1, 1, 2], new Map([[1, visibility]]));
assert.equal(visibility[0], 1, 'an edge building view is clipped to the map');
assert.equal(visibility[0 * 7 + 3], 0, 'an edge building view remains 5x5 after clipping');
visibilityBoard.owner[0][0] = 0;
visibilityBoard.gridType[0][0] = 0;
visibilityBoard.owner[3][3] = 1;
visibilityBoard.gridType[3][3] = -2;
visibilityBoard.isolated[3][3] = true;
computeTeamVisibility(visibilityBoard, [1, 1, 2], new Map([[1, visibility]]));
assert.equal(visibility[3 * 7 + 3], 1, 'an isolated building only reveals itself');
assert.equal(visibility[2 * 7 + 2], 0, 'an isolated building does not expand to 5x5');

const memoryBoard = {
  n: 7,
  m: 7,
  owner: grid(7, 7, 0),
  isolated: grid(7, 7, false),
  isolatedAge: grid(7, 7, 0),
  gridType: grid(7, 7, 0),
  armyCnt: grid(7, 7, 0),
};
memoryBoard.owner[3][3] = 1;
memoryBoard.armyCnt[3][3] = 20;
memoryBoard.owner[3][4] = 2;
memoryBoard.gridType[3][4] = -1;
memoryBoard.armyCnt[3][4] = 99;
const memoryVision = new FogVision('normal', 49, [1, 2]);
const memorySnapshot = () => memoryVision.snapshot(1, buildFullVisionArrays(memoryBoard));
memoryVision.advance(memoryBoard, 0);
assert.equal(memorySnapshot().fog[25], 0);
assert.equal(memorySnapshot().grid_type[25], 52);
memoryBoard.isolated[3][3] = true;
memoryVision.advance(memoryBoard, 1);
assert.equal(memorySnapshot().fog[25], 1);
assert.equal(memorySnapshot().grid_type[25], 52, 'last-seen building and color are retained');
memoryBoard.owner[3][3] = 0;
memoryBoard.owner[3][4] = 0;
memoryBoard.gridType[3][4] = 0;
memoryBoard.armyCnt[3][4] = 0;
memoryVision.advance(memoryBoard, 2);
assert.ok(memorySnapshot().fog.every((state) => state !== 0), 'team has no remaining vision source');
assert.equal(memorySnapshot().fog[25], 1);
assert.equal(memorySnapshot().grid_type[25], 52, 'losing all vision does not reveal the demolition');
assert.equal(memorySnapshot().army_cnt[25], 0);
memoryBoard.owner[3][3] = 1;
memoryBoard.isolated[3][3] = false;
memoryVision.advance(memoryBoard, 3);
assert.equal(memorySnapshot().fog[25], 0);
assert.equal(memorySnapshot().grid_type[25], 200, 'visible empty ground clears memory');
memoryBoard.isolated[3][3] = true;
memoryVision.advance(memoryBoard, 4);
assert.equal(memorySnapshot().fog[25], 1);
assert.equal(memorySnapshot().grid_type[25], 200, 'cleared building does not return under fog');
memoryBoard.isolated[3][3] = false;
memoryBoard.owner[3][4] = 3;
memoryBoard.gridType[3][4] = -2;
memoryVision.advance(memoryBoard, 5);
assert.equal(memorySnapshot().grid_type[25], 103);
memoryBoard.isolated[3][3] = true;
memoryVision.advance(memoryBoard, 6);
memoryBoard.owner[3][4] = 2;
memoryBoard.gridType[3][4] = -1;
memoryVision.advance(memoryBoard, 7);
assert.equal(memorySnapshot().grid_type[25], 103, 'unseen rebuild and recolor do not change memory');
memoryBoard.isolated[3][3] = false;
memoryVision.advance(memoryBoard, 8);
assert.equal(memorySnapshot().grid_type[25], 52, 'revisible building refreshes type and color');

const board = {
  n: 7,
  m: 7,
  owner: grid(7, 7, 0),
  isolated: grid(7, 7, false),
  isolatedAge: grid(7, 7, 0),
  gridType: grid(7, 7, 0),
  armyCnt: grid(7, 7, 0),
};
board.owner[3][3] = 1;
board.armyCnt[3][3] = 15;
board.isolated[3][3] = true;
board.owner[0][0] = 2;
board.gridType[2][2] = 1;
board.gridType[2][3] = 2;
board.owner[2][3] = 3;
board.armyCnt[2][3] = 70;
board.isolated[2][3] = true;
for (const mode of ['normal', 'explored']) {
  const vision = new FogVision(mode, 49, [1, 1, 2]);
  const snapshot = () => vision.snapshot(1, buildFullVisionArrays(board));
  vision.advance(board, 0);
  const first = snapshot();
  assert.equal(first, snapshot(), 'cache is shared by teammates');
  assert.equal(first.fog[24], 0);
  assert.equal(first.isolated[24], 1);
  assert.equal(first.army_cnt[24], 15);
  assert.equal(first.fog[0], 0, 'teammate shares vision');
  for (const index of [16, 17, 18, 23, 25, 30, 31, 32]) {
    assert.equal(first.fog[index], mode === 'normal' ? 2 : 1);
    assert.equal(first.army_cnt[index], 0);
    assert.equal(first.isolated[index], 0);
    if (mode === 'normal') assert.equal(first.grid_type[index], 200);
  }
  if (mode === 'explored') {
    assert.equal(first.grid_type[16], 201);
    assert.equal(first.grid_type[17], 204);
    assert.deepEqual(vision.archive(), []);
  } else {
    const initial = vision.archive()[0][1];
    assert.deepEqual([...initial], [0, 0, 1, 0, 7, 0, 8, 0, 24, 0]);
    vision.advance(board, 1);
    assert.deepEqual(vision.archive()[0][1], initial, 'isolated neighbors do not become explored');
    board.isolated[3][3] = false;
    vision.advance(board, 2);
    assert.equal(vision.archive()[0][1].length - initial.length, 16);
    board.isolated[3][3] = true;
    vision.advance(board, 3);
    const last = snapshot();
    assert.equal(last.fog[16], 1);
    assert.equal(last.grid_type[16], 201);
    assert.equal(last.grid_type[17], 204);
  }
}

const ids = ['Alice', 'Bea', 'Carol'];
const config = {
  width_ratio: 0.42,
  height_ratio: 0.42,
  swamp_ratio: 0.15,
  allow_team: true,
  multi_line: false,
  fog_mode: 'normal',
  map_mode: 'random',
  map_region: 'han',
  map_size: 'normal',
  speed: 1,
  player_names: ids,
  player_teams: [1, 1, 2],
  map_token: 'fog-fixture-0',
};
const keys = ['grid_type', 'army_cnt', 'isolated', 'fog'];
const views = new Map(ids.map((id) => [id, []]));
let saved;
const callbacks = {
  emitInitMap() {},
  update() {},
  chatMessage() {},
  endGame() {},
  md5: (id) => id,
  replayStore: {
    async saveReplay(raw) {
      saved = raw;
      return 'test';
    },
  },
};
for (const map_mode of [
  'random',
  'maze',
  'archipelago',
  'mediterranean',
  'huaxia',
  'twin_continents',
  'mega_random',
]) {
  const engine = await GameEngine.create({ ...config, map_mode }, ids, ids, 'maps', callbacks);
  const initial = engine.buildSnapshotFor(0);
  for (const [row, col] of engine.generals.slice(0, 2)) {
    const home = row * engine.m + col;
    assert.equal(initial.fog[home], 0, map_mode);
  }
  assert.ok(initial.fog.includes(2), map_mode);
  assert.equal(initial, engine.buildSnapshotFor(1), map_mode);
  assert.ok(engine.fogVision.archive()[0][1].length > 0, map_mode);
}

const engine = await GameEngine.create(config, ids, ids, 'exploration-test', {
  ...callbacks,
  update(id, frame) {
    const history = views.get(id);
    const prior = history.at(-1);
    const current = Object.fromEntries(
      keys.map((key) => [key, frame.is_diff ? prior[key].slice() : frame[key].slice()]),
    );
    if (frame.is_diff) {
      for (const key of keys) {
        for (let pair = 0; pair < frame[key].length; pair += 2)
          current[key][frame[key][pair]] = frame[key][pair + 1];
      }
    }
    assert.deepEqual(
      current,
      engine.buildSnapshotFor(ids.indexOf(id)),
      `filtered diff at ${id}/${frame.turn}`,
    );
    history.push(current);
  },
});
assert.deepEqual(engine.generals, [
  [18, 18],
  [7, 0],
  [0, 15],
]);
const pivot = [17, 18];
const march = [
  [0, 14],
  [1, 14],
  [2, 14],
  [2, 15],
  [3, 15],
  [3, 16],
  [4, 16],
  [5, 16],
  [5, 17],
  [6, 17],
  [7, 17],
  [8, 17],
  [9, 17],
  [10, 17],
  [11, 17],
  [12, 17],
  [13, 17],
  [14, 17],
  [15, 17],
  [15, 18],
  [16, 18],
];
const site = 15 * 19 + 18;
const natural = 15 * 19 + 16;
const ally = views.get('Bea');
await engine.sendMap(false);
assert.equal(ally[0].fog[natural], 2);
assert.equal(ally[0].grid_type[natural], 200);
await engine.gameTick();
engine.addMove('Alice', ...engine.generals[0], ...pivot, 2);
await engine.gameTick();
assert.equal(ally[2].fog[natural], 2);
assert.equal(ally[2].grid_type[natural], 200);
while (engine.turn < 105) await engine.gameTick();
let origin = engine.generals[2];
for (const destination of march) {
  engine.addMove('Carol', ...origin, ...destination, 2);
  await engine.gameTick();
  origin = destination;
}
engine.addMove('Carol', ...origin, 15, 18, 2);
await engine.gameTick();
origin = [15, 18];
engine.addBuild('Carol', ...origin, 'b');
await engine.gameTick();
engine.addMove('Alice', ...pivot, 16, 18, 2);
await engine.gameTick();
const visibleTurn = engine.turn;
assert.equal(ally[visibleTurn].grid_type[site], 53);
assert.equal(ally[visibleTurn].fog[site], 0);
engine.addMove('Carol', ...origin, 16, 18, 2);
await engine.gameTick();
const shallowTurn = engine.turn;
assert.equal(ally[shallowTurn].fog[site], 1);
assert.equal(ally[shallowTurn].grid_type[site], 53);
assert.equal(ally[shallowTurn].army_cnt[site], 0);
assert.equal(ally[shallowTurn].isolated[site], 0);
assert.equal(ally[shallowTurn].fog[natural], 2);
assert.equal(ally[shallowTurn].grid_type[natural], 200);
engine.surrender('Carol');
assert.equal(await engine.gameTick(), true);
assert.ok(
  views
    .get('Carol')
    .at(-1)
    .fog.every((state) => state === 0),
);
assert.deepEqual(saved.exploration, engine.fogVision.archive());
const damaged = structuredClone(saved);
damaged.exploration[0][1][1] += 1;
await assert.rejects(GameEngine.buildReplayFromActions(damaged), /探索记录/);
const replay = await GameEngine.buildReplayFromActions(saved);
const binary = encodeReplayPatchBinary(replay);
const context = vm.createContext({
  replay_binary_magic: [...Buffer.from('RPB5')],
  replay_text_decoder: new TextDecoder(),
  replay_class_from_code: ['', 'dead', 'afk'],
});
vm.runInContext(readFileSync('static/main/replay-binary.js', 'utf8'), context);
const decoded = context.decodeReplayBinary(Uint8Array.from(binary).buffer);
assert.equal(decoded.meta.fog_mode, 'normal');
for (const [player, team] of config.player_teams.entries()) {
  const live = views.get(ids[player]);
  const recorded = decoded.vision.get(team);
  const firstSeen = [];
  for (let cell = 0; cell < engine.n * engine.m; cell += 1) {
    for (let turn = live.length - 1; turn >= 0; turn -= 1) {
      assert.equal(
        context.replayFogAt(recorded, 'normal', cell, turn),
        live[turn].fog[cell],
        `${team}/${turn}/${cell}`,
      );
    }
    if (recorded.cells.has(cell)) firstSeen.push([cell, recorded.cells.get(cell)[0]]);
  }
  const archived = saved.exploration.find(([id]) => id === team)[1];
  assert.deepEqual(
    firstSeen,
    [...archived.filter((_, offset) => offset % 2 === 0)]
      .map((cell, index) => [cell, archived[index * 2 + 1]])
      .sort((left, right) => left[0] - right[0]),
  );
}

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://roka.test') return route.abort();
      if (url.pathname === '/replays/local') return route.fulfill({ path: 'static/game.html' });
      if (url.pathname === '/api/user-colors') return route.fulfill({ json: {} });
      return route.fulfill({ path: `static${url.pathname}` }).catch(() => route.fulfill({ status: 404 }));
    });
    await page.addInitScript(
      (fixture) => sessionStorage.setItem('roka_local_replay', fixture),
      binary.toString('base64'),
    );
    await page.goto('http://roka.test/replays/local');
    await page.waitForFunction(() => window.in_game && window.replay_data);
    assert.deepEqual(await page.locator('#tabs-replay-view .inline-button').allTextContents(), [
      '全知',
      '队伍 1',
      '队伍 2',
    ]);
    await page.locator('#tabs-replay-view .inline-button').nth(1).click();
    const state = (turn) =>
      page.evaluate(
        ({ turn, site, natural }) => {
          jumpToFrame(turn);
          return [site, natural].map((index) => {
            const row = Math.floor(index / m),
              col = index % m,
              cell = cell_elems[row][col];
            const style = getComputedStyle(cell);
            return {
              fog: fog[row][col],
              cls: cell.className,
              text: cell.textContent,
              image: style.backgroundImage,
              color: style.backgroundColor,
              filter: style.filter,
            };
          });
        },
        { turn, site, natural },
      );
    const [deepSite, deepMountain] = await state(0);
    assert.equal(deepSite.fog, 2);
    assert.match(deepSite.cls, /fog-unexplored/);
    assert.equal(deepSite.image, 'none');
    assert.equal(deepSite.text, '');
    assert.equal(deepMountain.fog, 2);
    assert.match(deepMountain.cls, /fog-unexplored/);
    assert.equal(deepMountain.image, 'none');
    assert.equal(deepMountain.text, '');
    const [liveSite] = await state(visibleTurn);
    assert.match(liveSite.cls, /c3 city/);
    const [oldSite, oldMountain] = await state(shallowTurn);
    assert.equal(oldSite.fog, 1);
    assert.match(oldSite.cls, /c3 city fog fog-memory/);
    assert.equal(oldSite.color, liveSite.color);
    assert.notEqual(oldSite.filter, liveSite.filter);
    const grayscale = Number(oldSite.filter.match(/grayscale\(([\d.]+)\)/)?.[1]);
    assert.ok(grayscale > 0 && grayscale < 1, `memory must retain owner hue: ${oldSite.filter}`);
    assert.equal(oldSite.text, '');
    assert.notEqual(oldSite.image, 'none');
    assert.equal(oldMountain.fog, 2);
    assert.equal(oldMountain.image, 'none');
    assert.equal(oldMountain.text, '');
    await state(visibleTurn);
    await page.locator('#replay-autoplay-btn').click();
    await page.waitForFunction(
      ({ shallowTurn, site }) => cur_turn >= shallowTurn && fog[Math.floor(site / m)][site % m] === 1,
      { shallowTurn, site },
    );
    await page.evaluate(() => {
      if (is_autoplaying) switchAutoplay();
    });
    await page.locator('#tabs-replay-view .inline-button').nth(2).click();
    assert.match((await state(shallowTurn))[0].cls, /city/);
    await page.locator('#tabs-replay-view .inline-button').nth(0).click();
    assert.equal((await state(0))[1].fog, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  'PASS: isolated vision, all generators, team snapshots and deltas, deterministic ops-v3/RPB5 and Chromium seeks at 1440/390',
);
