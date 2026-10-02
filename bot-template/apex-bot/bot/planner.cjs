'use strict';

const { makeBoard, connectedSet, distanceField, anchorCells, cutAnalysis } = require('./board.cjs');
const { computePush, actionCoordinates, preview } = require('./rules.cjs');

const ECON_GOAL = Number(process.env.APEX_ECON_GOAL || 6);
const ECON_DEADLINE = Number(process.env.APEX_ECON_DEADLINE || 90);
const FORCE_MARGIN = Number.isFinite(Number(process.env.APEX_FORCE_MARGIN))
  ? Math.max(0, Math.min(1, Number(process.env.APEX_FORCE_MARGIN))) : 0.12;
const MULTI_CROWN_CAP = Number.isFinite(Number(process.env.APEX_MULTI_CROWN_CAP))
  ? Math.max(0.5, Math.min(1.5, Number(process.env.APEX_MULTI_CROWN_CAP))) : 0.85;
const CAMPAIGN_GATHER_TIMEOUT = Number.isFinite(Number(process.env.APEX_CAMPAIGN_GATHER_TIMEOUT))
  ? Math.max(8, Math.min(80, Number(process.env.APEX_CAMPAIGN_GATHER_TIMEOUT))) : 28;
const CAMPAIGN_ATTACK_TIMEOUT = Number.isFinite(Number(process.env.APEX_CAMPAIGN_ATTACK_TIMEOUT))
  ? Math.max(8, Math.min(60, Number(process.env.APEX_CAMPAIGN_ATTACK_TIMEOUT))) : 18;
const CAMPAIGN_REBASE_AFTER = Number.isFinite(Number(process.env.APEX_CAMPAIGN_REBASE_AFTER))
  ? Math.max(6, Math.min(80, Number(process.env.APEX_CAMPAIGN_REBASE_AFTER))) : 14;
const CAMPAIGN_BLOCK_COOLDOWN = Number.isFinite(Number(process.env.APEX_CAMPAIGN_BLOCK_COOLDOWN))
  ? Math.max(4, Math.min(60, Number(process.env.APEX_CAMPAIGN_BLOCK_COOLDOWN))) : 20;
const CAMPAIGN_READINESS = Number.isFinite(Number(process.env.APEX_CAMPAIGN_READINESS))
  ? Math.max(0, Math.min(0.8, Number(process.env.APEX_CAMPAIGN_READINESS))) : 0;
const CAMPAIGN_STRENGTH_DEFAULT = Number.isFinite(Number(process.env.APEX_CAMPAIGN_STRENGTH))
  ? Math.max(0.05, Math.min(0.8, Number(process.env.APEX_CAMPAIGN_STRENGTH))) : 0.25;
const BUILD_CLUSTER_SIZE = Number.isFinite(Number(process.env.APEX_BUILD_CLUSTER_SIZE))
  ? Math.max(2, Math.min(8, Number(process.env.APEX_BUILD_CLUSTER_SIZE))) : 4;
const BUILD_COST = 50;
const SMALL_COLUMN = 18;
const FINISH_RESIDUE = 30;
const APPROACH_RADIUS = 12;
const APPROACH_MIN_FORCE = 40;
const APPROACH_MARGIN = 18;

function field(b, starts, enter = b.passable) { return distanceField(b, starts, enter); }
function swampRatio(b, m) {
  if (m.swampRatio === undefined) {
    let swampTiles = 0;
    for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'swamp') swampTiles += 1;
    m.swampRatio = b.size ? swampTiles / b.size : 0;
  }
  return m.swampRatio;
}
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

function routeArrival(b, f, at) {
  const path = route(f, at);
  let arrival = b.army[at] - 1;
  for (const j of path.slice(1, -1)) {
    arrival += b.enemy(j) ? Math.max(0, b.army[j] - 1) : -b.army[j] - 1;
  }
  return { arrival, distance: f.distance[at] };
}

function localGuard(b, crown, ownField = field(b, [crown], (at) => b.own(at) && !b.isolated[at])) {
  let guard = 0;
  for (let at = 0; at < b.size; at += 1) {
    if (ownField.distance[at] <= 4) guard += b.army[at];
  }
  return guard;
}

// Building spends fifty units immediately.  If the opponent has expanded
// while saving a border stack, that investment can turn a defendable crown
// into a one-turn target.  Hold construction until the stack is intercepted
// or the nearby garrison has grown back above the projected attack.
function constructionThreat(b, own, enemies) {
  const crowns = own.filter((at) => b.kind(at) === 'crown');
  const buildSites = own.filter((at) => b.kind(at) === 'plain' || b.kind(at) === 'city');
  for (const crown of crowns) {
    const threatField = field(b, [crown]);
    const ownField = field(b, [crown], (at) => b.own(at) && !b.isolated[at]);
    const guard = localGuard(b, crown, ownField);
    const buildNearCrown = buildSites.some((at) => Number.isFinite(ownField.distance[at]) && ownField.distance[at] <= 4);
    const projectedGuard = Math.max(0, guard - (buildNearCrown ? BUILD_COST : 0));
    for (const enemy of enemies) {
      const distance = threatField.distance[enemy];
      if (!Number.isFinite(distance) || distance > 12) continue;
      const { arrival } = routeArrival(b, threatField, enemy);
      const margin = Math.max(18, distance * 2);
      if (arrival + margin > projectedGuard) return true;
    }
    const concentrated = enemies
      .filter((at) => Number.isFinite(threatField.distance[at]) && threatField.distance[at] <= 18)
      .sort((a, z) => b.army[z] - b.army[a])[0];
    if (concentrated !== undefined && b.army[concentrated] >= Math.max(80, projectedGuard * 0.65) &&
      b.army[concentrated] + 30 > projectedGuard) return true;
  }
  return false;
}

// Humans often skip every early build, paint a narrow corridor, and then
// spend the saved army on a direct crown raid. A construction-only safety
// check sees that attack too late because the stack is still many cells from
// the crown. Detect the characteristic 1v1 state before committing money or
// a long campaign to the rear: the opponent still has only its initial crown,
// owns no city, has a meaningful territory/army lead, and is already inside a
// reachable approach window. Maze corridors get a longer warning horizon.
function earlyRushProfile(b, own, enemies) {
  if (b.turn < 25 || b.turn > 135 || !enemies.length) return null;
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
  if (enemyCrowns !== 1 || enemies.some((at) => b.kind(at) === 'city')) return null;
  const crowns = own.filter((at) => b.kind(at) === 'crown');
  if (!crowns.length) return { active: true, homeReserve: 0, distance: 0, crown: -1, enemyHome: -1 };
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  // The attack may start only after our first build, so the warning window
  // must include the opponent's travel time after that build.  A fixed
  // twelve-cell check misses compact 1x30/maze boards where the home stack
  // is still several dozen cells away but reaches the crown before the next
  // construction cycle. Keep the horizon bounded on large maps so this
  // latent defence does not freeze ordinary long-range development.
  const horizon = walls > b.size * 0.12 ? 48 : 36;
  const maze = walls > b.size * 0.12;
  let swampTiles = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'swamp') swampTiles += 1;
  const maritime = b.size > 0 && swampTiles / b.size > 0.3 && swampTiles / b.size < 0.55;
  const enemyHome = enemies.find((at) => b.kind(at) === 'crown');
  if (enemyHome === undefined) return null;
  // A second crown can be much closer to the saved enemy home than the
  // original crown. Select the weakest reachable target instead of assuming
  // crowns[0] is the one a delayed raid will hit.
  let crown = crowns[0];
  let crownField = field(b, [crown]);
  let crownDistance = crownField.distance[enemyHome];
  for (const candidate of crowns.slice(1)) {
    const candidateField = field(b, [candidate]);
    const candidateDistance = candidateField.distance[enemyHome];
    if (candidateDistance < crownDistance ||
      (candidateDistance === crownDistance && b.army[candidate] < b.army[crown])) {
      crown = candidate;
      crownField = candidateField;
      crownDistance = candidateDistance;
    }
  }
  const ownArmy = own.reduce((sum, at) => sum + b.army[at], 0);
  const enemyArmy = enemies.reduce((sum, at) => sum + b.army[at], 0);
  const landLead = enemies.length >= own.length + 8 || enemies.length >= own.length * 1.12;
  const armyLead = enemyArmy >= Math.max(90, ownArmy * 0.78);
  let nearest = Infinity;
  let strongest = 0;
  for (const at of enemies) {
    const distance = crownField.distance[at];
    if (!Number.isFinite(distance) || distance > horizon) continue;
    nearest = Math.min(nearest, distance);
    strongest = Math.max(strongest, b.army[at]);
  }
  const closeStack = strongest >= Math.max(36, ownArmy * 0.08);
  const owner = b.owner(enemyHome);
  const homeField = field(b, [enemyHome], (at) => b.owner(at) === owner && !b.isolated[at]);
  let homeReserve = 0;
  for (const at of enemies) {
    if (!b.isolated[at] && homeField.distance[at] <= 5) homeReserve += b.army[at];
  }
  const distance = crownDistance;
  // A player can keep the whole army behind the crown and still have a
  // winning attack.  Total army/land lead is therefore only a bonus signal;
  // the essential signal is a funded home reserve with a short route to our
  // sole crown while the opponent has not spent its first city investment.
  const savedHome = b.turn >= 25 && Number.isFinite(distance) && distance <= horizon &&
    homeReserve >= 48 && (enemyArmy >= Math.max(48, ownArmy * 0.45) || homeReserve >= 80);
  const advancing = Number.isFinite(nearest) && closeStack && (landLead || armyLead || nearest <= 6);
  if (!savedHome && !advancing) return null;
  return {
    active: true,
    homeReserve,
    distance,
    crown,
    enemyHome,
    maritime,
    maze,
    ownArmy,
    enemyArmy,
    guard: localGuard(b, crown),
    // A build can remove fifty units from a cell that is also part of the
    // crown's local guard. Keep a larger buffer on a short route and on maze
    // maps where one corridor is easy to lose.
    buildBuffer: BUILD_COST + Math.max(12, Math.min(36, distance * 2)),
  };
}

function earlyRushThreat(b, own, enemies) {
  return Boolean(earlyRushProfile(b, own, enemies));
}

// A maze has a single-lane campaign cost: a column with only one or two
// anchors cannot replace losses or keep the rear connected. Once the opponent
// has built, pause a long/gathering campaign until a compact anchor chain is
// available. A healthy spearhead at the final approach may still finish.
function mazeInfrastructureHold(b, m, own, enemies) {
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  if (walls <= b.size * 0.12) return false;
  const enemyCities = enemies.filter((at) => b.kind(at) === 'city').length;
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
  if (enemyCities === 0 && enemyCrowns <= 1) return false;
  const target = Number.isInteger(m.enemyHome) && b.enemy(m.enemyHome) && b.kind(m.enemyHome) === 'crown'
    ? m.enemyHome : enemies.find((at) => b.kind(at) === 'crown');
  if (!Number.isInteger(target)) return false;
  const targetField = field(b, [target]);
  const root = Number.isInteger(m.campaign?.at) && b.own(m.campaign.at)
    ? m.campaign.at : own.find((at) => b.kind(at) === 'crown');
  const distance = Number.isInteger(root) ? targetField.distance[root] : Infinity;
  if (!Number.isFinite(distance)) return false;
  if (m.campaign?.phase !== 'gather' && distance < (b.size >= 800 ? 24 : 8)) return false;
  const anchors = own.filter((at) => ['city', 'crown'].includes(b.kind(at)));
  const requiredAnchors = distance >= 48 ? 4 : distance >= 30 ? 3 : 2;
  // A city is commonly upgraded into a crown immediately after it is
  // founded.  Requiring a *current* city therefore kept this hold active on
  // narrow maps even though the crown chain was already anchored.  Crowns
  // are command anchors too; use the actual anchor count as the readiness
  // signal so a long campaign can start before the opponent fills the maze.
  if (anchors.length >= requiredAnchors) return false;
  if (m.campaign?.phase === 'attack' && distance <= 8 &&
      b.army[m.campaign.at] >= Math.max(36, b.army[target] * 1.25 + 12)) return false;
  return true;
}

function rushCrownFloor(profile) {
  return Math.max(18, Math.min(100, Math.ceil(profile.homeReserve * 0.8 + Math.min(12, profile.distance))));
}

