'use strict';

const { connectedSet, distanceField, anchorCells, cutAnalysis } = require('./board.cjs');
const { computePush, actionCoordinates, preview } = require('./rules.cjs');

const ECON_GOAL = Number(process.env.APEX_ECON_GOAL || 6);
const ECON_DEADLINE = Number(process.env.APEX_ECON_DEADLINE || 110);
const FORCE_MARGIN = Number.isFinite(Number(process.env.APEX_FORCE_MARGIN))
  ? Math.max(0, Math.min(1, Number(process.env.APEX_FORCE_MARGIN))) : 0.12;
const MULTI_CROWN_CAP = Number.isFinite(Number(process.env.APEX_MULTI_CROWN_CAP))
  ? Math.max(0.5, Math.min(1.5, Number(process.env.APEX_MULTI_CROWN_CAP))) : 0.85;

function field(b, starts, enter = b.passable) { return distanceField(b, starts, enter); }
function route(f, at) { const out = [at]; while (f.parent[at] >= 0) { at = f.parent[at]; out.push(at); } return out; }
function weightedRoute(b, start, target) {
  if (start === target) return [start];
  const distance = new Float64Array(b.size); distance.fill(Infinity);
  const parent = new Int32Array(b.size); parent.fill(-1);
  const heap = [];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= item[0]) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child += 1;
        if (heap[child][0] >= last[0]) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  distance[start] = 0; push([0, start]);
  while (heap.length) {
    const [cost, at] = pop();
    if (cost !== distance[at]) continue;
    if (at === target) break;
    for (const next of b.neighbors(at)) {
      if (!b.passable(next)) continue;
      const terrain = b.enemy(next) ? Math.min(80, b.army[next] + 2) : 1;
      const nextCost = cost + terrain;
      if (nextCost >= distance[next]) continue;
      distance[next] = nextCost;
      parent[next] = at;
      push([nextCost, next]);
    }
  }
  if (!Number.isFinite(distance[target])) return null;
  const path = [target];
  for (let at = target; parent[at] >= 0; at = parent[at]) path.push(parent[at]);
  return path.reverse();
}
function build(b, at, op = 'b') { return { kind: 'build', ...b.xy(at), op }; }
function movable(b, at) { return b.own(at) && !b.isolated[at] && b.army[at] > 1; }
function growth(b, at, ticks = 1) {
  if (!b.owner(at) || b.isolated[at]) return 0;
  if (b.kind(at) === 'crown') return ticks;
  if (b.kind(at) === 'swamp') return 0;
  let value = Math.floor((b.turn + ticks) / 50) - Math.floor(b.turn / 50);
  if (b.kind(at) === 'plain') value += Math.max(0, Math.min(50, b.turn + ticks) - Math.max(25, b.turn));
  return value;
}
function stranded(b, owner, removed) {
  const seen = new Set(), q = [];
  for (const at of anchorCells(b, owner)) if (at !== removed) { seen.add(at); q.push(at); }
  for (let h = 0; h < q.length; h++) for (const j of b.neighbors(q[h])) {
    if (j !== removed && !seen.has(j) && b.sameTeam(owner, b.owner(j))) { seen.add(j); q.push(j); }
  }
  let mass = 0;
  for (let at = 0; at < b.size; at++) if (at !== removed && b.sameTeam(owner, b.owner(at)) && !seen.has(at) && !b.isolated[at]) mass += b.army[at];
  return mass;
}
function pressure(b, at, omit = -1) {
  let value = 0;
  for (const j of b.neighbors(at)) if (j !== omit && b.enemy(j) && !b.isolated[j]) value = Math.max(value, b.army[j] - 1);
  return value;
}
function safeMove(b, from, to, intent = 'move') {
  if (!movable(b, from) || !b.passable(to)) return null;
  const targetArmy = b.army[to];
  const enemy = !b.friendly(to);
  const finalCrown = b.enemy(to) && b.kind(to) === 'crown' && b.grid.filter(v => v === b.grid[to]).length === 1;
  for (const mode of [2, 0, 1]) {
    const send = computePush(b, from, to, mode);
    if (send <= 0 || (enemy && send <= targetArmy)) continue;
    if (finalCrown && send > targetArmy) return actionCoordinates(b, from, to, mode);
    const left = b.army[from] - send;
    const arrive = enemy ? send - targetArmy : targetArmy + send;
    if (b.kind(from) === 'crown' && left < pressure(b, from, to)) continue;
    if (enemy && arrive < pressure(b, to, from) * 0.65 && intent !== 'cut') continue;
    if (left < pressure(b, from, to) && (stranded(b, b.playerId, from) + arrive) > 30) continue;
    return actionCoordinates(b, from, to, mode);
  }
  return null;
}

