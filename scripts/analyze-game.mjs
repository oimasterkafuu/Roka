// 分析 observe-<id>/frames.jsonl + 回放 ops 流：逐 turn 双方 land/army 汇总、
// bot 大兵堆（>阈值）位置及其到敌方最近格的距离、人类进攻 bot 的时间线。
// 用法：node scripts/analyze-game.mjs <replayId> [stackThreshold]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replayId = process.argv[2];
const threshold = Number(process.argv[3] || 400);

const dir = path.join(rootDir, 'data', `observe-${replayId}`);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const frames = fs
  .readFileSync(path.join(dir, 'frames.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const replay = v8.deserialize(
  zlib.brotliDecompressSync(fs.readFileSync(path.join(rootDir, 'data', 'replays', `${replayId}.rpl`))),
);

const { n, m } = meta;
const total = n * m;
const ownerOf = (code) => (typeof code === 'number' && code < 200 ? code % 50 : 0);
// 玩家座位：playerId = 座位 index+1。oimaster=1, yuelan=2
const names = meta.playerNames;

const XY = (idx) => `(${Math.floor(idx / m)},${idx % m})`;

function bfsDistToEnemy(frame, fromIdx, playerId) {
  // 从 fromIdx BFS（山地 201 不可走）到最近的敌方格子距离
  const { grid_type: gt } = frame;
  const dist = new Int16Array(total).fill(-1);
  const q = [fromIdx];
  dist[fromIdx] = 0;
  while (q.length) {
    const cur = q.shift();
    const cx = Math.floor(cur / m);
    const cy = cur % m;
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= m) continue;
      const ni = nx * m + ny;
      if (dist[ni] >= 0 || gt[ni] === 201) continue;
      dist[ni] = dist[cur] + 1;
      const o = ownerOf(gt[ni]);
      if (o > 0 && o !== playerId) return dist[ni];
      q.push(ni);
    }
  }
  return -1;
}

console.log(`players: ${names.map((nm, i) => `${i + 1}=${nm}`).join(' ')}  map ${n}x${m}`);
console.log('turn | P1 land/army | P2(yuelan) land/army | P2 大兵堆(>thr): pos=army,dist2enemy');

let prevOwnedBy = new Map(); // idx -> owner, 用于检测易主（战斗）
const events = [];

for (const frame of frames) {
  const { turn, grid_type: gt, army_cnt: ac } = frame;
  const land = [0, 0, 0];
  const army = [0, 0, 0];
  const stacks = [];
  for (let idx = 0; idx < total; idx += 1) {
    const o = ownerOf(gt[idx]);
    if (o >= 1 && o <= 2) {
      land[o] += 1;
      army[o] += ac[idx] || 0;
      if (o === 2 && (ac[idx] || 0) > threshold) {
        stacks.push({ idx, army: ac[idx] });
      }
    }
    // 易主检测
    const prev = prevOwnedBy.get(idx) || 0;
    if (prev !== o && prev > 0 && o > 0) {
      events.push({ turn, idx, from: prev, to: o });
    }
    prevOwnedBy.set(idx, o);
  }
  if (turn % 10 === 0 || turn === frames[frames.length - 1].turn) {
    const stackStr = stacks
      .sort((a, b) => b.army - a.army)
      .slice(0, 5)
      .map((s) => `${XY(s.idx)}=${s.army},d${bfsDistToEnemy(frame, s.idx, 2)}`)
      .join(' ');
    console.log(
      `${String(turn).padStart(4)} | ${String(land[1]).padStart(3)}/${String(army[1]).padStart(6)} | ${String(land[2]).padStart(3)}/${String(army[2]).padStart(6)} | ${stackStr}`,
    );
  }
}

console.log('\n=== 领土易主事件（prev>0 && new>0，即攻占）===');
const byTurn = new Map();
for (const e of events) {
  if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
  byTurn.get(e.turn).push(e);
}
for (const [turn, evs] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  const p1take = evs.filter((e) => e.to === 1).length;
  const p2take = evs.filter((e) => e.to === 2).length;
  console.log(`turn ${turn}: oimaster攻占 ${p1take} 格, yuelan攻占 ${p2take} 格`);
}

// ops 摘要
console.log('\n=== ops 统计 ===');
replay.player_ops.forEach((ops, i) => {
  const cnt = { s: 0, m: 0, b: 0, c: 0, w: 0, r: 0 };
  for (const op of ops) cnt[op.op] = (cnt[op.op] || 0) + 1;
  console.log(`${names[i]}: ${JSON.stringify(cnt)}`);
});
