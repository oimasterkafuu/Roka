'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrontline } = require('../bot/frontline.cjs');
function board() {
  return { n:5,m:7,turn:60,playerId:1,grid:Array(35).fill(201),army:Array(35).fill(0),isolated:Array(35).fill(0),teams:new Map([[1,1],[2,2],[3,3]]) };
}
function put(s,i,g,a){s.grid[i]=g;s.army[i]=a;return s;}
const move = {x:2,y:2,dx:2,dy:3,mode:0}; //16->17
function basic(){const s=board();put(s,16,101,101);put(s,17,2,10);return s;}
test('安全边界半兵足够立即进攻，不等待更多兵',()=>{
 const s=basic(), f=createFrontline(s);assert.equal(f.assess(move).mode,1);assert.ok(f.choose());
});
test('按实际自动公式的一半算量，不能把mode1当作总量50%',()=>{
 const s=basic();put(s,15,2,80);put(s,17,2,30);
 assert.equal(createFrontline(s).assess(move),null);
});
test('两跳绕切威胁会阻止全军深入',()=>{
 const s=basic();put(s,17,2,70);put(s,15,200,0);put(s,14,2,60);
 assert.equal(createFrontline(s).assess(move),null);
});
test('孤立敌军不算可机动侧翼，但仍有目标防御',()=>{
 const s=basic();put(s,17,2,70);put(s,15,2,500);s.isolated[15]=1;
 assert.equal(createFrontline(s).assess(move).mode,2);
 s.isolated[15]=0;assert.equal(createFrontline(s).assess(move),null);
 s.isolated[17]=1;put(s,17,2,200);assert.equal(createFrontline(s).assess(move),null);
});
test('无侧翼风险且半兵不够时允许安全全冲',()=>{
 const s=basic();put(s,17,2,70);assert.equal(createFrontline(s).assess(move).mode,2);
});
test('保留来源兵可以抵挡两跳威胁时半兵推进',()=>{
 const s=basic();put(s,15,200,0);put(s,14,2,10);
 assert.equal(createFrontline(s).assess(move).mode,1);
});
test('服从FFA和禁行边',()=>{
 const s=basic();assert.equal(createFrontline(s,{allowedOwners:new Set([3])}).assess(move),null);
 assert.equal(createFrontline(s,{blockedEdges:new Set(['16:17'])}).assess(move),null);
});
test('友方安全内部运输改为全冲',()=>{
 const s=basic();put(s,17,1,10);assert.deepEqual(createFrontline(s).assess(move),{...move,mode:2,half:false});
});
test('孤立来源不能发动进攻',()=>{
 const s=basic();s.isolated[16]=1;assert.equal(createFrontline(s).assess(move),null);
});
test('目标皇冠先增长再战斗',()=>{
 const s=basic();put(s,16,1,101);put(s,17,102,100);
 assert.equal(createFrontline(s).assess(move),null);
});
test('多前线当帧选择可攻薄弱点，不等待另一军团',()=>{
 const s=basic();put(s,17,2,500);put(s,29,101,81);put(s,30,2,2);
 const a=createFrontline(s).choose();assert.ok(a);assert.equal(a.x*s.m+a.y,29);
});
test('后方窄补给链存在可被绕切弱点就不深入',()=>{
 const s=board();put(s,14,101,10);put(s,15,1,2);put(s,16,1,100);put(s,17,2,10);
 put(s,8,2,30);assert.equal(createFrontline(s).assess(move),null);
});
test('强兵且巩固补给后可以有限深入',()=>{
 const s=board();put(s,14,101,100);put(s,15,1,100);put(s,16,1,300);put(s,17,2,10);
 assert.ok(createFrontline(s).assess(move));
});
test('未知目标不盲目突击',()=>{
 const s=basic();s.fog=Array(35).fill(0);s.fog[17]=1;assert.equal(createFrontline(s).assess(move),null);
});

test('统一策略实际出口保留动态半兵而不是重新变回mode0',()=>{
 const {chooseAction}=require('../bot/policy.cjs');
 const s=basic();const a=chooseAction(s);assert.ok(a);assert.equal(a.mode,1);
});
test('统一策略不能从其他模块绕过两跳补给风险',()=>{
 const {chooseAction}=require('../bot/policy.cjs');
 const s=basic();put(s,17,2,70);put(s,15,200,0);put(s,14,2,60);
 const a=chooseAction(s);
 assert.ok(!a || a.dx*s.m+a.dy!==17);
});

test('75万前线对3万敌军：后方弱连接不再一票否决半兵攻击',()=>{
 const s=board();s.turn=501;
 put(s,14,101,40000);put(s,15,1,2);put(s,16,1,750000);
 put(s,17,2,10000);put(s,8,2,20000);
 const {chooseAction}=require('../bot/policy.cjs');
 const a=chooseAction(s);assert.ok(a);assert.equal(a.kind,'attack');
 assert.equal(a.x*s.m+a.y,16);assert.equal(a.dx*s.m+a.dy,17);assert.equal(a.mode,1);
});

