'use strict';

// Archipelago layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis (16-seed archipelago matrix, `bot3-baseline-1..16`, plus per-tick
// traces of seeds 1/3/5/7/9/11 in both seats). The archipelago generator fills
// the board with swamp and scatters 3x3..4x4 plain islands on it: ~66% of the
// passable cells are swamp, and every island is separated from the next by a
// one-to-three-cell swamp strait. Swamp is walkable but pays no income, which
// turns this map into a pure land race with a fixed budget:
//
//   * army at tick 50 predicts the game, land at tick 50 does not. Pooled over
//     the 64 traced games, army > rival + 40 at t50 is 24W/5L and army < rival
//     - 40 is 7W/36L, while being 5+ land behind at t50 splits 17W/18L. The
//     reason is the burst window (ticks 26-50 in `tick-growth.ts`): every
//     owned plain cell adds +1 army per tick, so *each plain cell claimed by
//     t26 is worth ~22-25 army at t50* and nothing after it.
//   * the stock planner treats the room as open ground: `objectives` are the
//     remembered rival crowns and `campaignRoute`/`distances` price swamp and
//     plain identically, so the serial tick beelines at the rival crown
//     through open water. `bot3-baseline-3` seat 0 (loss) is the canonical
//     trace: t25 10 plain / 11 swamp vs the rival's 12 plain, then ticks
//     31-47 walk (11,0)->(10,0)->(10,2)->(9,2)->(8,2)->(7,2)->(6,3)->(6,4),
//     i.e. seven straight swamp cells toward the far crown, while two islands
//     sit one strait away. At t40 the rival is 25 plain and we are 10; by t50
//     it is 25 plain / 573 army against 13 plain / 290 army. The rival never
//     left its own islands.
//   * the same trace ends with the long bridge cut: `isolated` cells jump to
//     9-15 at t61-70 and the far stack decays, because a crossing leaves a
//     one-unit garrison on every swamp cell it took and the rival only has to
//     pick one of them off (`supplyCuts` prices the loss, but the crossing is
//     already spent by then).
//   * crowns are the only post-burst income (+1/tick each, swamp pays nothing),
//     and the traced losses sit on one crown for the whole game while the rival
//     upgrades a captured island at t52 and t59. `buildingStart` is 50 on the
//     clear serial room and `develop`/`site` keep the single serial tick on the
//     march instead, so the low-land economy never compounds.
//
// Three mechanisms, each with its own flag and all gated structurally on the
// board's swamp share (never on the map name, which the bot never receives):
//
//   `BOT3_ARCH_LAND`  - land-first objective. While the burst is still running
//                       and no rival is near our homes, the objective field is
//                       the nearest unclaimed-island's plain cells instead of
//                       the rival crown, so the serial tick hops island by
//                       island instead of swimming at the enemy. The focus
//                       island is latched on the board so the field cannot
//                       flicker between two equally close islands.
//   `BOT3_ARCH_WATER` - water discipline. A swamp capture that does not shorten
//                       the distance to the nearest unclaimed plain cell buys
//                       no income, so its score is capped under the land
//                       capture next door (`archipelagoWaterBlocked`).
//   `BOT3_ARCH_CROWN` - island crown. On a fully owned, rival-free island the
//                       build gates (`develop`, `buildingStart`, `units >= 100`)
//                       are relaxed, because a rear crown on a swamp board is
//                       the only income that compounds.
//   `BOT3_ARCH_FRONT` - frontier objective. Outside the land phase the stock
//                       objective is the remembered rival crown, and a crown
//                       across two straits leaves `goal` and `required` so far
//                       away that every capture rule stays dead: the traced
//                       `bot3-baseline-3` stack oscillates on one island
//                       ((3,2)<->(3,3) for twenty ticks) while the rival eats
//                       the outer islands. Aiming at the visible rival frontier
//                       instead always leaves a reachable step.
//
// All four default to off: the measured verdicts are in BOT3_ARCH.md.

