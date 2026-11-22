// 从服务器回放（.rpl）提取逐 turn 全量帧，输出 frames.jsonl + meta.json，
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

const replayId = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outDir =
  outIdx >= 0 ? process.argv[outIdx + 1] : path.join(rootDir, 'data', `observe-${replayId}`);

const buf = fs.readFileSync(path.join(rootDir, 'data', 'replays', `${replayId}.rpl`));
const replay = v8.deserialize(zlib.brotliDecompressSync(buf));
const meta = replay.meta;
const { initial, patches, n, m } = await GameEngine.buildReplayFromActions(replay);

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

writeFrame(initial);
for (const { forward } of patches) {
  for (const key of ['grid_type', 'army_cnt', 'isolated']) {
    const diff = forward[key];
    for (let index = 0; index < diff.length; index += 2) initial[key][diff[index]] = diff[index + 1];
  }
  writeFrame({ ...initial, turn: forward.turn });
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
      n,
      m,
      mapMode: meta.map_mode,
      speed: meta.speed,
    },
    null,
    2,
  ),
);
console.log(`frames -> ${framesPath} (turns=${patches.length})`);
