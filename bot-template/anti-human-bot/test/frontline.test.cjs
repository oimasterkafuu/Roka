'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');

// 5x7 棋盘，只有指定格不是山。16=(2,2) 17=(2,3) 18=(2,4) 15=(2,1) 14=(2,0) 19=(2,5)
function board() {
  return { n: 5, m: 7, turn: 60, playerId: 1, grid: Array(35).fill(201), army: Array(35).fill(0),
    isolated: Array(35).fill(0), teams: new Map([[1, 1], [2, 2], [3, 3]]) };
}
function put(s, i, g, a) { s.grid[i] = g; s.army[i] = a; return s; }
const move = { x: 2, y: 2, dx: 2, dy: 3, mode: 0 }; // 16 -> 17
function basic() { const s = board(); put(s, 16, 101, 101); put(s, 17, 2, 10); return s; }

test('安全边界立即可进攻，不必等待更多兵', () => {
  const s = basic(), f = createFrontline(s);
  const result = f.assess(move);
  assert.ok(result, `应通过，实际拒绝桶=${JSON.stringify(f.diagnostics.rejected)}`);
  assert.ok([0, 1, 2].includes(result.mode));
  assert.ok(createFrontline(s).choose());
});

test('打不过就不打：到达后无法占领时必须拒绝并给出数值诊断', () => {
  const s = basic(); put(s, 17, 2, 400);
  const f = createFrontline(s);
  assert.equal(f.assess(move), null);
  assert.ok(f.diagnostics.rejected['出兵或留守预算未通过']);
  const sample = f.diagnostics.examples[0];
  assert.equal(sample.A, 102);      // 皇冠本 tick 先 +1
  assert.equal(sample.D, 400);
});

test('贴着源点的强敌要求留下足够守军，不能为一次进攻抽空源点', () => {
  const s = basic(); put(s, 15, 2, 500);
  assert.equal(createFrontline(s).assess(move), null);
  const s2 = basic(); put(s2, 15, 2, 1); // 邻敌很弱 → 放行
  assert.ok(createFrontline(s2).assess(move));
});

test('两跳外的大军按到达时间衰减，不再一票否决两跳外的进攻', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 2000); put(s, 17, 2, 2); put(s, 19, 2, 2000); // 19 距 17 两跳
  const f = createFrontline(s);
  assert.ok(f.assess(move), `实际拒绝桶=${JSON.stringify(f.diagnostics.rejected)}`);
});

test('全图远处的敌军总量不再抬高本地进攻门槛', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 2000); put(s, 17, 2, 2);
  put(s, 27, 2, 50000); // (3,6) 与战场无关的远方巨堆（距源点/目标均 >3 跳）
  put(s, 33, 2, 50000);
  assert.ok(createFrontline(s).assess(move));
});

test('minArrive 控制占领后必须留下的兵力，禁止1兵蚕食', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 6); put(s, 17, 2, 1);
  assert.ok(createFrontline(s).assess(move));                                  // 默认 minArrive=1
  assert.equal(createFrontline(s, { minArrive: 6 }).assess(move), null);       // 要求留下 6 兵则拒绝
});

test('正在被反推（consolidate）时只接高价值目标', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 500); put(s, 17, 2, 3);
  assert.ok(createFrontline(s).assess(move));
  assert.equal(createFrontline(s, { consolidate: true }).assess(move), null);
  const s2 = board(); s2.turn = 600;
  put(s2, 16, 101, 500); put(s2, 17, 102, 3); // 敌皇冠仍然要打
  assert.ok(createFrontline(s2, { consolidate: true }).assess(move));
});

test('全冲的放行条件：新占格压得住源点旁边的敌军', () => {
  // 1×6 走廊：0 皇冠、1 我方前沿(100兵)、2 敌格(2兵)、3 中立、4 远处敌堆
  const corridor = { x: 0, y: 1, dx: 0, dy: 2, mode: 0 };
  // 敌堆在三跳外（源点旁边干净）→ 全冲，新占格 98 兵远强于留守的 1 兵
  const far = { n: 1, m: 6, turn: 600, playerId: 1, grid: [101, 1, 2, 200, 2, 2],
    army: [100, 100, 2, 0, 4000, 0], isolated: Array(6).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  assert.equal(createFrontline(far).assess(corridor).mode, 2);
  assert.equal(createFrontline(far, { wideKeepWeight: 1 }).assess(corridor).mode, 2);
  // 敌堆贴到源点旁边 → 不允许留 1 兵面对它，改半兵或拒绝
  const near = { n: 1, m: 6, turn: 600, playerId: 1, grid: [101, 1, 2, 200, 2, 2],
    army: [100, 100, 2, 0, 4000, 0], isolated: Array(6).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  near.grid[0] = 2; near.army[0] = 4000;   // 源点左侧贴脸 4000 敌兵
  const guarded = createFrontline(near).assess(corridor);
  assert.ok(!guarded || guarded.mode !== 2, '贴脸强敌时必须留守');
});

test('服从FFA目标限制与禁行边', () => {
  const s = basic();
  assert.equal(createFrontline(s, { allowedOwners: new Set([3]) }).assess(move), null);
  assert.equal(createFrontline(s, { blockedEdges: new Set(['16:17']) }).assess(move), null);
});

test('己方安全内部运输改为全冲', () => {
  const s = basic(); put(s, 17, 1, 10);
  assert.deepEqual(createFrontline(s).assess(move), { ...move, mode: 2, half: false });
});

test('孤立来源不能发动进攻', () => {
  const s = basic(); s.isolated[16] = 1;
  assert.equal(createFrontline(s).assess(move), null);
});

test('目标不可见时拒绝，绝不凭雾中数值进攻', () => {
  const s = basic(); s.fog = Array(35).fill(0); s.fog[17] = 1;
  assert.equal(createFrontline(s).assess(move), null);
});

test('相邻敌皇冠在目标周围干净时全冲拿下', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 1, 200); put(s, 17, 102, 100);
  const f = createFrontline(s);
  const result = f.assess(move);
  assert.ok(result);
  assert.match(result.reason, /攻冠/);
});

