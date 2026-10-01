import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { buildReplayStats } = require('./dist/server/replay-stats.js');

const HOUR = 60 * 60 * 1000;
const item = (time) => ({ time: Math.floor(time / 1000), id: String(time), rank: [], turn: 1 });
const check = (label, condition) => {
  assert.ok(condition, label);
  console.log(`  ok - ${label}`);
};

// 2026-10-02 00:30 Asia/Shanghai，窗口跨越自然日。
const now = Date.UTC(2026, 9, 1, 16, 30);
const stats = buildReplayStats(
  [
    item(now - 24 * HOUR), // cutoff，包含
    item(now), // now，包含
    item(now - 24 * HOUR - 1000), // cutoff 之前，排除
    item(now + 1000), // now 之后，排除
    item(Date.UTC(2026, 9, 1, 16, 5)), // 当前 Shanghai 小时
  ],
  now,
);

console.log('滚动窗口、自然日跨越与整点边界');
check('只统计 [now-24h, now] 内的对局', stats.games === 3);
check('始终生成连续 24 个小时 bucket', stats.buckets.length === 24);
check('bucket 标签使用 Asia/Shanghai 且跨过午夜', stats.buckets[0].label.includes('10-01'));
check('最后 bucket 是当前 Asia/Shanghai 小时', stats.buckets.at(-1).label === '10-02 00:00');
check('当前小时 bucket 包含当前小时对局', stats.buckets.at(-1).count === 2);
check('cutoff 边界对局计入总数', stats.games === 3);
check(
  '统计总数与各小时 bucket 总和一致',
  stats.buckets.reduce((sum, bucket) => sum + bucket.count, 0) === stats.games,
);

console.log('无数据');
const empty = buildReplayStats([], now);
check('无数据时 games 为 0', empty.games === 0);
check(
  '无数据时仍返回 24 个 0 bucket',
  empty.buckets.length === 24 && empty.buckets.every((bucket) => bucket.count === 0),
);

console.log('\n回放统计测试通过');