// Single objective supply tree. A funded branch is completed before another
// branch is opened; no node is moved away from the root of the active project.
function gather(b, m, root, need, reason) {
  if (!b.own(root) || b.isolated[root] || b.army[root] >= need) { m.delivery = null; return null; }
  const f = field(b, [root], at => b.own(at) && !b.isolated[at]);
  if (m.delivery?.root === root && movable(b, m.delivery.at) && f.distance[m.delivery.at] > 0) {
    const at = m.delivery.at, to = f.parent[at];
    const a = safeMove(b, at, to);
    if (a) { m.delivery = { root, at: to, movedTurn: b.turn }; return { action: a, branch: reason }; }
  }
  m.delivery = null;
  const sources = [];
  for (let at = 0; at < b.size; at++) {
    if (!movable(b, at) || at === root || !Number.isFinite(f.distance[at])) continue;
    const spare = b.army[at] - Math.max(1, pressure(b, at));
    if (spare < 3) continue;
    const p = route(f, at), mass = p.slice(0, -1).reduce((sum, i) => sum + Math.max(0, b.army[i] - 1), 0);
    sources.push({ at, p, score: Math.min(need - b.army[root] + 50, mass) / (p.length - 1) });
  }
  sources.sort((a, z) => z.score - a.score);
  for (const s of sources) {
    const a = safeMove(b, s.at, s.p[1]);
    if (a) { m.delivery = { root, at: s.p[1], movedTurn: b.turn }; return { action: a, branch: reason }; }
  }
  return null;
}

function opening(b, m, own, enemyDistance) {
  const options = [];
  const home = m.home;
  const hf = field(b, [home]);
  for (const from of own) {
    if (!movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (!b.passable(to) || b.owner(to)) continue;
      const a = safeMove(b, from, to);
      if (!a) continue;
      const compact = b.neighbors(to).filter(b.own).length;
      const space = b.neighbors(to).filter(j => b.passable(j) && !b.owner(j)).length;
      const enemyNear = Math.max(0, 6 - enemyDistance.distance[to]);
      const score = 60 + compact * 5 + space * 2 - hf.distance[to] * 1.5 - enemyNear * 16
        - (b.kind(to) === 'swamp' ? 120 : 0) + Math.min(40, b.army[from]) * 0.02;
      options.push({ action: a, branch: 'opening', score });
    }
  }
  options.sort((a,z) => z.score-a.score);
  if (options.length) return options[0];
  // Move the most useful stack one step toward an unoccupied exit.
  const exits = own.filter(i => b.neighbors(i).some(j => b.passable(j) && !b.owner(j)));
  const ef = field(b, exits, at => b.own(at));
  const sources = own.filter(i => movable(b,i) && ef.distance[i] > 0 && Number.isFinite(ef.distance[i]))
    .sort((a,z) => b.army[z]/ef.distance[z] - b.army[a]/ef.distance[a]);
  for (const at of sources) { const a = safeMove(b, at, ef.parent[at]); if (a) return { action: a, branch:'opening-route' }; }
  return null;
}

function tactical(b, own) {
  const options = [];
  for (const from of own) for (const to of b.neighbors(from)) {
    if (!b.enemy(to)) continue;
    const a = safeMove(b, from, to, 'cut');
    if (!a) continue;
    const cut = stranded(b, b.owner(to), to);
    const score = (b.kind(to)==='crown' ? 10000 : b.kind(to)==='city' ? 45 : 0) + cut;
    if (score < 25) continue;
    options.push({ action:a, branch:b.kind(to)==='crown'?'crown':'cut', score });
  }
  options.sort((a,z)=>z.score-a.score);
  return options[0] || null;
}

