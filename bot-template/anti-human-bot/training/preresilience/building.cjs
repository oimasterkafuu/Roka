'use strict';
const { architecture } = require('./architecture.cjs');
const urgent = move => move && (move.urgent === true || /防守|守主城|守城|斩首|清除.*威胁|回收孤军|打通孤军|defen|decap|emergency/i.test(
  typeof move.reason === 'string' ? move.reason : JSON.stringify(move.reason || {})));
function chooseBuild(state, move, params = {}) {
  if (!state || state.ended || state.dead || urgent(move)) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const context = architecture(state, params), { own, count, assess, params: p } = context;
  let land = 0, crowns = 0, cities = 0;
  const candidates = [];
  for (let i = 0; i < size; i++) if (own(i)) {
    land++;
    if (grid[i] === me + 100) crowns++;
    if (grid[i] === me + 50) cities++;
    if ((grid[i] === me || grid[i] === me + 50) && count(i) >= 50) candidates.push(i);
  }
  const target = Math.min(Math.floor(p.maxCrowns), 1 + Math.floor(land / p.territoryPerCrown));
  const turn = Number.isFinite(state.turn) ? Math.max(0, state.turn) : 1;
  let best = null;
  // 先完成已有产能，避免大量普通候选用尽共享评估预算。
  candidates.sort((a,b) => (grid[b] === me+50) - (grid[a] === me+50) || count(b)-count(a) || a-b);
  for (const i of candidates) {
    const upgrade = grid[i] === me + 50, risk = assess(i);
    const economic = crowns < target && (upgrade ? risk.crownSafe :
      crowns + cities < target && risk.foundationSafe);
    let score, reason;
    if (economic) {
      const burstLoss = upgrade ? 0 : Math.max(0, 50 - Math.max(25, turn));
      const payback = (upgrade ? 50 : 100) / 0.98 + (upgrade ? 0 : 1) + burstLoss;
      const stage = 1 + (p.earlyInvestment - 1) * Math.max(0, 1-turn/200);
      score = (p.investmentHorizon-payback)*p.paybackWeight*stage +
        Math.max(0,target-crowns-cities*0.5)/Math.max(1,crowns)*15 +
        (upgrade ? p.upgradeBonus : 0) + 20 - Math.min(20, risk.incoming);
      if (score < p.buildThreshold) continue;
      // 同时可建低风险皇冠时，经济用途优先于减损塔。
      score += 1000;
      reason = upgrade ? '可守住且预计回本：升级主城' : '后方两阶段资金充足：建造指挥所待升级主城';
    } else {
      if (upgrade || !risk.towerSafe || risk.crownSafe) continue;
      score = 30 + risk.anchorGroups * 10;
      reason = '团队锚点瓶颈：建造减损指挥塔，风险消退前不升级';
    }
    if (!best || score > best.score) best = { x: Math.floor(i/m), y: i%m, op: upgrade ? 'c' : 'b', reason, score };
  }
  if (!best) return null;
  const { score, ...action } = best;
  return action;
}
module.exports = { chooseBuild };