const INF = 1e6;

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

// Swamp-heavy gate. Measured swamp share of the passable cells per map mode:
// archipelago 66.2-70%, mediterranean 45.7%, random 7.2%. The gate sits above
// the mediterranean share so the layer can only ever arm on island rooms.
const DEFAULT_SWAMP_SHARE = 0.55;
// Land phase ends with the burst window (ticks 26-50). A plain cell claimed
// after tick 50 adds +1 army only at tick 100, i.e. nothing to the army that
// decides the game, so a longer phase only exposes the home island: measured
// 8-seed screens at 40 / 51 / 62 / unbounded give +2.3 / +3.1 / -3.1 / -9.4pp.
const DEFAULT_UNTIL = 51;
// Stop aiming at land while a visible rival is this close to a home. Chasing a
// far island with a rival stack next door is how the traced losses died.
const DEFAULT_CONTACT = 3;
// Score cap for a swamp capture that moves away from the nearest unclaimed
// plain cell. Below every land capture (63+), above a plain merge (14-25).
const DEFAULT_WATER_CAP = 18;
// First tick the island crown rule may fire, and the smallest island worth a
// crown (a 2-cell rock is not).
const DEFAULT_CROWN_TURN = 36;
const DEFAULT_CROWN_ISLAND = 5;
// Require this many steps of clearance from the rival before a rear crown is
// considered safe income.
const DEFAULT_CROWN_ENEMY = 4;
// Between the march terms (< 300) and the focused build (403-675).
const DEFAULT_CROWN_SCORE = 660;

const IDLE = Object.freeze({
  active: false,
  swampShare: 0,
  island: null,
  focus: -1,
  aimLand: false,
  targets: null,
  plainDist: null,
  waterCap: 0,
  crown: false,
  crownTurn: DEFAULT_CROWN_TURN,
  crownScore: DEFAULT_CROWN_SCORE,
  crownIslands: null,
});

function archipelagoConfig(overrides = {}, env = process.env) {
  // `BOT3_ARCH` is the measured bundle (land-first objective + clear-serial
  // frontier objective). Each mechanism still has its own flag, which wins over
  // the bundle, so a single mechanism can be A/B'd on its own.
  const bundle = flag(env.BOT3_ARCH, true);
  return {
    land: overrides.land ?? (env.BOT3_ARCH_LAND === undefined ? bundle : flag(env.BOT3_ARCH_LAND, false)),
    water: overrides.water ?? flag(env.BOT3_ARCH_WATER, false),
    crown: overrides.crown ?? flag(env.BOT3_ARCH_CROWN, false),
    front: overrides.front ?? (env.BOT3_ARCH_FRONT === undefined ? bundle : flag(env.BOT3_ARCH_FRONT, false)),
    frontFog: overrides.frontFog ?? flag(env.BOT3_ARCH_FRONT_FOG, false),
    // The land phase is a clear-serial rule by default: in fog it converts one
    // relay archipelago win into a timeout (measured -1 cell), while the clear
    // room keeps the +21.9pp interaction with the frontier objective.
    landFog: overrides.landFog ?? flag(env.BOT3_ARCH_LAND_FOG, false),
    multi: overrides.multi ?? flag(env.BOT3_ARCH_MULTI, false),
    swampShare: overrides.swampShare ?? number(env.BOT3_ARCH_SWAMP_SHARE, DEFAULT_SWAMP_SHARE, 0, 1),
    until: overrides.until ?? number(env.BOT3_ARCH_UNTIL, DEFAULT_UNTIL, 0, 100000),
    contact: overrides.contact ?? number(env.BOT3_ARCH_CONTACT, DEFAULT_CONTACT, 0, 100),
    waterCap: overrides.waterCap ?? number(env.BOT3_ARCH_WATER_CAP, DEFAULT_WATER_CAP, 1, 1000),
    crownTurn: overrides.crownTurn ?? number(env.BOT3_ARCH_CROWN_TURN, DEFAULT_CROWN_TURN, 0, 100000),
    crownIsland: overrides.crownIsland ?? number(env.BOT3_ARCH_CROWN_ISLAND, DEFAULT_CROWN_ISLAND, 1, 100),
    crownEnemy: overrides.crownEnemy ?? number(env.BOT3_ARCH_CROWN_ENEMY, DEFAULT_CROWN_ENEMY, 0, 100),
    crownScore: overrides.crownScore ?? number(env.BOT3_ARCH_CROWN_SCORE, DEFAULT_CROWN_SCORE, 1, 3000),
  };
}