function frontierStrike(b, own) {
  const options = [];
  for (const from of own) {
    if (!movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (!b.enemy(to) || b.isolated[to]) continue;
      const a = safeMove(b, from, to, 'cut');
      if (!a) continue;
      const severed = stranded(b, b.owner(to), to);
      const kindValue = b.kind(to) === 'crown' ? 10000 : b.kind(to) === 'city' ? 900 : 40;
      const border = b.neighbors(to).filter(j => b.own(j)).length * 12;
      const risk = Math.max(0, pressure(b, to, from) - (b.army[from] - 1));
      options.push({ action: a, branch: 'front', score: kindValue + severed * 2 + border - risk * 8 + b.army[to] * 0.02 });
    }
  }
  options.sort((a, z) => z.score - a.score);
  return options[0] || null;
}

function strategicCut(b, own) {
  const options = [];
  const cache = new Map();
  for (const from of own) {
    if (!movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (!b.enemy(to) || b.isolated[to]) continue;
      const owner = b.owner(to);
      let cuts = cache.get(owner);
      if (!cuts) { cuts = cutAnalysis(b, owner); cache.set(owner, cuts); }
      const detachedMass = cuts.mass[to] || 0;
      const detachedLand = cuts.land[to] || 0;
      if (detachedLand < 3 || detachedMass < 20) continue;
      const action = safeMove(b, from, to, 'cut');
      if (!action) continue;
      const anchor = b.kind(to) === 'crown' ? 10000 : b.kind(to) === 'city' ? 700 : 0;
      options.push({ action, branch: 'strategic-cut', score: anchor + detachedMass * 2 + detachedLand * 18 - b.army[to] * 0.5 });
    }
  }
  options.sort((a, z) => z.score - a.score);
  return options[0] || null;
}

function defense(b, m, own) {
  const crowns = own.filter(i => b.kind(i)==='crown');
  if (!m.threatDistance) m.threatDistance = Object.create(null);
  let worst = null;
  for (const crown of crowns) {
    const f = field(b,[crown]);
    let nearest = Infinity;
    for (let enemy = 0; enemy < b.size; enemy += 1) {
      if (b.enemy(enemy) && !b.isolated[enemy] && f.distance[enemy] < nearest) nearest = f.distance[enemy];
    }
    const key = String(crown);
    const previous = m.threatDistance[key];
    const advancing = previous === undefined || nearest < previous;
    m.threatDistance[key] = nearest;
    for(let at=0;at<b.size;at++) {
      if(!b.enemy(at)||b.isolated[at]||f.distance[at]>6) continue;
      const p = route(f,at);
      let arrival=b.army[at]-1;
      for(const j of p.slice(1,-1)) arrival += b.enemy(j) ? Math.max(0,b.army[j]-1) : -b.army[j]-1;
      const shortage=arrival-b.army[crown]-f.distance[at];
      // A stationary blob several steps away is not an emergency.  Requiring
      // either a short arrival window or a large margin prevents defence from
      // cancelling every campaign whenever the opponent merely owns a large
      // border stack.
      const imminent = f.distance[at] <= 2;
      if(shortage>0 && (imminent || advancing) && (!worst || shortage/(f.distance[at]+1)>worst.score)) worst={at,crown,eta:f.distance[at],need:arrival+3,score:shortage/(f.distance[at]+1)};
    }
  }
  if(!worst) return null;
  // Intercept at the head or at its actual supply cut, before pulling a crown.
  for(const from of b.neighbors(worst.at)) if(b.own(from)) { const a=safeMove(b,from,worst.at,'cut'); if(a)return {action:a,branch:'intercept'}; }
  return gather(b,m,worst.crown,worst.need,'defend');
}

function cutDefense(b, m, own) {
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  // Dense maze walls already provide narrow, naturally protected corridors;
  // reinforcing every Tarjan point there would starve the only useful attack
  // lane.  Keep this guard for open and archipelago maps where a cut point is
  // actually exposed to a broad counter-front.
  if (walls > b.size * 0.12) return null;
  const cuts = cutAnalysis(b, b.playerId);
  const points = [...cuts.points].filter((at) => b.own(at) && !b.isolated[at] && cuts.land[at] > 0);
  let best = null;
  for (const at of points) {
    let hostile = 0;
    for (const next of b.neighbors(at)) if (b.enemy(next) && !b.isolated[next]) hostile = Math.max(hostile, b.army[next]);
    if (hostile <= b.army[at] + 1) continue;
    // Reinforce the exact articulation cell from an adjacent friendly stack;
    // this is cheaper and more reliable than reacting after the corridor has
    // already been severed.
    for (const from of b.neighbors(at)) {
      if (!b.own(from) || !movable(b, from) || from === at) continue;
      const action = safeMove(b, from, at, 'cut');
      if (action) {
        const score = cuts.mass[at] * 2 + cuts.land[at] * 20 + hostile - b.army[at];
        if (!best || score > best.score) best = { action, branch: 'cut-defense', score };
      }
    }
  }
  return best;
}

