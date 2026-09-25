// 打印指定 turn 的 ASCII 棋盘 + 每格兵力，用于人工复盘关键回合。
// 用法：node scripts/show-board.mjs <replayId> <turn1> [turn2 ...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replayId = process.argv[2];
const wanted = new Set(process.argv.slice(3).map(Number));

const dir = path.join(rootDir, 'data', `observe-${replayId}`);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const { n, m } = meta;
const ownerOf = (code) => (typeof code === 'number' && code < 200 ? code % 50 : 0);

for (const line of fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const frame = JSON.parse(line);
  if (!wanted.has(frame.turn)) continue;
  const { grid_type: gt, army_cnt: ac } = frame;
  console.log(`\n=== turn ${frame.turn} ===`);
  console.log(`    ${[...Array(m).keys()].map((y) => String(y % 10)).join('')}`);
  for (let x = 0; x < n; x += 1) {
    const cells = [];
    for (let y = 0; y < m; y += 1) {
      const idx = x * m + y;
      const code = gt[idx];
      if (code === 201) cells.push('#');
      else if (code === 204 || (code >= 150 && code < 200)) cells.push('~');
      else {
        const owner = ownerOf(code);
        let ch = owner === 0 ? '.' : String.fromCharCode(64 + owner);
        if (code >= 100 && code < 150) ch = owner === 0 ? 'C' : ch.toLowerCase(); // 主城
        else if (code >= 50 && code < 100) ch = owner === 0 ? 'B' : String(owner); // 指挥所
        cells.push(ch);
      }
    }
    console.log(`${String(x).padStart(3)} ${cells.join('')}`);
  }
  const parts = [];
  for (let idx = 0; idx < n * m; idx += 1) {
    if ((ac[idx] || 0) > 1) parts.push(`(${Math.floor(idx / m)},${idx % m})=${ac[idx]}`);
  }
  console.log(`army: ${parts.join(' ')}`);
}
