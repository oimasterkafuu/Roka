'use strict';
// 攻冠兵力三级递升（2026-09-28 用户硬方针「三」）：
//   ① 半兵推得下就只出半兵（余兵留守，防御义务不动）；
//   ② 半兵不够先试智能全兵（mode0 智能分兵口径：就近合力、留守义务照算）；
//   ③ 智能全兵也不够才退真全兵（mode2 全压只留 1 兵）。
// 阈值参数化：crownSmartMargin / crownFullMargin（合力须压过守军的余量）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');

function board(n = 5, m = 7, turn = 600) {
  return { n, m, turn, playerId: 1, grid: Array(n * m).fill(201), army: Array(n * m).fill(0),
    isolated: Array(n * m).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const put = (s, i, g, a) => { s.grid[i] = g; s.army[i] = a; return s; };
// 16=(2,2) → 17=(2,3)
const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 1 };

// ── 第一档：半兵推得下就只出半兵 ─────────────────────────────────────
test('半兵推得下：只出半兵，不全兵梭哈', () => {
  const s = board();
  put(s, 16, 1, 100); put(s, 17, 102, 20); // 半兵 49 对守军 20
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 1);
  assert.match(result.reason, /斩首：半兵推皇冠/);
});

// ── 第二档：半兵不够、智能全兵够 ─────────────────────────────────────
test('半兵不够时试智能全兵（单格）', () => {
  const s = board();
  put(s, 16, 1, 200); put(s, 17, 102, 100); // 半兵 99 < 100，智能 199 ≥ 100
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 0);
  assert.match(result.reason, /斩首：智能全兵推皇冠/);
});

test('半兵不够时试智能全兵（多路合力，留守义务照算）', () => {
  const s = board();
  // 皇冠守 200；16 与 10 各 120——单格推不下，智能合力 238 > 201
  put(s, 17, 102, 200); put(s, 16, 1, 120); put(s, 10, 1, 120);
  const first = createFrontline(s).choose();
  assert.ok(first);
  assert.equal(first.dx * 7 + first.dy, 17);
  assert.equal(first.mode, 0, '智能合力够就不退真全兵');
  assert.match(first.reason, /合力斩首（智能全兵）/);
});

// ── 第三档：智能全兵也不够才退真全兵 ─────────────────────────────────
test('智能全兵不够才退真全兵（单格，贴脸敌压抽空 smart）', () => {
  const s = board();
  // 源点 200 兵，贴脸敌 100 → smart 只剩 100 < 守军 150；全压 199 够
  put(s, 16, 1, 200); put(s, 17, 102, 150); put(s, 15, 2, 100);
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 2);
  assert.match(result.reason, /斩首：真全兵推皇冠/);
});

test('智能全兵不够才退真全兵（多路合力，合力格各有贴脸敌）', () => {
  const s = board();
  // 皇冠守 150；16/10 各 100，各自贴脸敌 60 → 智能合力 40+40=80 < 151，
  // 真全兵合力 99+99=198 > 151 → 允许 mode2 全压第一击
  put(s, 17, 102, 150); put(s, 16, 1, 100); put(s, 10, 1, 100);
  put(s, 15, 2, 60); put(s, 3, 2, 60);
  const result = createFrontline(s).assess(move);
  assert.ok(result);
  assert.equal(result.mode, 2);
  assert.match(result.reason, /合力斩首（真全兵）/);
});

// ── 阈值参数化：余量抬高后档位后退 / 不开打 ─────────────────────────
test('crownSmartMargin 抬高后智能合力不再够用，退到真全兵', () => {
  const s = board();
  put(s, 17, 102, 200); put(s, 16, 1, 120); put(s, 10, 1, 120); // 合力 238
  const first = createFrontline(s, { crownSmartMargin: 100 }).choose();
  assert.ok(first);
  assert.equal(first.mode, 2, '238 > 200+100 不成立 → 退真全兵（238 > 200+1 成立）');
  assert.match(first.reason, /合力斩首（真全兵）/);
});

test('crownFullMargin 抬高后真全兵合力也不够，不送兵', () => {
  const s = board();
  put(s, 17, 102, 200); put(s, 16, 1, 120); put(s, 10, 1, 120); // 合力 238
  // grindMin 抬高只为隔离消耗冲击路径，专注验证合力余量门闸
  assert.equal(createFrontline(s, { crownSmartMargin: 100, crownFullMargin: 100, grindMin: 500 }).choose(), null);
});