function economy(b,m,own,ed,goal) {
  if(m.site!==undefined && (!b.own(m.site)||b.isolated[m.site]||b.kind(m.site)==='crown')) m.site=undefined;
  if(m.site!==undefined) {
    const at=m.site, need=b.kind(at)==='city'?50:100;
    if(ed.distance[at]<3) { m.site=undefined; return null; }
    if(b.army[at]>=need) return {action:build(b,at,b.kind(at)==='city'?'c':'b'),branch:'invest'};
    return gather(b,m,at,need+1,'fund');
  }
  if(own.filter(i=>b.kind(i)==='crown').length>=goal) return null;
  const sites=own.filter(i=>['plain','city'].includes(b.kind(i)) && ed.distance[i]>=4);
  sites.sort((a,z)=> (b.kind(z)==='city'?80:0)+b.army[z] -(b.kind(a)==='city'?80:0)-b.army[a]);
  if(!sites.length) return null;
  m.site=sites[0];
  return economy(b,m,own,ed,goal);
}

function chooseCampaign(b,m,own) {
  const crowns=[];
  for(let i=0;i<b.size;i++)if(b.enemy(i)&&b.kind(i)==='crown')crowns.push(i);
  if(!crowns.length) return null;
  if (m.blocked && b.turn >= m.blocked.until) m.blocked = null;
  if (m.campaign && m.delivery?.root === m.campaign.at) {
    const rallyField = field(b, [m.campaign.at], at => b.own(at) && !b.isolated[at]);
    const rallyDistance = rallyField.distance[m.delivery.at];
    // Count only monotonic movement toward the active root as progress.  A
    // delivery stack that is repeatedly pushed sideways or recaptured must
    // eventually be abandoned, otherwise it can keep a campaign in muster
    // forever while the opponent compounds its economy.
    if (Number.isFinite(rallyDistance) && rallyDistance < (m.campaign.deliveryBestDistance ?? Infinity)) {
      m.campaign.deliveryBestDistance = rallyDistance;
      m.campaign.lastProgress = b.turn;
    }
  }
  if(m.campaign) {
    const currentArmy = b.army[m.campaign.at] || 0;
    const phaseChanged = m.campaign.lastPhase !== m.campaign.phase;
    const phaseLimit = m.campaign.phase === 'attack' ? 14 : 24;
    const armyProgress = currentArmy > (m.campaign.lastArmy || 0) + 2;
    if (phaseChanged || m.campaign.lastAt !== m.campaign.at || armyProgress) {
      m.campaign.lastAt = m.campaign.at;
      m.campaign.lastArmy = currentArmy;
      m.campaign.lastProgress = b.turn;
      m.campaign.lastPhase = m.campaign.phase;
    } else if (b.turn - (m.campaign.lastProgress ?? m.campaign.started) > phaseLimit) {
      m.blocked = { crown: m.campaign.crown, until: b.turn + 35 };
      m.campaign = null;
      m.delivery = null;
      return null;
    }
  }
  if(!m.campaign || !b.enemy(m.campaign.crown) || b.kind(m.campaign.crown)!=='crown' || !b.own(m.campaign.at) || b.isolated[m.campaign.at]) {
    // The opponent may counter-capture the current spearhead before it reaches
    // the crown.  Recovering that exact bridge is usually cheaper than
    // abandoning the whole corridor and starting a fresh campaign from the
    // rear.  Keep the old campaign in place while the recapture is attempted;
    // on the next snapshot it becomes a normal gather/attack root again.
    const lostAt = m.campaign && Number.isInteger(m.campaign.at) ? m.campaign.at : -1;
    if (lostAt >= 0 && b.enemy(lostAt)) {
      for (const from of b.neighbors(lostAt)) {
        if (!b.own(from)) continue;
        const rescue = safeMove(b, from, lostAt, 'cut');
        if (rescue) return { action: rescue, branch: 'rescue' };
      }
    }
    // Keep a successful breach together.  When a crown is captured the old
    // campaign becomes invalid, but its active stack is still the best launch
    // point for the next crown in the same core.  The same hint also guides a
    // recovery after a counter-capture instead of teleporting the objective
    // back to the strongest rear stack.
    const hintAt = m.campaign && Number.isInteger(m.campaign.at) ? m.campaign.at : -1;
    const recoveryField = hintAt >= 0 ? field(b, [hintAt]) : null;
    let best=null;
    for(const crown of crowns) {
      if (m.blocked && m.blocked.crown === crown && b.turn < m.blocked.until) continue;
      const f=field(b,[crown]);
      for(const at of own)if(b.army[at]>2 && Number.isFinite(f.distance[at])){
        const path = route(f, at);
        const resistance = path.slice(1).reduce((sum, cell) => sum + (b.friendly(cell) ? 0 : b.army[cell] + 1), 0);
        const score=-f.distance[at]*2.5-resistance*0.18-b.army[crown]*0.08+b.army[at]*0.15;
        const recovery = recoveryField && Number.isFinite(recoveryField.distance[at])
          ? -recoveryField.distance[at] * 4
          : 0;
        const adjusted = score + recovery;
        if(!best||adjusted>best.score)best={crown,at,score:adjusted,phase:'gather',started:b.turn,lastPhase:'gather',lastProgress:b.turn,deliveryBestDistance:Infinity};
      }
    }
    if (!best && m.blocked && b.turn >= m.blocked.until) m.blocked = null;
    m.campaign=best;
  }
  const c=m.campaign;
  if(!c) return null;
  const f=field(b,[c.crown]);
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  // Weighted routing is valuable in obstacle-rich maps, where a short path
  // through the opponent's main spine is usually a trap.  Swamp-heavy maps
  // already have sparse usable lanes; adding a detour there only delays the
  // decisive push.
  const p = walls > b.size * 0.25 ? (weightedRoute(b,c.at,c.crown) || route(f,c.at)) : route(f,c.at);
  if(p.length<2)return null;
  let resistance=0;
  for(const i of p.slice(1))if(!b.friendly(i)) resistance+=b.army[i]+(b.kind(i)==='crown'?p.length:0)+1;
  // Attack on the first decisive window instead of waiting for a perfect
  // stack.  The reserve is enough to absorb rounding and one counter-push,
  // while the route itself keeps growing every tick if we wait for a 35%
  // surplus.
  const rawDesired=Math.max(120,resistance+Math.max(20,resistance*FORCE_MARGIN));
  const ownTotal = own.reduce((sum, at) => sum + b.army[at], 0);
  const urgencyCap = Math.max(260, ownTotal * MULTI_CROWN_CAP);
  const desired = Math.min(rawDesired, urgencyCap);
  if(c.phase==='gather'&&b.army[c.at]<desired) {
    const delivery=gather(b,m,c.at,desired,'muster');
    if(delivery)return delivery;
  }
  c.phase='attack';
  const to=p[1];
  // Before exposing a long supply route, anchor the active army itself. This
  // works for any topology, including a maze whose geometric width is one.
  if(b.kind(c.at)==='plain' && b.army[c.at]>=90) {
    const cuts=cutAnalysis(b,b.playerId);
    const danger = own.some(i=>i!==c.at && cuts.land[i]>0 &&
      pressure(b,i)>b.army[i] && cuts.mass[i]>b.army[c.at]*0.7);
    if(danger) return {action:build(b,c.at),branch:'anchor'};
  }
  const a=safeMove(b,c.at,to,'campaign');
  if(a){return {action:a,branch:'march'};}
  c.phase='gather';
  const delivery=gather(b,m,c.at,Math.max(desired,b.army[to]*1.3+30),'muster');
  if(delivery)return delivery;
  return null;
}

