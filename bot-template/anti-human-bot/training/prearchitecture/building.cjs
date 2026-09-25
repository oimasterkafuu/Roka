'use strict';
const { resolveParams } = require('./params.cjs');
const urgent = move => move && /防守|守主城|斩首|清除.*威胁|回收孤军|打通孤军/.test(move.reason);
function chooseBuild(state, move, params = {}) {
  if (!state || state.ended || state.dead || urgent(move)) return null;
  const { n, m, grid, army, playerId: me, teams } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const p = resolveParams(params);
  const owner = code => code > 0 && code < 200 ? code % 50 : 0;
  const owners = Array.from(grid, owner);
  const team = teams instanceof Map ? teams.get(me) : undefined;
  const allied = id => id === me || (id > 0 && team > 0 && teams.get(id) === team);
  const count = i => Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0;
  const unknown = i => state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  const adjacent = i => {
    const out = [];
    if (i >= m) out.push(i-m);
    if (i % m) out.push(i-1);
    if (i % m + 1 < m) out.push(i+1);
    if (i+m < size) out.push(i+m);
    return out;
  };
  let land = 0, crowns = 0, cities = 0;
  const threats = [], candidates = [];
  for (let i=0;i<size;i++) {
    if (owners[i] === me && !state.isolated?.[i]) {
      land++;
      if (grid[i] === me+100) crowns++;
      if (grid[i] === me+50) cities++;
      if ((grid[i] === me || grid[i] === me+50) && count(i) >= 50 && !unknown(i)) candidates.push(i);
    }
    if (unknown(i) || (owners[i] && !allied(owners[i]) && !state.isolated?.[i])) threats.push(i);
  }
  const target = Math.min(Math.floor(p.maxCrowns), 1 + Math.floor(land / p.territoryPerCrown));
  if (crowns >= target || !candidates.length) return null;
  const neighbors = Array.from({length:size}, (_, i) => adjacent(i));
  // 多源最短路径场，不把隔山的曼哈顿近邻误判成贴脸敌人。
  // 雾障碍作为不确定边界发出威胁，但已知山脉绝不传播。
  const distance = new Int32Array(size).fill(-1), power = new Float64Array(size);
  const queue = [];
  for (const i of threats) {
    if (grid[i] === 201) continue;
    distance[i] = 0; power[i] = unknown(i) ? 20 : Math.max(0, count(i)-1); queue.push(i);
  }
  for (let head=0;head<queue.length;head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (grid[j] === 201 || (allied(owners[j]) && owners[j] !== me)) continue;
      if (distance[j] < 0) { distance[j] = distance[i]+1; power[j] = power[i]; queue.push(j); }
      else if (distance[j] === distance[i]+1) power[j] = Math.max(power[j], power[i]);
    }
  }
  const turn = Number.isFinite(state.turn) ? Math.max(0,state.turn) : 1;
  let best = null;
  for (const i of candidates) {
    const upgrade = grid[i] === me+50;
    // 现有指挥所属于待完成产能，不无限重复铺设不会每 tick 增长的建筑。
    if (!upgrade && crowns + cities >= target) continue;
    const near = neighbors[i];
    const support = near.reduce((sum,j) => sum + (owners[j] === me && !state.isolated?.[j] && !unknown(j) ? Math.max(0,count(j)-1) : 0),0);
    const d = distance[i] < 0 ? Infinity : distance[i];
    const exposed = near.filter(j => grid[j] !== 201 && !allied(owners[j])).length;
    const adjacentThreat = near.reduce((sum,j) => sum + (unknown(j) ? 20 : owners[j] && !allied(owners[j]) && !state.isolated?.[j] ? Math.max(0,count(j)-1) : 0),0);
    const arrival = d; // 每 tick 至多前进一格，保守地忽略途中攻占损耗。
    const incoming = Math.max(adjacentThreat, Number.isFinite(d) ? power[i] * Math.min(1,p.enemyDistance / Math.max(1,d)) : 0);
    const after = count(i)-50;
    const growthBeforeAttack = upgrade && Number.isFinite(arrival) ? Math.max(0,arrival-1) : 0;
    // 贴脸威胁不能依赖尚未调到的友军；远处可以计入部分可调援军。
    const reinforcement = d <= 1 ? 0 : support*p.supportWeight;
    const reserve = p.buildSafety + incoming*p.threatWeight;
    if (after + growthBeforeAttack + reinforcement < reserve) continue;
    // 指挥所本身不增加常态产能，必须预计能筹齐第二次50兵。
    const funding = after + support*p.supportWeight - reserve;
    if (!upgrade && funding < 50) continue;
    const fundingDelay = upgrade ? 0 : 1 + Math.max(0,50-after+reserve)/Math.max(1,crowns);
    const burstLoss = !upgrade ? Math.max(0, 50-Math.max(25,turn)) : 0;
    const payback = (upgrade ? 50 : 100) / 0.98 + fundingDelay + burstLoss;
    const stage = 1 + (p.earlyInvestment-1)*Math.max(0,1-turn/200);
    const productionNeed = Math.max(0,target-crowns-cities*0.5)/Math.max(1,crowns);
    const horizon = p.investmentHorizon;
    const safety = Number.isFinite(d) ? Math.min(20,d-p.enemyDistance)*2-exposed*3 : 20;
    const score = (horizon-payback)*p.paybackWeight*stage + productionNeed*15 + safety +
      (upgrade ? p.upgradeBonus : 0) - incoming + Math.min(20,after-reserve)*0.2;
    if (score < p.buildThreshold) continue;
    if (!best || score > best.score) best = {x:Math.floor(i/m),y:i%m,op:upgrade?'c':'b',
      reason:upgrade?'可守住且预计回本：升级主城':'可守住且升级资金可筹：建造指挥所',score};
  }
  if (!best) return null;
  const {score, ...action} = best;
  return action;
}
module.exports = { chooseBuild };
