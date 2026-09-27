'use strict';
// 敌方跳板纵队拦截（2026-09-28 用户硬方针 + 二之补充 + 二之二补充）回归测试：
//   敌连通纵队深入我控区 ≥columnMinDepth 格且头部仍在推进 → 优先掐链（打脖子）/
//   未深入（边境接触）不触发 / 头部未推进（含首次观测）不触发 /
//   短促自耗型跳板（一两个格、无脖子可截）→ 迎头撞头部格 /
//   头部是敌建筑（头自带锚、尾部自弃，掐链无效）→ 一律打头拆建筑 /
//   policy 层：背水一战/皇冠告急优先于纵队拦截，多路告急不拦纵队。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseColumnStrike } = require('../bot/column.cjs');
const { chooseAction } = require('../bot/policy.cjs');

// 9×9：我方 x≤4（皇冠 (0,0)），敌方 x≥5（敌皇冠 (8,6)）。敌纵队沿 y=6 排插入我方
// 腹地。penetrate=4 时纵队格 (4,6)(3,6)(2,6)(1,6)（深入块 3 格、短型），
// penetrate=5 时再到 (0,6)（深入块 4 格、长纵队，头部 (0,6)=100）。
function columnBoard({ penetrate = 4, turn = 61, owner3 = false } = {}) {
  const n = 9, m = 9, size = n * m, grid = Array(size).fill(0), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  for (let x = 0; x <= 4; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 10; }
  grid[at(0, 0)] = 101; army[at(0, 0)] = 30;
  for (let x = 5; x < n; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 10; }
  grid[at(8, 6)] = 102; army[at(8, 6)] = 30;
  // 纵队（从外到内）：(4,6)=30 (3,6)=40 (2,6)=60 (1,6)=80 (0,6)=100。
  const snake = [[4, 30], [3, 40], [2, 60], [1, 80], [0, 100]];
  for (let k = 0; k < penetrate; k++) {
    const [x, a] = snake[k];
    grid[at(x, 6)] = 2; army[at(x, 6)] = a;
  }
  // 脖子旁的攻击源：(3,5) 大兵堆，可以直接掐链。
  grid[at(3, 5)] = 1; army[at(3, 5)] = 200;
  const teams = new Map([[1, 1], [2, 2]]);
  if (owner3) { // 第二敌阵营大堆贴脸皇冠：多路告急
    teams.set(3, 3);
    grid[at(0, 1)] = 3; army[at(0, 1)] = 500;
    grid[at(8, 0)] = 103; army[at(8, 0)] = 30;
  }
  return { n, m, turn, grid, army, playerId: 1, teams, gameId: 'column' };
}

test('敌纵队深入且推进：优先掐链，攻击纵队与敌主力之间的脖子', () => {
  const s = columnBoard({ penetrate: 4, turn: 61 });
  assert.equal(chooseColumnStrike(s), null, '首次观测无推进证据，不出手');
  // 下一 tick：纵队头部从 (1,6) 推进到 (0,6)（深入块变 4 格长纵队）。
  const s2 = columnBoard({ penetrate: 5, turn: 62 });
  // 同一局面对象跨 tick 演进（WeakMap 记忆挂在 state 上）。
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  const a = chooseColumnStrike(s);
  assert.ok(a);
  assert.match(a.move.reason, /掐断敌跳板纵队/);
  assert.equal(a.move.dx, 3); assert.equal(a.move.dy, 6, '打脖子 (3,6)，冻住头部一段');
  assert.ok(a.trapped >= 30, '掐链冻住量够本');
});

test('敌纵队未深入（普通边境接触）不触发', () => {
  // 敌 x≥3 与我 x≤2 贴脸对峙，没有任何敌格被我方包住（embedded 不成立）。
  const n = 9, m = 9, size = n * m, grid = Array(size).fill(0), army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  for (let x = 0; x <= 2; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 1; army[at(x, y)] = 10; }
  grid[at(0, 0)] = 101; army[at(0, 0)] = 30;
  for (let x = 3; x < n; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 50; }
  grid[at(8, 6)] = 102; army[at(8, 6)] = 30;
  const s = { n, m, turn: 61, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]), gameId: 'border' };
  assert.equal(chooseColumnStrike(s), null);
  s.turn = 62;
  assert.equal(chooseColumnStrike(s), null, '边境压力不是深入纵队，两个 tick 都不触发');
});

