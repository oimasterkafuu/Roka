'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSurrenderJudge } = require('../bot/surrender.cjs');

// 10x10 绝境棋盘：我方 1 皇冠 + 4 格小地（共 5 格 51 兵），
// 敌方 4 皇冠 + 18 格千兵大堆（2 万+ 兵），另有 500 兵压在我方皇冠旁（能收不收）。
// 参数放宽持续时长门槛，便于在百 tick 内走完判定。
// wiggle=true 时敌方一块边地按回合奇偶易手，模拟「对方近期有操作」的活跃状态
// （兵力自然增长不算活动——挂机敌人的兵也在涨，只有地盘变化算数）。
const PARAMS = { surrenderMinTurn: 30, surrenderTeaseTicks: 60, surrenderTeaseNearCrownTicks: 5 };
function board({ turn, wiggle = false, siege = true, myStack = null, leaderboard } = {}) {
  const s = { n: 10, m: 10, turn, playerId: 1, grid: Array(100).fill(0), army: Array(100).fill(0),
    isolated: Array(100).fill(0), teams: new Map([[1, 1], [2, 2]]),
    leaderboard: leaderboard ?? [{ id: 1, team: 1, class_: '' }, { id: 2, team: 2, class_: '' }] };
  s.grid[11] = 101; s.army[11] = 30; // 我方皇冠
  for (const i of [20, 21, 22, 30]) { s.grid[i] = 1; s.army[i] = 5; }
  if (siege) { s.grid[12] = 2; s.army[12] = 500; } // 敌 500 兵贴脸我方皇冠
  if (myStack) { s.grid[myStack[0]] = 1; s.army[myStack[0]] = myStack[1]; }
  for (const i of [60, 70, 80, 90]) { s.grid[i] = 102; s.army[i] = 500; } // 敌 4 皇冠
  for (let k = 0; k < 20; k++) { const i = 61 + k; if (s.grid[i] === 0) { s.grid[i] = 2; s.army[i] = 1000; } }
  if (wiggle) { s.grid[99] = turn % 2 ? 2 : 0; s.army[99] = turn % 2 ? 10 : 0; } // 敌地每 tick 易手
  return s;
}

test('四条全满足才投降：严重劣势 + 绝无胜算 + 对方活跃 + 调戏收尾', () => {
  const judge = createSurrenderJudge(PARAMS);
  let verdict = null;
  for (let turn = 30; turn <= 95; turn++) {
    verdict = judge.evaluate(board({ turn, wiggle: true }));
    if (verdict) { assert.equal(turn, 90); break; }
  }
  assert.ok(verdict?.surrender, '应在劣势持续 60+ tick 且 5+ 次能收尾后投降');
  assert.match(verdict.reason, /绝境投降/);
  // 一击即锁：投降判定只下一次
  assert.equal(judge.evaluate(board({ turn: 96, wiggle: true })), null);
});

test('劣势持续不足不投（条件 4 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  for (let turn = 30; turn <= 89; turn++) assert.equal(judge.evaluate(board({ turn, wiggle: true })), null);
});

test('对方被服务端标记 AFK 不投（条件 3 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  const afkBoard = (turn) => board({ turn, wiggle: true, leaderboard: [{ id: 1, team: 1, class_: '' }, { id: 2, team: 2, class_: 'afk' }] });
  for (let turn = 30; turn <= 120; turn++) assert.equal(judge.evaluate(afkBoard(turn)), null);
});

test('对方地盘长期静止（疑似挂机）不投（条件 3 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  // 兵力随自然增长在涨、但地盘从不动：不算「对方在动」
  for (let turn = 30; turn <= 200; turn++) assert.equal(judge.evaluate(board({ turn })), null);
});

test('存在可执行斩首不投（条件 2 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  // 我方 5000 兵大堆贴着敌皇冠（87 邻 88 号位敌皇冠）：能反杀就不算绝境
  for (let turn = 30; turn <= 120; turn++) {
    assert.equal(judge.evaluate(board({ turn, wiggle: true, myStack: [87, 5000] })), null);
  }
});

test('劣势不够深不投（条件 1 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  // 我方也有 3 皇冠与成片千兵地：兵力/领土/建筑不落后
  for (let turn = 30; turn <= 120; turn++) {
    const s = board({ turn, wiggle: true });
    for (const i of [1, 2, 3]) { s.grid[i] = 101; s.army[i] = 500; }
    for (let k = 0; k < 20; k++) { const i = 31 + k; if (s.grid[i] === 0) { s.grid[i] = 1; s.army[i] = 1000; } }
    assert.equal(judge.evaluate(s), null);
  }
});

test('对方未兵临皇冠（无调戏证据）不投（条件 4 未满足）', () => {
  const judge = createSurrenderJudge(PARAMS);
  for (let turn = 30; turn <= 120; turn++) assert.equal(judge.evaluate(board({ turn, wiggle: true, siege: false })), null);
});

test('回合下限之前不评估；劣势中断则调戏计时重置', () => {
  const judge = createSurrenderJudge(PARAMS);
  assert.equal(judge.evaluate(board({ turn: 10, wiggle: true })), null);
  for (let turn = 30; turn <= 80; turn++) judge.evaluate(board({ turn, wiggle: true }));
  // 中途一 tick 不劣势（敌皇冠消失），持续计时重置
  const recovered = board({ turn: 81, wiggle: true });
  for (const i of [60, 70, 80, 90]) { recovered.grid[i] = 0; recovered.army[i] = 0; }
  assert.equal(judge.evaluate(recovered), null);
  for (let turn = 82; turn <= 141; turn++) assert.equal(judge.evaluate(board({ turn, wiggle: true })), null);
  assert.ok(judge.evaluate(board({ turn: 142, wiggle: true }))?.surrender);
});

test('surrenderEnabled=0 时永不投降', () => {
  const judge = createSurrenderJudge({ ...PARAMS, surrenderEnabled: 0 });
  for (let turn = 30; turn <= 120; turn++) assert.equal(judge.evaluate(board({ turn, wiggle: true })), null);
});
