'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDefense } = require('../bot/defense.cjs');
function board(grid = [101, 1, 1, 2], army = [2, 30, 1, 20], extra = {}) {
  return { n: 1, m: grid.length, grid, army, playerId: 1, turn: 5,
    isolated: Array(grid.length).fill(0), fog: Array(grid.length).fill(0), teams: new Map(), ...extra };
}
function indices(s, result) {
  assert.ok(result); assert.equal('kind' in result.move, false);
  assert.equal(result.move.mode, 0); assert.equal(result.move.half, false);
  const a = result.move.x * s.m + result.move.y, b = result.move.dx * s.m + result.move.dy;
  assert.equal(Math.abs(result.move.x - result.move.dx) + Math.abs(result.move.y - result.move.dy), 1);
  return [a, b];
}
test('无真实威胁不搬兵', () => {
  assert.equal(chooseDefense(board()), null);
  assert.equal(chooseDefense(board([101, 1, 2], [100, 40, 20])), null);
});
test('皇冠救援输出标准attack和威胁玩家集合', () => {
  const s = board([101, 1, 2, 1], [2, 1, 25, 40]);
  const r = chooseDefense(s); assert.deepEqual(indices(s, r), [3, 2]);
  assert.deepEqual(r.threatOwners, new Set([2])); assert.equal(r.urgent, true);
});
test('绕墙路径提前预测，非曼哈顿邻近', () => {
  const s = board([101, 201, 2, 1, 201, 2, 1, 1, 2, 1, 201, 201],
    [2, 0, 40, 1, 0, 1, 1, 1, 1, 60, 0, 0], { n: 4, m: 3 });
  s.army[2] = 1; s.army[5] = 40;
  observeApproach(s, 2, 5);
  const r = chooseDefense(s); assert.deepEqual(indices(s, r), [9, 6]);
  assert.equal(r.urgent, false);
});
test('完整山墙不可穿越', () => {
  assert.equal(chooseDefense(board([101, 1, 201, 2], [2, 40, 0, 100])), null);
});
test('十二tick范围内后排大兵团，前排小兵不掩盖威胁', () => {
  const grid = [101, ...Array(9).fill(1), 2, 2, 1];
  const army = [1, ...Array(9).fill(1), 1, 80, 120];
  const s = board(grid, army); const r = chooseDefense(s);
  assert.deepEqual(indices(s, r), [12, 11]); assert.equal(r.urgent, false);
});
test('塔不遮蔽皇冠救援目标', () => {
  const s = board([101, 1, 2, 1, 51], [2, 1, 30, 45, 1]);
  const r = chooseDefense(s); assert.deepEqual(indices(s, r), [3, 2]); assert.match(r.reason, /皇冠/);
});
test('援军太远赶不上，不无效搬兵', () => {
  const s = board([2, 101, 1, 1, 1], [40, 2, 1, 1, 100]);
  assert.equal(chooseDefense(s), null);
});
test('能赶上皇冠的支路援军实际汇入', () => {
  const s = board([2, 1, 101, 201, 201, 1], [35, 1, 2, 0, 0, 50], { n: 2, m: 3 });
  assert.deepEqual(indices(s, chooseDefense(s)), [5, 2]);
});
test('多皇冠实际救援弱皇冠，不只靠最近或最大锚点', () => {
  const s = board([101, 1, 2, 201, 101, 1, 201, 1, 1, 1],
    [2, 1, 30, 0, 100, 1, 0, 45, 1, 1], { n: 2, m: 5 });
  assert.deepEqual(indices(s, chooseDefense(s)), [7, 2]);
});
test('另一个受威胁皇冠不能被抽空', () => {
  const s = board([2, 101, 101, 2], [20, 2, 40, 30]);
  assert.equal(chooseDefense(s), null);
});
test('mode0旁路敌兵留兵使截击不足，不能按全冲误判', () => {
  const s = board([101, 2, 1, 201, 201, 3], [1, 30, 40, 0, 0, 30], { n: 2, m: 3 });
  assert.equal(chooseDefense(s), null);
});
test('孤立敌军不能移动，孤立我军不能救援', () => {
  const s = board([101, 1, 2, 1], [2, 1, 25, 40]);
  s.isolated[2] = 1; assert.equal(chooseDefense(s), null);
  s.isolated[2] = 0; s.isolated[3] = 1; assert.equal(chooseDefense(s), null);
});
test('雾内兵不读取，未知路径保守不穿越', () => {
  const s = board([101, 1, 2, 1], [2, 1, 25, 40]);
  s.fog[2] = 1; assert.equal(chooseDefense(s), null);
  assert.equal(chooseDefense(board([101, 202, 2, 1], [2, 0, 25, 40])), null);
});
test('队友不是入侵者，队友守军构成敌路径阻力', () => {
  const teams = new Map([[1, 7], [3, 7]]);
  assert.equal(chooseDefense(board([101, 3, 2, 1], [2, 100, 25, 40], { teams })), null);
  assert.equal(chooseDefense(board([101, 1, 3, 1], [2, 1, 25, 40], { teams })), null);
});
test('同tick重复调用确定，不修改输入，支持typed arrays', () => {
  const s = board(Int16Array.from([101, 1, 2, 1]), Int32Array.from([2, 1, 25, 40]));
  const before = structuredClone(s), first = chooseDefense(s);
  assert.ok(first); assert.deepEqual(chooseDefense(s), first); assert.deepEqual(s, before);
  first.threatOwners.clear(); assert.deepEqual(chooseDefense(s).threatOwners, new Set([2]));
});
test('跨tick路径失效立即解除锁定', () => {
  const s = board([101, 1, 2, 1], [2, 1, 25, 40]); assert.ok(chooseDefense(s));
  s.turn++; s.grid[1] = 201; assert.equal(chooseDefense(s), null);
});
test('相同未执行运输不无限重复，独立state不共享锁定', () => {
  const s = board([101, 1, 2, 1], [2, 1, 25, 40]);
  assert.ok(chooseDefense(s)); s.turn++; assert.ok(chooseDefense(s));
  s.turn += 2; assert.equal(chooseDefense(s), null);
  assert.ok(chooseDefense(structuredClone(s)));
});
test('皇冠逐tick增长足以挡住时不救援', () => {
  assert.equal(chooseDefense(board([101, 1, 2, 1], [21, 1, 25, 40])), null);
});
test('非法和结束状态返回null', () => {
  for (const s of [null, {}, board(undefined, undefined, { ended: true }), board(undefined, undefined, { dead: true }), board([101, 2], [2, NaN])])
    assert.equal(chooseDefense(s), null);
});