function delayedRushGuard(b, m, own, enemies, profile) {
  if (!profile?.active || profile.crown < 0) return null;
  const crownFloor = rushCrownFloor(profile);
  const needed = Math.min(260, Math.max(
    crownFloor,
    profile.homeReserve + Math.max(12, profile.distance * 2) + 10,
  ));
  // The crown floor is the phase boundary. Once it is met, do not keep
  // waiting for the entire enemy home reserve; those soldiers may never
  // leave home and the lost expansion window would hand over several crowns.
  if (b.army[profile.crown] >= crownFloor) return null;
  const direct = b.neighbors(profile.crown)
    .filter((from) => b.own(from) && !b.isolated[from] && movable(b, from))
    .sort((a, z) => b.army[z] - b.army[a]);
  for (const from of direct) {
    const action = safeMove(b, from, profile.crown, 'gather', [2, 0, 1]);
    if (action) return { action, branch: 'delayed-rush-guard' };
  }
  const delivery = gather(b, m, profile.crown, needed, 'delayed-rush-guard',
    (at) => b.own(at) && !b.isolated[at], Math.min(8, Math.max(4, profile.distance)));
  return delivery;
}

function rushOutwardMove(b, action, profile) {
  if (!profile?.active || profile.crown < 0 || action?.kind !== 'attack') return false;
  const from = b.idx(action.x, action.y);
  const to = b.idx(action.dx, action.dy);
  if (from !== profile.crown) return false;
  return to !== profile.crown && !b.enemy(to) && b.army[profile.crown] < rushCrownFloor(profile);
}

function latentReserveMove(b, profile) {
  if (!profile?.active || profile.crown < 0) return null;
  const crownField = field(b, [profile.crown]);
  const sources = [];
  for (let from = 0; from < b.size; from += 1) {
    if (from === profile.crown || !movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (!b.own(to) || b.isolated[to] || crownField.distance[to] >= crownField.distance[from]) continue;
      const action = safeMove(b, from, to, 'gather', [0, 1]);
      if (action && !routeGuard(b, action).blocked) {
        sources.push({ action, score: crownField.distance[from] - crownField.distance[to] + b.army[from] * 0.001 });
      }
    }
  }
  sources.sort((a, z) => z.score - a.score);
  return sources[0] ? { ...sources[0], branch: 'delayed-rush-rally' } : null;
}

function asPlayer(b, playerId) {
  return makeBoard({
    n: b.n,
    m: b.m,
    grid: b.grid,
    army: b.army,
    isolated: b.isolated,
    fog: b.fog,
    turn: b.turn,
    leaderboard: b.leaderboard,
    teams: b.teams,
    _adjacency: b._adjacency,
  }, playerId);
}

function detachedAfter(b, after, owner) {
  const before = connectedSet(b, owner);
  const connected = connectedSet(after, owner);
  let mass = 0;
  let land = 0;
  for (let at = 0; at < b.size; at += 1) {
    if (!before.has(at) || connected.has(at) || b.owner(at) !== owner) continue;
    mass += Math.max(0, Number(after.army[at]) || 0);
    land += 1;
  }
  return { mass, land };
}

// Preview the opponent's next legal attack against every command tower.  A
// normal pressure check misses the important case where the opponent first
// captures a one-unit bridge cell and then reaches the tower on the next tick.
// Keep this narrow: only a successful capture of a city/crown that strands a
// substantial connected branch is considered an emergency.
function enemyAnchorThreats(b) {
  const anchors = anchorCells(b, b.playerId).filter((at) => b.own(at) && !b.isolated[at]);
  const loneCrown = anchors.filter((at) => b.kind(at) === 'crown').length === 1;
  const byOwner = new Map();
  const threats = [];
  for (const anchor of anchors) {
    for (const source of b.neighbors(anchor)) {
      if (!b.enemy(source) || b.isolated[source]) continue;
      const enemyOwner = b.owner(source);
      let enemyBoard = byOwner.get(enemyOwner);
      if (!enemyBoard) {
        enemyBoard = asPlayer(b, enemyOwner);
        byOwner.set(enemyOwner, enemyBoard);
      }
      for (const mode of [2, 0, 1]) {
        const action = actionCoordinates(enemyBoard, source, anchor, mode);
        const result = preview(enemyBoard, action);
        if (!result.ok || !result.captured) continue;
        const detached = detachedAfter(b, result.after, b.playerId);
        threats.push({ anchor, source, action, send: result.send, detachedMass: detached.mass, detachedLand: detached.land,
          fatal: b.kind(anchor) === 'crown' && loneCrown });
        break;
      }
    }
  }
  return threats.filter((threat) => threat.fatal || threat.detachedMass >= FINISH_RESIDUE);
}

function approachThreat(b, anchor, guard) {
  const f = field(b, [anchor]);
  let best = null;
  for (let at = 0; at < b.size; at += 1) {
    if (!b.enemy(at) || b.isolated[at] || !Number.isFinite(f.distance[at]) || f.distance[at] > APPROACH_RADIUS) continue;
    const distance = f.distance[at];
    const force = Math.max(0, b.army[at] - Math.max(1, distance - 2));
    if (force < APPROACH_MIN_FORCE || force < b.army[anchor] * 2 + 8) continue;
    if (force < guard * 0.55 && distance > 6) continue;
    const need = Math.max(b.army[anchor] + 8, Math.min(220, force + APPROACH_MARGIN));
    const score = (force - b.army[anchor]) / (distance + 1);
    if (!best || score > best.score) best = { at, distance, force, need, score };
  }
  return best;
}

// A crown raid may finish with an expendable remnant. Count what a countercut
// would actually disconnect after the capture, rather than requiring the
// spent assault force to preserve a route it no longer needs.
function crownFinish(b, action, result = preview(b, action)) {
  if (!result.ok || !result.captured || !b.enemy(result.to) || b.kind(result.to) !== 'crown') return false;
  const after = result.after;
  if (!result.decap && after.army[result.to] > FINISH_RESIDUE) return false;
  const cuts = cutAnalysis(after, after.playerId);
  for (const at of cuts.points) {
    if (cuts.mass[at] > FINISH_RESIDUE && pressure(after, at) > after.army[at]) return false;
  }
  // Other opponents can still punish an exposed home crown after a kill.
  for (const at of anchorCells(after, after.playerId)) {
    if (after.kind(at) === 'crown' && pressure(after, at) > after.army[at]) return false;
  }
  return true;
}

function routeGuard(b, action) {
  if (!action || action.kind !== 'attack') return { blocked: false, anchor: -1, cut: -1 };
  const to = b.idx(action.dx, action.dy);
  const previewResult = preview(b, action);
  if (!previewResult.ok || (previewResult.captured === false && b.enemy(to))) {
    return { blocked: false, anchor: -1, cut: -1 };
  }
  if (crownFinish(b, action, previewResult)) return { blocked: false, anchor: -1, cut: -1 };
  const after = previewResult.after;
  const cuts = cutAnalysis(after, after.playerId);
  let blocked = false;
  let anchor = -1;
  let cut = -1;
  for (const at of cuts.points) {
    // Keep the campaign guard focused on a plain bridge that the move really
    // leaves behind. Command-tower loss is handled by enemyAnchorThreats;
    // treating every anchor as a route cut makes an ordinary head move look
    // unsafe and changes which repair cell is selected.
    if (b.kind(at) !== 'plain') continue;
    if (!cuts.separates(at, previewResult.to) || cuts.mass[at] < 1) continue;
    if (pressure(after, at) <= after.army[at] + 1) continue;
    // The pushed column can be much larger than the side branch it leaves
    // behind. Comparing detached mass with half of `send` misses exactly that
    // case: the bridge still strands real territory even though the moving
    // army is enormous. Any non-empty detached branch is relevant here; the
    // pressure and post-build reserve checks below keep trivial cuts cheap.
    blocked = true;
    if (cut < 0 || cuts.mass[at] > cuts.mass[cut]) cut = at;
    // Building costs 50 immediately. Only create a new anchor when its
    // remaining garrison still survives the same one-hit cutoff; otherwise
    // the "defensive" build would pay for the breach itself.
    if (b.own(at) && b.kind(at) === 'plain' &&
      b.army[at] - 50 > pressure(after, at) + 1) {
      anchor = at;
      break;
    }
  }
  // A long unanchored corridor is the other common form of the same failure:
  // the head is safe now, but the next enemy tap can sever the whole column.
  if (blocked) return { blocked: true, anchor, cut };
  return { blocked: false, anchor: -1, cut: -1 };
}

function isMazeBoard(b) {
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  return walls > b.size * 0.12;
}

function mazeEdgeKey(from, to) {
  return from < to ? `${from}:${to}` : `${to}:${from}`;
}

function mazeEmergency(b, from, to, decision) {
  const branch = String(decision?.branch || '');
  if (/(defend|supply|anchor|intercept|rescue|cut|crown)/.test(branch)) return true;
  if (b.enemy(to)) {
    if (['crown', 'city'].includes(b.kind(to))) return true;
    if (stranded(b, b.owner(to), to) >= 20) return true;
  }
  if (b.own(to)) {
    const threat = pressure(b, to, from);
    const deficit = Math.max(0, threat - b.army[to]);
    // A real reinforcement can override the hysteresis.  A one-unit feed
    // into a threatened plain is exactly the stalled convoy pattern this
    // guard is meant to stop.
    if (deficit > 2 && Math.max(0, b.army[from] - 1) >= Math.max(8, deficit)) return true;
  }
  return false;
}

// Maze corridors have very little room for a bad tick.  The planner used to
// reselect the same legal edge whenever a convoy could not advance, producing
// A->B->A or the same command for dozens of server ticks.  Keep the military
// decision intact when it is making a real cut/defence, but require ordinary
// movement to make geometric progress or yield the tick to growth.
function mazeActionGuard(b, m, decision) {
  if (!(m.maze ?? isMazeBoard(b)) || !decision?.action || decision.action.kind !== 'attack') return decision;
  const from = b.idx(decision.action.x, decision.action.y);
  const to = b.idx(decision.action.dx, decision.action.dy);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return decision;
  const history = m.mazeHistory || (m.mazeHistory = {
    lastFrom: -1, lastTo: -1, edge: '', edgeStreak: 0, recent: [],
    blockedUntil: Object.create(null), reroutes: 0, holds: 0, holdStreak: 0,
  });
  const edge = mazeEdgeKey(from, to);
  const reverse = history.lastFrom === to && history.lastTo === from;
  const repeated = history.edge === edge ? history.edgeStreak + 1 : 1;
  const emergency = mazeEmergency(b, from, to, decision);
  const cooldown = Number(history.blockedUntil[edge] || 0) > b.turn;
  const openingRepeat = /opening/.test(String(decision.branch || '')) &&
    !b.enemy(to) && repeated <= 4;
  if ((!reverse && (repeated <= 1 || openingRepeat) && !cooldown) || emergency) return decision;

  history.blockedUntil[edge] = b.turn + (reverse ? 4 : 3);
  const objective = Number.isInteger(m.campaign?.crown) && b.enemy(m.campaign.crown)
    ? m.campaign.crown : Number.isInteger(m.enemyHome) && b.enemy(m.enemyHome) ? m.enemyHome : -1;
  const objectiveField = objective >= 0 ? field(b, [objective]) : null;
  const rally = Number.isInteger(m.campaign?.at) ? m.campaign.at : -1;
  const rallyField = rally >= 0 ? field(b, [rally], at => b.own(at) && !b.isolated[at]) : null;
  const candidates = [];
  const sources = [];
  if (b.own(from) && !b.isolated[from]) sources.push(from);
  const laneBound = /^(march|muster|campaign|route)/.test(String(decision.branch || ''));
  if (!laneBound) for (let at = 0; at < b.size; at += 1) {
    if (at !== from && b.own(at) && !b.isolated[at]) sources.push(at);
  }
  const recent = new Set(history.recent || []);
  for (const source of sources) {
    if (!movable(b, source)) continue;
    for (const target of b.neighbors(source)) {
      if (!b.passable(target)) continue;
      const candidateEdge = mazeEdgeKey(source, target);
      if (candidateEdge === edge || candidateEdge === mazeEdgeKey(to, from)) continue;
      // Do not replace one blocked edge with the exact edge used on the
      // preceding tick.  Without this check a cooldown on A-B made the
      // selector bounce back to the just-used B-C edge on every tick.
      if (candidateEdge === history.edge) continue;
      if (Number(history.blockedUntil[candidateEdge] || 0) > b.turn) continue;
      const candidateEmergency = mazeEmergency(b, source, target, decision);
      const recentlyUsed = recent.has(candidateEdge) && !candidateEmergency;
      const intent = b.enemy(target) ? 'cut' : decision.branch === 'march' ? 'campaign' : 'gather';
      const action = safeMove(b, source, target, intent);
      if (!action || routeGuard(b, action).blocked) continue;
      let score = source === from ? 50 : 0;
      if (recentlyUsed) score -= 18;
      if (b.owner(target) === 0) score += 16;
      if (b.kind(target) === 'swamp') score -= 40;
      if (objectiveField && Number.isFinite(objectiveField.distance[source]) && Number.isFinite(objectiveField.distance[target])) {
        score += (objectiveField.distance[source] - objectiveField.distance[target]) * 35;
      }
      if (rallyField && Number.isFinite(rallyField.distance[source]) && Number.isFinite(rallyField.distance[target])) {
        score += (rallyField.distance[source] - rallyField.distance[target]) * 18;
      }
      if (decision.branch === 'opening' || decision.branch === 'opening-route') {
        score += b.owner(target) === 0 ? 30 : -10;
      }
      if (b.enemy(target)) score += ['crown', 'city'].includes(b.kind(target)) ? 300 : stranded(b, b.owner(target), target);
      score -= Math.max(0, b.army[source] - b.army[target]) * 0.01;
      candidates.push({ action, score });
    }
    // Prefer a different branch from the same source.  Only search the rest
    // of the empire when the current corridor has no legal alternative.
    if (candidates.some(candidate => candidate.action.x === b.xy(from).x && candidate.action.y === b.xy(from).y)) break;
  }
  candidates.sort((a, z) => z.score - a.score);
  if (candidates[0]) {
    history.holdStreak = 0;
    history.reroutes += 1;
    return { ...candidates[0], branch: `${decision.branch || 'move'}-maze-reroute` };
  }
  history.holds += 1;
  history.holdStreak += 1;
  if (history.holdStreak >= 3) {
    const own = [];
    const enemies = [];
    for (let at = 0; at < b.size; at += 1) {
      if (b.own(at) && !b.isolated[at]) own.push(at);
      if (b.enemy(at) && !b.isolated[at]) enemies.push(at);
    }
    if (!constructionThreat(b, own, enemies)) {
      const objective = Number.isInteger(m.campaign?.at) && b.own(m.campaign.at) ? m.campaign.at : m.home;
      const objectiveField = Number.isInteger(objective) ? field(b, [objective]) : null;
      const sites = own.filter((at) => b.kind(at) === 'plain' && b.army[at] >= BUILD_COST + 8 &&
        b.army[at] - BUILD_COST > pressure(b, at) + 2)
        .map((at) => {
          const adjacentAnchor = b.neighbors(at).some((next) => b.own(next) && ['city', 'crown'].includes(b.kind(next)));
          const distance = objectiveField && Number.isFinite(objectiveField.distance[at]) ? objectiveField.distance[at] : 999;
          return { at, score: (adjacentAnchor ? 80 : 0) - distance + b.army[at] * 0.02 };
        })
        .sort((a, z) => z.score - a.score);
      if (sites[0]) {
        history.holdStreak = 0;
        return { action: build(b, sites[0].at), branch: 'maze-anchor-hold' };
      }
    }
  }
  return { action: null, branch: 'maze-hold' };
}

