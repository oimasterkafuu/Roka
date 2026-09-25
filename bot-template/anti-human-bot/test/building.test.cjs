'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chooseBuild}=require('../bot/building.cjs');
function state(){const s={n:5,m:5,playerId:1,grid:Array(25).fill(1),army:Array(25).fill(1),isolated:Array(25).fill(0),fog:Array(25).fill(0),teams:new Map([[1,1],[2,2]])};s.grid[0]=101;s.army[12]=112;return s;}
// 更新旧固定112/62门槛：改用可训练余量和可调友军筹资。
test('安全腹地保留升级资金及动态余量',()=>{const s=state();s.army[12]=108;assert.equal(chooseBuild(s).op,'b');s.army[12]=107;assert.equal(chooseBuild(s),null);});
test('指挥所升级需50加可训练安全余量',()=>{const s=state();s.grid[12]=51;s.army[12]=58;assert.equal(chooseBuild(s).op,'c');s.army[12]=57;assert.equal(chooseBuild(s),null);});
test('主城沼泽敌地不可建',()=>{for(const code of [101,151,2,200]){const s=state();s.grid[12]=code;assert.equal(chooseBuild(s),null);}});
test('孤立不能建',()=>{const s=state();s.isolated[12]=1;assert.equal(chooseBuild(s),null);});
test('强敌与未知贴脸威胁阻止资金不足的投资',()=>{const s=state();s.grid[13]=2;s.army[13]=80;assert.equal(chooseBuild(s),null);s.grid[13]=1;s.army[13]=1;s.fog[13]=1;assert.equal(chooseBuild(s),null);});
test('紧急行动优先',()=>{for(const reason of ['主城防守','守主城','清除威胁','回收孤军','打通孤军'])assert.equal(chooseBuild(state(),{reason}),null);});
test('优先升级现有指挥所',()=>{const s=state();s.grid[11]=51;s.army[11]=70;assert.equal(chooseBuild(s).op,'c');assert.equal(chooseBuild(s).y,1);});
test('限制经济建筑数量',()=>{const s=state();s.grid[1]=101;assert.equal(chooseBuild(s),null);});
test('对局结束不建造，普通拓地可以让位经济',()=>{const s=state();assert.ok(chooseBuild(s,{reason:'拓地'}));s.ended=true;assert.equal(chooseBuild(s),null);});
const {DEFAULT_PARAMS,PARAM_RANGES}=require('../bot/params.cjs');
const {chooseAction}=require('../bot/policy.cjs');
test('参数为14个有范围的有限扁平数值',()=>{assert.equal(Object.keys(DEFAULT_PARAMS).length,14);for(const [k,v] of Object.entries(DEFAULT_PARAMS)){assert.ok(Number.isFinite(v));assert.ok(v>=PARAM_RANGES[k][0]&&v<=PARAM_RANGES[k][1]);}});
test('零余量允许恰好50兵升级但49永不允许',()=>{const s=state();s.grid[12]=51;s.army[12]=50;assert.equal(chooseBuild(s,null,{buildSafety:0}).op,'c');s.army[12]=49;assert.equal(chooseBuild(s,null,{buildSafety:0}),null);});
test('安全余量参数确实影响行动',()=>{const s=state();s.grid[12]=51;s.army[12]=60;assert.ok(chooseBuild(s,null,{buildSafety:0}));assert.equal(chooseBuild(s,null,{buildSafety:30}),null);});
test('产能规模目标可训练',()=>{const s=state();assert.ok(chooseBuild(s));assert.equal(chooseBuild(s,null,{territoryPerCrown:40}),null);});
test('短回本视野拒绝漫长的两阶段投资',()=>{assert.equal(chooseBuild(state(),null,{investmentHorizon:60}),null);});
test('分散资金未集中前禁止提前花50落塔',()=>{const s=state();s.army[12]=70;s.grid[0]=1;s.grid[11]=101;s.army[11]=130;const a=chooseBuild(s);assert.equal(a,null);});
test('前沿弱敌并非一律禁建',()=>{const s=state();s.grid[12]=51;s.army[12]=100;s.grid[13]=2;s.army[13]=2;assert.equal(chooseBuild(s).op,'c');});
test('隔山强敌不影响可防守深入位置',()=>{const s=state();for(let r=0;r<5;r++)s.grid[r*5+3]=201;s.grid[14]=2;s.army[14]=500;s.grid[12]=51;s.army[12]=60;assert.equal(chooseBuild(s).op,'c');s.grid[13]=200;assert.equal(chooseBuild(s),null);});
test('清除主城威胁不会被经济抢占',()=>{assert.equal(chooseBuild(state(),{reason:'清除主城威胁'}),null);});
test('已有待升级产能时不重复铺设',()=>{const s=state();s.grid[11]=51;assert.equal(chooseBuild(s),null);});
test('非法参数回退且不改变输入',()=>{const s=state(),copy=structuredClone(s);assert.deepEqual(chooseBuild(s,null,{buildSafety:NaN}),chooseBuild(s));assert.deepEqual(s,copy);});
test('policy返回build协议与reason',()=>{const a=chooseAction(state());assert.equal(a.kind,'build');assert.equal(a.op,'b');assert.ok(a.reason);});
test('policy无行动及终局返回null',()=>{assert.equal(chooseAction(null),null);const s=state();s.dead=true;assert.equal(chooseAction(s),null);});
test('policy即使激进投资也优先直接斩首',()=>{const s=state();s.grid[13]=102;s.army[13]=1;const a=chooseAction(s,{buildThreshold:-30});assert.equal(a.kind,'attack');assert.equal(a.reason,'斩首');});

