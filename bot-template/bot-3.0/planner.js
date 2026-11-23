'use strict';

const {
  rescueValues,
  assessOpponents,
  evaluateFrontMove,
  searchCampaign,
  siegeValue,
} = require('./single-front');
const { openingOrder, END_TICK } = require('./opening');
const { isMazeBoard, laneBlocked, recordLane, LANE, SINGLE_FROM } = require('./maze');
const { closingUpdate, closingConfig } = require('./closing');
const {
  fogConfig,
  fogUpdate,
  fogRequired,
  fogBeliefTargets,
  fogRaidUpdate,
  fogPaintCap,
  RAID_SCORE,
  columnAdvance,
  funnelScore,
  expandScore,
  guardScore,
  INVEST_SCORE,
} = require('./fog');
const {
  fogMazeConfig,
  fogMazeObjective,
  fogMazeOpen,
  fogMazeProgress,
  fogMazePaintCap,
  fogMazeEconomy,
  fogMazeEconGate,
} = require('./fog-maze');
const {
  fogOracleConfig,
  fogOracleUpdate,
  fogOracleReserve,
  fogOracleBlocked,
  fogOraclePush,
  fogOraclePaint,
} = require('./fog-oracle');
const { landConfig, landContext } = require('./land');
const { planFinish, finishEnabled, finishOptions } = require('./kill');
const { multiUpdate, applyMulti } = require('./multi');
const { mshapeConfig, mshapeUpdate, applyMshape, applyFan } = require('./mshape');
const { cutConfig, cutUpdate, cutApply } = require('./cut');
const { fogMultiConfig, fogMultiUpdate } = require('./fog-multi');
const {
  predict: shadowPredict,
  contest: shadowContest,
  adjust: shadowAdjust,
  plan: shadowPlan,
  record: shadowRecord,
} = require('./shadow');
const {
  archipelagoConfig,
  archipelagoUpdate,
  archipelagoWaterBlocked,
} = require('./archipelago');

const INF = 1e6;
const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const anchor = (code) => code >= 50 && code < 150;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Neutral cells on our own border: the frontier one painting tick can actually
// take (see ./fog-maze). Mountains stay visible through the fog and are skipped.
function neutralBorder(b, me) {
  const { size, neighbors, grid_type: tile } = b;
  let open = 0;
  for (let i = 0; i < size; i++) {
    if (tile[i] === 201 || ownerOf(tile[i]) !== 0) continue;
    for (const j of neighbors[i]) {
      if (ownerOf(tile[j]) === me) {
        open++;
        break;
      }
    }
  }
  return open;
}

function createBoard(rows, cols, me) {
  const size = rows * cols;
  const neighbors = Array.from({ length: size }, (_, i) => {
    const cells = [];
    if (i >= cols) cells.push(i - cols);
    if (i % cols > 0) cells.push(i - 1);
    if (i % cols < cols - 1) cells.push(i + 1);
    if (i + cols < size) cells.push(i + cols);
    return cells;
  });
  return {
    size,
    cols,
    me,
    neighbors,
    grid_type: new Uint8Array(size),
    army_cnt: new Float64Array(size),
    fog: new Uint8Array(size),
    isolated: new Uint8Array(size),
    memory: new Uint8Array(size),
    lastSeen: new Int32Array(size).fill(-1),
    lastFrom: new Int32Array(size).fill(-1),
    lastMove: new Int32Array(size).fill(-100),
  };
}

function distances(board, seeds, allowed, limit = INF) {
  const dist = new Int32Array(board.size).fill(INF);
  const queue = [...seeds];
  for (const i of seeds) dist[i] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (dist[i] >= limit) continue;
    for (const j of board.neighbors[i]) {
      if (dist[j] !== INF || board.grid_type[j] === 201 || (allowed && !allowed(j))) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return { dist, queue };
}

// A virtual root joins every visible anchor. Only a child subtree without
// a back edge to another supply route is lost upon capture of its parent.
function supplyCuts(board, teams, anchors) {
  const lost = new Float64Array(board.size);
  const order = new Int32Array(board.size),
    low = new Int32Array(board.size);
  const parent = new Int32Array(board.size).fill(-1),
    cursor = new Uint8Array(board.size);
  const weight = new Float64Array(board.size);
  let time = 0;
  for (const root of anchors) {
    if (order[root]) continue;
    const stack = [root];
    order[root] = ++time;
    while (stack.length) {
      const i = stack.at(-1);
      const adj = board.neighbors[i];
      if (cursor[i] < adj.length) {
        const j = adj[cursor[i]++];
        if (teams[j] !== teams[i] || board.isolated[j] || j === parent[i]) continue;
        if (order[j]) low[i] = Math.min(low[i], order[j]);
        else {
          parent[j] = i;
          order[j] = ++time;
          low[j] = anchor(board.grid_type[j]) ? 0 : order[j];
          stack.push(j);
        }
      } else {
        stack.pop();
        weight[i] += board.army_cnt[i] + 2;
        const p = parent[i];
        if (p >= 0) {
          if (low[i] >= order[p]) lost[p] += weight[i];
          low[p] = Math.min(low[p], low[i]);
          weight[p] += weight[i];
        }
      }
    }
  }
  return lost;
}

// Reverse Dijkstra with small integer travel costs. A modest detour around
// a large garrison is often faster than waiting for another army to arrive.
function campaignRoute(board, targets, units, teams, myTeam, scale) {
  const distance = new Int32Array(board.size).fill(INF);
  const buckets = [[...targets]];
  for (const i of targets) distance[i] = 0;
  for (let cost = 0; cost < buckets.length; cost++) {
    for (const i of buckets[cost] ?? []) {
      if (distance[i] !== cost) continue;
      const resistance = teams[i] === myTeam ? 0 : Math.min(24, Math.floor(units[i] / scale));
      const next = cost + 2 + resistance;
      for (const j of board.neighbors[i]) {
        if (board.grid_type[j] === 201 || next >= distance[j]) continue;
        distance[j] = next;
        (buckets[next] ??= []).push(j);
      }
    }
  }
  return distance;
}

function assaultStrength(b, queue, goal, units, teams, myTeam) {
  const { size, neighbors } = b;
  const required = new Float64Array(size).fill(Infinity);
  // Minimum starting stack along a shortest route. Pick up friendly garrisons
  // en route, pay each defender and leave one unit behind on every step.
  for (const i of queue) {
    if (goal[i] === 0) {
      const reinforcements = neighbors[i].filter((k) => teams[k] && teams[k] === teams[i] && !b.isolated[k]);
      required[i] = 1 + 0.7 * Math.max(0, ...reinforcements.map((k) => units[k] - 1));
    }
    for (const j of neighbors[i]) {
      if (goal[j] !== goal[i] + 1) continue;
      const cost = teams[i] === myTeam ? 1 - units[i] : 1 + units[i];
      required[j] = Math.min(required[j], Math.max(2, required[i] + cost));
    }
  }
  return required;
}

function incomingStrength(b, enemies, units, teams, myTeam) {
  const { size, neighbors, grid_type: tile } = b;
  // Strongest hostile stack reaching a cell in up to four steps after paying
  // visible defenders. Keep the approach strength before fighting on that cell.
  let wave = new Float64Array(size);
  for (const i of enemies) wave[i] = units[i];
  const threat = new Float64Array(size),
    immediate = new Float64Array(size);
  for (let step = 1; step <= 4 && enemies.length; step++) {
    const later = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      if (wave[i] < 2) continue;
      for (const j of neighbors[i]) {
        if (tile[j] === 201) continue;
        const incoming = wave[i] - 1;
        if (step === 1) immediate[j] = Math.max(immediate[j], incoming);
        threat[j] = Math.max(threat[j], incoming - (step - 1) * 2);
        later[j] = Math.max(later[j], incoming - (teams[j] === myTeam ? units[j] : 0));
      }
    }
    wave = later;
  }
  return { threat, immediate };
}

