'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseLogistics } = require('../bot/logistics.cjs');
const micro = { x: 0, y: 2, dx: 0, dy: 3, reason: '拓地' };
function state(grid, army, extra = {}) {
  return { n: 1, m: grid.length, playerId: 1, grid, army, turn: 20,
    fog: grid.map(() => false), isolated: grid.map(() => false),
    teams: new Map([[1, 1], [2, 2]]), ...extra };
}
const choose = (s, move = micro, build = null, params = {}) => chooseLogistics(s, move, build, params);

test('非法输入、结束、死亡不行动', () => {
  for (const s of [null, {}, state([1], [30], { dead: true }), state([1], [30], { ended: true })])
    assert.equal(choose(s), null);
});
test('大量普通后方兵取得配额，不被拓地微操饿死', () => {
  const a = choose(state([1, 1, 1, 2], [150, 1, 5, 90]));
  assert.equal(a.kind, 'attack');
  assert.equal(a.y, 0); assert.equal(a.dy, 1);
  assert.equal(a.reason.amount, 149);
  assert.ok(a.reason.rearRatio > 0.9);
  assert.equal(a.reason.phase, 'reinforce');
});
test('隔次调度让出进攻机会，但下一次重新获得配额', () => {
  const s = state([1, 1, 1, 2], [100, 1, 1, 90]);
  assert.ok(choose(s)); s.turn++;
  assert.equal(choose(s), null); s.turn++;
  assert.ok(choose(s));
});
test('持久计划不会仅因12tick过期换目标', () => {
  const s = state([2, 1, 1, 1, 1, 1, 2], [80, 1, 100, 1, 20, 1, 80]);
  const a = choose(s);
  s.turn += 2; s.army[2] = 1; s.army[4] = 150;
  const b = choose(s);
  assert.equal(b.reason.target, a.reason.target);
  assert.equal(b.reason.planSince, a.reason.planSince);
  s.turn = 40;
  const c = choose(s);
  assert.equal(c.reason.planSince, a.reason.planSince);
  assert.equal(c.reason.target, a.reason.target);
});
test('目标失去所有权时立即失效重选', () => {
  const s = state([2, 1, 1, 1, 1, 1, 2], [80, 1, 100, 1, 20, 1, 80]);
  const a = choose(s);
  s.grid[a.reason.target] = 2; s.turn += 4;
  const b = choose(s);
  assert.ok(b); assert.notEqual(b.reason.target, a.reason.target);
  assert.equal(s.grid[b.reason.target], 1);
});
test('紧急守城及结构化紧急原因永不抢占', () => {
  for (const reason of ['守主城', '防守', '清除主城威胁', { code: 'emergency-defense' }]) {
    assert.equal(choose(state([1, 1, 2], [100, 1, 100]), { reason }, { x: 0, y: 0, op: 'b' }), null);
  }
});
test('实际敌前线优先，不把近处中立边界当主集结点', () => {
  const a = choose(state([200, 1, 1, 1, 1, 2], [0, 1, 100, 1, 1, 90]));
  assert.equal(a.reason.target, 4);
  assert.equal(a.y, 2); assert.equal(a.dy, 3);
});
test('BFS严格递减，多步汇兵没有往返倒兵', () => {
  const s = state([1, 1, 1, 1, 2], [40, 1, 1, 1, 80]);
  for (let i = 0; i < 3; i++) {
    const a = choose(s);
    assert.equal(a.y, i); assert.equal(a.dy, i + 1);
    assert.equal(a.reason.distanceAfter, a.reason.distanceBefore - 1);
    s.army[a.y] -= a.reason.amount; s.army[a.dy] += a.reason.amount;
    s.turn += 2;
  }
  assert.equal(choose(s), null);
});
test('孤立格及队友格不作为运输跳板或出兵点', () => {
  assert.equal(choose(state([1, 1, 1, 2], [100, 1, 1, 90], { isolated: [false, true, false, false] })), null);
  assert.equal(choose(state([1, 3, 1, 2], [100, 50, 1, 90], { teams: new Map([[1, 1], [3, 1], [2, 2]]) })), null);
});
test('主城mode0不能留下安全兵时半兵补给，普通格照常运输', () => {
  const half = choose(state([101, 1, 1, 2], [150, 1, 1, 90]));
  assert.equal(half.mode, 1); assert.equal(half.reason.amount, 74);
  assert.ok(choose(state([101, 1, 1, 2], [150, 40, 1, 90])));
});
test('精确mode0包括中立驻军、空格负一及雾留兵', () => {
  const a = choose(state([0, 1, 1, 2], [10, 30, 1, 90]));
  assert.equal(a.reason.amount, 20);
  const b = choose(state([200, 1, 1, 2], [0, 30, 1, 90]));
  assert.equal(b.reason.amount, 29);
  const c = choose(state([202, 1, 1, 2], [0, 30, 1, 90]));
  assert.equal(c.reason.amount, 27);
});
test('经济计划穿过自有格聚兵，优先完成安全指挥所', () => {
  const s = state([51, 1, 1, 1, 1, 1, 2], [20, 1, 280, 1, 1, 1, 20]);
  const a = choose(s);
  assert.equal(a.reason.phase, 'fund'); assert.equal(a.reason.target, 0);
  assert.equal(a.y, 2); assert.equal(a.dy, 1);
  s.army = [20, 280, 1, 1, 1, 1, 20]; s.turn += 4;
  const b = choose(s);
  assert.equal(b.reason.target, 0); assert.equal(b.dy, 0);
  assert.equal(b.reason.planSince, a.reason.planSince);
});
test('普通地块筹齐两阶段费用，资金不足不立项', () => {
  const funded = state([1, 1, 1], [60, 1, 60]);
  assert.equal(choose(funded).reason.phase, 'fund');
  assert.equal(choose(state([1, 1, 1], [30, 1, 30])), null);
});
test('投资保留安全余量并控制节奏，不重复铺指挥所', () => {
  const s = state([51, 1, 1], [60, 120, 1]);
  const b = choose(s, micro, { x: 0, y: 0, op: 'c', reason: '预计回本' });
  assert.equal(b.kind, 'build'); assert.equal(b.reason.phase, 'upgrade');
  assert.equal(choose(s, micro, { x: 0, y: 0, op: 'c' }), null);
  s.turn += 8; s.army[0] = 50;
  assert.notEqual(choose(s, micro, { x: 0, y: 0, op: 'c' })?.kind, 'build');
});
test('turn回退重置计划和配额，独立state互不污染', () => {
  const s = state([1, 1, 1, 2], [100, 1, 1, 90]);
  assert.ok(choose(s)); assert.equal(choose(s), null);
  assert.ok(choose(structuredClone(s)));
  s.turn = 1;
  const a = choose(s);
  assert.ok(a); assert.equal(a.reason.planSince, 1);
});
test('不修改输入，包括冻结的数组及局面对象', () => {
  const s = state([1, 1, 1, 2], [100, 1, 1, 90]);
  const snapshot = structuredClone(s);
  for (const key of ['grid', 'army', 'fog', 'isolated']) Object.freeze(s[key]);
  Object.freeze(s);
  assert.ok(choose(s)); assert.deepEqual(s, snapshot);
});
test('不连通敌前线不会吸走另一连通分量兵力', () => {
  const s = state([1, 1, 200, 201, 1, 2], [50, 1, 0, 0, 1, 100]);
  const a = choose(s);
  assert.equal(a.reason.target, 1); assert.equal(a.dy, 1);
});