const { architecture } = require('../bot/architecture.cjs');
function bridge() {
  const grid = Array(35).fill(201), army = Array(35).fill(0);
  for (let i=21;i<=27;i++) { grid[i]=1; army[i]=1; }
  grid[21]=101; grid[27]=103;
  grid[17]=2; army[17]=2; grid[10]=200; grid[3]=2; army[3]=400;
  army[24]=80;
  return { n:5,m:7,playerId:1,grid,army,turn:100,teams:new Map([[1,1],[3,1],[2,2]]) };
}
const bridgeParams = { territoryPerCrown:6 };
test('多团队锚点之间的易切断通道可以建设减损塔',()=>{
  const s=bridge(), risk=architecture(s).assess(24);
  assert.equal(risk.anchorGroups,2); assert.ok(risk.tactical); assert.ok(risk.towerSafe);
  const a=chooseBuild(s,null,bridgeParams); assert.equal(a.op,'b'); assert.match(a.reason,/减损/);
});
test('近弱敌不能遮蔽更后排的强军',()=>{
  const s=bridge(); s.grid[24]=51;
  const risk=architecture(s).assess(24);
  assert.equal(risk.distance,1); assert.ok(risk.incoming>=400); assert.equal(risk.crownSafe,false);
  assert.equal(chooseBuild(s,null,bridgeParams),null);
});
test('减损指挥塔风险未消退时持续驻留不升级',()=>{
  const s=bridge(); s.grid[24]=51;
  for(let tick=100;tick<110;tick++) { s.turn=tick; assert.equal(chooseBuild(s,null,bridgeParams),null); }
});
test('塔点资金足以保守覆盖全部敌可达兵时优先皇冠',()=>{
  const s=bridge(); s.grid[24]=51; s.army[24]=1000;
  assert.equal(chooseBuild(s,null,bridgeParams).op,'c');
});
test('风险消退后已有塔及时升级而非永久标记为塔',()=>{
  const s=bridge(); s.grid[24]=51; s.grid[17]=200; s.grid[3]=200;
  assert.equal(chooseBuild(s,null,bridgeParams).op,'c');
});
test('没有第二个建筑锚点的普通前线不滥建塔',()=>{
  const s=bridge(); s.grid[27]=3;
  assert.equal(architecture(s).assess(24).tactical,false);
  assert.equal(chooseBuild(s,null,bridgeParams),null);
});
test('存在团队绕行通路时不谎称瓶颈连通价值',()=>{
  const s=bridge(); for(let i=28;i<35;i++) {s.grid[i]=1;s.army[i]=1;}
  assert.equal(architecture(s).assess(24).anchorGroups,1);
  assert.equal(chooseBuild(s,null,bridgeParams),null);
});
test('不相干分量的锚点不能充当第二个连通端点',()=>{
  const s=bridge(); s.grid[26]=201; s.grid[0]=101;
  assert.equal(architecture(s).assess(24).tactical,false);
});
test('孤立或雾中队友锚点不能提供已证连通价值',()=>{
  for(const key of ['isolated','fog']) {const s=bridge();s[key]=Array(35).fill(false);s[key][27]=true;
    assert.equal(architecture(s).assess(24).tactical,false);}
});
test('两侧多股可达敌军叠加而非只取最强一股',()=>{
  const s=state();s.turn=100;s.grid[12]=51;s.army[12]=110;
  s.grid[13]=2;s.army[13]=30;s.grid[11]=2;s.army[11]=30;
  assert.equal(chooseBuild(s),null);
});
test('己方未调援军不作为贴脸升级的保证',()=>{
  const s=state();s.turn=100;s.grid[12]=51;s.army[12]=60;
  s.grid[13]=2;s.army[13]=40;s.grid[11]=101;s.army[11]=900;
  assert.equal(architecture(s).assess(12).crownSafe,false);
});
test('未知可达后排不能凭隐藏兵数证明皇冠安全',()=>{
  const s=bridge();s.grid[24]=51;s.army[24]=1000;s.fog=Array(35).fill(false);s.fog[3]=true;
  assert.equal(chooseBuild(s,null,bridgeParams),null);
  s.army[3]=0;assert.equal(chooseBuild(s,null,bridgeParams),null);
});
test('预算耗尽拒绝投资且结果可重复',()=>{
  const s={n:1,m:200001,playerId:1,grid:Array(200001).fill(1),army:Array(200001).fill(1)};
  s.army[0]=200;const risk=architecture(s).assess(0);
  assert.equal(risk.complete,false);assert.equal(risk.crownSafe,false);
});