function safeMove(
  b,
  from,
  to,
  intent = 'move',
  modes = intent === 'gather' ? [0, 1, 2] : [2, 0, 1],
) {
  if (!movable(b, from) || !b.passable(to)) return null;
  const targetArmy = b.army[to];
  const enemy = !b.friendly(to);
  for (const mode of modes) {
    const send = computePush(b, from, to, mode);
    if (send <= 0 || (enemy && send <= targetArmy)) continue;
    const action = actionCoordinates(b, from, to, mode);
    if (b.enemy(to) && b.kind(to) === 'crown' && crownFinish(b, action)) return action;
    const left = b.army[from] - send;
    const arrive = enemy ? send - targetArmy : targetArmy + send;
    // Check the payload, not just the source stack or gather phase. A large
    // source can still yield only two soldiers after smart reservations.
    if (intent === 'campaign' && arrive < SMALL_COLUMN) continue;
    if (b.kind(from) === 'crown' && left < pressure(b, from, to)) continue;
    if (enemy && arrive < pressure(b, to, from) * 0.65 && intent !== 'cut') continue;
    if (left < pressure(b, from, to) && (stranded(b, b.playerId, from) + arrive) > 30) continue;
    return action;
  }
  return null;
}

function costlySupplyCuts(b) {
  const cuts = cutAnalysis(b, b.playerId);
  return [...cuts.points].filter((at) => cuts.mass[at] > FINISH_RESIDUE &&
    !b.isolated[at] && pressure(b, at) > b.army[at]);
}

function repairSupply(b, at) {
  // Reinforce or remove the attacker in one action. A delivery that would
  // arrive only after the threatened anchor falls is not an emergency repair.
  const needed = pressure(b, at);
  for (const from of b.neighbors(at)) {
    if (!b.own(at) || !b.own(from)) continue;
    const action = safeMove(b, from, at, 'gather');
    if (action && b.army[at] + computePush(b, from, at, action.mode) >= needed && !routeGuard(b, action).blocked) {
      return { action, branch: 'supply-defend' };
    }
  }
  for (const enemy of b.neighbors(at)) {
    if (!b.enemy(enemy) || b.isolated[enemy]) continue;
    for (const from of b.neighbors(enemy)) {
      const action = safeMove(b, from, enemy, 'cut');
      if (action && !routeGuard(b, action).blocked && !costlySupplyCuts(preview(b, action).after).length) {
        return { action, branch: 'supply-intercept' };
      }
    }
  }
  // Only the concrete one-hit threat opens this building window. Find a
  // funded cell inside the threatened branch, and verify that losing the old
  // city would no longer strand a substantial army after this exact build.
  const cuts = cutAnalysis(b, b.playerId);
  const sites = [];
  for (let site = 0; site < b.size; site += 1) {
    if (!b.own(site) || b.isolated[site] || b.kind(site) !== 'plain' || b.army[site] < BUILD_COST) continue;
    if (site !== at && !cuts.separates(at, site)) continue;
    if (b.army[site] - BUILD_COST < pressure(b, site)) continue;
    sites.push(site);
  }
  sites.sort((a, z) => b.army[z] - b.army[a]);
  for (const site of sites) {
    const action = build(b, site);
    const after = preview(b, action).after;
    if (!costlySupplyCuts(after).length) return { action, branch: 'supply-anchor' };
  }
  return null;
}

function anchorDefense(b) {
  const threats = enemyAnchorThreats(b)
    .sort((a, z) => Number(z.fatal) - Number(a.fatal) || z.detachedMass - a.detachedMass || z.send - a.send);
  for (const threat of threats) {
    // Remove the attacking head if a neighbouring stack can do so in one
    // legal action. This is preferable to pulling the crown backwards and
    // keeps the response local even on a long map.
    for (const from of b.neighbors(threat.source)) {
      if (!b.own(from) || b.isolated[from] || !movable(b, from)) continue;
      const action = safeMove(b, from, threat.source, 'cut');
      if (action && !routeGuard(b, action).blocked) return { action, branch: 'anchor-intercept' };
    }
    // If interception is unavailable, fill the tower with a full push. The
    // amount is checked against the exact simulated send, so this branch does
    // not spend a turn on a cosmetic one-unit reinforcement.
    for (const from of b.neighbors(threat.anchor)) {
      if (!b.own(from) || b.isolated[from] || !movable(b, from)) continue;
      const action = safeMove(b, from, threat.anchor, 'gather', [2, 0, 1]);
      if (!action) continue;
      const send = computePush(b, from, threat.anchor, action.mode);
      if (b.army[threat.anchor] + send > threat.send + 1) {
        return { action, branch: 'anchor-reinforce' };
      }
    }
    const repair = repairSupply(b, threat.anchor);
    if (repair) return { ...repair, branch: repair.branch || 'anchor-repair' };
  }
  const cuts = cutAnalysis(b, b.playerId);
  const endangered = costlySupplyCuts(b)
    .filter((at) => ['city', 'crown'].includes(b.kind(at)))
    .sort((a, z) => cuts.mass[z] - cuts.mass[a]);
  for (const at of endangered) {
    const repair = repairSupply(b, at);
    if (repair) return repair;
  }
  return null;
}

// Every chosen move, including tactics, funding and stall recovery, must use
// the same connectivity check. Otherwise a non-campaign branch can drain the
// very city the campaign guard is trying to preserve.
function secureDecision(b, decision) {
  if (!decision.action || decision.action.kind !== 'attack') return decision;
  const guard = routeGuard(b, decision.action);
  if (!guard.blocked) return decision;
  const from = b.idx(decision.action.x, decision.action.y);
  const to = b.idx(decision.action.dx, decision.action.dy);
  for (const mode of [0, 1, 2]) {
    if (mode === decision.action.mode) continue;
    const action = safeMove(b, from, to, decision.branch === 'march' ? 'campaign' : 'move', [mode]);
    if (action && !routeGuard(b, action).blocked) return { ...decision, action };
  }
  if (guard.anchor >= 0) return { action: build(b, guard.anchor), branch: 'route-anchor' };
  return repairSupply(b, guard.cut) || { action: null, branch: 'supply-hold' };
}

function supplyReservations(m) {
  const reserved = new Set([m.campaign?.at, m.delivery?.at, m.delivery?.root]);
  for (const [from, to] of m.delivery?.edges || []) { reserved.add(from); reserved.add(to); }
  return reserved;
}

function advanceSupplyTree(b, m, reason, canEnter) {
  const state = m.delivery;
  // Invalidate the whole route when ownership or a safety constraint changes.
  // Never continue an obsolete tree through an enemy-captured junction.
  if (state.edges.some(([from, to]) => !canEnter(from) || !canEnter(to))) {
    m.delivery = null;
    return null;
  }
  while (state.edges.length) {
    if (state.pending) {
      const [previousFrom] = state.edges[0];
      if (b.turn <= state.movedTurn) return null;
      if (b.army[previousFrom] >= state.pending.army) { m.delivery = null; return null; }
      state.edges.shift();
      state.pending = null;
      continue;
    }
    const [from, to] = state.edges[0];
    if (!movable(b, from)) { state.edges.shift(); continue; }
    const action = safeMove(b, from, to, 'gather');
    if (!action || routeGuard(b, action).blocked) { m.delivery = null; return null; }
    state.pending = { army: b.army[from] };
    state.at = to;
    state.movedTurn = b.turn;
    return { action, branch: `${reason}-tree` };
  }
  m.delivery = null;
  return null;
}

// Merge affordable tributaries BEFORE moving their shared trunk. Unlike
// round-robin convoys this traverses each shared edge once. The selected tree
// is frozen until delivery or invalidation, so growth cannot keep adding new
// sources and postpone the original delivery indefinitely.
function treeGather(b, m, root, need, reason, canEnter, f, sources) {
  const trunk = sources[0].p;
  const nodes = new Set(trunk);
  const spare = (at) => at === root ? 0 : Math.max(0, b.army[at] - Math.max(1, pressure(b, at)));
  let funds = trunk.reduce((sum, at) => sum + spare(at), 0);
  const deficit = need - b.army[root];
  let branches = 0;
  // A sufficient direct convoy is already cheaper; do not delay it merely
  // to exercise the tree mechanism.
  while (funds < deficit && branches < 4) {
    let best = null;
    for (const source of sources) {
      if (nodes.has(source.at)) continue;
      const extra = [];
      let junction = source.at;
      while (!nodes.has(junction) && junction >= 0) {
        extra.push(junction); junction = f.parent[junction];
      }
      if (junction < 0 || junction === root || extra.length > 4) continue;
      const mass = extra.reduce((sum, at) => sum + spare(at), 0);
      if (mass < 8 || nodes.size + extra.length > 160) continue;
      const score = Math.min(deficit - funds, mass) / extra.length;
      if (!best || score > best.score) best = { extra, mass, score };
    }
    if (!best) break;
    best.extra.forEach((at) => nodes.add(at));
    funds += best.mass;
    branches += 1;
  }
  if (!branches) return null;
  const edges = [...nodes].filter((at) => at !== root)
    // Drain leaves first.  If a shared trunk is moved toward the root before
    // its tributary arrives, that trunk edge is already consumed and the
    // branch's army stops one junction short of the objective.
    .sort((a, z) => f.distance[z] - f.distance[a] || a - z)
    .map((at) => [at, f.parent[at]]);
  m.delivery = { mode: 'tree', root, at: edges[0][0], edges, branches, movedTurn: -1 };
  return advanceSupplyTree(b, m, reason, canEnter);
}

