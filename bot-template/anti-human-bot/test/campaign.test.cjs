'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCampaign } = require('../bot/campaign.cjs');
function board({ n = 7, m = 7, turn = 60, blockedEdges, targetOwner = 2, threatened = false } = {}) {
  const size = n * m, grid = Array(size).fill(1), army = Array(size).fill(100);
  const at = (x, y) => x * m + y;
  grid[at(0, 3)] = 101; army[at(0, 3)] = 12;
  for (let y = 0; y < m; y++) { grid[at(1, y)] = 1; army[at(1, y)] = 15; }
  grid[at(1, 3)] = 1; army[at(1, 3)] = 24;
  // 1.4 倍门槛由大量己方有效兵满足；目标皇冠附近保持敌方阵营。
  for (let x = 2; x < n; x++) for (let y = 0; y < m; y++) { grid[at(x, y)] = 2; army[at(x, y)] = 2; }
  grid[at(n - 1, 3)] = 102; army[at(n - 1, 3)] = 5;
  return { n, m, turn, grid, army, playerId: 1, teams: new Map([[1, 1], [2, 2]]),
    blockedEdges, threatened, gameId: `${n}:${m}` };
}
function move(s, opts = {}) { return chooseCampaign(s, {}, opts); }

test('低于50tick不发动', () => assert.equal(move(board({ turn: 49 }), { targetOwner: 2 }), null));
test('急防优先返回null并清理目标', () => {
  const s = board(); assert.ok(move(s, { targetOwner: 2 }));
  assert.equal(move(s, { targetOwner: 2, threatened: true }), null);
});
test('第三方目标不会被自行挑选', () => assert.equal(move(board(), { targetOwner: 3 }), null));
test('不能攻击同队皇冠', () => { const s = board(); s.teams.set(2, 1); assert.equal(move(s, { targetOwner: 2 }), null); });
test('不可达皇冠返回null', () => { const s = board(); for (let x = 1; x < s.n; x++) s.grid[x * s.m + 3] = 201; assert.equal(move(s, { targetOwner: 2 }), null); });
test('blockedEdges阻止首段出击', () => {
  const s = board({ blockedEdges: new Set(['8:7']) });
  const a = move(s, { targetOwner: 2 });
  assert.ok(!a || !(a.x * s.m + a.y === 8 && a.dx * s.m + a.dy === 7));
});
test('动作始终是单步mode0且无kind', () => {
  const s = board(), a = move(s, { targetOwner: 2 }); assert.ok(a);
  assert.equal(a.mode, 0); assert.equal(a.kind, undefined); assert.equal(Math.abs(a.x-a.dx)+Math.abs(a.y-a.dy), 1);
});
test('reason为中文对象且不含kind', () => {
  const a = move(board(), { targetOwner: 2 }); assert.ok(a);
  assert.equal(typeof a.reason, 'object'); assert.equal(a.reason.kind, undefined); assert.match(a.reason.detail, /[\u4e00-\u9fff]/);
});
test('无严重威胁才考虑campaign', () => assert.ok(move(board(), { targetOwner: 2 })));
test('目标皇冠丢失后重置', () => {
  const s = board(); move(s, { targetOwner: 2 }); s.grid[45] = 2; assert.equal(move(s, { targetOwner: 2 }), null);
});
test('turn倒退视为新对局', () => {
  const s = board({ turn: 70 }); move(s, { targetOwner: 2 }); s.turn = 10; assert.equal(move(s, { targetOwner: 2 }), null);
});
test('增长耗时纳入forecast', () => {
  const s = board({ turn: 99 }); const a = move(s, { targetOwner: 2 });
  assert.ok(a); assert.ok(a.reason.forecast.enemyGrowth >= 1);
});
test('主城留守不被清空', () => {
  const s = board(); s.grid[1] = 101; s.army[1] = 4;
  const a = move(s, { targetOwner: 2 });
  assert.ok(!a || a.x * s.m + a.y !== 1);
});
test('强势时最终允许前进', () => {
  const s = board(); for(let i=0;i<s.army.length;i++) if(s.grid[i]===1)s.army[i]=300; s.army[0 * s.m + 3] = 2;
  const a = move(s, { targetOwner: 2 }); assert.ok(a); assert.ok(['gather', 'advance'].includes(a.reason.phase));
});
test('树调兵先叶后根：连续动作不会从根向叶', () => {
  const s = board(); const a = move(s, { targetOwner: 2 });
  assert.ok(a); assert.ok(a.y !== 3 || a.x !== 1 || a.dx !== 0);
});
test('对局标识变化会重置持续目标', () => {
  const s = board(); move(s, { targetOwner: 2 }); s.gameId = 'new-game'; assert.ok(move(s, { targetOwner: 2 }));
});

