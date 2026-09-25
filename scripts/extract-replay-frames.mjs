// 从服务器回放（.rpl, ops-v1）提取逐 turn 全量帧，输出 frames.jsonl + meta.json，
// 供 scripts/replay-bot-decisions.mjs 及临时分析脚本使用。
//
// 用法：node scripts/extract-replay-frames.mjs <replayId> [--out data/observe-<id>]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { GameEngine } = require(path.join(rootDir, 'dist', 'game-engine.js'));
const { buildScheduledReplayActions } = require(
  path.join(rootDir, 'dist', 'game-engine', 'replay-scheduling.js'),
);

const replayId = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outDir =
  outIdx >= 0 ? process.argv[outIdx + 1] : path.join(rootDir, 'data', `observe-${replayId}`);

const buf = fs.readFileSync(path.join(rootDir, 'data', 'replays', `${replayId}.rpl`));
const replay = v8.deserialize(zlib.brotliDecompressSync(buf));
if (replay.version !== 'ops-v1') {
  throw new Error('回放版本不兼容。');
}

const meta = replay.meta;
const engine = new GameEngine(
  {
    ...meta,
    allow_team: meta.allow_team ?? false,
    fog: false,
    map_size_version: meta.map_size_version ?? 1,
  },
  meta.player_names.map((_, i) => `replay_sid_${i}`),
  meta.player_names.map((_, i) => `replay_id_${i}`),
  '__replay_build__',
  {
    update: () => undefined,
    emitInitMap: () => undefined,
    chatMessage: () => undefined,
    endGame: () => undefined,
    md5: (input) => input,
    replayStore: { saveReplay: async () => '' },
  },
);

await engine.initializeMap();
engine.selectGenerals();

const { scheduledMoves, scheduledBuilds, scheduledSurrenders } = buildScheduledReplayActions(replay);

fs.mkdirSync(outDir, { recursive: true });
const framesPath = path.join(outDir, 'frames.jsonl');
const out = fs.createWriteStream(framesPath);

const writeFrame = (frame) => {
  out.write(
    JSON.stringify({
      turn: frame.turn,
      grid_type: frame.grid_type,
      army_cnt: frame.army_cnt,
      isolated: frame.isolated,
    }) + '\n',
  );
};

writeFrame(engine.buildReplayFrame(false));

while (engine.turn < replay.total_turns) {
  const nextTurn = engine.turn + 1;
  for (let p = 0; p < scheduledSurrenders.length; p += 1) {
    if (scheduledSurrenders[p].has(nextTurn)) {
      engine.surrender(engine.playerSids[p]);
    }
  }
  for (let p = 0; p < scheduledBuilds.length; p += 1) {
    const build = scheduledBuilds[p].get(nextTurn);
    if (build) {
      engine.addBuild(engine.playerSids[p], build.x, build.y, build.kind);
    }
  }
  for (let p = 0; p < scheduledMoves.length; p += 1) {
    const move = scheduledMoves[p].get(nextTurn);
    if (move) {
      engine.addMove(engine.playerSids[p], move[0], move[1], move[2], move[3], move[4]);
    }
  }
  const gameEnd = await engine.gameTick();
  writeFrame(engine.buildReplayFrame(gameEnd || engine.turn >= replay.total_turns));
  if (gameEnd) {
    break;
  }
}

out.end();
await new Promise((resolve) => out.on('finish', resolve));

fs.writeFileSync(
  path.join(outDir, 'meta.json'),
  JSON.stringify(
    {
      replayId,
      totalTurns: replay.total_turns,
      playerNames: meta.player_names,
      playerTeams: meta.player_teams,
      n: engine.n,
      m: engine.m,
      mapMode: meta.map_mode,
      speed: meta.speed,
    },
    null,
    2,
  ),
);
console.log(`frames -> ${framesPath} (turns=${engine.turn})`);
