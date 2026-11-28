import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {decodeRpl} from '../dist/rpl.js';
import { GameEngine } from '../dist/game-engine.js';
import { ReplayStore } from '../dist/replay-store.js';

if (!global.gc) throw new Error('Run with node --expose-gc');
const turns = 2000;
const teams = Array.from({ length: 8 }, (_, index) => index + 1);
const names = teams.map((team) => `Team${team}`);
const config = {
  width_ratio: 1.85,
  height_ratio: 1.85,
  swamp_ratio: 0.12,
  allow_team: false,
  multi_line: false,
  map_mode: 'random',
  map_region: 'han',
  map_size: 'large',
  speed: 1,
  player_names: names,
  player_teams: teams,
  map_token: 'fog-perf-v4',
};
const memory = () => {
  global.gc();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  return { heapUsed, arrayBuffers, rss };
};
const sizeDelta = (after, before) =>
  Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
const directions = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
function expand(engine, turn) {
  const best = Array(teams.length).fill(null);
  for (let row = 0; row < engine.n; row += 1) {
    for (let col = 0; col < engine.m; col += 1) {
      const player = engine.owner[row][col] - 1;
      if (player < 0 || engine.isolated[row][col]) continue;
      const strength = engine.armyCnt[row][col];
      if (strength <= Math.max(3, best[player]?.strength ?? 0)) continue;
      for (let offset = 0; offset < directions.length; offset += 1) {
        const [dr, dc] = directions[(offset + turn + player) % directions.length];
        const nextRow = row + dr,
          nextCol = col + dc;
        if (
          engine.owner[nextRow]?.[nextCol] !== 0 ||
          engine.gridType[nextRow][nextCol] === 1 ||
          engine.armyCnt[nextRow][nextCol] + 1 >= strength
        )
          continue;
        best[player] = { move: [row, col, nextRow, nextCol], strength };
        break;
      }
    }
  }
  best.forEach((action, player) => {
    if (action) engine.addMove(names[player], ...action.move, 2);
  });
}

const directory = await mkdtemp(path.join(tmpdir(), 'roka-fog-benchmark-'));
const browserResults = {};
try {
  const results = {};
  let baselineBoard;
  let normalBinary;
  for (const fog_mode of ['visible', 'normal']) {
    const store=new ReplayStore(path.join(directory,fog_mode));
    await store.ensureReady();
    const baselineMemory = memory();
    let transmitted = 0;
    const engine = await GameEngine.create({ ...config, fog_mode }, names, names, 'fog-benchmark', {
      emitInitMap() {},
      chatMessage() {},
      endGame() {},
      md5: (id) => id,
      replayStore: store,
      update(_sid, frame) {
        transmitted +=
          frame.grid_type.length + frame.army_cnt.length + frame.isolated.length + (frame.fog?.length ?? 0);
      },
    });
    await engine.sendMap(false);
    let tickMs = 0;
    for (let turn = 1; turn <= turns; turn += 1) {
      if (turn % 3 === 0) expand(engine, turn);
      const start = performance.now();
      assert.equal(await engine.gameTick(), false);
      tickMs += performance.now() - start;
    }
    const final = engine.buildReplayFrame(false);
    const finalBoard = [final.grid_type, final.army_cnt, final.isolated];
    if (baselineBoard) assert.deepEqual(finalBoard, baselineBoard);
    else baselineBoard = finalBoard;
    const discoveries=engine.fogVision?teams.reduce((sum,team)=>sum+engine.fogVision.snapshot(team,final).fog.filter(value=>value!==2).length,0):0;
    const liveMemory = memory();
    const id = await engine.saveHistory();
    const start = performance.now();
    const binary=await store.readRawReplay(id);await GameEngine.buildReplayFromActions(await decodeRpl(binary));
    const readDecodeRebuildMs = performance.now() - start;
    results[fog_mode] = {
      dims: [engine.n, engine.m],
      turns,
      teams: teams.length,
      tickMs,
      msPerTick: tickMs / turns,
      liveRetainedDelta: sizeDelta(liveMemory, baselineMemory),
      transmittedArrayEntries: transmitted,
      discoveries, discoveryArchiveBytes:0,
      rplBytes: (await store.readRawReplay(id)).byteLength,
      wireBytes: binary.length,
      readDecodeRebuildMs,
    };
    if (fog_mode === 'normal') normalBinary = binary;
  }
  const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://roka.test') return route.abort();
      if (url.pathname === '/replays/benchmark') return route.fulfill({ path: 'static/game.html' });
      if (url.pathname === '/api/getreplay/benchmark')
        return route.fulfill({ body: normalBinary, contentType: 'application/octet-stream' });
      if (url.pathname === '/api/user-colors') return route.fulfill({ json: {} });
      return route.fulfill({ path: `static${url.pathname}` }).catch(() => route.fulfill({ status: 404 }));
    });
    await page.goto('http://roka.test/replays/benchmark');
    await page.waitForFunction(() => window.in_game && window.replay_data?.patches.length === 2000);
    Object.assign(
      browserResults,
      await page.evaluate(() => {
        const measure = (fn) => {
          const start = performance.now();
          fn();
          return performance.now() - start;
        };
        const stats = (values) => {
          values.sort((left, right) => left - right);
          return {
            n: values.length,
            p50: values[Math.floor(values.length / 2)],
            p95: values[Math.ceil(values.length * 0.95) - 1],
            max: values.at(-1),
          };
        };
        const seek = [],
          lookup = [],
          view = [];
        setReplayViewTeam(1);
        for (let trial = 0; trial < 30; trial += 1) {
          const target = trial % 2 ? 41 + trial * 11 : 1976 - trial * 7;
          seek.push(measure(() => jumpToFrame(target)));
          if (cur_turn !== target) throw new Error('seek did not reach target');
          lookup.push(measure(() => applyReplayFogView()));
          view.push(measure(() => setReplayViewTeam(((trial + 1) % 8) + 1)));
        }
        return { seekMs: stats(seek), lookupMs: stats(lookup), switchViewMs: stats(view) };
      }),
    );
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify(
      {
        results,
        extraMsPerTick: results.normal.msPerTick - results.visible.msPerTick,
        browser: browserResults,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