// Project visible columns along terrain-shortest approaches to a particular
// garrison. Distance decreases on every move, so a column can pick up each
// friendly stack only once. Separate teams cannot pool troops in an FFA.
function constructionPressure(b, units, teams, myTeam, enemyDist) {
  const cache = new Map();
  return function pressure(target) {
    if (enemyDist[target] > 7) return 0;
    if (cache.has(target)) return cache.get(target);
    const cells = [target],
      distance = new Map([[target, 0]]),
      rivals = new Set();
    for (const i of cells) {
      if (teams[i] && teams[i] !== myTeam) rivals.add(teams[i]);
      if (distance.get(i) === 7) continue;
      for (const j of b.neighbors[i]) {
        if (b.grid_type[j] === 201 || distance.has(j)) continue;
        distance.set(j, distance.get(i) + 1);
        cells.push(j);
      }
    }
    let strongest = 0;
    for (const rival of rivals) {
      const arriving = new Map();
      for (let k = cells.length - 1; k > 0; k--) {
        const i = cells[k];
        const incoming = arriving.get(i) ?? 0;
        const mass = teams[i] === rival ? incoming + (b.isolated[i] ? 0 : units[i]) : incoming - units[i];
        if (mass <= 1) continue;
        const send = mass - 1,
          next = distance.get(i) - 1;
        for (const j of b.neighbors[i]) {
          if (distance.get(j) === next && send > (arriving.get(j) ?? 0)) arriving.set(j, send);
        }
      }
      strongest = Math.max(strongest, arriving.get(target) ?? 0);
    }
    cache.set(target, strongest);
    return strongest;
  };
}

function selectBuildSite(
  b,
  units,
  pressure,
  frontDist,
  homeDist,
  supplyDistance,
  minHomeDist = 0,
  minEnemyDist = 0,
  enemyDist = null,
) {
  const { size, me, neighbors, grid_type: tile } = b;
  // In serial play, depositing several garrisons at the same safe site is
  // cheaper than marching each one to the front. Prefer sites we can finish.
  let site = -1,
    siteValue = -Infinity;
  for (let i = 0; i < size; i++) {
    if (ownerOf(tile[i]) !== me || crown(tile[i]) || swamp(tile[i]) || b.isolated[i]) continue;
    if (minHomeDist && homeDist[i] < minHomeDist) continue;
    // A crown the rival's vision has never touched cannot be remembered as a
    // target (see ./fog-multi `DEFAULT_SITE`).
    if (minEnemyDist && enemyDist && enemyDist[i] < minEnemyDist) continue;
    const city = anchor(tile[i]);
    const cost = city ? 50 : 100;
    const donors = neighbors[i].filter((j) => ownerOf(tile[j]) === me && !b.isolated[j] && units[j] > 2);
    const funds = units[i] + donors.reduce((sum, j) => sum + units[j] - 1, 0);
    if (funds < cost) continue;
    const safeFunds = donors.filter((j) => pressure(j) <= 1);
    const available = units[i] + safeFunds.reduce((sum, j) => sum + units[j] - 1, 0);
    if (available < cost || available - 50 < pressure(i)) continue;
    const largest = Math.max(0, ...safeFunds.map((j) => units[j] - 1));
    const value =
      (city ? 75 : 0) +
      Math.min(units[i], cost) +
      Math.min(largest, cost - Math.min(cost, units[i])) * 0.8 +
      Math.min(4, frontDist[i]) +
      Math.min(4, homeDist[i]) +
      (supplyDistance ? 4 * Math.min(8, supplyDistance[i]) : 0);
    if (value > siteValue) {
      siteValue = value;
      site = i;
    }
  }
  return site;
}

