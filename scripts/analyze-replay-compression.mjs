// 回放存储压缩评估（issue #67）：扫描 data/replays/*.rpl（ops-v1 操作流，
// v8 serialize + brotli q6），统计操作流特征并对比候选编码的体积：
//   A. 现状基线：v8 serialize + brotli q6（即线上 .rpl 文件本身）。
//   B. v8 serialize + brotli q11（只调高压缩档）。
//   C. 紧凑文本 DSL（ops 转 `w12;s3,4;m0h;...` 字符串）+ brotli q11。
//   D. 二进制打包（每 op 1~5 字节 LE）+ brotli q11。
// 另统计 op 类型分布与「选中切换」（s op）占比，量化机器人频繁切操作的膨胀。
// 用法：node scripts/analyze-replay-compression.mjs [--limit=N]

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import zlib from 'node:zlib';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replayDir = path.join(rootDir, 'data', 'replays');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;

const brotli = (buf, quality) =>
  zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } });

/** ops-v1 玩家操作流 → 紧凑文本 DSL（无损，逐 op 一一对应）。 */
const opsToDsl = (ops) =>
  ops
    .map((op) => {
      switch (op.op) {
        case 'w':
          return `w${op.n}`;
        case 'r':
          return 'r';
        case 's':
          return `s${op.x},${op.y}`;
        case 'b':
          return 'b';
        case 'c':
          return 'c';
        case 'm':
          return `m${op.d}${op.a ? 'a' : op.h ? 'h' : ''}`;
        default:
          throw new Error(`unknown op: ${JSON.stringify(op)}`);
      }
    })
    .join(';');

/** ops-v1 玩家操作流 → 二进制打包（无损）：w=0 r=1 b=2 c=3 s=4 m=5/6/7。 */
const opsToBinary = (ops) => {
  const parts = [];
  for (const op of ops) {
    switch (op.op) {
      case 'w': {
        const b = Buffer.alloc(3);
        b.writeUInt8(0, 0);
        b.writeUInt16LE(op.n, 1);
        parts.push(b);
        break;
      }
      case 'r':
        parts.push(Buffer.from([1]));
        break;
      case 'b':
        parts.push(Buffer.from([2]));
        break;
      case 'c':
        parts.push(Buffer.from([3]));
        break;
      case 's': {
        const b = Buffer.alloc(3);
        b.writeUInt8(4, 0);
        b.writeUInt8(op.x, 1);
        b.writeUInt8(op.y, 2);
        parts.push(b);
        break;
      }
      case 'm':
        parts.push(Buffer.from([op.a ? 7 : op.h ? 6 : 5, op.d]));
        break;
      default:
        throw new Error(`unknown op: ${JSON.stringify(op)}`);
    }
  }
  return Buffer.concat(parts);
};

async function main() {
  const names = (await readdir(replayDir)).filter((name) => name.endsWith('.rpl')).slice(0, limit);
  console.log(`扫描 ${names.length} 个回放文件…`);

  let totalFile = 0;
  let totalRawV8 = 0;
  let totalQ11 = 0;
  let totalDsl = 0;
  let totalBin = 0;
  let totalOps = 0;
  let totalTurns = 0;
  const opHistogram = { w: 0, s: 0, m: 0, b: 0, c: 0, r: 0 };
  let selectOps = 0;
  let failed = 0;

  for (const name of names) {
    const filePath = path.join(replayDir, name);
    try {
      const compressed = await readFile(filePath);
      const raw = zlib.brotliDecompressSync(compressed);
      const replay = v8.deserialize(raw);
      if (!replay || replay.version !== 'ops-v1' || !Array.isArray(replay.player_ops)) {
        failed += 1;
        continue;
      }

      totalFile += compressed.length;
      totalRawV8 += raw.length;
      totalQ11 += brotli(raw, 11).length;

      const dslDoc = JSON.stringify({
        v: 1,
        m: replay.meta,
        t: replay.total_turns,
        p: replay.player_ops.map(opsToDsl),
      });
      totalDsl += brotli(Buffer.from(dslDoc, 'utf8'), 11).length;

      const binDoc = Buffer.concat([
        Buffer.from(JSON.stringify({ v: 1, m: replay.meta, t: replay.total_turns }), 'utf8'),
        Buffer.from([0]),
        ...replay.player_ops.map(opsToBinary),
      ]);
      totalBin += brotli(binDoc, 11).length;

      totalTurns += replay.total_turns ?? 0;
      for (const ops of replay.player_ops) {
        totalOps += ops.length;
        for (const op of ops) {
          opHistogram[op.op] = (opHistogram[op.op] ?? 0) + 1;
          if (op.op === 's') selectOps += 1;
        }
      }
    } catch {
      failed += 1;
    }
  }

  const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
  const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`;

  console.log('\n== 操作流特征 ==');
  console.log(
    `总回合数: ${totalTurns}，总 op 数: ${totalOps}（平均每局 op/回合: ${(totalOps / Math.max(1, totalTurns)).toFixed(2)}）`,
  );
  console.log(`op 类型分布: ${JSON.stringify(opHistogram)}`);
  console.log(`选中切换 s 占比: ${((selectOps / Math.max(1, totalOps)) * 100).toFixed(1)}%`);

  console.log('\n== 体积对比（合计） ==');
  console.log(`A 现状 v8+brotli q6（线上文件）: ${mib(totalFile)}`);
  console.log(`  其中解压后 v8 原始字节: ${mib(totalRawV8)}`);
  console.log(`B v8+brotli q11: ${mib(totalQ11)}（相对现状 ${pct(totalQ11, totalFile)}）`);
  console.log(`C 文本 DSL+brotli q11: ${mib(totalDsl)}（相对现状 ${pct(totalDsl, totalFile)}）`);
  console.log(`D 二进制打包+brotli q11: ${mib(totalBin)}（相对现状 ${pct(totalBin, totalFile)}）`);
  if (failed > 0) {
    console.log(`\n（${failed} 个文件解析失败，已跳过）`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