test('优势前沿连续有机会就连续攻击，不被建设周期或后方集兵抢占',()=>{
 const {chooseAction}=require('../bot/policy.cjs');
 const s={n:1,m:8,turn:501,playerId:1,grid:[101,1,1,2,2,2,2,102],
  army:[1000,2,750000,5000,5000,5000,5000,10000],isolated:Array(8).fill(0),teams:new Map([[1,1],[2,2]])};
 let captures=0;
 for(let t=0;t<4;t++){
  const a=chooseAction(s);assert.ok(a);assert.equal(a.kind,'attack');
  const from=a.y,to=a.dy;assert.equal(s.grid[to]%50,2);
  let reserve=0;for(const v of [from-1,from+1])if(v>=0&&v<8&&v!==to&&s.grid[v]%50!==1)reserve+=s.army[v]-1;
  const theoretical=Math.max(0,s.army[from]-reserve-1),cap=s.army[from]-1;
  const push=a.mode===2?cap:Math.min(cap,a.mode===1?Math.floor(theoretical/2):theoretical);
  assert.ok(push>s.army[to]);s.army[from]-=push;s.army[to]=push-s.army[to];s.grid[to]=1;
  s.turn++;s.lastMove={op:'m',x:0,y:from,dx:0,dy:to,turn:s.turn};captures++;
 }
 assert.equal(captures,4);
});

test('敌能反击夺回目标但源点与补给安全时仍然攻击交换',()=>{
 const s=basic();put(s,16,101,1401);put(s,17,2,300);put(s,18,2,600);
 const a=createFrontline(s).assess(move);assert.ok(a);assert.equal(a.mode,1);assert.match(a.reason,/边界交换/);
});
test('安全己方内部整批运输不做半兵或自动分兵',()=>{
 const s=basic();put(s,17,1,10);
 for(const mode of [0,1]) { const a=createFrontline(s).assess({...move,mode});assert.equal(a.mode,2);assert.equal(a.half,false); }
});
test('目的地己方不代表内部：源皇冠受威胁仍保留留守分兵',()=>{
 const s=basic();put(s,17,1,10);put(s,15,2,50);
 const a=createFrontline(s).assess({...move,mode:1});assert.equal(a.mode,1);
});

test('目标后面敌军远强于我但必须经过目标才能反击，不伪装成切源威胁',()=>{
 const s=basic();put(s,16,101,1001);put(s,17,2,10);put(s,18,2,10000);
 const a=createFrontline(s).assess(move);assert.ok(a);assert.equal(a.mode,1);
});
test('敌后援真能经侧路绕切时仍保护源点，而非全面取消安全',()=>{
 const s=basic();put(s,16,101,1001);put(s,17,2,10);put(s,18,2,10000);
 put(s,9,200,0);put(s,10,2,10000);
 assert.equal(createFrontline(s).assess(move),null);
});

test('相邻可攻皇冠不因后链弱连接和巨量目标后援而挂起',()=>{
 const s=board();s.turn=1200;
 put(s,14,101,50000);put(s,15,1,2);put(s,16,1,2000);put(s,17,102,300);
 put(s,8,2,100);put(s,18,2,10000);
 const {chooseAction}=require('../bot/policy.cjs');const a=chooseAction(s);
 assert.ok(a);assert.equal(a.y,2);assert.equal(a.dy,3);assert.match(a.reason,/直接攻冠/);
});
test('直接攻冠仍须算增长，不能以等兵力当作可捕获',()=>{
 const s=basic();put(s,16,1,102);put(s,17,102,100);
 assert.equal(createFrontline(s).assess(move),null);
});
test('未知侧翼不否决当前可捕获的可见皇冠',()=>{
 const s=basic();put(s,16,1,200);put(s,17,102,100);s.fog=Array(35).fill(false);s.fog[9]=true;
 assert.ok(createFrontline(s).assess(move));
});
test('不能为攻一座敌皇冠抽空当下受威胁的己方皇冠',()=>{
 const s=basic();put(s,16,101,200);put(s,17,102,150);put(s,15,2,100);
 assert.equal(createFrontline(s).assess(move),null);
});
test('攻冠被拒返回数值诊断而不是只有空动作',()=>{
 const s=basic();put(s,16,1,50);put(s,17,102,100);const f=createFrontline(s);assert.equal(f.choose(),null);
 assert.ok(f.diagnostics.rejected['攻冠兵力不足']);assert.equal(f.diagnostics.examples[0].defense,101);
});
test('完整策略最小复现：敌皇冠后面未知不导致空动作',()=>{
 const s={n:1,m:3,turn:1260,playerId:1,grid:[101,102,202],army:[100,70,0],isolated:[0,0,0],fog:[0,0,1],teams:new Map([[1,1],[2,2]])};
 const {chooseAction}=require('../bot/policy.cjs');const a=chooseAction(s);
 assert.ok(a);assert.equal(a.kind,'attack');assert.equal(a.y,0);assert.equal(a.dy,1);
});
test('源点分兵相关邻格未知时攻冠用出兵量确定的全冲',()=>{
 const s=basic();put(s,16,1,200);put(s,17,102,100);s.fog=Array(35).fill(false);s.fog[9]=true;
 assert.equal(createFrontline(s).assess(move).mode,2);
});
test('直接攻冠不越过FFA、禁行边与孤立源点限制',()=>{
 const s=basic();put(s,17,102,10);
 assert.equal(createFrontline(s,{allowedOwners:new Set([3])}).assess(move),null);
 assert.equal(createFrontline(s,{blockedEdges:new Set(['16:17'])}).assess(move),null);
 s.isolated[16]=1;assert.equal(createFrontline(s).assess(move),null);
});