test('无近敌安全主城可以全额向前供兵', () => {
  const a = choose(state([101, 1, 1, 1, 1, 2], [150, 1, 1, 1, 1, 200]));
  assert.equal(a.y, 0); assert.equal(a.reason.amount, 149);
});
test('主城敌军按运输路径和行动间隔预测增长', () => {
  const a = choose(state([1, 1, 1, 102], [100, 1, 1, 90]));
  assert.equal(a.reason.forecast.eta, 5);
  assert.equal(a.reason.forecast.naturalGrowth, 5);
  assert.equal(a.reason.forecast.needed, 96);
});
test('远程补兵比邻近补兵需要预算更多敌增长', () => {
  const near = choose(state([1, 1, 102], [100, 1, 90]));
  const far = choose(state([1, 1, 1, 1, 102], [100, 1, 1, 1, 90]));
  assert.ok(far.reason.forecast.required > near.reason.forecast.required);
});
test('普通敌地预测跨入爆发期增长', () => {
  const a = choose(state([1, 1, 1, 2], [100, 1, 1, 90], { turn: 24 }));
  assert.equal(a.reason.forecast.naturalGrowth, 4);
});
test('敌指挥所只有50tick增长而无爆发增长', () => {
  const a = choose(state([1, 1, 1, 52], [100, 1, 1, 90], { turn: 47 }));
  assert.equal(a.reason.forecast.naturalGrowth, 1);
});
test('可见敌后方援军纳入到达预算', () => {
  const a = choose(state([1, 1, 1, 102, 2], [100, 1, 1, 90, 40]));
  assert.equal(a.reason.forecast.reinforcement, 38);
});
test('雾中敌军数值不能进入增援估计', () => {
  const make = amount => choose(state([1, 1, 1, 102, 2], [100, 1, 1, 90, amount],
    { fog: [false, false, false, false, true] }));
  assert.deepEqual(make(10).reason.forecast, make(9000).reason.forecast);
});
test('防守集兵趋势仅来自可见变化并扣自然增长', () => {
  const s = state([1, 1, 1, 102], [100, 1, 1, 90]);
  choose(s); s.turn += 2; s.army[3] += 12;
  const a = choose(s);
  assert.equal(a.reason.forecast.observedGain, 25);
});
test('仅自然增长不误判敌方集兵', () => {
  const s = state([1, 1, 1, 102], [100, 1, 1, 90]);
  choose(s); s.turn += 2; s.army[3] += 2;
  assert.equal(choose(s).reason.forecast.observedGain, 0);
});
test('前线达到含增长需求后让出进攻行动', () => {
  assert.equal(choose(state([1, 1, 1, 102], [100, 1, 150, 90])), null);
});
test('先集齐费用再落塔，落塔后下一经济机会完成皇冠',()=>{
 const s=state([1,1,1],[60,1,65]);let foundation=false,upgrade=false;
 for(let k=0;k<20;k++){const a=choose(s);if(a?.kind==='attack'){s.army[a.y]-=a.reason.amount;s.army[a.dy]+=a.reason.amount;}if(a?.kind==='build'){if(a.op==='b'){assert.ok(s.army[a.y]>=108);foundation=true;s.grid[a.y]=51;}else{assert.ok(foundation);upgrade=true;s.grid[a.y]=101;}s.army[a.y]-=50;}s.turn+=4;if(upgrade)break;}
 assert.ok(foundation);assert.ok(upgrade);
});
test('物流不能用1兵留守绕过共用8兵升级余量', () => {
  assert.equal(choose(state([51, 1], [51, 1])), null);
  const a = choose(state([51, 1], [58, 1]));
  assert.equal(a.op, 'c'); assert.equal(a.reason.reserve, 8);
});
test('经济行动配额之间仍然向持续进攻目标补兵且不反向倒兵', () => {
  const s = state([51, 1, 1, 1, 1, 1, 2], [20, 1, 280, 1, 1, 1, 20]);
  const a = choose(s); assert.equal(a.reason.phase, 'fund');
  s.army[a.y] -= a.reason.amount; s.army[a.dy] += a.reason.amount;
  s.army[3] = 80; s.turn += 2;
  const b = choose(s); assert.equal(b.reason.phase, 'reinforce');
  assert.equal(b.y, 3); assert.equal(b.dy, 4);
});

