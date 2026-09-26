'use strict';
const { architecture } = require('./architecture.cjs');
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

// 紧急防守让行；但经济落后（建造竞赛落后）时不再无条件让行——
// 「敌人已经建了一圈皇冠」本身就是紧急情况。
function urgent(state, move) {
  if (!move) return false;
  if (move.urgent === true || /防守|守主城|守城|清除.*威胁|回收孤军|打通孤军|defen|emergency/i.test(
    typeof move.reason === 'string' ? move.reason : JSON.stringify(move.reason || {}))) return true;
  const { n, m, grid, army, playerId: me } = state;
  const { x, y, dx, dy } = move;
  if (!grid || !army || (move.kind && move.kind !== 'attack') ||
      ![x, y, dx, dy].every(Number.isInteger) || x < 0 || x >= n || dx < 0 || dx >= n ||
      y < 0 || y >= m || dy < 0 || dy >= m || Math.abs(x - dx) + Math.abs(y - dy) !== 1) return false;
  const from = x * m + y, to = dx * m + dy;
  const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);
  const team = state.teams instanceof Map ? state.teams.get(me) : state.teams?.[me];
  const allied = (id) => id === me || (team > 0 && (state.teams instanceof Map ? state.teams.get(id) : state.teams?.[id]) === team);
  const unknown = (i) => state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  if (owner(grid[from]) !== me || state.isolated?.[from] || unknown(from) || unknown(to) ||
      grid[to] < 101 || grid[to] > 149 || allied(owner(grid[to]))) return false;
  const ns = [];
  if (x) ns.push(from - m); if (y) ns.push(from - 1);
  if (x + 1 < n) ns.push(from + m); if (y + 1 < m) ns.push(from + 1);
  let reserve = 0;
  for (const j of ns) if (j !== to && grid[j] !== 201 && grid[j] !== 203 && !allied(owner(grid[j])))
    reserve += unknown(j) ? 2 : Math.max(0, army[j] || 0) - 1;
  const total = Math.max(0, army[from] || 0);
  let amount = Math.min(total - 1, Math.max(0, total - reserve - 1));
  const mode = move.mode ?? (move.half ? 1 : 0);
  if (mode === 1) amount = Math.floor(amount / 2);
  if (mode === 2) amount = total - 1;
  return amount > (army[to] || 0) + 1;
}

// 目标皇冠数：由地皮决定的基线，叠加建造竞赛追赶目标。
function crownTarget(land, turn, p, state) {
  const base = Math.max(1 + Math.floor(land / p.territoryPerCrown), land >= 20 && turn >= 100 ? 2 : 1);
  if (!state) return base;
  const ctx = createContext(state, p);
  if (!ctx) return base;
  const race = ctx.race;
  let target = base;
  let safeLand = 0, surplus = 0;
  for (let i = 0; i < ctx.size; i++) {
    if (!ctx.own(i)) continue;
    const far = ctx.enemyDistance[i] < 0 || ctx.enemyDistance[i] >= 5;
    if (!far) continue;
    safeLand++;
    surplus += Math.max(0, ctx.army[i] - 4);
  }
  const potential = Math.min(safeLand + race.myCrowns + race.myCities, Math.max(base, race.myCrowns + Math.floor(surplus / 110)));
  target = Math.max(target, potential);
  if (race.behind) target = Math.max(target, race.bestCrowns + 1);
  return Math.max(1, Math.min(target, Math.max(1, Math.floor(land / 3))));
}

function clusterValue(state, i) {
  const { m, n, grid, playerId: me } = state, x = Math.floor(i / m), y = i % m;
  let near = 0, adj = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const d = Math.abs(dx) + Math.abs(dy), a = x + dx, b = y + dy;
    if (!d || d > 3 || a < 0 || b < 0 || a >= n || b >= m) continue;
    if (grid[a * m + b] === me + 100) { near++; if (d === 1) adj++; }
  }
  return Math.min(near, 3) * 9 + Math.min(adj, 2) * 6 - Math.max(0, near - 5) * 12;
}

function chooseBuild(state, move, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const context = architecture(state, params), { own, count, assess, params: p } = context;
  const race = context.race || { behind: false, deficit: 0, myCrowns: 0, myCities: 0, bestCrowns: 0 };
  // 经济落后时建筑优先级高到可以压过普通的防守/清威胁动作；不落后时仍然让行。
  if (!race.behind && urgent(state, move)) return null;
  const turn = Number.isFinite(state.turn) ? Math.max(0, state.turn) : 1;
  let land = 0, crowns = 0, cities = 0;
  const candidates = [];
  for (let i = 0; i < size; i++) if (own(i)) {
    land++;
    if (grid[i] === me + 100) crowns++;
    if (grid[i] === me + 50) cities++;
    if ((grid[i] === me || grid[i] === me + 50) && count(i) >= (race.behind ? 40 : 50)) candidates.push(i);
  }
  const target = crownTarget(land, turn, p, state);
  const unfinished = [];
  for (let i = 0; i < size; i++) if (own(i) && grid[i] === me + 50 && !state.isolated?.[i]) unfinished.push(i);
  // 竞赛落后时允许并行开两个工地；平时串行，避免兵力被摊薄。
  const maxSites = race.behind ? 2 : 1;
  const canFound = unfinished.length < maxSites;
  let best = null;
  candidates.sort((a, b) => (grid[b] === me + 50) - (grid[a] === me + 50) || count(b) - count(a) || a - b);
  for (const i of candidates) {
    const upgrade = grid[i] === me + 50;
    const risk = assess(i);
    if (!risk.complete) continue;
    // 追赶期允许在已有工地旁继续铺点（产能优先），平时避免把资金摊成一片半成品。
    const adjacentTower = context.neighbors[i].some((j) => own(j) && grid[j] === me + 50);
    if (!upgrade && adjacentTower && !race.behind) continue;
    const room = crowns + cities < target;
    const economic = upgrade ? crowns < target && risk.crownSafe
      : room && canFound && risk.foundationSafe;
    let score, reason;
    if (economic) {
      const burstLoss = upgrade ? 0 : Math.max(0, 50 - Math.max(25, turn));
      const payback = (upgrade ? 50 : 100) / 0.98 + (upgrade ? 0 : 1) + burstLoss;
      const stage = 1 + (p.earlyInvestment - 1) * Math.max(0, 1 - turn / 200);
      // 落后越多，建设意愿越强；这是「敌人已经建了一圈皇冠」时的主动追赶。
      const deficitBonus = race.behind ? (race.deficit + 1) * 22 * p.raceAggression : 0;
      score = (p.investmentHorizon - payback) * p.paybackWeight * stage +
        Math.max(0, target - crowns - cities * 0.5) / Math.max(1, crowns) * 15 +
        (upgrade ? p.upgradeBonus : 0) + 20 - Math.min(20, risk.incoming) + deficitBonus;
      if (score < p.buildThreshold) continue;
      score += 1000 + clusterValue(state, i);
      reason = upgrade ? '升级主城（含竞赛追赶权重）' : '后方资金到位：建造指挥所待升级主城';
    } else {
      if (upgrade || !risk.towerSafe || risk.crownSafe) continue;
      score = 30 + risk.anchorGroups * 10;
      reason = '团队锚点瓶颈：建造减损指挥塔，风险消退前不升级';
    }
    if (!best || score > best.score) best = { x: Math.floor(i / m), y: i % m, op: upgrade ? 'c' : 'b', reason, score };
  }
  if (!best) return null;
  const { score, ...action } = best;
  return action;
}
module.exports = { chooseBuild, urgent, crownTarget, clusterValue };