// One objective owns the delivery; short deliveries finish before switching.
function gather(b, m, root, need, reason, canEnter = at => b.own(at) && !b.isolated[at], maxDistance = Infinity) {
  if (!b.own(root) || b.isolated[root] || b.army[root] >= need) { m.delivery = null; return null; }
  const treeActive = m.delivery?.mode === 'tree' && m.delivery.root === root;
  if (treeActive) {
    const decision = advanceSupplyTree(b, m, reason, canEnter);
    if (decision) return decision;
  }
  const f = field(b, [root], canEnter);
  if (m.delivery?.root === root && movable(b, m.delivery.at) && f.distance[m.delivery.at] > 0 && f.distance[m.delivery.at] <= maxDistance) {
    const at = m.delivery.at, to = f.parent[at];
    const a = safeMove(b, at, to, 'gather');
    if (a) { m.delivery = { root, at: to, movedTurn: b.turn }; return { action: a, branch: reason }; }
  }
  m.delivery = null;
  const sources = [];
  for (let at = 0; at < b.size; at++) {
    if (!movable(b, at) || at === root || !Number.isFinite(f.distance[at]) || f.distance[at] > maxDistance) continue;
    const spare = b.army[at] - Math.max(1, pressure(b, at));
    if (spare < 3) continue;
    const p = route(f, at), mass = p.slice(0, -1).reduce((sum, i) => sum + Math.max(0, b.army[i] - 1), 0);
    sources.push({ at, p, score: Math.min(need - b.army[root] + 50, mass) / (p.length - 1) });
  }
  sources.sort((a, z) => z.score - a.score);
  if (b.size >= 800 && reason === 'muster' && need - b.army[root] >= 80 && sources[0]?.p.length >= 9) {
    const decision = treeGather(b, m, root, need, reason, canEnter, f, sources);
    if (decision) return decision;
  }
  for (const s of sources) {
    const a = safeMove(b, s.at, s.p[1], 'gather');
    if (a) { m.delivery = { root, at: s.p[1], movedTurn: b.turn }; return { action: a, branch: reason }; }
  }
  return null;
}

