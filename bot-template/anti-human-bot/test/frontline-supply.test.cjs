'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chooseAction}=require('../bot/policy.cjs');
const {chooseLogistics,getSupplyBatch}=require('../bot/logistics.cjs');
function board(){return {n:1,m:8,playerId:1,turn:101,grid:[101,1,1,1,1,1,1,2],army:[1600,1,1,1,1,1,2000,3000],isolated:Array(8).fill(0),fog:Array(8).fill(false),teams:new Map([[1,1],[2,2]])};}
function execute(s,a){
 const from=a.y,to=a.dy;
 // 本fixture仅一维已知领土，保留真实智能分兵公式及增长先于行动。
 s.turn++;for(let i=0;i<s.m;i++)if(s.grid[i]===101)s.army[i]++;
 let reserve=0;for(const v of [from-1,from+1])if(v>=0&&v<s.m&&v!==to&&s.grid[v]%50!==1)reserve+=s.army[v]-1;
 const theoretical=Math.max(0,s.army[from]-reserve-1),cap=s.army[from]-1;
 const pushed=Math.min(cap,a.mode===2?cap:a.mode===1?Math.floor(theoretical/2):theoretical);
 assert.ok(pushed>0);s.army[from]-=pushed;
 if(s.grid[to]%50===1)s.army[to]+=pushed;
 else {assert.ok(pushed>s.army[to]);s.army[to]=pushed-s.army[to];s.grid[to]=1;}
 s.lastMove={op:'m',x:0,y:from,dx:0,dy:to,turn:s.turn};
}
test('2000对3000、近三格无兵：无需总量1.4倍或敌皇冠，启用远方1600',()=>{
 const s=board(),a=chooseAction(s);assert.ok(a);assert.equal(a.y,0);assert.equal(a.dy,1);
 assert.equal(a.reason.code,'frontline-supply');
});
test('缺兵连续六步从后方运输到前线，第七步出击，不让前线2000徘徊',()=>{
 const s=board();for(let i=0;i<6;i++){
  const a=chooseAction(s);assert.ok(a);assert.equal(a.y,i);assert.equal(a.dy,i+1);
  assert.equal(a.reason.code,'frontline-supply');execute(s,a);
  if(i<5)assert.equal(s.army[6],2000);
 }
 const attack=chooseAction(s);assert.ok(attack);assert.equal(attack.y,6);assert.equal(attack.dy,7);execute(s,attack);
 assert.equal(s.grid[7],1);
});
test('后方暂时不够填满缺口也先运有效兵，不等总兵力优势',()=>{
 const s=board();s.army[0]=500;const a=chooseAction(s);assert.equal(a.y,0);assert.equal(a.dy,1);
});
test('近处微量兵不能永远抢占远方有效运输',()=>{
 const s=board();s.army[4]=5;const a=chooseAction(s);assert.equal(a.y,0);
});
test('近处有效来源仍先用，随后继续远调',()=>{
 const s=board();s.army[4]=300;let a=chooseAction(s);assert.equal(a.y,4);execute(s,a);
 a=chooseAction(s);assert.equal(a.y,5);execute(s,a);
 a=chooseAction(s);assert.equal(a.y,0);
});
test('缺口补给遵守禁行边，不能提交已知被guard禁止的动作',()=>{
 const s=board();assert.equal(chooseLogistics(s,null,null,{militaryOnly:true,blockedEdges:new Set(['0:1'])}),null);
});
test('最短边被禁时沿己方较长路径继续送兵',()=>{
 const s={n:2,m:5,turn:101,playerId:1,grid:[101,1,1,1,2,1,1,1,1,201],army:[1600,1,1,2000,3000,1,1,1,1,0],isolated:Array(10).fill(0),teams:new Map([[1,1],[2,2]])};
 const a=chooseLogistics(s,null,null,{militaryOnly:true,blockedEdges:new Set(['0:1'])});
 assert.ok(a);assert.equal(a.x,0);assert.equal(a.y,0);assert.equal(a.dx,1);assert.equal(a.dy,0);
});
test('候选没执行不消耗补给配额，也不虚构运输进展',()=>{
 const s=board();const a=chooseAction(s);s.turn++;const b=chooseAction(s);
 assert.equal(a.y,b.y);assert.equal(a.dy,b.dy);assert.equal(b.reason.code,'frontline-supply');
});

const supply=s=>chooseLogistics(s,null,null,{militaryOnly:true});
test('一轮预算约3300：近源到账能打一格仍继续远源，预算不逐tick增长',()=>{
 const s=board();s.army[4]=1100;
 let a=supply(s);const required=a.reason.batch.required;
 assert.equal(required,3300);assert.deepEqual(getSupplyBatch(s),{target:6,required,active:true});
 assert.equal(a.y,4);execute(s,a);a=supply(s);assert.equal(a.y,5);execute(s,a);
 assert.ok(s.army[6]>3002);assert.ok(s.army[6]<required);
 for(let i=0;i<6;i++){
  a=supply(s);assert.ok(a);assert.equal(a.y,i);assert.equal(a.reason.batch.required,required);
  assert.equal(a.reason.forecast.required,required);execute(s,a);
 }
 assert.equal(supply(s),null);assert.equal(getSupplyBatch(s),null);
});
test('局部巨量后援及观测增长不使本轮预算无限膨胀',()=>{
 const s=board();s.m=10;s.grid.push(2,2);s.army.push(100000,100000);s.fog.push(false,false);s.isolated.push(0,0);
 const a=supply(s);assert.ok(a.reason.batch.required<=3450);
 s.turn++;s.army[7]+=10000;s.army[8]+=100000;
 const b=supply(s);assert.equal(b.reason.batch.required,a.reason.batch.required);
});
test('预算16tick到期让行，候选未执行不会永久锁住',()=>{
 const s=board();const a=supply(s);
 s.turn+=15;assert.equal(supply(s).reason.batch.required,a.reason.batch.required);
 s.turn++;assert.equal(supply(s),null);assert.equal(getSupplyBatch(s),null);
 s.turn++;assert.ok(supply(s));
});
test('目标失效、无有效来源、回合倒退均清理旧批次',()=>{
 for(const change of [s=>{s.grid[7]=1;},s=>{s.army[0]=1;},s=>{s.grid[6]=2;}]){
  const s=board();assert.ok(supply(s));change(s);s.turn++;
  assert.equal(supply(s),null);assert.equal(getSupplyBatch(s),null);
 }
 const s=board();supply(s);s.turn=80;s.army[7]=4000;
 assert.equal(getSupplyBatch(s),null);assert.equal(supply(s).reason.batch.required,4400);
});
test('每步重算禁行边，无动作不公开active批次',()=>{
 const s=board();assert.ok(supply(s));
 assert.equal(chooseLogistics(s,null,null,{militaryOnly:true,blockedEdges:new Set(['0:1'])}),null);
 assert.equal(getSupplyBatch(s),null);
});

test('统一策略已开始预算后不因小批到账刚过敌守军就提前出击',()=>{
 const s=board();s.army[0]=800;s.army[5]=1100;
 const first=chooseAction(s);assert.equal(first.y,5);execute(s,first);
 assert.ok(s.army[6]>3000 && s.army[6]<3300);
 const next=chooseAction(s);assert.equal(next.reason.code,'frontline-supply');assert.equal(next.y,0);
 assert.equal(next.reason.batch.required,3300);
});
test('原本能攻击时不新开预算阻止当下进攻',()=>{
 const s=board();s.army[6]=3100;s.army[0]=800;
 const a=chooseAction(s);assert.equal(a.y,6);assert.equal(a.dy,7);
});