test('中后期20地单皇冠至少投资第二个皇冠，完成后停止',()=>{
  const s=state();s.turn=560;s.grid[12]=51;s.army[12]=58;
  const p={territoryPerCrown:40};
  assert.equal(chooseBuild(s,{reason:'斩首（远程）'},p).op,'c');
  s.grid[12]=101;s.army[12]-=50;s.grid[13]=51;s.army[13]=100;
  assert.equal(chooseBuild(s,null,p),null);
});

test('已有后方塔时不在旁边开新塔项目',()=>{const s=state();s.grid[11]=51;s.army[11]=5;s.army[12]=200;assert.equal(chooseBuild(s,null,{territoryPerCrown:6,maxCrowns:4}),null);});
test('安全富裕大图皇冠目标突破20且仅受安全资金限制',()=>{
 const {crownTarget}=require('../bot/building.cjs'),{DEFAULT_PARAMS:p}=require('../bot/params.cjs');
 const s={n:20,m:20,playerId:1,grid:Array(400).fill(1),army:Array(400).fill(20),teams:new Map(),turn:560};s.grid[0]=101;
 assert.ok(crownTarget(400,560,p,s)>6);
 assert.ok(crownTarget(400,560,{...p,maxCrowns:7},s)>20);
 s.army.fill(1);assert.ok(crownTarget(400,560,p,s)<=2);
});
test('同样大地图近敌边境不计作安全扩产基地',()=>{
 const {crownTarget}=require('../bot/building.cjs'),{DEFAULT_PARAMS:p}=require('../bot/params.cjs');
 const s={n:20,m:20,playerId:1,grid:Array.from({length:400},(_,i)=>i%3?1:2),army:Array(400).fill(20),teams:new Map(),turn:560};s.grid[1]=101;
 assert.ok(crownTarget(266,560,p,s)<=2);
});