const { chooseBuild } = require('../bot/building.cjs');
test('物流不能凭外部升级提示绕过后排强军风险',()=>{
  const s=state([51,1,1,1,1,2,2],[100,1,1,1,1,2,500],{turn:100});
  assert.equal(chooseBuild(s),null);
  assert.notEqual(choose(s,micro,{x:0,y:0,op:'c'})?.kind,'build');
});
test('激进经济参数也不能绕过可达敌军总量',()=>{
  const s=state([51,1,1,1,1,2,2],[100,1,1,1,1,2,500],{turn:100});
  const p={buildSafety:0,threatWeight:0.5,buildThreshold:-30,investmentHorizon:300};
  assert.equal(chooseBuild(s,null,p),null);
  assert.notEqual(choose(s,micro,null,p)?.kind,'build');
});
test('物流与building对可证安全的近敌皇冠一致放行',()=>{
  const s=state([51,2],[100,2],{turn:100});
  assert.equal(chooseBuild(s).op,'c');assert.equal(choose(s).op,'c');
});
test('物流入口也拒绝建造会被两步内强军攻破的塔',()=>{
  const s=state([101,1,1,1,103],[1,1,80,1,1],{n:3,m:5,turn:100,
    grid:[201,201,2,201,201,201,201,200,201,201,101,1,1,1,103],
    army:[0,0,400,0,0,0,0,0,0,0,1,1,80,1,1],
    teams:new Map([[1,1],[3,1],[2,2]])});
  // 强军距候选仅两步：塔也不能直接送掉。
  assert.equal(chooseBuild(s),null);assert.notEqual(choose(s)?.kind,'build');
});
test('物流不得绕过短回本视野',()=>{
  const s=state([1,1,1],[150,1,1]);
  const p={investmentHorizon:60};
  assert.equal(chooseBuild(s,null,p),null);assert.notEqual(choose(s,micro,null,p)?.kind,'build');
});
test('物流共享团队瓶颈塔用途，驻留后安全时转皇冠',()=>{
  const grid=Array(35).fill(201),army=Array(35).fill(0);
  for(let i=21;i<=27;i++){grid[i]=1;army[i]=1;}
  grid[21]=101;grid[27]=103;grid[17]=2;army[17]=2;grid[10]=200;grid[3]=2;army[3]=400;army[24]=80;
  const s=state(grid,army,{n:5,m:7,turn:100,teams:new Map([[1,1],[2,2],[3,1]])});
  const p={territoryPerCrown:6};
  const a=choose(s,micro,null,p);assert.equal(a.op,'b');assert.equal(a.reason.phase,'anchor-tower');
  s.grid[24]=51;s.army[24]-=50;s.turn+=4;
  assert.notEqual(choose(s,micro,{x:3,y:3,op:'c'},p)?.kind,'build');
  s.grid[3]=200;s.grid[17]=200;s.army[24]=80;s.turn+=4;
  assert.equal(choose(s,micro,null,p).op,'c');
});