// Same encoding as ./planner `swamp`: owned swamp is 150+owner, unclaimed swamp
// is 204, and neither 200 (unclaimed plain) nor 201 (mountain) is swamp.
const isSwamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Terrain is static for the whole game (growing/reclaiming never changes a tile
// between swamp and plain), so the island partition and the swamp share are
// computed once per board and cached on it. Mountains stay visible in fog, so
// the partition is exact even before the board is explored.
function terrainState(b) {
  if (b.archIsland && b.archSize === b.size) return b;
  const { size, neighbors, grid_type: tile } = b;
  const island = new Int32Array(size).fill(-1);
  const sizes = [];
  for (let start = 0; start < size; start++) {
    if (island[start] !== -1 || isSwamp(tile[start]) || tile[start] === 201) continue;
    const id = sizes.length;
    let cells = 0;
    const stack = [start];
    island[start] = id;
    while (stack.length) {
      const i = stack.pop();
      cells++;
      for (const j of neighbors[i]) {
        if (island[j] !== -1 || isSwamp(tile[j]) || tile[j] === 201) continue;
        island[j] = id;
        stack.push(j);
      }
    }
    sizes.push(cells);
  }
  let passable = 0,
    swamp = 0;
  for (let i = 0; i < size; i++) {
    if (tile[i] === 201) continue;
    passable++;
    if (isSwamp(tile[i])) swamp++;
  }
  b.archIsland = island;
  b.archIslandSize = Int32Array.from(sizes);
  b.archSwampShare = passable ? swamp / passable : 0;
  b.archSize = size;
  return b;
}

// Steps from every cell to the nearest unclaimed plain cell (a fogged cell is
// reported as plain, which is exactly the case the layer wants to explore).
function plainDistance(b, tile) {
  const { size, neighbors } = b;
  const dist = new Int32Array(size).fill(INF);
  const queue = [];
  for (let i = 0; i < size; i++) {
    if (tile[i] !== 200) continue;
    dist[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (dist[j] !== INF || tile[j] === 201) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

function archipelagoUpdate(b, context, config = archipelagoConfig()) {
  const {
    turn = 0,
    tile,
    teams,
    myTeam,
    homes = [],
    homeDist,
    enemyDist,
    fog = false,
    multi = false,
  } = context;
  if (!(config.land || config.water || config.crown || config.front)) return IDLE;
  // Multi-line rooms allocate sixteen orders through `./multi` and do not have
  // the serial land race this layer prices; measured on the 16-seed matrix the
  // multi archipelago cells lose 5 wins (apex) and 2 (v2) under the layer, so it
  // stays off there unless asked.
  if (context.multi && !config.multi) return IDLE;
  const state = terrainState(b);
  if (!(state.archSwampShare >= config.swampShare)) return IDLE;
  const size = b.size,
    island = state.archIsland,
    islands = state.archIslandSize.length;
  const neutral = new Int32Array(islands);
  const enemyCells = new Int32Array(islands);
  const near = new Int32Array(islands).fill(INF);
  for (let i = 0; i < size; i++) {
    const id = island[i];
    if (id < 0) continue;
    if (tile[i] === 200) {
      neutral[id]++;
      if (homeDist[i] < near[id]) near[id] = homeDist[i];
    }
    if (teams[i] && teams[i] !== myTeam && !b.isolated[i]) enemyCells[id]++;
  }
  // Focus island: latched while it still has plain land and no rival on it, so
  // the objective field cannot flicker between two equally close islands.
  let focus = b.archFocus ?? -1;
  if (focus < 0 || focus >= islands || !neutral[focus] || enemyCells[focus]) focus = -1;
  if (focus < 0) {
    let bestValue = Infinity;
    for (let id = 0; id < islands; id++) {
      if (!neutral[id] || enemyCells[id]) continue;
      // A step costs a tick, a claimed cell is worth ~25 army during the burst:
      // prefer the bigger island unless it is far enough to cost a real detour.
      const value = near[id] - 0.25 * neutral[id];
      if (value < bestValue) {
        bestValue = value;
        focus = id;
      }
    }
  }
  b.archFocus = focus;
  let targets = null;
  if (config.land && (config.landFog || !context.fog) && focus >= 0) {
    targets = [];
    for (let i = 0; i < size; i++) if (island[i] === focus && tile[i] === 200) targets.push(i);
    if (!targets.length) targets = null;
  }
  // Keep the land objective only while the burst is live and no rival is next
  // to a home; after that the rival crowns are the objective again.
  let contact = INF;
  for (const home of homes) if (enemyDist[home] < contact) contact = enemyDist[home];
  const aimLand = Boolean(targets) && turn < config.until && contact > config.contact;
  // Frontier objective: after the land phase the nearest rival cell is a
  // reachable step even when the rival crown is two straits away.
  let frontTargets = null;
  const frontRoom = config.front && (config.frontFog || !context.fog);
  if (frontRoom && !aimLand && context.enemies?.length) frontTargets = context.enemies;
  let crownIslands = null;
  if (config.crown) {
    const enemyNear = new Int32Array(islands).fill(INF);
    for (let i = 0; i < size; i++) {
      const id = island[i];
      if (id >= 0 && enemyDist[i] < enemyNear[id]) enemyNear[id] = enemyDist[i];
    }
    crownIslands = new Uint8Array(islands);
    for (let id = 0; id < islands; id++) {
      if (neutral[id] || state.archIslandSize[id] < config.crownIsland) continue;
      if (enemyNear[id] < config.crownEnemy) continue;
      crownIslands[id] = 1;
    }
  }
  return {
    active: true,
    swampShare: state.archSwampShare,
    island,
    focus: aimLand ? focus : -1,
    aimLand,
    targets: aimLand ? targets : frontTargets,
    plainDist: config.water || config.land ? plainDistance(b, tile) : null,
    waterCap: config.water ? config.waterCap : 0,
    crown: config.crown,
    crownTurn: config.crownTurn,
    crownScore: config.crownScore,
    crownIslands,
  };
}

// A swamp capture that does not move closer to unclaimed plain land pays no
// income and buys no landing, so it is capped under a land capture. Crossing a
// strait is still allowed: every hop of a shortest crossing lowers the field.
function archipelagoWaterBlocked(arch, tile, from, to) {
  if (!arch || !(arch.waterCap > 0) || !arch.plainDist) return false;
  if (!isSwamp(tile[to])) return false;
  if (arch.plainDist[to] < arch.plainDist[from]) return false;
  return arch.plainDist[from] < INF;
}

module.exports = {
  archipelagoConfig,
  archipelagoUpdate,
  archipelagoWaterBlocked,
  terrainState,
  plainDistance,
  isSwamp,
  DEFAULT_SWAMP_SHARE,
  DEFAULT_UNTIL,
  DEFAULT_CONTACT,
  DEFAULT_WATER_CAP,
  DEFAULT_CROWN_TURN,
  DEFAULT_CROWN_ISLAND,
  DEFAULT_CROWN_ENEMY,
  DEFAULT_CROWN_SCORE,
};