function chooseOrders(b, turn, leaderboard, multi) {
  const { size, me, neighbors, grid_type: tile, army_cnt: army } = b;
  const teamByOwner = new Map(leaderboard.filter((p) => !p.dead).map((p) => [p.id, p.team]));
  const myTeam = teamByOwner.get(me);
  if (!myTeam) return [];
  const teams = new Uint8Array(size),
    units = new Float64Array(army);
  const homes = [],
    targets = [],
    enemies = [],
    borders = [],
    anchors = [],
    scouts = [];
  const next = turn + 1,
    beforeBurstEnd = !multi && turn < 50,
    burst = beforeBurstEnd && next >= 26;
  for (let i = 0; i < size; i++) {
    if (!b.fog[i]) {
      b.memory[i] = tile[i];
      b.lastSeen[i] = turn;
    } else if (tile[i] !== 201 && (b.lastSeen[i] === -1 || b.lastSeen[i] < turn - 12)) scouts.push(i);
    const owner = ownerOf(tile[i]);
    teams[i] = teamByOwner.get(owner) ?? 0;
    if (teams[i] && anchor(tile[i])) anchors.push(i);
    if (owner === me && crown(tile[i])) homes.push(i);
    if (teams[i] && teams[i] !== myTeam && !b.isolated[i]) enemies.push(i);
    const remembered = b.fog[i] ? b.memory[i] : tile[i];
    const rememberedTeam = teamByOwner.get(ownerOf(remembered));
    if (crown(remembered) && rememberedTeam && rememberedTeam !== myTeam) targets.push(i);
    if (teams[i] && !b.isolated[i]) {
      if (crown(tile[i])) units[i]++;
      else if (!swamp(tile[i])) {
        if (next % 50 === 0) units[i]++;
        if (burst && !anchor(tile[i])) units[i]++;
      }
    }
  }
  if (!homes.length) return [];
  for (let i = 0; i < size; i++) {
    if (teams[i] === myTeam && neighbors[i].some((j) => teams[j] !== myTeam && tile[j] !== 201))
      borders.push(i);
  }
  const cut = supplyCuts(b, teams, anchors);
  const homeDist = distances(b, homes).dist;
  const frontDist = distances(b, borders, (j) => teams[j] === myTeam).dist;
  const enemyDist = distances(b, enemies).dist;
  const clearSerial = !multi && !(b.fogMode ?? b.fog.includes(1));
  // Shadow layer (see ./shadow): relay is deterministic in clear serial rooms,
  // so its next order is known one tick early. The call has to happen on every
  // frame (including the opening branch below, which returns early) because
  // relay's private opening bookkeeping is built up frame by frame. Only scores
  // move here; the candidate set and the untouched planner stay as is.
  const shadow = shadowPredict(b, turn, leaderboard, multi);
  // Fog single-line layer (see ./fog). `fogOpen` is the room gate that also
  // supplies the objective fallback; the column needs a measured material edge
  // on top of it (`fogUpdate`) and pauses whenever a home is threatened.
  const fogCfg = fogConfig();
  const fogMaze = isMazeBoard(b);
  const fogOpen =
    !clearSerial &&
    !multi &&
    fogCfg.enabled &&
    (!fogMaze || fogCfg.maze) &&
    size <= fogCfg.maxBoard &&
    turn >= fogCfg.startTurn;
  // Maze + fog layer (see ./fog-maze). A fogged corridor board is the one room
  // neither `./fog` (corridor maps excluded) nor `./maze` (the front planner is
  // clear-serial only) prices, so it gets its own objective. Off by default.
  const fogMazeCfg = fogMazeConfig();
  const mazeFogRoom = fogMaze && fogMazeCfg.enabled;
  // A zero garrison or a disconnected pocket means fighting has already
  // changed the opening economy. Let the tactical planner handle that frame.
  if (
    turn < END_TICK &&
    homes.length === 1 &&
    !tile.some((t, i) => ownerOf(t) === me && (!army[i] || b.isolated[i]))
  ) {
    const orders = openingOrder(b, teams, homes, turn, enemyDist, multi);
    const tacticalCapture = enemies.some(
      (i) =>
        crown(tile[i]) &&
        neighbors[i].some((j) => ownerOf(tile[j]) === me && !b.isolated[j] && units[j] - 1 > units[i]),
    );
    const approach = enemies.some(
      (i) =>
        homeDist[i] <= 3 &&
        units[i] - homeDist[i] > units[homes[0]] - (orders.find((op) => op.from === homes[0])?.send ?? 0),
    );
    const contested = orders.some((move) =>
      neighbors[move.to].some(
        (i) =>
          teams[i] && teams[i] !== myTeam && !b.isolated[i] && units[i] - 1 > move.send + move.destination,
      ),
    );
    const exposedStem = orders.some(
      (move) =>
        cut[move.from] > 0 &&
        neighbors[move.from].some(
          (i) =>
            teams[i] && teams[i] !== myTeam && !b.isolated[i] && units[i] - 1 > units[move.from] - move.send,
        ),
    );
    if (!approach && !contested && !exposedStem && !tacticalCapture) {
      if (shadow) shadowRecord(b, turn, orders);
      return orders;
    }
    b.opening = null;
  }
  const scouting = distances(b, scouts).dist;
  const maze = isMazeBoard(b) && process.env.BOT3_MAZE !== '0';
  // A corridor is won by painting neutral cells and by one concentrated
  // column. The open-map front planner concentrates on a rival crown instead
  // and stops expanding, which is exactly the wrong shape on a maze board, so
  // it only takes the frame late (see maze.js for the measured thresholds).
  const single = clearSerial && turn >= (maze ? SINGLE_FROM : 28);
  const self = leaderboard.find((p) => p.id === me);
  const borderDistance = single ? distances(b, borders).dist : null;
  const rival = single
    ? assessOpponents(b, leaderboard, targets, borderDistance, teams, myTeam, units, self)
    : null;
  // Without a remembered enemy crown there is no objective at all: fog vision
  // is radius 1, so the crowns only appear once our land touches their
  // neighbour. Aim at the visible front until then (see ./fog), but only when
  // the leaderboard army says we are close enough to afford the attrition:
  // chasing a front from far behind is what costs the anti/archipelago cell.
  let enemyArmy = 0,
    enemyLand = 0,
    enemyRow = null;
  for (const p of leaderboard)
    if (!p.dead && p.team !== myTeam) {
      if ((Number(p.army) || 0) >= enemyArmy) enemyRow = p;
      enemyArmy = Math.max(enemyArmy, Number(p.army) || 0);
      enemyLand = Math.max(enemyLand, Number(p.land) || 0);
    }
  // Expansion-shape layer (see ./mshape). Multi-line rooms have no burst and
  // land is the only recurring income, so the tick after each growth pulse is
  // worth more than any serial objective: the layer prices the frontier (a
  // capture that keeps neutral neighbours open) and lifts the inherited
  // sixteen-order cap. Off by default.
  const mshapeLayer = mshapeUpdate(
    b,
    {
      turn,
      multi,
      size,
      me,
      corridor: isMazeBoard(b),
      land: self.land,
      enemyLand,
      army: self.army,
      enemyArmy,
    },
    mshapeConfig(),
  );
  // Fog oracle (see ./fog-oracle). The leaderboard is rebuilt from the unfogged
  // grids, so `rival.army` / `rival.land` are exact even where the vision is
  // not: the difference against the visible half is the interior reserve, and
  // the passed ticks give the rival's crown count. Off by default.
  const oracleCfg = fogOracleConfig();
  const oracle =
    fogOpen && !multi && oracleCfg.enabled && size <= oracleCfg.maxBoard
      ? fogOracleUpdate(
          b,
          { turn, multi, rival: enemyRow, mine: self.army },
          oracleCfg,
        )
      : null;
  const oraclePaint = oracle ? fogOraclePaint(oracle, oracleCfg) : Infinity;
  // Swamp is visible through the fog, so the board's terrain mix is known even
  // before it is explored; archipelago-style rooms use their own aim threshold.
  let swampCells = 0;
  if (fogOpen)
    for (let i = 0; i < size; i++) if (swamp(tile[i])) swampCells++;
  const aimLead = swampCells >= size * fogCfg.swampShare ? fogCfg.aimLeadSwamp : fogCfg.aimLead;
  // Archipelago layer (see ./archipelago). Swamp-heavy rooms are a land race, not
  // an open front: the objective becomes the nearest unclaimed island while the
  // burst is live, deep-water swamp captures are capped, and a fully owned
  // island may raise a crown. Gated on the board's swamp share, never on the map
  // name, and off by default.
  const arch = archipelagoUpdate(
    b,
    {
      turn,
      tile,
      teams,
      myTeam,
      homes,
      homeDist,
      enemyDist,
      enemies,
      known: targets.length,
      fog: !clearSerial,
      multi,
    },
    archipelagoConfig(),
  );
  // Maze + fog gate. `leadCap` stands the layer down once the leaderboard says
  // the game is already won: on the weak-opponent corridor cells the layer's
  // expansion converts fast wins into 1000-tick timeouts, and those are not
  // wins. The layer is for the even and losing corridor games.
  const mazeFogBase =
    mazeFogRoom &&
    fogMazeOpen(b, { multi, size, turn }, fogMazeCfg) &&
    !(fogMazeCfg.endTurn > 0 && turn >= fogMazeCfg.endTurn) &&
    !(fogMazeCfg.known && targets.length) &&
    !(fogMazeCfg.landCap > 0 && enemyLand > 0 && self.land * 100 > enemyLand * fogMazeCfg.landCap) &&
    !(
      fogMazeCfg.leadCap > 0 &&
      turn >= fogMazeCfg.leadTurn &&
      enemyArmy > 0 &&
      self.army * 100 > enemyArmy * fogMazeCfg.leadCap
    );
  // Enemy economy gate (see ./fog-maze). The one measured regression of the
  // layer is an economy game: the rival turns its 43-48 corridor land into
  // twenty crowns while we hold two, so the layer hands the frame back as soon
  // as the rival's crown *income* (the leaderboard army delta of a non-growth
  // tick) says it owns `econ` crowns while we still hold at most `econOurs`.
  // Off at 0, and no state is allocated while it is off.
  const mazeFogEcon =
    mazeFogBase && fogMazeCfg.econ > 0
      ? fogMazeEconomy(b, { turn, enemyArmy }, fogMazeCfg)
      : null;
  const mazeFogBaseOpen = mazeFogBase && !fogMazeEconGate(mazeFogEcon, turn, fogMazeCfg);
  // Progress guard (see ./fog-maze). Off by default (`stall`, `landLead` and
  // `drop` are 0), and skipped entirely while they are so the layer's measured
  // path stays byte for byte. When it is on it hands the frame back to the
  // stock planner with a latched verdict: the border has nothing left to paint,
  // the layer has stopped converting ticks into land, or our land is being
  // eaten. Measured verdicts are in BOT3_MAZE.md.
  const mazeFogGuard =
    fogMazeCfg.stall > 0 ||
    fogMazeCfg.landLead > 0 ||
    fogMazeCfg.drop > 0 ||
    fogMazeCfg.behind > 0 ||
    fogMazeCfg.armyBehind > 0;
  const neutralFront = mazeFogBaseOpen && mazeFogGuard ? neutralBorder(b, me) : -1;
  const mazeFogProgress =
    mazeFogBaseOpen && mazeFogGuard
      ? fogMazeProgress(
          b,
          { turn, land: self.land, enemyLand, army: self.army, enemyArmy, neutralFront },
          fogMazeCfg,
        )
      : null;
  const mazeFogOpen = mazeFogBaseOpen && !mazeFogProgress?.stalled;
  // Paint cap (see ./fog-maze): `Infinity` unless the bundle is on, so the
  // shipped layer keeps its measured path byte for byte. The border count is
  // only walked while the cap is live.
  const paintCap =
    mazeFogOpen && fogMazeCfg.paint > 0
      ? fogMazePaintCap(fogMazeCfg, neutralBorder(b, me))
      : Infinity;
  // Land-first layer (see ./land). Structurally swamp-heavy clear serial rooms
  // spend the serial tick on army concentration instead of land, and the exact
  // leaderboard land race says when that is the losing trade. Every field is
  // inert unless a `BOT3_LAND*` flag is set, so the shipped path stays byte for
  // byte.
  const landCfg = landConfig();
  const land = clearSerial
    ? landContext(
        b,
        {
          turn,
          multi,
          clearSerial,
          single,
          size,
          land: self.land,
          enemyLand,
          neutral: landCfg.landfirst ? neutralBorder(b, me) : 0,
        },
        landCfg,
      )
    : null;
  const fogAim =
    fogOpen &&
    fogCfg.aimFront &&
    !maze &&
    !targets.length &&
    self.army * 100 >= enemyArmy * aimLead;
  // Belief region for the hidden enemy home (see ./fog). `belief` also lets it
  // take over the objective field, so every advance rule (not just the column)
  // pushes at the far region. Keeping it off by default means the prior can
  // steer the column without moving every garrison off a crown.
  const beliefTargets =
    fogOpen && fogCfg.belief && !targets.length ? fogBeliefTargets(b, homes, fogCfg) : null;
  // Objective on a fogged corridor board: remembered crowns first (they are the
  // win condition), then the visible rival frontier plus the far anchors of the
  // passable tree (see ./fog-maze). Without it `goal` stays infinite and every
  // advance rule is dead.
  const mazeFogTargets =
    mazeFogOpen && !targets.length
      ? fogMazeObjective(b, { homes, enemies }, fogMazeCfg).targets
      : null;
  // Multi-line corridor rooms: the sixteen orders have to walk *different*
  // branches instead of stacking into one corridor (see ./fog-maze).
  const mazeFogMulti =
    mazeFogRoom && multi && size <= fogMazeCfg.maxBoard && turn >= fogMazeCfg.startTurn;
  const mazeBranches =
    mazeFogMulti && fogMazeCfg.branches
      ? fogMazeObjective(b, { homes, enemies }, { ...fogMazeCfg, count: fogMazeCfg.branches })
          .targets
      : null;
  const branchDist =
    mazeBranches?.length && fogMazeCfg.branch ? distances(b, mazeBranches).dist : null;
  const objectives = arch.targets?.length
    ? arch.targets
    : single
      ? (rival?.crowns ?? [])
      : beliefTargets?.length
      ? beliefTargets
      : mazeFogTargets?.length
        ? mazeFogTargets
        : fogAim
          ? enemies
          : targets;
  const { dist: goal, queue } = distances(b, objectives);
  const heading = targets.length ? goal : enemies.length ? enemyDist : scouting;
  const required = assaultStrength(b, queue, goal, units, teams, myTeam);
  // `scout` only steers the fog column. It is the same belief field, priced the
  // same conservative way, so a column that reaches the far region can still
  // stage instead of walking a stack into an unseen garrison.
  const scoutTargets =
    fogOpen && (fogCfg.scout || fogCfg.raid) && !targets.length && !beliefTargets?.length
      ? fogBeliefTargets(b, homes, fogCfg)
      : null;
  const scout = scoutTargets?.length ? distances(b, scoutTargets) : null;
  const scoutRequired = scout ? assaultStrength(b, scout.queue, scout.dist, units, teams, myTeam) : null;
  const scoutReserve =
    scout && fogCfg.guess ? fogRequired(scoutRequired, scout.dist, fogCfg.guess) : scoutRequired;
  const { threat, immediate } = incomingStrength(b, enemies, units, teams, myTeam);
  const pressure = constructionPressure(b, units, teams, myTeam, enemyDist);
  const danger = homes.filter((i) => threat[i] > units[i]);
  const exposedHome = turn >= 38 && homes.length <= 2 ? homes.find((i) => pressure(i) > units[i]) : undefined;
  const defense = distances(b, danger, (j) => teams[j] === myTeam && !b.isolated[j]).dist;
  const fog =
    fogOpen || mazeFogOpen
      ? fogUpdate(b, { turn, multi, size, army: self.army, enemyArmy, danger: danger.length })
      : { active: false };
  const fogColumn = fog.active === true && (mazeFogOpen ? fogMazeCfg.column : fogCfg.column);
  const fogGuess = mazeFogOpen ? fogMazeCfg.guess : fogCfg.guess;
  const fogReserve =
    fogColumn && (fogGuess || oracle)
      ? fogRequired(required, goal, fogOracleReserve(fogGuess, oracle, oracleCfg))
      : required;
  // Paint-before-advance on the open fog room (see ./fog `fogPaintCap`): the
  // column advance may only merge between our own cells while the border has
  // nothing left to paint. `Infinity` unless the knob is on, so the shipped path
  // stays byte for byte. The stops keep the cap off once the land race is won,
  // the board is swamp-heavy (swamp pays no income) or the phase is over: the
  // cap converts early merge ticks into land, and a leading empire needs its
  // concentration back. Land, army and turn are all exact reads.
  const paintWon =
    (fogCfg.paintLead > 0 && enemyLand > 0 && self.land * 100 > enemyLand * fogCfg.paintLead) ||
    (fogCfg.paintUntil > 0 && turn >= fogCfg.paintUntil) ||
    (fogCfg.paintSwamp > 0 && swampCells * 100 >= size * fogCfg.paintSwamp) ||
    (fogCfg.paintArmy > 0 && enemyArmy > 0 && self.army * 100 > enemyArmy * fogCfg.paintArmy);
  const fogPaint =
    fogColumn && fogCfg.paint > 0 && !paintWon
      ? fogPaintCap(fogCfg, neutralBorder(b, me))
      : Infinity;
  // A dead-even attrition on a compact serial room has to be converted by
  // concentration, not by more income; see ./closing for the diagnosis.
  // Land-first rooms hand the frame back to the land race: the funnel crosses
  // swamp instead of converting it, so the layer is asked for its verdict but
  // stays out of the frame (the state stays readable for diagnostics).
  const closing = single
    ? closingUpdate(
        b,
        {
          turn,
          multi,
          size,
          army: self.army,
          enemyArmy: rival ? rival.player.army : 0,
          enemyCrowns: rival ? rival.crowns.length : 0,
          danger: danger.length,
        },
        land?.closeSkip ? closingConfig({ enabled: false }) : undefined,
      )
    : { active: false };
  const closeIn = closing.active === true;
  // Finish layer: when an owned stack can provably take an enemy crown and
  // keep it, that ends the game and outranks every economy or frontier score.
  // It ships on only against the replayed relay planner: the strict shadow
  // streak (`board.shadow.armed`) is the proof that the opponent is that
  // planner, and the measured conversions are against it. The per-tick
  // prediction is not the gate, because relay's queue can be empty on a tick
  // while the layer stays armed. `BOT3_FINISH=0` disables the layer,
  // `BOT3_FINISH_ARM=0` drops the arm gate (A/B only), `board.finish = true`
  // forces it for one game. Multi-line play is untouched.
  const finishArmed = process.env.BOT3_FINISH_ARM === '0' || b.shadow?.armed === true;
  if (!multi && b.finish !== false && (b.finish === true || (finishEnabled() && finishArmed))) {
    const finish = planFinish(
      b,
      {
        turn,
        teams,
        myTeam,
        homes,
        targets,
        cut,
        threat,
        danger,
        teamByOwner,
        rivalTeam: rival ? (teamByOwner.get(rival.player.id) ?? 0) : 0,
      },
      finishOptions(),
    );
    if (finish.ok) {
      if (process.env.BOT3_FINISH_TRACE === '1')
        console.error(`[finish] t${turn} ${finish.from}->${finish.to} armed ${b.shadow?.armed}`);
      b.column = finish.to;
      b.columnTurn = turn;
      b.lastFrom[finish.to] = finish.from;
      b.lastMove[finish.to] = turn;
      if (shadow) shadowRecord(b, turn, [{ from: finish.from, to: finish.to }]);
      return [{ score: 3000, from: finish.from, to: finish.to, mode: 2 }];
    }
  }
  const mobileArmy = self.army - self.land;
  // Fog multi-line layer (see ./fog-multi): it prices the fog burst by the land
  // race and, when asked, hands the sixteen orders a focus objective while no
  // rival crown is known. Off by default, so nothing here changes the baseline.
  const fogMultiLayer = multi
    ? fogMultiUpdate(
        b,
        {
          turn,
          multi,
          size,
          fog: Boolean(b.fogMode ?? b.fog.includes(1)),
          homes,
          targets,
          enemies,
          army: self.army,
          land: self.land,
          enemyArmy,
          enemyLand,
        },
        fogMultiConfig(),
      )
    : null;
  // Multi-line rooms get their own economy and endgame scoring; see ./multi.
  // Off by default, so `BOT3_MULTI` unset keeps the byte-identical baseline.
  const multiLayer = multiUpdate(b, {
    turn,
    multi,
    size,
    units,
    teams,
    myTeam,
    targets,
    fogTargets:
      mazeFogMulti && fogMazeCfg.route && mazeBranches?.length
        ? mazeBranches
        : fogMultiLayer?.targets,
    fogBurst: fogMultiLayer?.burst,
    mobileArmy,
    army: self.army,
    enemyArmy,
    fog: Boolean(b.fogMode ?? b.fog.includes(1)),
  });
  // While closing, the empire funnels into its heaviest stack and that stack
  // pushes once it can pay for the remaining path (see ./closing). The lead has
  // to be chosen here, where the unit counts live.
  let closingLead = -1,
    closingLeadDist = null;
  const fogRaidRoom = fogOpen && fogCfg.raid && !closeIn;
  if (closeIn || fogColumn || fogRaidRoom) {
    let best = 0;
    for (let i = 0; i < size; i++) {
      if (teams[i] !== myTeam || b.isolated[i] || ownerOf(tile[i]) !== me) continue;
      if (units[i] > best) {
        best = units[i];
        closingLead = i;
      }
    }
    if (closingLead >= 0) closingLeadDist = distances(b, [closingLead], (j) => !b.isolated[j]).dist;
  }
  // Gather-then-raid doctrine (see ./fog). While no enemy crown is remembered,
  // the heaviest stack is held back and fed by the rest of the empire; once it
  // carries enough mass it drives at the belief region / remembered crown.
  const fogRaid = fogRaidRoom
    ? fogRaidUpdate(
        b,
        {
          turn,
          lead: closingLead,
          leadMass: closingLead >= 0 ? units[closingLead] : 0,
          mobileArmy,
          danger: danger.length,
        },
        fogCfg,
      )
    : { phase: 'idle', lead: -1, mass: 0, gather: false, resting: false };
  const raidOn = fogRaid.phase === 'gather' || fogRaid.phase === 'raid';
  const longFront = !multi && size >= 400;
  let route;
  if (longFront && !clearSerial && turn >= 44) {
    const unseen = scouts.filter((i) => b.lastSeen[i] === -1);
    const destinations = targets.length ? targets : unseen.length ? unseen : scouts;
    route = campaignRoute(b, destinations, units, teams, myTeam, Math.max(3, mobileArmy / 70));
  }
  let front;
  const anchorDist = single
    ? distances(
        b,
        anchors.filter((i) => teams[i] === myTeam),
        (j) => teams[j] === myTeam && !b.isolated[j],
      ).dist
    : null;
  if (single) {
    for (const i of borders) {
      for (const j of neighbors[i]) {
        if (tile[j] !== 201 && teams[j] !== myTeam)
          anchorDist[j] = Math.min(anchorDist[j], anchorDist[i] + 1);
      }
    }
  }
  const rivalCrowns = new Map();
  if (single)
    for (const i of targets) {
      const owner = ownerOf(b.memory[i]);
      rivalCrowns.set(owner, (rivalCrowns.get(owner) ?? 0) + 1);
    }
  const ffa = new Set(teamByOwner.values()).size > 2;
  const productiveTarget = ffa
    ? 5 + 2 * Math.max(0, ...rivalCrowns.values())
    : rival
      ? rival.crowns.length + Math.max(3, Math.ceil(rival.crowns.length * 0.35))
      : 5;
  const invest =
    single &&
    !closeIn &&
    (homes.length < productiveTarget || mobileArmy > homes.length * 240) &&
    (!danger.length || homes.length > 2);
  let limit = single
    ? invest
      ? Math.max(productiveTarget, homes.length + 1)
      : Math.max(2, 1 + Math.floor(mobileArmy / 140))
    : Math.max(2, Math.min(longFront ? 12 : 32, 1 + Math.floor(mobileArmy / 185)));
  // Fog mirrors are attrition: each extra crown is one more target the raider
  // must spend a stack on, plus one army per tick. Only the ceiling moves; the
  // site choice (and its `spread` rule) stays on the normal path.
  if (fogOpen && fogCfg.homes) limit = Math.max(limit, fogCfg.homes);
  // Island crowns (see ./land): a crown on a rear island is safe income on a
  // swamp-heavy archipelago room, and the stock ceiling is priced by mobile
  // army, not by what the map can support. Inert at 0.
  if (land?.homes) limit = Math.max(limit, land.homes);
  const develop =
    (!single || invest || homes.length <= 2 || turn % 12 < (longFront ? 6 : 5) || land?.develop) &&
    !closeIn;
  const backup = single && !longFront && !ffa && homes.length === 1 && enemyDist[homes[0]] <= 12;
  const buildingStart = clearSerial ? (backup ? 39 : 50) : 38;
  // Crown placement in a fogged multi-line room (see ./fog-multi `site`): a
  // site the rival's vision has never touched cannot be remembered as a target.
  // Off at 0 and only read in a fog multi room, so the shipped path stays byte
  // for byte.
  const fogSite = multi && !clearSerial ? fogMultiConfig().site : 0;
  const siteSpread = fogOpen ? fogCfg.spread : (land?.spread ?? 0);
  const site =
    develop && turn >= buildingStart && homes.length < limit
      ? selectBuildSite(
          b,
          units,
          pressure,
          frontDist,
          homeDist,
          anchorDist,
          siteSpread,
          fogSite,
          enemyDist,
        )
      : -1;
  if (single) {
    const route = campaignRoute(b, objectives, units, teams, myTeam, Math.max(3, mobileArmy / 70));
    const rescue = rescueValues(b, teams, myTeam, units);
    front = {
      b,
      beforeBurstEnd,
      units,
      teams,
      myTeam,
      turn,
      goal,
      required,
      homeDist,
      immediate,
      cut,
      rescue,
      frontDist,
      route,
      homes,
      danger,
      site,
      self,
      rival,
      ffa,
      wide: longFront,
      anchorDist,
      defense,
      invest,
      backup,
      closing: closeIn,
      push: closing.push ?? 1,
      lead: closingLead,
      leadDist: closingLeadDist,
      enemyDist,
      arch,
      land,
    };
  }
  const candidates = [];
  const propose = (score, from, to, mode = 2, build, send) => {
    if (score > 0) candidates.push({ score, from, to, mode, build, send });
  };
  for (let i = 0; i < size; i++) {
    if (ownerOf(tile[i]) !== me || b.isolated[i]) continue;
    const base = crown(tile[i]),
      critical = base || cut[i] > 20;
    const nearFight = enemyDist[i] < 5;
    // A new crown inside the old cluster is one raid away from a cascade: the
    // traced losses lose two or three crowns to a single stack. When the fog
    // spread rule is on, a site too close to an existing crown is refused.
    const tooClose = siteSpread > 0 && homeDist[i] < siteSpread;
    // Island crown (see ./archipelago): on a swamp-heavy room a crown is the
    // only income that compounds (+1/tick, swamp pays nothing), so a fully
    // owned island the rival cannot reach may raise one without waiting for
    // `develop`/`buildingStart` and without a 100-unit stack.
    const archCrown =
      Boolean(arch.crownIslands) && arch.island[i] >= 0 && arch.crownIslands[arch.island[i]] === 1;
    if (
      !base &&
      !swamp(tile[i]) &&
      !tooClose &&
      units[i] >= 50 &&
      (turn >= buildingStart || (archCrown && turn >= arch.crownTurn))
    ) {
      const city = anchor(tile[i]);
      // A safe upgrade gives a second crown immediately, even if the old
      // crown is under pressure. Otherwise a forced defence takes this tick.
      const safe = (city || !danger.length) && pressure(i) <= units[i] - 50;
      const outpost = single && !closeIn && anchorDist[i] >= 5 && (cut[i] > 25 || units[i] >= 85);
      // `pressure` projects a seven-step hostile mass and is far too pessimistic
      // on a fogged small map (it reads 3000+ everywhere), so it would suppress
      // every build and leave the empire on two crowns for 1000 ticks. A fog
      // crown only needs to be out of the current line of contact.
      const fogBuild =
        fogOpen &&
        fogCfg.invest &&
        units[i] >= 100 &&
        immediate[i] < units[i] &&
        homes.length < limit;
      if (
        (safe || fogBuild || archCrown) &&
        (develop || outpost || fogBuild || archCrown) &&
        (homes.length < limit || outpost || archCrown) &&
        (city || units[i] >= 100 || (cut[i] > 30 && nearFight) || outpost || archCrown)
      ) {
        const buildScore =
          archCrown && i === site
            ? Math.max(arch.crownScore, 675)
            : archCrown
              ? arch.crownScore
              : fogBuild
                ? INVEST_SCORE
                : i === site
                  ? invest
                    ? 675
                    : single
                      ? 403
                      : 360
                  : outpost
                    ? 420
                    : city
                      ? 195
                      : units[i] >= 100
                        ? 150
                        : 105;
        propose(
          backup && i === site
            ? 820
            : (land?.site && i === site ? Math.max(buildScore, land.site) : buildScore) -
                (nearFight && homes.length > 1 ? 82 : 0),
          i,
          i,
          2,
          city ? 'c' : 'b',
        );
      }
    }
    if (units[i] < 2) continue;
    for (const j of neighbors[i]) {
      if (tile[j] === 201 || (teams[j] === myTeam && ownerOf(tile[j]) !== me)) continue;
      const own = teams[j] === myTeam,
        hostile = teams[j] && !own;
      const strike = hostile && crown(tile[j]);
      const exposure = Math.max(
        0,
        ...neighbors[i]
          .filter((k) => k !== j && teams[k] && teams[k] !== myTeam && !b.isolated[k])
          .map((k) => units[k] - 1),
      );
      let mode = 2,
        send = units[i] - 1;
      // Capturing the threatening stack itself removes that approach.
      const intercept = hostile && send > units[j] && units[j] - 1 >= threat[i];
      const trade =
        hostile &&
        !base &&
        !strike &&
        exposedHome !== undefined &&
        homeDist[j] <= 4 &&
        units[j] >= Math.max(6, 0.5 * units[exposedHome]) &&
        units[j] - send <= units[exposedHome] + homeDist[j] &&
        exposure <= 1;
      const needed = intercept || trade ? exposure : threat[i];
      if (critical && needed > 1 && !(strike && send > units[j])) {
        const otherDefense = neighbors[i]
          .filter((k) => k !== j && tile[k] !== 201 && teams[k] !== myTeam)
          .reduce((sum, k) => sum + units[k] - 1, 0);
        const smart = Math.max(0, units[i] - 1 - otherDefense);
        if (units[i] - Math.min(send, smart) >= needed) {
          mode = 0;
          send = Math.min(send, smart);
        } else if (units[i] - Math.min(send, Math.floor(smart / 2)) >= needed) {
          mode = 1;
          send = Math.min(send, Math.floor(smart / 2));
        } else continue;
      }
      if (send <= 0) continue;
      // Moving a guard off a choke to fund a rear site opens the same lane
      // as spending the guard on a castle. Moving toward the column can
      // still intercept it, or reinforce a threatened crown behind us.
      if (own && j === site && defense[j] >= defense[i] && pressure(i) > units[i] - send) continue;
      if (trade && send >= 4)
        propose(920 + Math.min(100, Math.min(units[j], send)), i, j, mode, undefined, send);
      if (!own && send <= units[j]) {
        if (front && hostile) propose(siegeValue(front, i, j, send), i, j, mode, undefined, send);
        continue;
      }
      const remaining = own ? send + units[j] : send - units[j];
      const opens = neighbors[j].filter((k) => tile[k] !== 201 && teams[k] !== myTeam).length;
      const support = neighbors[j].filter((k) => teams[k] === myTeam && !b.isolated[k]).length;
      if (front) {
        propose(
          evaluateFrontMove(front, {
            i,
            j,
            own,
            hostile,
            strike,
            send,
            remaining,
            support,
            exposure,
            intercept,
            base,
          }),
          i,
          j,
          mode,
          undefined,
          send,
        );
        continue;
      }
      let score = 0;
      if (!own) {
        score = beforeBurstEnd ? 62 : 32;
        // Land-first burst (see ./land): a neutral capture inside the 26..49
        // window pays one army per tick until turn 50, so on a swamp-heavy
        // board it outranks the own-merge marches that score on this path.
        if (land?.burst) score += land.burst;
        if (land?.capture && !hostile) score += land.capture;
        if (swamp(tile[j])) score -= beforeBurstEnd && turn < 49 ? 29 : 8;
        score += Math.min(3, opens) * 2 + Math.min(4, remaining - 1) * 1.3;
        if (hostile) score += 17 + Math.min(95, Math.sqrt(cut[j]) * 5);
        if (hostile && anchor(tile[j])) score += 80;
        if (strike) score += 2000;
        if (hostile && threat[i] && homeDist[j] <= 3) score += Math.min(130, units[j] * 3);
        if (neighbors[j].some((k) => teams[k] === myTeam && b.isolated[k])) score += 90;
        if (scouting[j] < scouting[i]) score += 6;
        if (enemyDist[j] < enemyDist[i] || goal[j] < goal[i]) score += 5;
        if (support > 1 && nearFight) score += 9;
        if (immediate[j] > remaining && !strike) score -= Math.min(52, remaining * 1.3);
      } else if (!b.isolated[j]) {
        if (frontDist[j] < frontDist[i]) score = 14 + Math.min(45, Math.sqrt(send) * 4);
        if (defense[j] < defense[i] && send >= 2)
          score = Math.max(score, 560 + Math.min(90, send * 2) - 10 * defense[j]);
        if (j === site && units[j] < (anchor(tile[j]) ? 50 : 100) && send >= 2)
          score = Math.max(score, 321 + Math.min(30, send / 3));
      }
      if (goal[j] < goal[i]) {
        const need = required[j] + (b.fog[j] ? 4 : 0) + Math.min(15, goal[j]);
        if (remaining >= need && (remaining >= goal[j] + 1 || goal[j] <= 2)) {
          const closeAttack = goal[j] <= 4 ? 145 : 0;
          score = Math.max(
            score,
            285 + closeAttack - Math.min(110, goal[j] * 5) + Math.min(20, (remaining - need) / 4),
          );
        } else if (turn >= 45 && send >= 4) {
          score = Math.max(
            score,
            48 + Math.min(62, Math.sqrt(send) * 4) - Math.min(18, goal[j]) + (hostile ? 8 : 0),
          );
        }
      }
      if (turn < (clearSerial ? 45 : 35) && goal[j] > 5 && own)
        score = Math.min(score, 44 + Math.min(send, 14));
      if (turn >= 40 && !strike && !b.isolated[j] && heading[j] < heading[i]) {
        // Gather while advancing. A stack that picks up the next garrison
        // can reach the front intact without a separate collection phase.
        const pickup = own ? Math.min(send, units[j] - 1) : 0;
        const mass = Math.max(0, remaining - immediate[j] * 0.75);
        const march =
          60 + Math.min(145, Math.sqrt(mass) * 8) + Math.min(55, pickup) - Math.min(32, heading[j]);
        if (send > 7 && mass > 5) score = Math.max(score, march);
      }
      if (route && route[j] < route[i] && send >= 12 && !b.isolated[j]) {
        const sameColumn = i === b.column && turn - b.columnTurn <= 3;
        const assemble = own ? Math.min(units[j] - 1, send) : 0;
        const safeMass = remaining - immediate[j] * 0.65;
        if (safeMass > 8) {
          const priority =
            150 +
            Math.min(145, Math.sqrt(safeMass) * 8) +
            Math.min(45, assemble) +
            (sameColumn ? 45 : 0) -
            Math.min(80, route[j] * 0.8);
          score = Math.max(score, priority);
        }
      }
      if (route && homes.length > 2 && own && defense[j] < defense[i] && defense[i] > 2)
        score = Math.min(score, 170);
      // Maze fog: on a corridor board a forward neutral capture is both income
      // and the only way to open vision, and the own-merge march term above is
      // otherwise what the tick is spent on (see ./fog-maze).
      if (
        mazeFogOpen &&
        fogMazeCfg.capture &&
        !own &&
        !hostile &&
        !strike &&
        (fogMazeCfg.deep || goal[j] < goal[i])
      )
        score = Math.max(
          score,
          fogMazeCfg.capture +
            Math.min(60, Math.sqrt(send) * 6) -
            Math.min(40, (Number.isFinite(goal[j]) ? goal[j] : 40) * 2),
        );
      // Maze fog multi-line: walk the corridor branches instead of stacking all
      // sixteen orders into the same lane (see ./fog-maze).
      if (branchDist && fogMazeCfg.branch && !strike) {
        const closer = branchDist[j] < branchDist[i];
        if (!own && closer)
          score = Math.max(
            score,
            fogMazeCfg.branch +
              Math.min(60, Math.sqrt(send) * 6) -
              Math.min(40, (Number.isFinite(branchDist[j]) ? branchDist[j] : 40) * 2),
          );
        else if (own && closer && send >= 2) score = Math.max(score, fogMazeCfg.branch);
      }
      // Contact with the visible rival frontier: taking it is the only way the
      // fogged map shrinks. Scored as a bonus instead of an objective cell so
      // the column keeps walking the corridor behind it.
      if (mazeFogOpen && fogMazeCfg.harass && hostile && !strike && !base)
        score = Math.max(
          score,
          fogMazeCfg.harass + Math.min(60, Math.sqrt(send) * 6) - Math.min(30, enemyDist[j] * 3),
        );
      if (hostile && danger.length && homeDist[j] <= 4 && units[j] >= 8 && intercept)
        score = Math.max(score, 680 + Math.min(100, units[j]));
      // Fog column: the heaviest stack advances and attacks instead of merging
      // between its own cells, and rear garrisons funnel into it. `fogReserve`
      // prices the steps the fog hides, so the column stages instead of walking
      // a big stack into an ambush (see ./fog for the measured traces).
      if (fogColumn) {
        const aim = scout ? scout.dist : goal;
        const reserve = scout ? scoutReserve : fogReserve;
        if (i === closingLead) {
          const forward = aim[j] < aim[i] || (hostile && enemyDist[j] <= enemyDist[i]);
          if (
            fogCfg.expand &&
            !own &&
            !hostile &&
            !strike &&
            !b.isolated[j] &&
            send >= 2 &&
            (forward || heading[j] < heading[i])
          )
            score = Math.max(score, expandScore(send, heading[j]));
          if (forward && send > 1 && remaining >= reserve[i]) {
            // Paint cap: a forward column move onto our own cell is a merge and
            // buys no land. While the corridor frontier still has a neutral
            // cell, cap it under the capture term so the serial tick paints
            // (see ./fog-maze, `BOT3_MAZEFOG3`).
            let advance = own
              ? Math.min(columnAdvance(send, remaining), paintCap, fogPaint)
              : columnAdvance(send, remaining);
            // Fog oracle: refuse a dive the lead cannot pay for (a fogged step
            // may hold `density` units), and add a push when the rival's
            // interior is empty (see ./fog-oracle).
            if (fogOracleBlocked(oracle, b.fog[j] === 1, send, oracleCfg))
              advance = Math.min(advance, oracleCfg.blockScore);
            else if (fogOraclePush(oracle, send, oracleCfg)) advance += oracleCfg.pushScore;
            score = Math.max(score, advance);
          } else if (
            fogCfg.guard &&
            !forward &&
            enemyDist[i] >= 4 &&
            homeDist[i] > 2 &&
            homeDist[j] < homeDist[i] &&
            send >= 8
          )
            score = Math.max(score, guardScore(send));
        } else if (
          fogCfg.funnel &&
          closingLeadDist &&
          closingLeadDist[j] < closingLeadDist[i] &&
          enemyDist[i] >= 3 &&
          send >= 2
        ) {
          score = Math.max(score, funnelScore(own ? send + units[j] : send));
        }
      }
      // Gather-then-raid doctrine. `gather` holds the assembly point and pulls
      // the rest of the empire into it; `raid` drives the assembled stack at
      // the objective field. Both are additive with the fog column above; the
      // lead only keeps a real capture or a defence while it assembles.
      if (raidOn && closingLeadDist) {
        if (i === fogRaid.lead) {
          if (fogRaid.phase === 'raid') {
            const ahead = (scout ? scout.dist[j] < scout.dist[i] : goal[j] < goal[i]) ||
              (hostile && enemyDist[j] <= enemyDist[i]);
            const reserve = scout ? scoutReserve : fogReserve;
            if (ahead && send > 1 && remaining >= reserve[i])
              score = Math.max(score, RAID_SCORE + 100 + Math.min(120, Math.sqrt(remaining) * 6));
          } else if (!strike && !hostile) {
            score = 0;
          }
        } else if (
          own &&
          send >= 2 &&
          !crown(tile[i]) &&
          !danger.length &&
          closingLeadDist[j] < closingLeadDist[i]
        ) {
          score = Math.max(score, RAID_SCORE + Math.min(60, send * 2));
        }
      }
      // A narrow advance is fragile when an adjacent enemy can take the
      // vacated connection. Independent routes and anchors avoid that risk.
      if (!own && support === 1 && !anchor(tile[i]) && exposure >= units[i] - send && !strike) score -= 180;
      // Paint before merging (see ./fog-oracle): while the leaderboard says the
      // board still has open neutral land, a plain move onto our own cell buys
      // no land, no income and no vision, so it may not outrank the capture next
      // door. Defence modes (0/1), strikes and the campaign route keep their
      // score: those are what a fogged empire has to keep paying for.
      if (own && mode === 2 && !strike && !(route && route[j] < route[i]))
        score = Math.min(score, oraclePaint);
      // Last crown (see ./fog-oracle): the crown count is read off the rival's
      // army growth, and once it is one, a remembered home is the whole game.
      // Opt-in: the ledger is primed at 1 by the spawn rule, so an unconfirmed
      // read would make this fire from the opening tick.
      if (oracleCfg.allIn && oracle?.lastCrown && targets.length && goal[j] < goal[i] && send >= 4)
        score = Math.max(score, oracleCfg.allInScore);
      if (b.lastFrom[i] === j && turn - b.lastMove[i] <= 4 && defense[j] >= defense[i] && !strike)
        score -= 110;
      // Water discipline (see ./archipelago): on a swamp-heavy board a swamp
      // capture that does not shorten the distance to the nearest unclaimed
      // plain cell pays no income, so it may not outrank the land capture next
      // door. Strikes and hostile captures keep their score.
      if (!own && !hostile && !strike && archipelagoWaterBlocked(arch, tile, i, j))
        score = Math.min(score, arch.waterCap);
      if (score > 0) propose(score, i, j, mode, undefined, send);
    }
  }
  if (front) searchCampaign(front, candidates);
  // Cut economics layer (see ./cut): windfall timing, articulation pricing and
  // fortifying our own chokepoints. Off by default; one hook, no state.
  cutApply(
    cutUpdate({ b, size, turn, multi, teams, units, cut, myTeam }, cutConfig()),
    {
      b,
      size,
      turn,
      multi,
      teams,
      units,
      cut,
      homes,
      myTeam,
      pressure,
      enemyDist,
      fog: !clearSerial,
      closing: closeIn,
      // Exact material reads: the cell sums are only what we can see in a fog
      // room, and the rescue gate is a positional question, so use the
      // leaderboard numbers.
      army: self.army,
      rivalArmy: enemyArmy,
      land: self.land,
      rivalLand: enemyLand,
    },
    candidates,
  );
  // Upstream reinforcement pricing: a small deposit into an own stack is far
  // less valuable than a full-stack move, a recently reversed lane is noise,
  // and reconnecting a large pocket can recover its whole garrison at once.
  if (turn >= 50 && !(clearSerial && longFront)) {
    const forceScale = Math.max(10, Math.sqrt(mobileArmy));
    for (const op of candidates) {
      if (op.build) continue;
      const i = op.from,
        j = op.to;
      if (teams[j] === myTeam && !danger.includes(j)) {
        const send = op.send;
        if (!send) continue;
        const fraction = send / Math.max(1, units[j] + send);
        const cost = anchor(tile[j]) ? 50 : 100;
        if (fraction < 0.2 && !(j === site && units[j] < cost && units[j] + send >= cost))
          op.score *= 0.2 + 3 * fraction;
        if (b.lastFrom[i] === j && turn - b.lastMove[i] <= 8) op.score -= 260;
      } else if (teams[j] !== myTeam && !crown(tile[j])) {
        const rescue = front?.rescue[j] ?? 0;
        if (rescue > forceScale * 2 && op.send > units[j] && (homes.length > 1 || !danger.length))
          op.score = Math.max(op.score, 780 + Math.min(900, (340 * rescue) / forceScale));
      }
    }
  }
  if (multiLayer) applyMulti(multiLayer, { tile, teams, units, neighbors, myTeam, frontDist }, candidates);
  if (mshapeLayer) applyMshape(mshapeLayer, { tile, teams, units, neighbors, myTeam }, candidates);
  // Shadow pricing: the scores of the existing candidates move, and the
  // prediction also creates the candidates re-ranking cannot produce (see
  // ./shadow: an approach step toward its next objective, the counter-capture
  // of the tile it abandons, a reinforcement it cannot invalidate).
  const shadowCtx = shadow ? shadowContest(shadow, b, turn, b.me - 1) : null;
  if (shadowCtx) {
    for (const op of candidates) op.score += shadowAdjust(shadowCtx, b, op);
    shadowPlan(shadowCtx, b, turn, candidates);
    // A vetoed order is validated after relay's already landed and would be
    // spent for nothing; the single serial slot goes to the next best order.
    // If every candidate is vetoed, keep them: an idle tick is worse.
    const kept = candidates.filter((op) => !op.veto);
    if (kept.length && kept.length !== candidates.length)
      candidates.splice(0, candidates.length, ...kept);
  }
  candidates.sort((a, c) => c.score - a.score);
  const used = new Set(),
    orders = [];
  // Maze lane discipline: do not spend consecutive ticks on the same corridor
  // edge (or its reverse) unless the move is a real cut, capture or defence.
  const take = (op) => {
    if (used.has(op.from) || used.has(op.to)) return false;
    if (maze && (LANE || (mazeFogOpen && fogMazeCfg.lane)) && !op.build) {
      const i = op.from,
        j = op.to;
      const hostile = teams[j] && teams[j] !== myTeam;
      const forward = goal[j] < goal[i] || (front ? front.route[j] < front.route[i] : false);
      const emergency =
        (hostile && (crown(tile[j]) || (units[j] >= 16 && units[i] - 1 > units[j]))) ||
        (teams[j] === myTeam && (immediate[j] >= units[j] || (danger.length > 0 && defense[j] <= 1)));
      if (laneBlocked(b, i, j, turn, forward, emergency)) return false;
    }
    used.add(op.from);
    used.add(op.to);
    orders.push(op);
    if (!op.build) {
      if (!multi) {
        b.column = op.to;
        b.columnTurn = turn;
      }
      b.lastFrom[op.to] = op.from;
      b.lastMove[op.to] = turn;
      if (maze) recordLane(b, op.from, op.to);
    }
    return true;
  };
  // The rules allow one order per non-empty front per tick and neither the
  // engine nor the server caps the queue, so the cap is `./mshape`'s to lift.
  const multiSlots = mshapeLayer ? mshapeLayer.slots : 16;
  for (const op of candidates) {
    if (take(op) && (!multi || orders.length >= multiSlots)) break;
  }
  // Unlimited fronts (see ./mshape): one cell may take two different neutral
  // neighbours in the same tick when both pushes are halved.
  if (mshapeLayer && multi) {
    for (const op of applyFan(mshapeLayer, { tile, teams, units, neighbors }, orders)) orders.push(op);
  }
  // A fully blocked frame must not idle: keep the previous behaviour when no
  // lane passed the guard (the cooldown expires within four ticks).
  if (maze && !orders.length && candidates.length) take(candidates[0]);
  if (shadow) shadowRecord(b, turn, orders);
  return orders;
}

module.exports = { createBoard, chooseOrders };