test('560tick单皇冠多塔从低余额持久筹资，敌全军预测和远程斩首不能饿死经济', () => {
  const grid=Array(44).fill(1), army=Array(44).fill(1);
  grid[0]=51; army[0]=5;
  grid[4]=51; army[4]=3;
  grid[24]=101; army[24]=2;
  grid[40]=51; army[40]=20; // 前沿塔始终危险，不能升级。
  grid[42]=2; grid[43]=102; army[42]=10000; army[43]=20000;
  const s=state(grid,army,{turn:560});
  const p={territoryPerCrown:40,maxCrowns:2};
  const remote={x:0,y:30,dx:0,dy:31,reason:'斩首（远程）'};
  const funding=[], upgrades=[], reinforcements=[];
  for(let tick=560;tick<1120;tick++) {
    s.turn=tick;
    for(let i=0;i<grid.length;i++) {
      if(grid[i]===101 || grid[i]===102) army[i]++;
      else if(tick%50===0 && grid[i]>0 && grid[i]<100) army[i]++;
    }
    const a=choose(s,remote,null,p);
    if(!a) continue;
    if(a.kind==='build') {
      const i=a.x*s.m+a.y;
      const risk=require('../bot/architecture.cjs').architecture(s,p).assess(i);
      assert.ok(a.op==='c' ? risk.crownSafe : risk.towerSafe || risk.foundationSafe);
      if(a.op==='c') { assert.notEqual(i,40); upgrades.push({tick,i}); }
      grid[i]=a.op==='c' ? 101 : 51; army[i]-=50;
    } else {
      const from=a.x*s.m+a.y,to=a.dx*s.m+a.dy;
      army[from]-=a.reason.amount;army[to]+=a.reason.amount;
      if(a.reason.phase==='fund') funding.push({tick,...a.reason});
      else reinforcements.push(tick);
    }
  }
  assert.ok(funding.length>5);
  assert.ok(funding.some(a=>a.forecast.needed>10000));
  assert.ok(funding.at(-1).tick-funding[0].tick>32);
  assert.equal(new Set(funding.map(a=>a.planSince)).size,1);
  assert.equal(upgrades.length,1); assert.ok([0,4].includes(upgrades[0].i));
  assert.ok(reinforcements.length>0,'筹资配额不能独占前线运输');
  assert.equal(grid.filter(v=>v===101).length,2);
  assert.equal(grid[40],51);
  assert.ok(funding.every(a=>a.tick<upgrades[0].tick),'达到皇冠目标后停止筹资');
});

test('真实可立即斩首优先，不可捕获或远程文字标签不阻断建设',()=>{
  const s=state([51,1,1,1,1,1,1,1,1,1,1,102],[80,1,1,1,1,1,1,1,1,1,80,2],{turn:560});
  const immediate={x:0,y:10,dx:0,dy:11,reason:'斩首'};
  assert.equal(choose(s,immediate),null);
  assert.equal(chooseBuild(s,immediate),null);
  const remote={x:0,y:9,dx:0,dy:10,reason:{code:'decap',detail:'远程斩首'}};
  assert.equal(choose(s,remote).op,'c');
  s.turn++;s.army[10]=2;
  assert.equal(chooseBuild(s,immediate).op,'c');
});

test('军事物流先用近处皇冠，不被远方巨堆吸走动作',()=>{
 const s=state([101,1,1,1,101,1,1,2],[750000,1,1,1,40000,1,10,30000],{turn:60});
 const a=choose(s);assert.ok(a);assert.equal(a.y,4);assert.equal(a.dy,5);
});
test('近处有效兵用尽之后才启用远后方',()=>{
 const s=state([101,1,1,1,101,1,1,2],[750000,1,1,1,1,1,10,30000],{turn:60});
 const a=choose(s);assert.ok(a);assert.equal(a.y,0);assert.equal(a.dy,1);
});
