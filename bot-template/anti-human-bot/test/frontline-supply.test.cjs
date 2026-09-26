'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAction } = require('../bot/policy.cjs');
const { chooseLogistics, getSupplyBatch } = require('../bot/logistics.cjs');

function board() {
  return { n: 1, m: 8, playerId: 1, turn: 101, grid: [101, 1, 1, 1, 1, 1, 1, 2],
    army: [1600, 1, 1, 1, 1, 1, 2000, 3000], isolated: Array(8).fill(0),
    fog: Array(8).fill(false), teams: new Map([[1, 1], [2, 2]]) };
}
const supply = (s, extra) => chooseLogistics(s, null, null, { militaryOnly: true, ...extra });

test('前线缺口会把后方兵力送上去', () => {
  const s = board();
  s.army[7] = 6000;   // 门口敌堆远大于我方前沿：不构成有利交换，必须走补给
  const a = chooseAction(s);
  assert.ok(a);
  assert.equal(a.reason.code, 'frontline-supply');
  assert.equal(a.y, 0);
  assert.equal(a.dy, 1);
});

test('缺口预算以最容易打下的相邻敌格为准，不追着最强敌堆做军备竞赛', () => {
  const s = board();
  const a = supply(s);
  assert.ok(a);
  // 门口 3000 兵 → 预算约 3000 + 3% 余量，而不是无限膨胀
  assert.ok(a.reason.batch.required >= 3000 && a.reason.batch.required <= 3120,
    `required=${a.reason.batch.required}`);
  assert.deepEqual(getSupplyBatch(s), { target: 6, required: a.reason.batch.required, active: true });
});

test('补给需求每 tick 重新计算，缺口补上后自然停止', () => {
  const s = board();
  const a = supply(s);
  assert.ok(a.reason.batch.required > 3000);
  assert.equal(getSupplyBatch(s).target, 6);
  // 前线已经攒够（甚至超过门口守军）→ 本 tick 不再需要补给
  s.army[6] = 4000; s.turn += 3;
  assert.equal(supply(s), null);
  assert.equal(getSupplyBatch(s), null);
  // 需求变差（门口被增援）→ 同一 tick 立刻重新给出需求，不需要等任何批次
  s.army[7] = 9000; s.turn += 1;
  const again = supply(s);
  assert.ok(again);
  assert.ok(again.reason.batch.required > 9000);
});

test('目标失效或没有可用兵源时本 tick 就没有补给计划', () => {
  for (const change of [(s) => { s.grid[7] = 1; }, (s) => { s.army[0] = 1; }]) {
    const s = board();
    assert.ok(supply(s));
    change(s); s.turn++;
    assert.equal(supply(s), null);
    assert.equal(getSupplyBatch(s), null);
  }
});

test('禁行边会被尊重：最短路被禁则不再谎报补给', () => {
  const s = board();
  assert.equal(supply(s, { blockedEdges: new Set(['0:1']) }), null);
});

test('本来就能进攻时不新开预算拖住进攻', () => {
  const s = board();
  s.army[6] = 3100;
  assert.equal(supply(s, { allowStartBatch: false }), null);
});

test('主城不会被抽空去填前线', () => {
  const s = board();
  s.army[0] = 100;   // 后方主城有 100 兵
  const a = supply(s);
  assert.ok(a);
  assert.ok(a.reason.amount <= 96, `主城必须留守，实际出兵 ${a.reason.amount}`);
});

test('拆建筑的机会不会被已开始的前线补给批次顶掉', () => {
  const s = board();
  s.army[7] = 6000;
  const first = chooseAction(s);
  assert.equal(first.reason.code, 'frontline-supply');   // 先起一轮补给批次
  s.turn += 1;
  s.grid[7] = 52;          // 门口变成敌方指挥所，且我方前沿已攒够兵
  s.army[7] = 20;
  s.army[6] = 800;
  const second = chooseAction(s);
  assert.ok(second);
  assert.equal(second.kind, 'attack');
  assert.equal(second.dy, 7);
  assert.match(String(second.reason), /攻指挥所/);
});
