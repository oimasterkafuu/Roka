'use strict';
const { architecture } = require('./architecture.cjs');
// 紧急防守明确让行；远程路径上的“斩首”文字不等于本手能夺城。
function urgent(state, move) {
  if (!move) return false;
  if (move.urgent === true || /防守|守主城|守城|清除.*威胁|回收孤军|打通孤军|defen|emergency/i.test(
    typeof move.reason === 'string' ? move.reason : JSON.stringify(move.reason || {}))) return true;
  const { n, m, grid, army, playerId: me } = state;
  const { x, y, dx, dy } = move;
  if (!grid || !army || (move.kind && move.kind !== 'attack') ||
      ![x,y,dx,dy].every(Number.isInteger) || x < 0 || x >= n || dx < 0 || dx >= n ||
      y < 0 || y >= m || dy < 0 || dy >= m || Math.abs(x-dx)+Math.abs(y-dy) !== 1) return false;
  const from=x*m+y, to=dx*m+dy;
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const team=state.teams?.get(me);
  const allied = id => id === me || (team > 0 && state.teams?.get(id) === team);
  const unknown = i => state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  if (owner(grid[from]) !== me || state.isolated?.[from] || unknown(from) || unknown(to) ||
      grid[to] < 101 || grid[to] > 149 || allied(owner(grid[to]))) return false;
  const ns=[];
  if(x) ns.push(from-m); if(y) ns.push(from-1);
  if(x+1<n) ns.push(from+m); if(y+1<m) ns.push(from+1);
  let reserve=0;
  for(const j of ns) if(j!==to && grid[j]!==201 && grid[j]!==203 && !allied(owner(grid[j])))
    reserve += unknown(j) ? 2 : Math.max(0, army[j] || 0)-1;
  const total=Math.max(0, army[from] || 0);
  let amount=Math.min(total-1, Math.max(0,total-reserve-1));
  const mode=move.mode ?? (move.half ? 1 : 0);
  if(mode===1) amount=Math.floor(amount/2);
  if(mode===2) amount=total-1;
  return amount > (army[to] || 0) + 1;
}
function crownTarget(land, turn, p, state) {
  if (state && land >= 60 && turn >= 100) {
    const {grid,army,m,n,playerId:me}=state;
    const owner=c=>c>0&&c<200?c%50:0;
    const team=state.teams?.get(me);
    const hostile=id=>id>0&&id!==me&&!(team>0&&state.teams?.get(id)===team);
    const dist=new Int32Array(grid.length).fill(-1),q=[];
    let crowns=0;
    for(let i=0;i<grid.length;i++) {if(grid[i]===me+100)crowns++;if(hostile(owner(grid[i]))||state.fog?.[i]){dist[i]=0;q.push(i);}}
    for(let h=0;h<q.length;h++){const i=q[h];if(dist[i]>=5)continue;const ns=[];if(i>=m)ns.push(i-m);if(i%m)ns.push(i-1);if(i%m+1<m)ns.push(i+1);if(i+m<n*m)ns.push(i+m);for(const j of ns)if(dist[j]<0&&grid[j]!==201){dist[j]=dist[i]+1;q.push(j);}}
    let safeLand=0,surplus=0;
    for(let i=0;i<grid.length;i++)if(owner(grid[i])===me&&!state.isolated?.[i]&&!state.fog?.[i]&&(dist[i]<0||dist[i]>=5)){safeLand++;surplus+=Math.max(0,army[i]-4);}
    const affordable=crowns+Math.floor(surplus/120);
    return Math.max(crowns,Math.min(safeLand,affordable));
  }
  // 中后期规模已够却仅有一个皇冠时，至少争取第二个生存锚点。
  return Math.max(1 + Math.floor(land / p.territoryPerCrown), land >= 20 && turn >= 100 ? 2 : 1);
}
function clusterValue(state, i) {
 const {m,n,grid,playerId:me}=state,x=Math.floor(i/m),y=i%m;
 let near=0,adj=0;
 for(let dx=-3;dx<=3;dx++)for(let dy=-3;dy<=3;dy++){
  const d=Math.abs(dx)+Math.abs(dy),a=x+dx,b=y+dy;
  if(!d||d>3||a<0||b<0||a>=n||b>=m)continue;
  if(grid[a*m+b]===me+100){near++;if(d===1)adj++;}
 }
 return Math.min(near,3)*9+Math.min(adj,2)*6-Math.max(0,near-5)*12;
}
function chooseBuild(state, move, params = {}) {
  if (!state || state.ended || state.dead || urgent(state, move)) return null;
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
  const target = crownTarget(land, state.turn || 0, p, state);
  const unfinished = [];
  for (let i=0;i<size;i++) if (own(i) && grid[i] === me+50 && !state.isolated?.[i]) unfinished.push(i);
  const turn = Number.isFinite(state.turn) ? Math.max(0, state.turn) : 1;
  let best = null;
  // 先完成已有产能，避免大量普通候选用尽共享评估预算。
  candidates.sort((a,b) => (grid[b] === me+50) - (grid[a] === me+50) || count(b)-count(a) || a-b);
  for (const i of candidates) {
    const upgrade = grid[i] === me + 50, risk = assess(i);
    // 皇冠投资串行完成，已有任何未升级塔时不再新增经济塔。
    const adjacentTower = context.neighbors[i].some(j => own(j) && grid[j] === me+50);
    if (!upgrade && adjacentTower) continue;
    const economic = crowns < target && (upgrade ? risk.crownSafe :
      unfinished.length === 0 && crowns + cities < target && risk.foundationSafe);
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
      score += 1000 + clusterValue(state,i);
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
module.exports = { chooseBuild, urgent, crownTarget, clusterValue };