function distantThreat() {
  return board([101, 1, 1, 1, 2, 1, 201, 201, 201, 201],
    [2, 1, 1, 1, 30, 50, 0, 0, 0, 0], { n: 2, m: 5, turn: 60 });
}
// 先观察兵团在更远的相邻格，下一拍留下1兵并推进到目标格。
function observeApproach(s, source, dest) {
  const grid = s.grid.slice(), army = s.army.slice();
  s.grid[source] = 2; s.army[source] = army[dest] + 3;
  s.grid[dest] = 1; s.army[dest] = 1;
  chooseDefense(s); s.turn++;
  s.grid = grid; s.army = army;
  s.grid[source] = 2; s.army[source] = 1;
}
function activateDistant(s) {
  observeApproach(s, 9, 4);
  return s;
}
function receipt(s, r) {
  s.lastMove = r ? { ...r.move, op: 'm', turn: s.turn } : null;
}
test('连续20tick贫兵噪声不搜刮1至2兵，沿途已有兵不算援军贡献', () => {
  const s = distantThreat();
  // 只有皇冠支路的两兵可以搬运；路径守军和增长不能把它包装成大额援军。
  for (let t = 0; t < 20; t++) {
    s.turn = 60 + t; s.army[5] = 2 + t % 2;
    assert.equal(chooseDefense(s), null, `第${t}拍不得搜刮`);
  }
  const route = board([101, 1, 1, 1, 2, 201, 1, 201, 201, 201],
    [2, 12, 1, 1, 30, 0, 3, 0, 0, 0], { n: 2, m: 5, turn: 60 });
  const r = chooseDefense(route);
  if (r) assert.notEqual(indices(route, r)[0], 6, '不能将途经的12兵归功于首步2兵');
});
test('连续20tick静止敌军即使原地集兵也不反复动员', () => {
  const s = distantThreat(), executed = [];
  let last = null;
  for (let t = 0; t < 20; t++) {
    s.turn = 60 + t; receipt(s, last);
    s.army[5] = 50 + t; s.army[4] = 30 + t; // 数值变化不能绕过同威胁停滞冷却。
    last = chooseDefense(s);
    if (last) { assert.equal(last.urgent, false); executed.push(s.turn); }
  }
  assert.equal(executed.length, 0, '静止或原地增长不构成实际推进证据');
  for (let i = 1; i < executed.length; i++) assert.ok(executed[i] - executed[i - 1] >= 5);
});
test('两兵急救确实扭转皇冠失守，非紧急冷却不能阻止急救', () => {
  const s = activateDistant(distantThreat()), r = chooseDefense(s); assert.ok(r);
  s.turn++; receipt(s, r);
  s.grid[4] = 1; s.army[4] = 1;
  s.grid[1] = 2; s.army[1] = 5; // 下一拍4兵入城，增援2兵后皇冠还能剩1兵。
  s.army[5] = 3;
  const rescue = chooseDefense(s);
  assert.deepEqual(indices(s, rescue), [5, 0]); assert.equal(rescue.urgent, true);
  assert.equal(s.army[1] - 1 - (s.army[0] + 1), 1);
  s.army[5] = 2;
  assert.equal(chooseDefense(s), null, '一兵不能扭转战果时不做无效急救');
});
test('非紧急滑动5tick至多两次，缺口持续改善且敌逼近也须让出行动', () => {
  const s = board([101, 1, 1, 1, 1, 1, 1, 2, 1, ...Array(7).fill(201)],
    [2, 1, 1, 1, 1, 1, 1, 60, 100, ...Array(7).fill(0)], { n: 2, m: 8, turn: 60 });
  observeApproach(s, 15, 7);
  let last = chooseDefense(s); assert.ok(last); assert.equal(last.urgent, false);
  for (let t = 1; t <= 3; t++) {
    s.turn++; receipt(s, last);
    s.grid[8 - t] = 2; s.army[8 - t] = 1;
    s.grid[7 - t] = 2; s.army[7 - t] = 60 - 10 * t;
    s.army[8]++;
    last = chooseDefense(s);
    if (t === 1) assert.ok(last, '敌逼近且缺口改善时允许第二次');
    else assert.equal(last, null, '第三次起让出行动');
  }
});
test('mode1/2实际回执占用配额，未执行及不匹配回执不计额', () => {
  for (const mode of [0, 1, 2, 'none', 'other', 'half']) {
    const s = board([101, ...Array(6).fill(1), 2, 1, ...Array(7).fill(201)],
      [2, ...Array(6).fill(1), 60, 100, ...Array(7).fill(0)], { n: 2, m: 8, turn: 60 });
    observeApproach(s, 15, 7);
    let last = chooseDefense(s); assert.ok(last);
    for (let t = 1; t <= 3; t++) {
      s.turn++; receipt(s, last);
      if (mode === 'none') s.lastMove = null;
      else if (s.lastMove) {
        if (mode === 'other') s.lastMove.y = 2;
        else if (mode === 'half') s.lastMove.half = true;
        else s.lastMove.mode = mode;
      }
      s.grid[8 - t] = 2; s.army[8 - t] = 1;
      s.grid[7 - t] = 2; s.army[7 - t] = 60 - 10 * t;
      s.army[8]++;
      last = chooseDefense(s);
      if ((typeof mode === 'number' || mode === 'half') && t >= 2) assert.equal(last, null, `mode${mode}应计额`);
      else assert.ok(last, `${mode} 第${t}拍不应误占配额`);
    }
  }
});
test('实际逼近允许远程回防，同拍稳定，停步立即解除', () => {
  const s = distantThreat(); assert.equal(chooseDefense(s), null);
  s.turn++; activateDistant(s);
  const r = chooseDefense(s); assert.ok(r); assert.equal(r.urgent, false);
  assert.deepEqual(chooseDefense(s), r);
  s.turn++; s.army[5]++;
  assert.equal(chooseDefense(s), null);
});
test('新增皇冠缩短距离不能冒充敌军推进', () => {
  const s = board([101, 1, 1, 1, 1, 1, 2, 1, ...Array(6).fill(201)],
    [2, 1, 1, 1, 1, 1, 50, 90, ...Array(6).fill(0)], { n: 2, m: 7, turn: 60 });
  assert.equal(chooseDefense(s), null);
  s.turn++; s.grid[2] = 101;
  assert.equal(chooseDefense(s), null);
});
test('推进兵团经沿途消耗及皇冠增长已不致命则不回防', () => {
  const s = distantThreat(); s.army[4] = 10;
  activateDistant(s);
  assert.equal(chooseDefense(s), null);
});