function opening(b, m, own, enemyDistance) {
  const fogged = b.fog.some((value) => Number(value) !== 0);
  if (fogged) {
    const scout = fogScout(b, m, own);
    if (scout) return scout;
  }
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

// Fog hides ownership and army counts but leaves the terrain graph visible.
// Prefer a legal step across the visible perimeter into an unseen, passable
// cell so both sides eventually make contact. The old opening score favored
// compact cells near home; under fog that made each bot keep circling its own
// starting basin and spend the whole deadline building locally.
function fogScout(b, m, own) {
  const homeField = Number.isInteger(m.home) ? field(b, [m.home]) : null;
  const options = [];
  for (const from of own) {
    if (!movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (!b.passable(to) || b.owner(to) !== 0 || Number(b.fog[to]) === 0) continue;
      const action = safeMove(b, from, to, 'move');
      if (!action) continue;
      const hiddenExits = b.neighbors(to).filter((next) =>
        b.passable(next) && Number(b.fog[next]) !== 0,
      ).length;
      const homeDepth = homeField && Number.isFinite(homeField.distance[to])
        ? homeField.distance[to]
        : 0;
      options.push({
        action,
        branch: 'fog-scout',
        score: homeDepth * 8 + hiddenExits * 24 + Math.min(120, b.army[from]) * 0.08 -
          (b.kind(to) === 'swamp' ? 160 : 0),
      });
    }
  }
  options.sort((a, z) => z.score - a.score);
  return options[0] || null;
}

// A perfect maze is effectively a tree.  A generic perimeter expansion paints
// whichever branch happens to have the most empty neighbours, so both sides
// can spend the whole opening growing away from one another.  When the first
// enemy crown is visible, bias the next neutral capture along the shortest
// route to that crown.  This is still ordinary expansion (one legal adjacent
// action per tick); it simply chooses the branch that creates contact and a
// usable forward build line instead of scattering into dead ends.
function mazeOpening(b, m, own, enemyDistance) {
  const target = Number.isInteger(m.enemyHome) && b.enemy(m.enemyHome)
    ? m.enemyHome
    : (() => {
      for (let at = 0; at < b.size; at += 1)
        if (b.enemy(at) && b.kind(at) === 'crown') return at;
      return -1;
    })();
  if (target < 0) return opening(b, m, own, enemyDistance);
  const objective = field(b, [target]);
  const home = Number.isInteger(m.home) ? field(b, [m.home]) : null;
  const options = [];
  for (const from of own) {
    if (!movable(b, from) || !Number.isFinite(objective.distance[from])) continue;
    for (const to of b.neighbors(from)) {
      if (!b.passable(to) || b.owner(to) !== 0 || !Number.isFinite(objective.distance[to])) continue;
      const toward = objective.distance[from] - objective.distance[to];
      if (toward <= 0) continue;
      const action = safeMove(b, from, to, 'move');
      if (!action || routeGuard(b, action).blocked) continue;
      const exits = b.neighbors(to).filter((next) => b.passable(next) && b.owner(next) === 0).length;
      const homeDepth = home && Number.isFinite(home.distance[to]) ? home.distance[to] : 0;
      const enemyNear = Math.max(0, 8 - objective.distance[to]);
      options.push({
        action,
        branch: 'maze-opening',
        score: toward * 180 + homeDepth * 2 + exits * 12 +
          Math.min(100, b.army[from]) * 0.08 - enemyNear * 10 - (b.kind(to) === 'swamp' ? 160 : 0),
      });
    }
  }
  options.sort((a, z) => z.score - a.score);
  return options[0] || opening(b, m, own, enemyDistance);
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

function reposition(b, own) {
  const sources = own
    .filter((at) => movable(b, at))
    .sort((a, z) => b.army[z] - b.army[a]);
  for (const from of sources) {
    const neighbours = b.neighbors(from)
      .filter((to) => b.own(to) && !b.isolated[to] && b.army[from] > b.army[to] + 4)
      .sort((a, z) => b.army[a] - b.army[z]);
    for (const to of neighbours) {
      const action = safeMove(b, from, to, 'gather');
      if (action) return { action, branch: 'stalled-reposition' };
    }
  }
  return null;
}

function emergencyProbe(b, own) {
  const sources = own
    .filter((at) => movable(b, at))
    .sort((a, z) => b.army[z] - b.army[a]);
  for (const from of sources) {
    const targets = b.neighbors(from)
      .filter((to) => b.passable(to) && !b.friendly(to) && b.kind(to) !== 'swamp')
      .sort((a, z) => {
        const value = (at) => (b.kind(at) === 'crown' ? 10000 : b.kind(at) === 'city' ? 500 : b.enemy(at) ? 100 : 0);
        return value(z) - value(a);
      });
    for (const to of targets) {
      const mode = b.enemy(to) ? 0 : 2;
      const send = computePush(b, from, to, mode);
      if (send <= 0 || (b.enemy(to) && send <= b.army[to])) continue;
      const action = actionCoordinates(b, from, to, mode);
      if (routeGuard(b, action).blocked) continue;
      if (preview(b, action).ok) return { action, branch: 'stalled-probe' };
    }
  }
  return null;
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

// When a direct crown reinforcement cannot catch the incoming column, attack
// its supply articulation instead.  A defensive gather can be mathematically
// hopeless while a nearby cut still removes the entire hostile branch; leave
// this decision ahead of the fallback gather so defence does not become a
// passive loop beside an already doomed crown.
function defensiveCut(b, worst) {
  const owner = b.owner(worst.at);
  if (owner <= 0) return null;
  const cuts = cutAnalysis(b, owner);
  const candidates = [...cuts.points]
    .filter((at) => b.enemy(at) && !b.isolated[at] &&
      (at === worst.at || cuts.mass[at] >= 20 || cuts.land[at] >= 3))
    .sort((a, z) => (cuts.mass[z] - cuts.mass[a]) || (cuts.land[z] - cuts.land[a]));
  let best = null;
  for (const to of candidates) {
    for (const from of b.neighbors(to)) {
      if (!b.own(from) || b.isolated[from] || !movable(b, from)) continue;
      const action = safeMove(b, from, to, 'cut');
      if (!action) continue;
      const guard = routeGuard(b, action);
      if (guard.blocked) {
        // A defensive cut can intentionally leave a newly captured bridge
        // outside our old anchor graph.  Permit that trade when the enemy
        // branch removed by the cut is materially larger than the exposed
        // friendly tail; this is the emergency case where preserving the
        // tail simply loses the crown on the next tick.
        const result = preview(b, action);
        const ownCuts = cutAnalysis(result.after, b.playerId);
        const ownLoss = guard.cut >= 0 ? ownCuts.mass[guard.cut] : 0;
        const enemyGain = cuts.mass[to] || 0;
        if (enemyGain < Math.max(20, ownLoss * 1.05)) continue;
      }
      const score = cuts.mass[to] * 2 + cuts.land[to] * 20 - b.army[to] +
        (to === worst.at ? 40 : 0);
      if (!best || score > best.score) best = { action, branch: 'defense-cut', score };
    }
  }
  return best;
}

// A visible enemy column can approach a crown or command city through neutral
// land without ever touching our border.  In that case the first legal answer
// is a staged move toward a point on the enemy's actual route, not ordinary
// expansion.  This stays deliberately narrow: approachThreat supplies the
// same force/arrival gate as crown defence, and every emitted step still goes
// through safeMove, preview, and routeGuard.
function emergencyDefensiveCut(b, own) {
  const cuts = cutAnalysis(b, b.playerId);
  const targets = anchorCells(b, b.playerId)
    .filter((at) => b.own(at) && !b.isolated[at] && ['crown', 'city'].includes(b.kind(at)))
    .map((at) => ({ at, value: b.kind(at) === 'crown' ? 1000 : 500 }));
  for (const at of cuts.points) {
    if (b.own(at) && !b.isolated[at] && cuts.mass[at] >= FINISH_RESIDUE) {
      targets.push({ at, value: 220 + Math.min(180, cuts.mass[at]) });
    }
  }

  const options = [];
  for (const protectedTarget of targets) {
    const protectedAt = protectedTarget.at;
    const guard = localGuard(b, protectedAt);
    const threat = approachThreat(b, protectedAt, guard);
    if (!threat) continue;
    const threatOwner = b.owner(threat.at);
    const threatField = field(b, [protectedAt]);
    const threatPath = route(threatField, threat.at).reverse();
    const maxCutDistance = Math.min(8, Math.max(2, threat.distance - 1));
    for (let i = 1; i < threatPath.length - 1; i += 1) {
      const target = threatPath[i];
      if (!b.visible[target] || !b.passable(target) || b.own(target)) continue;
      if (threatField.distance[target] < 2 || threatField.distance[target] > maxCutDistance) continue;
      // Do not blindly march through the threatening player's visible army.
      // Other visible owners remain valid route cells: the emergency rule is
      // allowed to cross their land when that is the only legal approach.
      const canEnter = (at) => b.visible[at] && b.passable(at) &&
        (!b.enemy(at) || b.owner(at) !== threatOwner || at === target);
      const supply = distanceField(b, own.filter((at) => movable(b, at)), canEnter);
      if (!Number.isFinite(supply.distance[target])) continue;
      const path = route(supply, target).reverse();
      if (path.length < 2) continue;
      const from = path[0];
      const next = path[1];
      if (!movable(b, from)) continue;
      const action = safeMove(b, from, next, 'cut');
      if (!action || !preview(b, action).ok || routeGuard(b, action).blocked) continue;
      const routeCost = path.length - 1;
      const terrainPenalty = b.kind(next) === 'swamp' ? 8 : 0;
      const foreignBonus = b.owner(next) > 0 && !b.own(next) ? 12 : 0;
      const targetValue = protectedTarget.value;
      options.push({
        action,
        branch: 'emergency-defense-cut',
        score: targetValue + (maxCutDistance - threatField.distance[target]) * 30 - routeCost * 8 -
          terrainPenalty + foreignBonus + threat.force * 0.05,
      });
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
    const guard = localGuard(b, crown);
    // A long approach is an emergency only while this is the sole crown.
    // Once a second crown exists, a distant stack must not freeze every
    // campaign around a disposable outpost; direct tower captures are still
    // handled by enemyAnchorThreats below.
    const approach = crowns.length === 1 ? approachThreat(b, crown, guard) : null;
    if (approach && b.army[crown] < approach.need) {
      // Fill the threatened crown with a full local column first. Smart split
      // deliberately leaves a reserve for neighbouring fronts, but that is
      // the wrong trade when a saved enemy stack is already approaching the
      // only crown. The next call can then pull the next tributary in turn.
      const direct = [...b.neighbors(crown)]
        .filter((from) => b.own(from) && !b.isolated[from] && movable(b, from))
        .sort((a, z) => b.army[z] - b.army[a]);
      for (const from of direct) {
        const action = safeMove(b, from, crown, 'gather', [2, 0, 1]);
        if (action) return { action, branch: 'anchor-approach' };
      }
      const emergency = emergencyDefensiveCut(b, own);
      if (emergency) return emergency;
      const delivery = gather(b, m, crown, approach.need, 'anchor-approach');
      if (delivery) return delivery;
    }
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
      const { arrival } = routeArrival(b, f, at);
      const shortage=arrival-b.army[crown]-f.distance[at];
      // A stationary blob several steps away is not an emergency.  Requiring
      // either a short arrival window or a large margin prevents defence from
      // cancelling every campaign whenever the opponent merely owns a large
      // border stack.
      const imminent = f.distance[at] <= 2;
      const savedMass = arrival + Math.max(18, f.distance[at] * 2) > guard;
      if(shortage>0 && (imminent || advancing || savedMass) && (!worst || shortage/(f.distance[at]+1)>worst.score)) worst={at,crown,eta:f.distance[at],need:arrival+3,score:shortage/(f.distance[at]+1)};
    }
  }
  // This check also handles a rear approach that has not entered our territory
  // yet, so it must run even when the local six-cell `worst` scan found nothing.
  if (worst) {
    // Intercept at the head or at its actual supply cut, before pulling a crown.
    for(const from of b.neighbors(worst.at)) if(b.own(from)) { const a=safeMove(b,from,worst.at,'cut'); if(a)return {action:a,branch:'intercept'}; }
  }
  const emergency = emergencyDefensiveCut(b, own);
  if (emergency) return emergency;
  if(!worst) return null;
  const cut = defensiveCut(b, worst);
  if (cut) return cut;
  const delivery = gather(b,m,worst.crown,worst.need,'defend');
  if (delivery) return delivery;
  // The local crown may still be impossible to save, while a broader enemy
  // articulation is attackable from another branch.  Use that last-resort
  // cut before yielding the tick to economy or a new campaign.
  const fallback = strategicCut(b, own);
  return fallback ? { ...fallback, branch: 'defense-cut' } : null;
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
  const enemies = [];
  for (let at = 0; at < b.size; at += 1) if (b.enemy(at) && !b.isolated[at]) enemies.push(at);
  if (constructionThreat(b, own, enemies)) return null;
  if (own.filter((i) => b.kind(i) === 'crown').length >= goal && !m.buildPlan) return null;

  const validSite = (at) => b.own(at) && !b.isolated[at] &&
    (b.kind(at) === 'plain' || b.kind(at) === 'city') &&
    (ed.distance[at] === Infinity || ed.distance[at] >= 4);

  // Keep a short, contiguous construction plan. A plan is deliberately
  // stateful: after a foundation is built, the same cell is upgraded next;
  // only then is the adjacent cell selected. This produces a compact crown
  // cluster instead of scattering one half-funded city across the map.
  if (m.buildPlan) {
    while (m.buildPlan.index < m.buildPlan.cells.length) {
      const at = m.buildPlan.cells[m.buildPlan.index];
      if (!validSite(at)) {
        m.buildPlan.index += 1;
        continue;
      }
      const kind = b.kind(at);
      const need = kind === 'city' ? BUILD_COST : BUILD_COST * 2;
      if (b.army[at] >= need) {
        m.buildPlan.stalled = 0;
        return {
          action: build(b, at, kind === 'city' ? 'c' : 'b'),
          branch: kind === 'city' ? 'cluster-upgrade' : 'cluster-foundation',
        };
      }
      const funding = gather(b, m, at, need + 1, 'cluster-fund');
      if (funding) return funding;
      // No safe local delivery is available. Leave the plan intact so the
      // next economy window can retry, but let the military planner act now.
      return null;
    }
    m.buildPlan = null;
  }

  const anchors = anchorCells(b, b.playerId).filter((at) => b.own(at) && !b.isolated[at]);
  if (!anchors.length) return null;
  const anchorDistance = field(b, anchors, (at) => b.own(at) && !b.isolated[at]);
  const candidate = own.filter(validSite);
  if (!candidate.length) return null;

  const anchorNeighbours = (at) => b.neighbors(at).filter((next) =>
    b.own(next) && ['city', 'crown'].includes(b.kind(next))).length;
  const siteScore = (at) => {
    const kind = b.kind(at);
    const adjacent = anchorNeighbours(at);
    const distance = anchorDistance.distance[at];
    const front = Number.isFinite(ed.distance[at]) ? Math.min(ed.distance[at], 12) : 12;
    return (kind === 'city' ? 320 : 0) + adjacent * 180 +
      (Number.isFinite(distance) ? Math.max(0, 8 - distance) * 18 : -80) +
      Math.min(180, b.army[at]) * 0.35 + front * 8;
  };
  candidate.sort((a, z) => siteScore(z) - siteScore(a));
  const seed = candidate[0];
  const cells = [seed];
  const used = new Set(cells);
  // Reserve a cluster only for funds that already exist in the safe rear.
  // This keeps the plan contiguous without promising four construction sites
  // when the board can currently finance only one of them.
  const crowns = own.filter((at) => b.kind(at) === 'crown').length;
  const available = own.reduce((sum, at) =>
    sum + Math.max(0, b.army[at] - Math.max(1, pressure(b, at))), 0);
  const clusterSize = Math.min(BUILD_CLUSTER_SIZE, Math.max(1, goal - crowns),
    Math.max(1, Math.floor(available / 110)));
  while (cells.length < clusterSize) {
    const frontier = [];
    for (const base of cells) {
      for (const next of b.neighbors(base)) {
        if (used.has(next) || !validSite(next)) continue;
        const adjacency = cells.filter((cell) => b.neighbors(cell).includes(next)).length;
        frontier.push({
          at: next,
          score: adjacency * 150 + anchorNeighbours(next) * 80 +
            (b.kind(next) === 'city' ? 280 : 0) + Math.min(150, b.army[next]) * 0.25 +
            (Number.isFinite(ed.distance[next]) ? Math.min(ed.distance[next], 10) * 5 : 50),
        });
      }
    }
    if (!frontier.length) break;
    frontier.sort((a, z) => z.score - a.score);
    const next = frontier[0].at;
    used.add(next);
    cells.push(next);
  }
  m.buildPlan = { cells, index: 0, seed, started: b.turn };
  return economy(b, m, own, ed, goal);
}

// Maze maps have fewer useful build cells than open maps, but every connected
// crown still adds a full production lane.  Keeping the generic six-crown
// ceiling on a corridor lets Anti-Human compound its lead while Apex is still
// marching through neutral cells.  The caller supplies a larger, bounded goal
// only when the board is actually maze-like.
function mazeEconomyGoal(b, own, enemies) {
  const crowns = own.filter((at) => b.kind(at) === 'crown').length;
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
  const territoryGoal = Math.ceil(own.length / 7);
  return Math.min(12, Math.max(8, crowns + 1, enemyCrowns, territoryGoal));
}

// Long travel is an investment window. Use only nearby rear troops, with a
// separate delivery cursor, so construction cannot reverse a military convoy.
function sustainEconomy(b, m, own, ed, enemies) {
  if (b.turn < ECON_DEADLINE) return null;
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown');
  if (!enemyCrowns.length) return null;
  if (constructionThreat(b, own, enemies)) return null;
  const cf = field(b, enemyCrowns);
  const head =
    m.campaign && b.own(m.campaign.at)
      ? m.campaign.at
      : own.reduce((best, at) => (b.army[at] > b.army[best] ? at : best), own[0]);
  const distance = cf.distance[head];
  // Do not stop a breach already within striking distance of the enemy core.
  if (!Number.isFinite(distance) || distance < 24) {
    // A rear project selected before the spearhead arrived must not continue
    // consuming turns after the campaign enters its finishing corridor.
    // Abandon only the remote project; a safe frontline project remains valid
    // and can finish without pulling the assault stack backwards.
    if (m.rearEconomy?.site >= 0 && !m.rearEconomy.front) {
      m.rearEconomy.site = -1;
      m.rearEconomy.delivery = null;
      m.rearEconomy.spent = 0;
      m.rearEconomy.nextWindow = b.turn + 12;
    }
    return null;
  }
  const crowns = own.filter((at) => b.kind(at) === 'crown').length;
  const infrastructureCap = b.size >= 1600 ? 36 : b.size >= 800 ? 28 : 24;
  const goal = Math.min(infrastructureCap, Math.max(ECON_GOAL, enemyCrowns.length + 2, Math.ceil(own.length / 8)));
  const state = m.rearEconomy || (m.rearEconomy = { site: -1, delivery: null, spent: 0, nextWindow: 0 });
  const mazeBoard = m.maze ?? isMazeBoard(b);
  if (b.turn < state.nextWindow) return null;
  // A rear project selected before a maze assault must not keep consuming the
  // sparse investment windows after the spearhead reaches the corridor.  Let
  // the next window look for a funded post beside the head instead.
  if (mazeBoard && m.campaign?.phase === 'attack' && state.site >= 0 && !state.front) {
    state.site = -1;
    state.delivery = null;
    state.spent = 0;
  }
  const reserved = supplyReservations(m);
  const canEnter = (at) => b.own(at) && !b.isolated[at] && ed.distance[at] >= 4 && !reserved.has(at);
  const validSite = (at) => b.own(at) && !b.isolated[at] && !reserved.has(at) &&
    ed.distance[at] >= (state.front ? (mazeBoard ? 2 : 4) : 6) &&
    ['plain', 'city'].includes(b.kind(at));
  if (!validSite(state.site)) {
    state.site = -1;
    state.delivery = null;
    state.front = false;
  }
  if (crowns >= goal && state.site < 0) return null;
  if (state.site < 0) {
    const frontField = m.campaign && b.own(m.campaign.at)
      ? field(b, [m.campaign.at], (at) => b.own(at) && !b.isolated[at])
      : null;
    // A frontline project does not have to be funded by the single cell on
    // which it is built.  On a large board that cell is often a fresh plain
    // with only a small garrison, while two or three safe neighbours already
    // contain enough spare army.  Check the local six-step neighbourhood and
    // use it as a bounded supply tree; this prevents a rear stack from walking
    // the entire campaign corridor just to pay for a city.
    const frontDistance = mazeBoard ? 2 : 4;
    const frontCanEnter = (cell) => b.own(cell) && !b.isolated[cell] &&
      ed.distance[cell] >= frontDistance && !reserved.has(cell);
    const frontCandidates = own
      .filter((at) => !reserved.has(at) && frontField && frontField.distance[at] > 0 && frontField.distance[at] <= 5 &&
        ed.distance[at] >= frontDistance && ['plain', 'city'].includes(b.kind(at)))
      .map((at) => {
        const need = b.kind(at) === 'city' ? BUILD_COST + 1 : BUILD_COST * 2 + 1;
        const local = field(b, [at], frontCanEnter);
        const localSpare = own.reduce((sum, source) => {
          if (source === at || !Number.isFinite(local.distance[source]) || local.distance[source] > 6) return sum;
          return sum + Math.max(0, b.army[source] - Math.max(1, pressure(b, source)));
        }, Math.max(0, b.army[at]));
        return {
          at,
          need,
          localSpare,
          localDistance: local.distance[at],
          score: (b.army[at] >= need ? 900 : 0) + (6 - frontField.distance[at]) * 140 + (b.kind(at) === 'city' ? 320 : 0) +
            Math.min(200, b.army[at]) + Math.min(120, localSpare) * 0.35 + ed.distance[at] * 2,
        };
      })
      .filter((candidate) => candidate.localSpare >= candidate.need)
      .sort((a, z) => z.score - a.score);
    if (frontCandidates.length) {
      state.site = frontCandidates[0].at;
      state.front = true;
    }
    // If no funded frontline site exists, search a bounded rear neighbourhood;
    // every selected project can already afford both construction actions
    // without waiting for growth.
    const candidates = own
      .filter(validSite)
      .map((at) => {
        const adjacent = b.neighbors(at).filter((i) => b.own(i) && b.kind(i) === 'crown').length;
        return { at, score: adjacent * 180 + (b.kind(at) === 'city' ? 320 : 0) + Math.min(200, b.army[at]) };
      })
      .sort((a, z) => z.score - a.score);
    if (state.site < 0) for (const { at } of candidates) {
      const local = [at],
        seen = new Set(local),
        distances = [0];
      let funds = 0;
      for (let h = 0; h < local.length; h++) {
        const cell = local[h];
        funds += Math.max(0, b.army[cell] - 1);
        if (distances[h] === 5) continue;
        for (const next of b.neighbors(cell))
          if (!seen.has(next) && canEnter(next)) {
            seen.add(next);
            local.push(next);
            distances.push(distances[h] + 1);
          }
      }
      if (funds < (b.kind(at) === 'city' ? BUILD_COST + 1 : BUILD_COST * 2 + 1)) continue;
      state.site = at;
      state.front = false;
      break;
    }
  }
  if (state.site < 0) return null;
  const at = state.site,
    kind = b.kind(at),
    need = kind === 'city' ? BUILD_COST + 1 : BUILD_COST * 2 + 1;
  let decision;
  if (b.army[at] >= need) {
    decision = {
      action: build(b, at, kind === 'city' ? 'c' : 'b'),
      branch: kind === 'city' ? 'rear-upgrade' : 'rear-foundation',
    };
    if (kind === 'city') {
      state.site = -1;
      state.front = false;
      state.delivery = null;
    }
  } else {
    decision = gather(b, state, at, need, state.front ? 'front-fund' : 'rear-fund', canEnter, state.front ? 6 : 5);
  }
  if (!decision) {
    state.nextWindow = b.turn + 8;
    state.spent = 0;
    return null;
  }
  state.spent += 1;
  // Finish foundation + crown together, then give the campaign time to move.
  if (decision.branch === 'rear-upgrade' || (state.spent >= 8 && decision.branch !== 'rear-foundation')) {
    state.nextWindow = b.turn + 12;
    state.spent = 0;
  }
  return decision;
}

// When a campaign is still gathering on a large board, a safe one-step push
// near its head is often cheaper than repeatedly moving the same rear stack
// through a long corridor.  This is deliberately a narrow window: it only
// fires while the campaign is stalled in muster, only uses cells at least
// four steps from the enemy, and never consumes the campaign root or its
// active delivery cursor.  The resulting local bridge can later fund a
// frontline city through sustainEconomy().
function forwardExpansion(b, m, own, ed, enemies) {
  if (b.size < 800 || b.turn < 70 || !m.campaign || m.campaign.phase !== 'gather') return null;
  if (m.forwardGrowthNext !== undefined && b.turn < m.forwardGrowthNext) return null;
  const campaign = m.campaign;
  if (!Number.isInteger(campaign.at) || !b.own(campaign.at) || b.isolated[campaign.at]) return null;
  const targetField = Number.isInteger(campaign.crown) ? field(b, [campaign.crown]) : null;
  const longRoute = targetField && Number.isFinite(targetField.distance[campaign.at]) && targetField.distance[campaign.at] >= 20;
  if (!longRoute) return null;
  const enemyLand = enemies.length;
  if (own.length >= Math.max(55, enemyLand * 1.05)) {
    m.forwardGrowthNext = b.turn + 12;
    return null;
  }
  const frontField = field(b, [campaign.at], (at) => b.own(at) && !b.isolated[at]);
  const reserved = supplyReservations(m);
  reserved.add(m.rearEconomy?.site);
  const options = [];
  for (const from of own) {
    if (reserved.has(from) || !movable(b, from) || frontField.distance[from] > 4) continue;
    for (const to of b.neighbors(from)) {
      if (reserved.has(to) || b.owner(to) !== 0 || !b.passable(to) || b.kind(to) === 'swamp') continue;
      if (ed.distance[to] < 5) continue;
      const action = safeMove(b, from, to, 'gather');
      if (!action || routeGuard(b, action).blocked) continue;
      const room = b.neighbors(to).filter((next) => b.passable(next) && b.owner(next) === 0).length;
      options.push({
        action,
        score: (5 - frontField.distance[from]) * 90 + Math.min(80, ed.distance[to]) * 3 + room * 12 +
          Math.min(120, b.army[from]) * 0.15,
      });
    }
  }
  m.forwardGrowthNext = b.turn + (options.length ? 10 : 5);
  options.sort((a, z) => z.score - a.score);
  return options[0] ? { ...options[0], branch: 'forward-expansion' } : null;
}

// Paint a second safe lane on very large boards when the active campaign is
// not under attack.  This keeps the nearest local sources close to the front
// and is cheaper than asking one rear stack to cross the whole map for every
// muster or construction project.
function broadExpansion(b, m, own, ed, enemies) {
  if (b.size < 800 || b.turn < 55) return null;
  if (m.rearEconomy?.site >= 0 || (m.campaign?.phase === 'attack' && b.army[m.campaign.at] >= 18)) return null;
  if (m.broadGrowthNext !== undefined && b.turn < m.broadGrowthNext) return null;
  if (own.length >= Math.max(60, enemies.length * 0.98)) {
    m.broadGrowthNext = b.turn + 14;
    return null;
  }
  const homeField = Number.isInteger(m.home) ? field(b, [m.home], (at) => b.own(at) && !b.isolated[at]) : null;
  const reserved = supplyReservations(m);
  const options = [];
  for (const from of own) {
    if (reserved.has(from) || !movable(b, from)) continue;
    for (const to of b.neighbors(from)) {
      if (reserved.has(to) || b.owner(to) !== 0 || !b.passable(to) || b.kind(to) === 'swamp') continue;
      if (ed.distance[to] < 5) continue;
      const action = safeMove(b, from, to, 'gather');
      if (!action || routeGuard(b, action).blocked) continue;
      const room = b.neighbors(to).filter((next) => b.passable(next) && b.owner(next) === 0).length;
      const depth = homeField && Number.isFinite(homeField.distance[from]) ? homeField.distance[from] : 0;
      options.push({
        action,
        score: depth * 4 + Math.min(80, ed.distance[to]) * 2 + room * 10 + Math.min(120, b.army[from]) * 0.12,
      });
    }
  }
  m.broadGrowthNext = b.turn + (options.length ? 8 : 5);
  options.sort((a, z) => z.score - a.score);
  return options[0] ? { action: options[0].action, branch: 'broad-expansion' } : null;
}

// Large boards need a second clock besides the active crown campaign. A long
// convoy can occupy the nearest stack for hundreds of ticks while the opponent
// keeps painting the neutral rear. Spend a sparse, deterministic window on a
// safe rear expansion, leaving the campaign root and its delivery cursor
// untouched.
function rearExpansion(b, m, own, ed, enemies) {
  if (b.size < 800 || b.turn < 45) return null;
  if (m.rearGrowthNext !== undefined && b.turn < m.rearGrowthNext) return null;
  const enemyLand = enemies.length;
  if (own.length >= Math.max(60, enemyLand * 0.92)) {
    m.rearGrowthNext = b.turn + 12;
    return null;
  }
  const crowns = enemies.filter((at) => b.kind(at) === 'crown');
  if (!crowns.length) return null;
  const core = field(b, crowns);
  if (m.campaign && Number.isFinite(core.distance[m.campaign.at]) && core.distance[m.campaign.at] < 16) {
    m.rearGrowthNext = b.turn + 4;
    return null;
  }
  const reserved = supplyReservations(m);
  reserved.add(m.rearEconomy?.site);
  const rear = own.filter(
    (at) => !reserved.has(at) && ed.distance[at] >= 5 && b.kind(at) !== 'swamp',
  );
  const action = opening(b, m, rear, ed);
  const growthInterval = b.size >= 1600 ? (action ? 2 : 1) : (action ? 4 : 2);
  m.rearGrowthNext = b.turn + growthInterval;
  return action ? { ...action, branch: 'rear-expansion' } : null;
}

function chooseCampaign(b,m,own) {
  const crowns=[];
  for(let i=0;i<b.size;i++)if(b.enemy(i)&&b.kind(i)==='crown')crowns.push(i);
  if(!crowns.length) return null;
  const mazeBoard = m.maze ?? isMazeBoard(b);
  const maritime = swampRatio(b, m) > 0.3 && swampRatio(b, m) < 0.55;
  const campaignStrength = maritime ? 0.15 : CAMPAIGN_STRENGTH_DEFAULT;
  const campaignReadiness = maritime ? 0.2 : CAMPAIGN_READINESS;
  if (m.blocked && b.turn >= m.blocked.until) m.blocked = null;
  if (m.campaign && m.delivery?.root === m.campaign.at) {
    if (m.delivery.mode === 'tree' && m.delivery.movedTurn === b.turn - 1) m.campaign.lastProgress = b.turn;
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
    const targetField = Number.isInteger(m.campaign.crown) ? field(b, [m.campaign.crown]) : null;
    const crownDistance = targetField ? targetField.distance[m.campaign.at] : Infinity;
    const routeProgress = Number.isFinite(crownDistance) &&
      (m.campaign.bestCrownDistance === undefined || crownDistance < m.campaign.bestCrownDistance);
    const phaseChanged = m.campaign.lastPhase !== m.campaign.phase;
    const phaseLimit = m.campaign.phase === 'attack' ? CAMPAIGN_ATTACK_TIMEOUT : CAMPAIGN_GATHER_TIMEOUT;
    // Army growth alone is not campaign progress.  A blocked rally root must
    // eventually be abandoned even when its crown keeps producing units.
    if (routeProgress) m.campaign.bestCrownDistance = crownDistance;
    if (phaseChanged || m.campaign.lastAt !== m.campaign.at || routeProgress) {
      m.campaign.lastAt = m.campaign.at;
      m.campaign.lastProgress = b.turn;
      m.campaign.lastPhase = m.campaign.phase;
    } else if (b.turn - (m.campaign.lastProgress ?? m.campaign.started) > phaseLimit) {
      const blockCooldown = mazeBoard ? Math.max(48, CAMPAIGN_BLOCK_COOLDOWN * 3) : CAMPAIGN_BLOCK_COOLDOWN;
      m.blocked = { crown: m.campaign.crown, until: b.turn + blockCooldown };
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

    // A captured crown is a breach, not the end of the operation.  Reusing
    // the breach as the next rally root keeps the assault moving through a
    // compact crown cluster.  The old selector preferred a large rear stack,
    // which made every subsequent crown start another long march and left
    // the spearhead idle at the first captured crown.
    if (hintAt >= 0 && b.own(hintAt) && !b.isolated[hintAt] && b.army[hintAt] > 1) {
      let next = null;
      for (const crown of crowns) {
        const f = field(b, [crown]);
        const distance = f.distance[hintAt];
        if (!Number.isFinite(distance)) continue;
        const path = route(f, hintAt);
        const resistance = path.slice(1).reduce(
          (sum, cell) => sum + (b.friendly(cell) ? 0 : b.army[cell] + 1),
          0,
        );
        const coreBias = crown === m.enemyHome ? (mazeBoard ? -1200 : -260) : 0;
        const score = distance * 12 + resistance * 0.35 + b.army[crown] * 0.05 + coreBias;
        if (!next || score < next.score) next = { crown, score, distance };
      }
      if (next) {
        m.campaign = {
          crown: next.crown,
          at: hintAt,
          score: -next.score,
          phase: 'gather',
          started: b.turn,
          lastPhase: 'gather',
          lastProgress: b.turn,
          deliveryBestDistance: Infinity,
          bestCrownDistance: next.distance,
        };
      }
    }
    let best=null;
    if (!m.campaign) for(const crown of crowns) {
      if (m.blocked && m.blocked.crown === crown && b.turn < m.blocked.until) continue;
      const f=field(b,[crown]);
      for(const at of own)if(b.army[at]>2 && Number.isFinite(f.distance[at])){
        const path = route(f, at);
        const resistance = path.slice(1).reduce((sum, cell) => sum + (b.friendly(cell) ? 0 : b.army[cell] + 1), 0);
        const readiness = b.army[at] - resistance;
        // The first enemy crown is the only stable proxy for the original
        // core. A moderate bias keeps it ahead of disposable frontier crowns
        // when reachable, while distance and route resistance still prevent
        // an impossible cross-map commitment.
        const coreBias = crown === m.enemyHome ? (mazeBoard ? 1800 : 450) : 0;
        const score=-f.distance[at]*2.5-resistance*0.18-b.army[crown]*0.08+
          coreBias + b.army[at]*campaignStrength + Math.max(-120, Math.min(120, readiness))*campaignReadiness;
        const recovery = recoveryField && Number.isFinite(recoveryField.distance[at])
          ? -recoveryField.distance[at] * 4
          : 0;
        const adjusted = score + recovery;
        if(!best||adjusted>best.score)best={crown,at,score:adjusted,phase:'gather',started:b.turn,lastPhase:'gather',lastProgress:b.turn,deliveryBestDistance:Infinity,bestCrownDistance:f.distance[at]};
      }
    }
    if (!best && m.blocked && b.turn >= m.blocked.until) m.blocked = null;
    m.campaign=best;
  }
  const c=m.campaign;
  if(!c) return null;
  const f=field(b,[c.crown]);
  // A failed push can leave the campaign root nearly empty while stronger
  // stacks remain elsewhere. Rebase the same crown campaign instead of
  // sending repeated deliveries into a dead corridor.
  const rootArmy = b.army[c.at] || 0;
  const brokenSpearhead = c.phase === 'attack' && rootArmy < 12;
  const stalledMazeGather = mazeBoard && c.phase === 'gather' && rootArmy < 18 &&
    b.turn - c.started >= 12 && (c.recoveryRebases || 0) < 3;
  if (stalledMazeGather) {
    m.delivery = null;
    const bestDistance = Number.isFinite(c.bestCrownDistance) ? c.bestCrownDistance : f.distance[c.at];
    const alternatives = own
      .filter((at) => at !== c.at && b.army[at] > rootArmy + 20 && Number.isFinite(f.distance[at]))
      .sort((a, z) => {
        const zScore = b.army[z] - f.distance[z] * 2;
        const aScore = b.army[a] - f.distance[a] * 2;
        return zScore - aScore;
      });
    const replacement = alternatives.find((at) =>
      f.distance[at] + 1 < bestDistance || f.distance[at] <= bestDistance + 36,
    );
    if (replacement !== undefined) {
      c.at = replacement;
      c.phase = 'gather';
      c.started = b.turn;
      c.lastAt = c.at;
      c.lastProgress = b.turn;
      c.deliveryBestDistance = Infinity;
      c.bestCrownDistance = f.distance[c.at];
      c.recoveryRebases = (c.recoveryRebases || 0) + 1;
      return chooseCampaign(b, m, own);
    }
  }
  if (b.turn - c.started >= CAMPAIGN_REBASE_AFTER &&
      ((c.phase === 'gather' && rootArmy < 18) || brokenSpearhead)) {
    const bestDistance = Number.isFinite(c.bestCrownDistance) ? c.bestCrownDistance : f.distance[c.at];
    const alternatives = own
      .filter((at) => at !== c.at && b.army[at] > rootArmy + 40 && Number.isFinite(f.distance[at]) &&
        (f.distance[at] + 1 < bestDistance ||
          (brokenSpearhead && (c.recoveryRebases || 0) < 2) ||
          (mazeBoard && c.phase === 'gather' && (c.recoveryRebases || 0) < 3 &&
            f.distance[at] <= bestDistance + 36)))
      .sort((a, z) => (b.army[z] - f.distance[z] * 2) - (b.army[a] - f.distance[a] * 2));
    if (alternatives.length) {
      c.at = alternatives[0];
      c.phase = 'gather';
      c.started = b.turn;
      c.lastAt = c.at;
      c.lastProgress = b.turn;
      c.bestCrownDistance = Math.min(bestDistance, f.distance[c.at]);
      c.recoveryRebases = (c.recoveryRebases || 0) + 1;
      m.delivery = null;
    }
  }
  let walls = 0;
  for (let at = 0; at < b.size; at += 1) if (b.kind(at) === 'mountain') walls += 1;
  // Weighted routing is valuable in obstacle-rich maps, where a short path
  // through the opponent's main spine is usually a trap.  Swamp-heavy maps
  // already have sparse usable lanes; adding a detour there only delays the
  // decisive push.
  const longBoardRoute = b.size >= 800 && Number.isFinite(f.distance[c.at]) && f.distance[c.at] >= 20;
  const p = (walls > b.size * 0.25 || longBoardRoute)
    ? (weightedRoute(b,c.at,c.crown) || route(f,c.at))
    : route(f,c.at);
  if(p.length<2)return null;
  let resistance=0;
  for(const i of p.slice(1))if(!b.friendly(i)) resistance+=b.army[i]+(b.kind(i)==='crown'?p.length:0)+1;
  // Attack on the first decisive window instead of waiting for a perfect
  // stack.  The reserve is enough to absorb rounding and one counter-push,
  // while the route itself keeps growing every tick if we wait for a 35%
  // surplus.
  // Once only a few crowns remain, the operation is in the finishing phase.
  // A fixed 120-unit muster is wasteful there: the next crown in a compact
  // cluster may have only a few defenders, and waiting for another full army
  // lets it keep producing units while the spearhead sits idle.
  const minimumDesired = crowns.length <= 3 ? 18 : 120;
  const rawDesired=Math.max(minimumDesired,resistance+Math.max(20,resistance*FORCE_MARGIN));
  const ownTotal = own.reduce((sum, at) => sum + b.army[at], 0);
  const urgencyCap = Math.max(260, ownTotal * MULTI_CROWN_CAP);
  const desired = Math.min(rawDesired, urgencyCap);

  // The full path resistance is a useful estimate for the eventual crown
  // capture, but it is the wrong gate for the first move.  On a maze it can
  // include every enemy cell in a long corridor, so the old planner kept
  // feeding the rally root for dozens of turns while the opponent closed the
  // map.  Open the corridor as soon as the spearhead can take its first
  // hostile cell (or can safely advance through friendly land); later cells
  // are handled one by one as the column moves forward.
  let firstHostile = -1;
  for (let i = 1; i < p.length; i += 1) {
    if (b.enemy(p[i])) { firstHostile = p[i]; break; }
  }
  const firstContactNeed = firstHostile >= 0
    ? Math.max(18, b.army[firstHostile] + 8)
    : 18;
  const musterTurns = c.musterTurns || 0;
  // Do not launch a token column merely because the first visible cell is
  // weak.  It still needs a meaningful fraction of the eventual push, with a
  // ceiling so a long maze cannot demand the sum of every enemy stack before
  // moving.  This turns a long muster into a staged attack without feeding a
  // twenty-unit spearhead into the first counter-cut.
  const breakthroughThreshold = mazeBoard
    ? Math.min(desired, Math.max(firstContactNeed + 8, Math.min(96, desired * 0.45)))
    : Math.min(
      desired,
      Math.max(firstContactNeed, Math.min(160, desired * 0.65)),
    );
  const forcedMazeBreak = mazeBoard && musterTurns >= 36 &&
    b.army[c.at] >= Math.max(24, firstContactNeed);
  const breakthroughReady = b.army[c.at] >= breakthroughThreshold && musterTurns >= 2 || forcedMazeBreak;
  if (c.phase === 'gather') {
    c.musterTurns = musterTurns + 1;
    if (breakthroughReady) {
      c.phase = 'attack';
      c.lastPhase = 'gather';
      c.lastProgress = b.turn;
      c.musterTurns = 0;
    }
  }
  if(c.phase==='gather'&&b.army[c.at]<desired) {
    // A narrow campaign that has already reached the final approach should
    // change the enemy graph before paying for another long convoy.  When the
    // next head move is unavailable, a strategic cut of the opponent's
    // supply branch is often the only useful action; repeatedly gathering the
    // same rear route just lets the opponent add another crown.
    if (mazeBoard && Number.isFinite(c.bestCrownDistance) && c.bestCrownDistance > 10 && c.bestCrownDistance <= 18 &&
        b.turn - c.started >= 8) {
      const escapeCut = strategicCut(b, own) || frontierStrike(b, own);
      if (escapeCut) return { ...escapeCut, branch: 'campaign-cut' };
    }
    const delivery = gather(b, m, c.at, desired, 'muster');
    if(delivery)return delivery;
    // A severed spearhead can remain technically connected while no source
    // can safely reach it.  Waiting for the normal campaign timeout here
    // gives Anti-Human a full building cycle.  Rebase immediately to the
    // strongest reachable stack while keeping the same crown objective.
    if (b.army[c.at] < 18) {
      const bestDistance = Number.isFinite(c.bestCrownDistance) ? c.bestCrownDistance : f.distance[c.at];
      const alternatives = own
        .filter((at) =>
          at !== c.at &&
          b.army[at] > b.army[c.at] + 24 &&
          Number.isFinite(f.distance[at]) &&
          f.distance[at] + 1 < bestDistance,
        )
        .sort((a, z) => (b.army[z] - f.distance[z] * 2) - (b.army[a] - f.distance[a] * 2));
      if (alternatives.length) {
        c.at = alternatives[0];
        c.phase = 'gather';
        c.started = b.turn;
        c.lastAt = c.at;
        c.lastProgress = b.turn;
        c.deliveryBestDistance = Infinity;
        c.bestCrownDistance = f.distance[c.at];
        m.delivery = null;
        return chooseCampaign(b, m, own);
      }
    }
  }
  // Never turn a token garrison into a marching campaign.  On narrow maps a
  // one to ten unit hop can be legal every tick yet make no real progress:
  // the opponent cuts it immediately and the controller keeps reselecting the
  // same corridor.  Keep gathering (or let the recovery path rebase it) until
  // the root has a meaningful column.
  if (c.phase === 'gather' && b.army[c.at] < Math.min(desired, 18)) return null;
  c.phase='attack';
  const to=p[1];
  const a=safeMove(b,c.at,to,'campaign');
  if(a){
    const guard = routeGuard(b, a);
    if (guard.anchor >= 0) {
      return { action: build(b, guard.anchor), branch: 'route-anchor' };
    }
    if (guard.blocked) {
      const repair = repairSupply(b, guard.cut);
      if (repair) return repair;
      // The next move would expose a large, anchorless branch to a one-turn
      // enemy cutoff.  Reinforce the exact articulation cell when logistics
      // can reach it; otherwise hold the spearhead instead of repeatedly
      // feeding the same corridor.
      if (guard.cut >= 0 && b.own(guard.cut)) {
        const need = Math.max(b.army[guard.cut] + 2, pressure(b, guard.cut) + 2);
        const reinforcement = gather(b, m, guard.cut, need, 'route-reinforce');
        if (reinforcement) return reinforcement;
      }
      c.phase = 'gather';
      return { action: null, branch: 'route-hold' };
    }
    return {action:a,branch:'march'};
  }
  c.phase='gather';
  if (mazeBoard && Number.isFinite(c.bestCrownDistance) && c.bestCrownDistance > 10 && c.bestCrownDistance <= 18) {
    const escapeCut = strategicCut(b, own) || frontierStrike(b, own);
    if (escapeCut) return { ...escapeCut, branch: 'campaign-cut' };
  }
  const target = Math.max(desired, b.army[to] * 1.3 + 30);
  const delivery = gather(b, m, c.at, target, 'muster');
  if(delivery)return delivery;
  if (mazeBoard && Number.isFinite(c.bestCrownDistance) && c.bestCrownDistance > 10 && c.bestCrownDistance <= 18) {
    const escapeCut = strategicCut(b, own) || frontierStrike(b, own);
    if (escapeCut) return { ...escapeCut, branch: 'campaign-cut' };
  }
  return null;
}

// A stale campaign can legitimately have no legal move for a few ticks while
// a convoy gathers or a bridge is being reinforced.  Once that pause becomes
// longer than the bounded muster wait, keeping every old cursor is harmful:
// the rest of the board may still have a safe local expansion or cut.  Clear
// only the stale military cursors and resume from the current frontier while
// leaving a funded construction plan intact.
function recover(b, m, own) {
  const enemies = [];
  for (let at = 0; at < b.size; at += 1) if (b.enemy(at) && !b.isolated[at]) enemies.push(at);
  const ed = field(b, enemies);
  const assaultRoot = m.campaign?.at;
  // On a maze, reaching the final approach is expensive.  A stalled tick
  // near the target must not discard that progress and restart from the rear:
  // the fresh opening can spend the rest of the game rebuilding the corridor
  // while the opponent keeps its crown production.  Keep the same campaign
  // and let chooseCampaign reissue a local muster or march instead.
  if (
    m.maze &&
    m.campaign &&
    Number.isFinite(m.campaign.bestCrownDistance) &&
    m.campaign.bestCrownDistance <= 24 &&
    b.enemy(m.campaign.crown)
  ) {
    m.campaign.phase = 'gather';
    m.campaign.started = b.turn;
    m.campaign.lastProgress = b.turn;
    m.campaign.musterTurns = 0;
    m.delivery = null;
    const nearCampaign = chooseCampaign(b, m, own);
    if (nearCampaign) return nearCampaign;
    return { action: null, branch: 'maze-near-target-hold' };
  }
  // A healthy spearhead that is already attacking should keep ownership of
  // the action budget.  The recovery hook is for stale logistics, not for
  // replacing a finishing assault with a fresh opening on the other side.
  if (m.campaign?.phase === 'attack' && Number.isInteger(assaultRoot) && b.army[assaultRoot] >= 18) {
    const strike = frontierStrike(b, own);
    if (strike) return { ...strike, branch: 'stalled-recovery' };
    return reposition(b, own);
  }
  m.campaign = null;
  m.delivery = null;
  m.blocked = null;
  const strike = frontierStrike(b, own);
  if (strike) return { ...strike, branch: 'stalled-recovery' };
  const cut = strategicCut(b, own);
  if (cut) return { ...cut, branch: 'stalled-cut' };
  const expansion = m.maze ? mazeOpening(b, m, own, ed) : opening(b, m, own, ed);
  if (expansion) return { ...expansion, branch: 'stalled-expansion' };
  return reposition(b, own) || emergencyProbe(b, own);
}

function plan(b,m) {
  const own=[]; const enemies=[];
  let campaignPaused = false;
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
  const rushProfile = earlyRushProfile(b, own, enemies);
  const mazeBoard = m.maze ?? isMazeBoard(b);
  const mazeGoal = mazeBoard ? mazeEconomyGoal(b, own, enemies) : ECON_GOAL;
  // Do not let a harmlessly distant reserve freeze the whole economy once
  // the sole crown already has enough local guard.  The hold specifically
  // covers the post-build exposure window: fifty units spent on a nearby
  // site plus the travel margin of the saved home column.
  const immediateRushHold = rushProfile && !rushProfile.maritime && b.turn < 42 && rushProfile.homeReserve >= 150 &&
    b.army[rushProfile.crown] < rushCrownFloor(rushProfile);
  const rushBuildHold = rushProfile && (immediateRushHold ||
    (!rushProfile.maritime && (rushProfile.maze || rushProfile.distance <= 24) &&
      b.turn >= 42 && rushProfile.homeReserve >= 80 &&
      b.army[rushProfile.crown] < rushCrownFloor(rushProfile)));
  // On large maps a first campaign can monopolize the action budget while
  // the opponent paints several hundred cells. Pause only a gathering
  // campaign when the territory gap is structural; an already marching
  // spearhead is left uninterrupted so a real breakthrough can finish.
  const largeExpansionRace = b.size >= 800 &&
    (own.length < 80 || own.length + 20 < enemies.length * 0.7);
  // Once a maze campaign has a rally root, its convoy must stay contiguous.
  // Pausing a gathering campaign on four out of five ticks made the tree
  // cursor alternate with rear expansion and effectively turned a long
  // corridor into a permanent muster.  Economy still receives the explicit
  // sparse window below; do not suspend the active campaign itself.
  const largeExpansionPause = largeExpansionRace && !m.campaign && b.turn % 5 !== 0;
  if (largeExpansionPause) campaignPaused = true;
  const mazeBuildHold = mazeInfrastructureHold(b, m, own, enemies);
  if (mazeBuildHold) {
    campaignPaused = true;
    // Drop stale delivery state so the economy pass cannot keep feeding the
    // obsolete two-anchor assault after the opponent has built.
    if (m.campaign && m.campaign.phase !== 'attack') {
      m.campaign = null;
      m.delivery = null;
      m.musterWaitTurns = 0;
    }
  }
  const anchorGuard = anchorDefense(b);
  if (anchorGuard) return anchorGuard;
  const tactic=tactical(b,own);
  if(tactic?.branch==='crown')return tactic;
  // Before an opponent is visible, reserve a small deterministic share of
  // the action budget for scouting. This keeps fog games from becoming two
  // isolated local economies that never discover a crown to attack.
  if (fogged && !enemies.length && b.turn >= 20 && b.turn % 3 === 0 && !rushBuildHold) {
    const scout = fogScout(b, m, own);
    if (scout) return scout;
  }
  // Once a campaign has a valid rally root, keep its convoy/attack sequence
  // together.  The generic defence and economy passes used to run first on
  // every tick; a harmless nearby pressure signal could therefore steal the
  // action budget, reset the delivery cursor, and make the bot collect the
  // same route forever without ever reaching the first hostile cell.
  if (m.campaign && Number.isInteger(m.campaign.at) && b.own(m.campaign.at) && !b.isolated[m.campaign.at]) {
    const campaign = chooseCampaign(b, m, own);
    if (campaign?.action) {
      const ownTotal = own.reduce((sum, at) => sum + b.army[at], 0);
      const enemyTotal = enemies.reduce((sum, at) => sum + b.army[at], 0);
      const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
      const gatherWindow = campaign.branch === 'muster' || campaign.branch === 'muster-wait';
      // A rally is a plan, not a permanent lock on the action budget. During
      // a long gather, spend a deterministic sparse window on a compact city
      // cluster or a funded frontline post when the opponent has a real army
      // lead. This prevents the old failure mode where Apex keeps ferrying
      // small columns while Anti-Human adds crowns and cities every tick.
      // Once the spearhead is attacking, or our army is safely ahead, keep the
      // campaign contiguous and do not let economy work interrupt a finish.
      const ownCrowns = own.filter((at) => b.kind(at) === 'crown').length;
      const crownDeficit = enemyCrowns > ownCrowns;
      const economyCadence = 8;
      const economyWindow = gatherWindow &&
        (ownTotal < enemyTotal * 1.15 || crownDeficit) &&
        b.turn % economyCadence === 0;
      const allowEconomyWindow = economyWindow;
      const latentCrownMove = rushBuildHold && rushOutwardMove(b, campaign.action, rushProfile);
      if (!campaignPaused && !allowEconomyWindow && !latentCrownMove) return campaign;
      campaignPaused = true;
    }
  }
  const ownTotal = own.reduce((sum, at) => sum + b.army[at], 0);
  const enemyTotal = enemies.reduce((sum, at) => sum + b.army[at], 0);
  const enemyCrowns = enemies.filter((at) => b.kind(at) === 'crown').length;
  const defend=defense(b,m,own);
  if(defend)return defend;
  if (rushBuildHold) {
    const guard = delayedRushGuard(b, m, own, enemies, rushProfile);
    if (guard) return guard;
  }
  const investmentWindow = rushBuildHold ? null : sustainEconomy(b, m, own, ed, enemies);
  if (investmentWindow) return investmentWindow;
  const finishing = enemyCrowns <= 2 && ownTotal > enemyTotal * 1.35;
  if (finishing) {
    // Once the opposing empire is already collapsing, every spare tick must
    // stay on the shortest crown campaign.  Ordinary cutoff and economy work
    // can otherwise leave a tiny last crown alive indefinitely.
    const final = campaignPaused ? null : chooseCampaign(b, m, own);
    if (final) return final;
    if (!campaignPaused && m.campaign?.phase === 'gather' && b.own(m.campaign.at)) return { action: null, branch: 'muster-wait' };
  }
  const coreReady = Number.isInteger(m.enemyHome) && b.enemy(m.enemyHome) && b.kind(m.enemyHome) === 'crown' &&
    b.turn >= 180 && ownTotal >= enemyTotal * 1.1 && enemyCrowns > 1;
  if (coreReady) {
    const coreCampaign = campaignPaused ? null : chooseCampaign(b, m, own);
    if (coreCampaign) return coreCampaign;
  }
  // On a large board the original enemy crown can be more than a hundred
  // cells away. Waiting until the six-crown economy plan is complete starts
  // that march too late: the opponent has already filled the map with new
  // crowns by the time the column reaches its core. Once the opening reserve
  // is ahead by a modest margin, give the core campaign the action budget and
  // let the economy resume from the forward bridge it creates.
  // Once the army lead is decisive, spending turns on side cuts or another
  // economy cycle only gives Anti-Human time to add crowns. Keep the prepared
  // crown campaign in control of the action budget while preserving the
  // immediate defence check above.
  const decisive = enemyCrowns <= 6 && ownTotal >= Math.max(350, enemyTotal * 1.35) && ownTotal > enemyTotal + 150;
  if (decisive) {
    const assault = campaignPaused ? null : chooseCampaign(b, m, own);
    if (assault) return assault;
  }
  if (!rushBuildHold) {
    const forward = forwardExpansion(b, m, own, ed, enemies);
    if (forward) return forward;
    const broad = broadExpansion(b, m, own, ed, enemies);
    if (broad) return broad;
    const rear = rearExpansion(b, m, own, ed, enemies);
    if (rear) return rear;
  }
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
  const openingTurns = swampRatio(b, m) > 0.3 && swampRatio(b, m) < 0.55 ? 50 : 40;
  if(b.turn<openingTurns || (fogged && explore)) {
    if (rushBuildHold) {
      const guard = delayedRushGuard(b, m, own, enemies, rushProfile);
      if (guard) return guard;
      const rally = latentReserveMove(b, rushProfile);
      if (rally) return rally;
      return { action: null, branch: 'delayed-rush-wait' };
    }
    return (mazeBoard ? mazeOpening(b, m, own, ed) : opening(b, m, own, ed)) || {action:null,branch:'wait'};
  }
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
  if (!rushBuildHold && b.turn < ECON_DEADLINE &&
      (!earlyStrike || mazeBoard || process.env.APEX_EARLY_MAZE === '0')) {
    const invest=economy(b,m,own,ed,mazeGoal);
    if(invest)return invest;
  }
  const campaign=(!campaignPaused && (enemyInvested || b.turn >= 70)) ? chooseCampaign(b,m,own) : null;
  if(campaign && !(rushBuildHold && rushOutwardMove(b, campaign.action, rushProfile))) return campaign;
  // Once a campaign has a valid rally root but no legal delivery step, keep
  // the root intact and let growth refill it.  Falling back to opening here
  // spends the action on a new frontier and is exactly the oscillation that
  // starves a planned core assault.
  if (!campaignPaused && m.campaign && m.campaign.phase === 'gather' && b.own(m.campaign.at) && !b.isolated[m.campaign.at]) {
    m.musterWaitTurns = (m.musterWaitTurns || 0) + 1;
    if (m.musterWaitTurns >= 8) {
      const blockedCrown = m.campaign.crown;
      m.blocked = { crown: blockedCrown, until: b.turn + CAMPAIGN_BLOCK_COOLDOWN };
      m.campaign = null;
      m.delivery = null;
      m.musterWaitTurns = 0;
      const recovery = frontierStrike(b, own);
      if (recovery) return { ...recovery, branch: 'muster-recovery' };
      return { action: null, branch: 'campaign-reset' };
    }
    return { action: null, branch: 'muster-wait' };
  }
  m.musterWaitTurns = 0;
  const investment=rushBuildHold ? null : economy(b,m,own,ed,mazeGoal);
  // On a maze, an active campaign and the construction plan share the same
  // narrow corridor.  Allow the compact plan to take a bounded turn after the
  // opponent has invested; otherwise the old `enemyInvested` gate left Apex
  // at two or three crowns while Anti-Human reached seven.  ConstructionThreat
  // and the rush guard still veto a build when the home crown is actually in
  // the kill window.
  if (investment && (!enemyInvested || b.turn < 80 || mazeBoard)) return investment;
  if(campaign && !(rushBuildHold && rushOutwardMove(b, campaign.action, rushProfile))) return campaign;
  const growthAction=rushBuildHold ? null : economy(b,m,own,ed,mazeGoal);
  if(growthAction)return growthAction;
  if (rushBuildHold) return latentReserveMove(b, rushProfile) || { action: null, branch: 'delayed-rush-wait' };
  return (explore ? (mazeBoard ? mazeOpening(b, m, own, ed) : opening(b,m,own,ed)) : null)||{action:null,branch:'wait'};
}
module.exports={plan,recover,secureDecision,stranded,safeMove,gather,treeGather,growth,routeGuard,constructionThreat,earlyRushThreat,mazeInfrastructureHold,isMazeBoard,mazeEmergency,mazeActionGuard,localGuard,sustainEconomy,forwardExpansion,broadExpansion,defense,defensiveCut,emergencyDefensiveCut};