function plan(b,m) {
  const own=[]; const enemies=[];
  for(let i=0;i<b.size;i++){if(b.own(i)&&!b.isolated[i])own.push(i);if(b.enemy(i)&&!b.isolated[i])enemies.push(i);}
  if(!Number.isInteger(m.home)||!b.own(m.home))m.home=own.find(i=>b.kind(i)==='crown');
  if(!own.length)return {action:null,branch:'idle'};
  const fogged = b.fog.some((value) => Number(value) !== 0);
  // In fog, ordinary unseen cells look like harmless neutral land.  Endless
  // blind expansion lets the opponent outgrow us and also exposes many
  // unprotected cut points. Explore until a useful perimeter exists, then
  // switch the action budget to economy, rallying, and visible combat.
  const explore = !fogged || b.turn < 120 || own.length < 40 || (fogged && b.turn % 5 === 0);
  const ed=field(b,enemies);
  const tactic=tactical(b,own);
  if(tactic?.branch==='crown')return tactic;
  const ownTotal = own.reduce((sum, at) => sum + b.army[at], 0);
  const enemyTotal = enemies.reduce((sum, at) => sum + b.army[at], 0);
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
  const finishing = enemyCrowns <= 2 && ownTotal > enemyTotal * 1.35;
  if (finishing) {
    // Once the opposing empire is already collapsing, every spare tick must
    // stay on the shortest crown campaign.  Ordinary cutoff and economy work
    // can otherwise leave a tiny last crown alive indefinitely.
    const final = chooseCampaign(b, m, own);
    if (final) return final;
    if (m.campaign?.phase === 'gather' && b.own(m.campaign.at)) return { action: null, branch: 'muster-wait' };
  }
  const defend=defense(b,m,own);
  if(defend)return defend;
  const cutGuard = cutDefense(b, m, own);
  if (cutGuard) return cutGuard;
  const cut = strategicCut(b, own);
  if (cut && (!m.campaign || cut.score > 250)) return cut;
  const strike=frontierStrike(b,own);
  // Once a campaign exists, its rally corridor owns the action budget.  A
  // tempting side capture can otherwise move the very stack being assembled
  // and leave the controller oscillating between two fronts.  Local strikes
  // remain available during recovery windows and before a campaign starts.
  const campaignBusy = Boolean(m.campaign && (!m.blocked || b.turn >= m.blocked.until));
  if(strike && !campaignBusy && (b.turn < 90 || strike.score > 100))return strike;
  if(tactic)return tactic;
  if(b.turn<50 || (fogged && explore)) return opening(b,m,own,ed)||{action:null,branch:'wait'};
  // A failed core route opens a short recovery window.  Spend it on a
  // winnable local border capture instead of immediately rebuilding the same
  // long muster; this changes the geometry and the economy before retrying.
  if (m.blocked && b.turn < m.blocked.until && strike) return strike;
  const enemyInvested = enemies.some(i => b.kind(i)==='city') || enemies.filter(i => b.kind(i)==='crown').length > 1;
  let topologyWalls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') topologyWalls += 1;
  const earlyStrike = enemyInvested && topologyWalls > b.size * 0.12;
  // The opponent's second crown/city is the signal that its expansion phase
  // has turned into infrastructure.  Start the prepared strike immediately;
  // postponing it behind another economy cycle gives the opponent a free
  // window to multiply its core.
  if (b.turn < ECON_DEADLINE && !(earlyStrike && process.env.APEX_EARLY_MAZE !== '0')) {
    const invest=economy(b,m,own,ed,ECON_GOAL);
    if(invest)return invest;
  }
  const campaign=(enemyInvested || b.turn >= 70) ? chooseCampaign(b,m,own) : null;
  if(campaign)return campaign;
  // Once a campaign has a valid rally root but no legal delivery step, keep
  // the root intact and let growth refill it.  Falling back to opening here
  // spends the action on a new frontier and is exactly the oscillation that
  // starves a planned core assault.
  if (m.campaign && m.campaign.phase === 'gather' && b.own(m.campaign.at) && !b.isolated[m.campaign.at]) {
    return { action: null, branch: 'muster-wait' };
  }
  const investment=economy(b,m,own,ed,ECON_GOAL);
  if(investment && (!enemyInvested || b.turn < 80))return investment;
  if(campaign)return campaign;
  const growthAction=economy(b,m,own,ed,ECON_GOAL);
  if(growthAction)return growthAction;
  return (explore ? opening(b,m,own,ed) : null)||{action:null,branch:'wait'};
}
module.exports={plan,stranded,safeMove,gather,growth};
