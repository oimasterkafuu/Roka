'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDefense } = require('../bot/defense.cjs');

const at = (x, y) => x * 7 + y;
function board() {
  return { n: 5, m: 7, turn: 600, playerId: 1, grid: Array(35).fill(201), army: Array(35).fill(0),
    isolated: Array(35).fill(0), teams: new Map([[1, 1], [2, 2]]) };
}
const put = (s, x, y, g, a) => { s.grid[at(x, y)] = g; s.army[at(x, y)] = a; return s; };
// 双宽走廊：我方 (1,0)(2,0crown)(1,1)(2,1)(1,2)(2,2)(1,3)(2,3)，敌人在 (2,foeD)
function lane({ foeDistance = 3, rearPile = 500, crown = 20, front = 5 } = {}) {
  const s = board();
  put(s, 2, 0, 101, crown); put(s, 1, 0, 1, 5);
  put(s, 1, 1, 1, rearPile); put(s, 2, 1, 1, 5);
  put(s, 1, 2, 1, 5); put(s, 2, 2, 1, front);
  put(s, 1, 3, 1, 5); put(s, 2, 3, 1, front);
  put(s, 2, foeDistance, 2, 200);
  put(s, 2, foeDistance + 1, 2, 50);
  put(s, 2, 6, 102, 100);
  return s;
}

test('皇冠被逼近时提前汇兵，且标记为 urgent 让统一策略优先执行', () => {
  const s = lane({ foeDistance: 3 });
  const d = chooseDefense(s);
  assert.ok(d, '三 tick 内的威胁必须响应');
  assert.equal(d.urgent, true);
  assert.match(d.reason, /皇冠防守/);
  assert.deepEqual([d.move.x, d.move.y], [1, 1]); // 从后方兵堆出发
});

test('更远的威胁同样提前响应（反应窗口不再只有3tick）', () => {
  const s = lane({ foeDistance: 4 });
  const d = chooseDefense(s);
  assert.ok(d, '四 tick 外的可抵达威胁也要提前布防');
  assert.equal(d.urgent, false);
});

test('后方没有可调兵力时不虚报防御动作', () => {
  const s = lane({ foeDistance: 3, rearPile: 1 });
  assert.equal(chooseDefense(s), null);
});

test('威胁被前线挡住时不触发回防', () => {
  const s = lane({ foeDistance: 3, front: 300 }); // 前沿 300 兵，200 敌军打不穿
  assert.equal(chooseDefense(s), null);
});

test('无敌情时不做任何防御动作', () => {
  const s = board();
  put(s, 2, 0, 101, 50); put(s, 2, 1, 1, 50); put(s, 2, 2, 1, 50);
  assert.equal(chooseDefense(s), null);
});

test('孤立或雾中的源点不会被当成防御兵源', () => {
  const s = lane({ foeDistance: 3 });
  s.isolated[at(1, 1)] = 1;
  const d = chooseDefense(s);
  assert.ok(!d || !(d.move.x === 1 && d.move.y === 1));
});

test('防御模块不修改输入局面', () => {
  const s = lane({ foeDistance: 3 });
  const before = JSON.stringify(s);
  chooseDefense(s);
  assert.equal(JSON.stringify(s), before);
});