test('敌纵队头部未推进（两个 tick 静止）不触发', () => {
  const s = columnBoard({ penetrate: 5, turn: 61 });
  assert.equal(chooseColumnStrike(s), null, '首次观测不出手');
  s.turn = 62; // 局面不变：头部距离没变，不算推进
  assert.equal(chooseColumnStrike(s), null, '头部静止的纵队不拦');
});

test('短促自耗型跳板：无脖子可截，迎头撞头部格', () => {
  // tick 61：敌插入 (4,6)(3,6)——深入块只有 (3,6) 一格（短型）。
  const s = columnBoard({ penetrate: 2, turn: 61 });
  assert.equal(chooseColumnStrike(s), null, '首次观测不出手');
  // tick 62：再插一格到 (2,6)——深入块 (3,6)(2,6) 两格仍在推进，头部 (2,6)。
  const s2 = columnBoard({ penetrate: 3, turn: 62 });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  s.grid[2 * s.m + 5] = 1; s.army[2 * s.m + 5] = 200; // 贴着头部的主力，能直接撞
  const a = chooseColumnStrike(s);
  assert.ok(a);
  assert.match(a.move.reason, /迎头撞敌短跳板/);
  assert.equal(a.move.dx, 2); assert.equal(a.move.dy, 6, '直接迎头撞头部格，以兵换兵顶回去');
});

test('policy 调度：敌纵队深入时输出掐链攻击（column-strike 分支）', () => {
  const s = columnBoard({ penetrate: 4, turn: 61 });
  chooseAction(s); // 首次观测：记录头部距离
  const s2 = columnBoard({ penetrate: 5, turn: 62 });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  const a = chooseAction(s);
  assert.ok(a);
  assert.equal(a.kind ?? 'attack', 'attack');
  assert.match(a.reason, /掐断敌跳板纵队/);
  assert.equal(a.dx, 3); assert.equal(a.dy, 6);
});

test('二之二补充：头部是敌指挥所（头自带锚、尾部自弃）一律打头，不掐链', () => {
  // tick 61：深入块 (4,6)(3,6)(2,6)(1,6) 四格长纵队，但头部 (1,6) 是敌指挥所。
  const s = columnBoard({ penetrate: 4, turn: 61 });
  s.grid[1 * s.m + 6] = 52; s.army[1 * s.m + 6] = 80;
  s.grid[0 * s.m + 5] = 1; s.army[0 * s.m + 5] = 300; // 贴着未来头部的主力，能直接拆
  assert.equal(chooseColumnStrike(s), null, '首次观测不出手');
  // tick 62：纵队推进——头前移到 (0,6) 并落成指挥所（以建筑为头）。
  const s2 = columnBoard({ penetrate: 5, turn: 62 });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  s.grid[0 * s.m + 6] = 52; s.army[0 * s.m + 6] = 100;
  s.grid[0 * s.m + 5] = 1; s.army[0 * s.m + 5] = 300;
  const a = chooseColumnStrike(s);
  assert.ok(a);
  assert.match(a.move.reason, /打头拆敌跳板建筑/, '尾部自弃，打掉尾部挡不住头，一律打头');
  assert.equal(a.move.dx, 0); assert.equal(a.move.dy, 6, '攻击落点是头部建筑而非脖子 (3,6)');
});

test('policy 调度：多路告急（皇冠被第二敌阵营贴脸）时不为拦纵队抽空防守', () => {
  const s = columnBoard({ penetrate: 4, turn: 61, owner3: true });
  // 家里 600 兵守在 (1,0)，可以反打贴脸的 500——防御有动作且威胁 urgent。
  s.grid[1 * s.m + 0] = 1; s.army[1 * s.m + 0] = 600;
  chooseAction(s); // 首次观测
  const s2 = columnBoard({ penetrate: 5, turn: 62, owner3: true });
  Object.assign(s, { grid: s2.grid, army: s2.army, turn: 62 });
  s.grid[1 * s.m + 0] = 1; s.army[1 * s.m + 0] = 600;
  const a = chooseAction(s);
  assert.ok(a);
  assert.doesNotMatch(a.reason, /掐断敌跳板纵队|迎头撞敌短跳板|侧击敌纵队腰部/);
  assert.match(a.reason, /防守|背水|截击/, '皇冠告急的防守动作优先于纵队拦截');
});