test('连续真实调兵从多个叶子向根汇合并最终发动攻击',()=>{
 const s=board(),sources=new Set();let advanced=false;
 for(let t=0;t<90;t++){
  const a=move(s,{targetOwner:2});assert.ok(a,'优势局不应中途卡住');
  if(a.reason.phase==='advance'){advanced=true;break;}
  const from=a.x*s.m+a.y,to=a.dx*s.m+a.dy;
  assert.ok(a.reason.distanceAfter<a.reason.distanceBefore);
  sources.add(from);for(let i=0;i<s.grid.length;i++)if(s.grid[i]===101||s.grid[i]===102)s.army[i]++;
  s.army[from]-=a.reason.amount;s.army[to]+=a.reason.amount;s.turn++;s.lastMove={...a,op:'m',turn:s.turn};
 }
 // 缺口补足即进攻，不再强制为了凑三个来源继续扩树。
 assert.ok(sources.size>=2);assert.ok(advanced);
});
test('大量2兵细枝不单独汇入，优先大源',()=>{const s=board();for(let i=0;i<s.grid.length;i++)if(s.grid[i]===1)s.army[i]=2;s.army[2]=180;const a=move(s,{targetOwner:2});assert.ok(a);assert.ok(a.reason.amount>10);assert.ok(a.reason.forecast.gatherTicks<20);});
test('皇冠只有1兵不因产能身份被搜刮',()=>{const s=board();s.army[0]=1;const a=move(s,{targetOwner:2});assert.ok(a);assert.notEqual(a.x*s.m+a.y,0);});
test('前线已够兵立即推进，不等后方树完成',()=>{const s=board();s.army[10]=3000;const a=move(s,{targetOwner:2});assert.ok(a);assert.equal(a.reason.phase,'advance');});
test('下一tick出现高收益新兵源时重算，不坚持旧分支',()=>{const s=board();const a=move(s,{targetOwner:2});assert.ok(a);s.turn++;const from=a.x*s.m+a.y;s.army[from]=1;s.army[from===6?0:6]=2000;const b=move(s,{targetOwner:2});assert.ok(b);assert.notEqual(b.x*s.m+b.y,from);});
test('已供兵源再次积累大量兵仍可参与滚动汇兵',()=>{const s=board();const a=move(s,{targetOwner:2});assert.ok(a);const i=a.x*s.m+a.y,j=a.dx*s.m+a.dy;s.turn++;s.lastMove={...a,op:'m',turn:s.turn};s.army[i]=3000;s.army[j]+=a.reason.amount;const b=move(s,{targetOwner:2});assert.ok(b);assert.ok(b.reason.amount>2);});

test('边界模式只预算下一格，前线足够立即进攻', () => {
  const s = board();
  s.army[10] = 150;
  const a = move(s, {targetOwner:2,boundaryAdvance:true});
  assert.ok(a); assert.equal(a.reason.phase,'advance');
  assert.equal(a.reason.forecast.movementTax,1);
  assert.equal(a.x,1);assert.equal(a.dx,2);
});

test('边界模式不抽走其他已接敌集群作为独立兵源', () => {
  const s=board();
  for(let y=0;y<s.m;y++)s.army[s.m+y]=10;
  const a=move(s,{targetOwner:2,boundaryAdvance:true});
  assert.ok(a);
  if(a.reason.phase==='gather')assert.equal(a.x,0);
});

// 单通道固定接敌点，远后方巨堆只负责满足优势门槛，不能压过近处兵源。
function supplyCorridor(crown = 7, nearArmy = 45) {
  const s = { n: 1, m: 10, turn: 60, playerId: 1, gameId: 'supply',
    grid: Array(10).fill(1), army: Array(10).fill(1) };
  s.grid[9] = 102; s.army[9] = 30;
  s.grid[crown] = 101; s.army[crown] = nearArmy;
  s.army[0] = 10000; s.army[8] = 2;
  return s;
}
const boundaryOptions = { targetOwner: 2, boundaryAdvance: true };
for (const depth of [1, 2, 3]) test(`边界模式${depth}步内皇冠优先于远处巨堆且够用即停止选源`, () => {
  const s = supplyCorridor(8 - depth);
  const a = move(s, boundaryOptions);
  assert.ok(a); assert.equal(a.reason.phase, 'gather');
  assert.equal(a.y, 8 - depth); assert.equal(a.dy, 9 - depth);
  assert.equal(a.reason.forecast.gatherTicks, depth, '不应把远源加入预算');
});

test('近皇冠真实供兵耗尽后才滚动启用远处补给', () => {
  const s = supplyCorridor(7, 12);
  const a = move(s, boundaryOptions);
  assert.ok(a); assert.equal(a.reason.phase, 'gather'); assert.equal(a.y, 7);
  s.army[7]++; s.army[9]++;
  s.army[7] -= a.reason.amount; s.army[8] += a.reason.amount;
  s.turn++; s.lastMove = { ...a, op: 'm', turn: s.turn };
  const b = move(s, boundaryOptions);
  assert.ok(b); assert.equal(b.reason.phase, 'gather'); assert.equal(b.y, 0); assert.equal(b.dy, 1);
});

test('近皇冠供兵足够后立即攻击，不为远源继续扩树', () => {
  const s = supplyCorridor();
  const a = move(s, boundaryOptions);
  assert.ok(a); assert.equal(a.y, 7);
  s.army[7]++; s.army[9]++;
  s.army[7] -= a.reason.amount; s.army[8] += a.reason.amount;
  s.turn++; s.lastMove = { ...a, op: 'm', turn: s.turn };
  const b = move(s, boundaryOptions);
  assert.ok(b); assert.equal(b.reason.phase, 'advance'); assert.equal(b.y, 8); assert.equal(b.dy, 9);
  assert.equal(b.reason.forecast.gatherTicks, 0);
});

test('边界模式FFA不因附近兵源改打第三方', () => {
  const s = supplyCorridor(); s.grid[1] = 103; s.army[1] = 1;
  assert.equal(move(s, { boundaryAdvance: true }), null);
  const a = move(s, boundaryOptions);
  assert.ok(a); assert.equal(a.reason.target, 9); assert.equal(a.y, 7);
});
