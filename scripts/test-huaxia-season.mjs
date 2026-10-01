import assert from 'node:assert/strict';
import { isHuaxiaSeasonActive } from '../src/map/huaxia-season.ts';

const cases = [
  ['上海 9/30 23:59 关闭', '2026-09-30T15:59:59.999Z', false],
  ['上海 10/1 00:00 开启', '2026-09-30T16:00:00.000Z', true],
  ['上海 10/7 23:59 开启', '2026-10-07T15:59:59.999Z', true],
  ['上海 10/8 00:00 关闭', '2026-10-07T16:00:00.000Z', false],
  ['次年上海 10/1 00:00 开启', '2027-09-30T16:00:00.000Z', true],
];

for (const [label, iso, expected] of cases) {
  assert.equal(isHuaxiaSeasonActive(new Date(iso)), expected, label);
}

console.log(`华夏年度窗口测试通过（${cases.length} 项）。`);