test('目标旁边有巨量敌军时不再为攻冠送兵', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 1, 2000); put(s, 17, 102, 300); put(s, 18, 2, 10000); // 10000 贴着目标
  assert.equal(createFrontline(s).assess(move), null);
});

test('攻冠仍然优先于普通地，choose 会挑皇冠', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 500); put(s, 17, 2, 5); put(s, 15, 102, 5); // 15=(2,1) 与 17 同为相邻目标
  const chosen = createFrontline(s).choose();
  assert.ok(chosen);
  assert.equal(chosen.dx * 7 + chosen.dy, 15);
});

test('攻冠被拒时返回数值诊断而不是只有空动作', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 1, 50); put(s, 17, 102, 300);
  const f = createFrontline(s);
  assert.equal(f.choose(), null);
  assert.ok(Object.keys(f.diagnostics.rejected).length);
  assert.equal(f.diagnostics.examples[0].from, 16);
});

test('未知邻格只提高保证金，不再一律否决可见皇冠', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 1, 400); put(s, 17, 102, 100);
  s.fog = Array(35).fill(false); s.fog[9] = true; // 与战场无关的雾格
  assert.ok(createFrontline(s).assess(move));
});

test('连续机会可连续进攻，不被建设周期或后方集兵抢占', () => {
  const { chooseAction } = require('../bot/policy.cjs');
  const s = { n: 1, m: 8, turn: 501, playerId: 1, grid: [101, 1, 1, 2, 2, 2, 2, 102],
    army: [1000, 2, 750000, 5000, 5000, 5000, 5000, 10000], isolated: Array(8).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  let captures = 0;
  for (let t = 0; t < 4; t++) {
    const a = chooseAction(s);
    assert.ok(a); assert.equal(a.kind, 'attack');
    const from = a.y, to = a.dy;
    assert.equal(s.grid[to] % 50, 2);
    let reserve = 0;
    for (const v of [from - 1, from + 1]) if (v >= 0 && v < 8 && v !== to && s.grid[v] % 50 !== 1) reserve += s.army[v] - 1;
    const theoretical = Math.max(0, s.army[from] - reserve - 1), cap = s.army[from] - 1;
    const push = a.mode === 2 ? cap : Math.min(cap, a.mode === 1 ? Math.floor(theoretical / 2) : theoretical);
    assert.ok(push > s.army[to]);
    s.army[from] -= push; s.army[to] = push - s.army[to]; s.grid[to] = 1;
    s.turn++; s.lastMove = { op: 'm', x: 0, y: from, dx: 0, dy: to, turn: s.turn };
    captures++;
  }
  assert.equal(captures, 4);
});

test('消耗冲击：兵力接近时不无限对峙，主动换掉对方守军', () => {
  const s = { n: 1, m: 4, turn: 900, playerId: 1, grid: [101, 1, 2, 2],
    army: [100, 111000, 111058, 1], isolated: Array(4).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  const charge = { x: 0, y: 1, dx: 0, dy: 2, mode: 1 };
  const result = createFrontline(s).assess(charge);
  assert.ok(result, '均势必须动手');
  assert.match(result.reason, /消耗冲击/);
  assert.ok([0, 1, 2].includes(result.mode));
  const sent = Number(/出兵(\d+)/.exec(result.reason)[1]);
  assert.ok(sent >= 50000, `必须真的打出去，实际 ${sent}`);
});

test('消耗冲击：明显劣势且未对峙时不送兵', () => {
  const s = { n: 1, m: 4, turn: 900, playerId: 1, grid: [101, 1, 2, 2],
    army: [100, 20000, 111058, 1], isolated: Array(4).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  assert.equal(createFrontline(s).assess({ x: 0, y: 1, dx: 0, dy: 2, mode: 1 }), null);
});

test('消耗冲击：产能/兵力占优时，即使局部劣势也换兵破对峙', () => {
  // 6x4：第一行是双方主力对峙，其余行是各自腹地。
  const build = (homeOwner) => {
    const grid = Array(24).fill(201), army = Array(24).fill(0);
    grid[0] = 101; army[0] = 100;
    grid[1] = 1; army[1] = 59000;
    grid[2] = 2; army[2] = 111058;
    grid[3] = 2; army[3] = 1;
    for (let k = 4; k < 24; k++) { grid[k] = homeOwner === 1 ? 1 : 2; army[k] = homeOwner === 1 ? 1 : 50; }
    return { n: 6, m: 4, turn: 900, playerId: 1, grid, army,
      isolated: Array(24).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  };
  const move = { x: 0, y: 1, dx: 0, dy: 2, mode: 1 };
  const rich = createFrontline(build(1)).assess(move);
  assert.ok(rich, '产能与地皮占优时必须敢换');
  assert.match(rich.reason, /消耗冲击/);
  // 反过来：腹地全在对方手里（产能与兵力都落后）时不送兵
  assert.equal(createFrontline(build(2)).assess(move), null);
});

test('消耗冲击：小股部队不参与交换', () => {
  const s = { n: 1, m: 4, turn: 900, playerId: 1, grid: [101, 1, 2, 2],
    army: [100, 30, 40, 1], isolated: Array(4).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  assert.equal(createFrontline(s).assess({ x: 0, y: 1, dx: 0, dy: 2, mode: 1 }), null);
});

test('拆建筑不吃亏也打：占领格守不住时不再要求「打赚」', () => {
  const s = board(); s.turn = 600;
  // 我方 400 兵 vs 敌指挥所 100；两跳外还有 900 敌兵 → exposure 为负
  put(s, 16, 1, 400); put(s, 17, 52, 100); put(s, 19, 2, 900);
  const f = createFrontline(s);
  const result = f.assess(move);
  assert.ok(result, `拆指挥所不该被否决，实际桶=${JSON.stringify(f.diagnostics.rejected)}`);
  assert.match(result.reason, /攻指挥所/);
});

test('拆建筑不能把自家源点抽空：源点是我方建筑时照常留守', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 300);                        // 源点是我方皇冠
  put(s, 17, 102, 100);                        // 目标敌皇冠
  put(s, 15, 2, 900);                          // 紧贴我方皇冠的 900 敌兵
  assert.equal(createFrontline(s).assess(move), null, '互删建筑是净亏');
});

test('choose 会优先挑建筑而不是同强度的普通敌格', () => {
  const s = board(); s.turn = 600;
  put(s, 16, 101, 800);
  put(s, 15, 52, 20);                          // 敌指挥所（(2,1)，弱）
  put(s, 17, 2, 20);                           // 普通敌格，强度相同
  const chosen = createFrontline(s).choose();
  assert.ok(chosen);
  assert.equal(chosen.dx * 7 + chosen.dy, 15);
});

// 复现实地日志：2×6 棋盘，源点 (0,1)=223 兵，旁边 (1,1) 有 51 敌兵，
// 目标 (0,2)=43 兵且被 (1,2) 的 100 兵增援（对应日志 defense:115 / sourceAdj:51 / keepSource:64）。
const LIVE = (sourceArmy, sourceGrid, targetArmy, reinforceArmy) => {
  const n = 2, m = 6, at = (x, y) => x * m + y;
  const grid = Array(12).fill(1), army = Array(12).fill(1);
  grid[at(0, 0)] = 101; army[at(0, 0)] = 50;
  grid[at(0, 1)] = sourceGrid; army[at(0, 1)] = sourceArmy;
  grid[at(0, 2)] = 2; army[at(0, 2)] = targetArmy;
  grid[at(1, 1)] = 2; army[at(1, 1)] = 51;
  grid[at(1, 2)] = 2; army[at(1, 2)] = reinforceArmy;
  return { n, m, turn: 2731, playerId: 1, grid, army, isolated: Array(12).fill(0), teams: new Map([[1, 1], [2, 2]]) };
};
const LIVE_MOVE = { x: 0, y: 1, dx: 0, dy: 2, mode: 0 };

test('复现实地日志：A=223 对守军115 必须打下来，而不是空动作', () => {
  const f = createFrontline(LIVE(223, 1, 43, 100));
  const result = f.assess(LIVE_MOVE);
  assert.ok(result, `必须能打，实际桶=${JSON.stringify(f.diagnostics.rejected)}`);
  assert.equal(result.mode, 2);      // 半兵打不穿 → 全冲
});

test('复现实地日志：A=223 对守军35 也不能因为源点旁边有敌军就空转', () => {
  assert.ok(createFrontline(LIVE(223, 1, 18, 10)).assess(LIVE_MOVE), '能拿下就必须拿下');
});

test('自家建筑不会被抽空：从皇冠出兵后仍留下挡得住贴邻敌军的守军', () => {
  const result = createFrontline(LIVE(223, 101, 43, 100)).assess(LIVE_MOVE);
  if (result) {
    const sent = Number(/出兵(\d+)/.exec(result.reason)[1]);
    const garrison = 223 + 1 - sent;   // 皇冠本 tick 先 +1
    assert.ok(garrison >= 51, `皇冠留守必须压住贴邻的 51 敌兵，实际留守 ${garrison}`);
  }
});
