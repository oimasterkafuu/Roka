'use strict';

// One-tick simulator of the real engine rules (src/game-engine.ts, gameTick).
//
// The bot board is already the engine's *encoded* grid (`grid_type`: owner code
// for owned cells, 200 empty plain, 201 mountain, 204 neutral swamp; see
// src/game-engine/map-encoding.ts), so the simulator runs on copies of the same
// arrays the planner uses. Nothing here reads `dist/` and nothing ships the
// engine: the rules below were validated against the real GameEngine by
// `bot-template/bot-3.0/msim.test.cjs`-style scripted boards (see MSIM.md for
// the measured match rate).
//
// Modelled, in engine order:
//   1. growth (tick-growth.ts): crown +1 every tick; city +1 and plain +1 on
//      `turn % 50 === 0` while not isolated; the single-line burst (turns 26..50,
//      `+1` on normal plains) is *off* in multi-line rooms.
//   2. per-player queue execution in seat order, reversed on odd ticks (the
//      engine resolves `order.reverse()` when `turn % 2 === 1`). Multi-line:
//      every move order whose `from` is not the target of another queued move
//      executes one step, in seq order; invalid orders are discarded; a pure
//      cycle forces its lowest-seq member; build orders wait until their cell is
//      no longer the `from` of any queued move. Single-line: pop from the head
//      until one order executes.
//   3. attack (computePush/attack): mode 2 pushes army-1, mode 0 keeps
//      `defense + 1` where defense sums `army - 1` over the other three
//      neighbours, mode 1 half of that. Capture iff push > garrison, a failed
//      assault trades the push 1:1, captured buildings are destroyed, and the
//      last crown of a player is an instant kill (empire torn down to isolated).
//   4. connectivity (applyConnectivity): per team, BFS from crowns/cities;
//      newly severed cells halve immediately and then decay from tick 11 of the
//      isolation at 5% per recorded turn; reconnected cells double unless the
//      pocket was reinforced by a move into it.

const MOUNTAIN = 201;
const BUILD_COST = 50;
const ISOLATED_GRACE_TICKS = 10;
const ISOLATED_DECAY_RATIO = 0.05;
const BURST_START_TURN = 26;
const BURST_END_TURN = 50;
const PLAIN_GROWTH_INTERVAL = 50;

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const isMountain = (code) => code === MOUNTAIN;
const isCity = (code) => code >= 50 && code < 100;
const isCrown = (code) => code >= 100 && code < 150;
// Neutral swamp is 204, owned swamp is owner + 150. 200 is an *empty plain*,
// not a swamp, so it is excluded explicitly.
const isSwamp = (code) => code >= 150 && code !== MOUNTAIN && code !== 200;
const isPlain = (code) => !isMountain(code) && !isCity(code) && !isCrown(code) && !isSwamp(code);
// Neutral plain with no army is encoded 200, so a plain cell that is neither
// owned nor empty is `code < 50` (owned).
const plainCode = (owner) => (owner > 0 ? owner : 200);
const identityTeam = (owner) => owner;
const swampCode = (owner) => (owner > 0 ? owner + 150 : 204);
const cityCode = (owner) => owner + 50;
const crownCode = (owner) => owner + 100;

function createState(size) {
  return {
    size,
    code: new Uint16Array(size),
    army: new Float64Array(size),
    iso: new Uint8Array(size),
    age: new Uint8Array(size),
    rein: new Uint8Array(size),
    dead: new Uint8Array(64),
    deadCount: 0,
  };
}

// Copy the planner's board into a simulator state (reused across candidates).
// `ages` is the isolation age bookkeeping carried across frames by `./mqueue`:
// the wire only carries 1 (grace) / 2 (decaying), and the 5% decay fires on
// `age > 10 && age % 2 === 1`, so a cell that stays isolated needs the real
// counter or the model loses a unit every other tick. Without `ages` every
// isolated cell is treated as age 1 (first tick of the grace window).
function loadBoard(st, b, ages) {
  st.code.set(b.grid_type);
  st.army.set(b.army_cnt);
  for (let i = 0; i < st.size; i++) {
    const flag = b.isolated[i];
    st.iso[i] = flag ? 1 : 0;
    st.age[i] = flag ? (ages && ages[i] > 0 ? ages[i] : flag) : 0;
    st.rein[i] = 0;
  }
  st.dead.fill(0);
  st.deadCount = 0;
  return st;
}

function cloneState(st) {
  const copy = createState(st.size);
  copyState(copy, st);
  return copy;
}

function copyState(dst, src) {
  dst.code.set(src.code);
  dst.army.set(src.army);
  dst.iso.set(src.iso);
  dst.age.set(src.age);
  dst.rein.set(src.rein);
  dst.dead.set(src.dead);
  dst.deadCount = src.deadCount;
  return dst;
}

// Engine growth for one cell (tick-growth.ts). Multi-line rooms never burst.
function growthAt(code, isolated, turn, multi) {
  const owner = ownerOf(code);
  if (owner <= 0) return 0;
  const burst = !multi && turn >= BURST_START_TURN && turn <= BURST_END_TURN;
  const every50 = turn % PLAIN_GROWTH_INTERVAL === 0;
  if (isCrown(code)) return 1;
  if (isolated) return 0;
  if (isCity(code)) return every50 ? 1 : 0;
  if (isSwamp(code)) return 0;
  return (every50 ? 1 : 0) + (burst ? 1 : 0);
}

function grow(st, turn, multi) {
  const burst = !multi && turn >= BURST_START_TURN && turn <= BURST_END_TURN;
  const every50 = turn % PLAIN_GROWTH_INTERVAL === 0;
  const { code, army, iso, dead } = st;
  if (!burst && !every50) {
    for (let i = 0; i < st.size; i++) {
      if (isCrown(code[i]) && ownerOf(code[i]) > 0 && !dead[ownerOf(code[i])]) army[i] += 1;
    }
    return;
  }
  for (let i = 0; i < st.size; i++) {
    const owner = ownerOf(code[i]);
    if (owner <= 0 || dead[owner]) continue;
    if (isCrown(code[i])) army[i] += 1;
    else if (iso[i]) continue;
    else if (isCity(code[i])) army[i] += every50 ? 1 : 0;
    else if (isSwamp(code[i])) continue;
    else army[i] += (every50 ? 1 : 0) + (burst ? 1 : 0);
  }
}

// Verbatim engine computePush.
function pushAt(st, ctx, from, to, mode) {
  const total = st.army[from];
  const cap = Math.max(0, total - 1);
  if (mode === 2) return cap;
  const mine = ownerOf(st.code[from]);
  let defense = 0;
  for (const k of ctx.neighbors[from]) {
    if (k === to || isMountain(st.code[k])) continue;
    const owner = ownerOf(st.code[k]);
    if (owner > 0 && owner === mine) continue;
    defense += st.army[k] - 1;
  }
  const theoretical = Math.max(0, total - defense - 1);
  const push = mode === 1 ? Math.floor(theoretical / 2) : theoretical;
  return Math.min(push, cap);
}

// Engine chkMove for player id `player` (1-based).
function canMove(st, ctx, player, from, to) {
  return (
    ownerOf(st.code[from]) === player &&
    !st.iso[from] &&
    st.army[from] > 0 &&
    !isMountain(st.code[to]) &&
    ctx.adjacent(from, to)
  );
}

function countCrowns(st, owner) {
  let count = 0;
  for (let i = 0; i < st.size; i++) if (isCrown(st.code[i]) && ownerOf(st.code[i]) === owner) count += 1;
  return count;
}

// teardownEmpire: buildings drop to plain, every cell is halved (1 stays 1) and
// enters isolation, cells whose garrison halves to zero go neutral.
function teardown(st, victim) {
  for (let i = 0; i < st.size; i++) {
    if (ownerOf(st.code[i]) !== victim) continue;
    if (isCity(st.code[i]) || isCrown(st.code[i])) st.code[i] = plainCode(victim);
    if (!st.iso[i]) {
      st.army[i] = st.army[i] === 1 ? 1 : Math.floor(st.army[i] / 2);
      if (st.army[i] <= 0) {
        st.code[i] = isSwamp(st.code[i]) ? swampCode(0) : plainCode(0);
        st.army[i] = 0;
        st.iso[i] = 0;
        st.age[i] = 0;
        st.rein[i] = 0;
        continue;
      }
    }
    st.iso[i] = 1;
    st.age[i] = 1;
  }
}

// Verbatim engine attack. Returns true when the order consumed the queue slot.
function attack(st, ctx, from, to, mode) {
  const cnt = pushAt(st, ctx, from, to, mode);
  if (cnt <= 0) return false;
  const attacker = ownerOf(st.code[from]);
  const defender = ownerOf(st.code[to]);
  // A move into our own isolated pocket cancels the reconnect doubling. In a
  // 1v1 room the only way that can happen is a same-player push, which chkMove
  // already excludes (one cell has one owner), so this only documents the rule.
  if (st.iso[to] && defender > 0 && defender === attacker) st.rein[to] = 1;
  if (defender === attacker) {
    st.army[from] -= cnt;
    st.army[to] += cnt;
    return true;
  }
  if (cnt <= st.army[to]) {
    st.army[from] -= cnt;
    st.army[to] -= cnt;
    return true;
  }
  const wasCrown = isCrown(st.code[to]);
  const defense = st.army[to];
  st.army[from] -= cnt;
  if (isCity(st.code[to]) || wasCrown) st.code[to] = plainCode(attacker);
  else if (isSwamp(st.code[to])) st.code[to] = swampCode(attacker);
  else st.code[to] = plainCode(attacker);
  st.army[to] = cnt - defense;
  st.iso[to] = 0;
  st.age[to] = 0;
  st.rein[to] = 0;
  if (wasCrown && defender > 0 && countCrowns(st, defender) === 0) {
    teardown(st, defender);
    st.dead[defender] = 1;
    st.deadCount += 1;
  }
  return true;
}

function applyOp(st, ctx, player, op) {
  if (op.build) {
    if (ownerOf(st.code[op.from]) !== player || st.iso[op.from]) return false;
    if (st.army[op.from] < BUILD_COST) return false;
    if (op.build === 'c') {
      if (!isCity(st.code[op.from])) return false;
      st.army[op.from] -= BUILD_COST;
      st.code[op.from] = crownCode(player);
      return true;
    }
    if (!isPlain(st.code[op.from])) return false;
    st.army[op.from] -= BUILD_COST;
    st.code[op.from] = cityCode(player);
    return true;
  }
  if (!canMove(st, ctx, player, op.from, op.to)) return false;
  return attack(st, ctx, op.from, op.to, op.mode);
}

// Engine queue semantics. `queue` is mutated in place: every order the tick
// consumed (executed *or* discarded) leaves it.
function executeQueue(st, ctx, player, queue, multi) {
  if (!queue.length) return 0;
  if (!multi) {
    while (queue.length) {
      const op = queue.shift();
      if (applyOp(st, ctx, player, op)) return 1;
    }
    return 0;
  }
  const moveTargets = new Set(),
    blockedStarts = new Set();
  for (const op of queue) {
    if (op.build) blockedStarts.add(op.from);
    else moveTargets.add(op.to);
  }
  // Topological peel (engine issue #121): a chain advances tail-first, so only
  // ops whose own cell is nobody's target may run. What survives the peel is a
  // cycle; its lowest-seq member is forced so the queue cannot deadlock.
  const peeled = new Set();
  let peeling = true;
  while (peeling) {
    peeling = false;
    const liveTargets = new Set();
    for (const op of queue) if (!op.build && !peeled.has(op)) liveTargets.add(op.to);
    for (const op of queue) {
      if (op.build || peeled.has(op)) continue;
      if (!liveTargets.has(op.from)) {
        peeled.add(op);
        peeling = true;
      }
    }
  }
  let forced = null;
  for (const op of queue) {
    if (!op.build && !peeled.has(op)) {
      forced = op;
      break;
    }
  }
  const removed = [];
  let executed = 0;
  for (const op of queue) {
    const eligible = op.build ? !blockedStarts.has(op.from) : !moveTargets.has(op.from) || op === forced;
    if (!eligible) continue;
    if (applyOp(st, ctx, player, op)) executed += 1;
    removed.push(op);
  }
  if (removed.length) {
    let write = 0;
    for (const op of queue) if (!removed.includes(op)) queue[write++] = op;
    queue.length = write;
  }
  return executed;
}

// applyConnectivity: per team, BFS from crowns/cities of alive members. 1v1
// rooms give every player its own team, so the default team map is identity.
function connectivity(st, ctx, teamsOf = identityTeam) {
  const { size, code, army, iso, age, rein, dead } = st;
  const connected = new Uint8Array(size);
  const queue = new Int32Array(size);
  const seenTeam = new Set();
  for (let owner = 1; owner < 32; owner++) {
    if (dead[owner]) continue;
    const team = teamsOf(owner);
    if (!team || seenTeam.has(team)) continue;
    seenTeam.add(team);
    let head = 0,
      tail = 0;
    for (let i = 0; i < size; i++) {
      const owneri = ownerOf(code[i]);
      if (owneri > 0 && !dead[owneri] && teamsOf(owneri) === team && (isCrown(code[i]) || isCity(code[i]))) {
        connected[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const i = queue[head++];
      for (const j of ctx.neighbors[i]) {
        if (connected[j]) continue;
        const ownerj = ownerOf(code[j]);
        if (ownerj <= 0 || dead[ownerj] || teamsOf(ownerj) !== team || isMountain(code[j])) continue;
        connected[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  for (let i = 0; i < size; i++) {
    if (ownerOf(code[i]) <= 0) {
      iso[i] = 0;
      age[i] = 0;
      rein[i] = 0;
      continue;
    }
    const was = iso[i];
    if (connected[i]) {
      if (was) {
        if (!rein[i]) army[i] *= 2;
        iso[i] = 0;
        age[i] = 0;
        rein[i] = 0;
      }
      continue;
    }
    if (!was) {
      rein[i] = 0;
      iso[i] = 1;
      age[i] = 1;
      army[i] = army[i] === 1 ? 1 : Math.floor(army[i] / 2);
      if (army[i] <= 0) {
        code[i] = isSwamp(code[i]) ? swampCode(0) : plainCode(0);
        army[i] = 0;
        iso[i] = 0;
        age[i] = 0;
        rein[i] = 0;
      }
      continue;
    }
    age[i] += 1;
    if (age[i] > ISOLATED_GRACE_TICKS && age[i] % 2 === 1) {
      const decay = Math.max(1, Math.ceil(army[i] * ISOLATED_DECAY_RATIO));
      if (army[i] - decay <= 0) {
        code[i] = isSwamp(code[i]) ? swampCode(0) : plainCode(0);
        army[i] = 0;
        iso[i] = 0;
        age[i] = 0;
        rein[i] = 0;
      } else army[i] -= decay;
    }
  }
}

// One engine tick: growth, both queues in seat order, then connectivity.
// `queues` maps player id -> mutable order array. `players` lists the ids in
// seat order (player id n has seat index n-1).
function step(st, ctx, { turn, multi, players, queues, teamsOf = identityTeam }) {
  grow(st, turn, multi);
  const order = players.slice();
  if (turn % 2 === 1) order.reverse();
  const executed = new Map();
  for (const player of order) {
    const queue = queues.get(player) ?? [];
    executed.set(player, executeQueue(st, ctx, player, queue, multi));
  }
  connectivity(st, ctx, teamsOf);
  return executed;
}

function armyTotal(st, owner) {
  let sum = 0;
  for (let i = 0; i < st.size; i++) if (ownerOf(st.code[i]) === owner) sum += st.army[i];
  return sum;
}

function landTotal(st, owner) {
  let count = 0;
  for (let i = 0; i < st.size; i++) if (ownerOf(st.code[i]) === owner) count += 1;
  return count;
}

function isolatedArmy(st, owner) {
  let sum = 0;
  for (let i = 0; i < st.size; i++) if (ownerOf(st.code[i]) === owner && st.iso[i]) sum += st.army[i];
  return sum;
}

// Reusable context built from the planner board: adjacency test plus the
// neighbour lists the bot already carries.
function contextOf(b) {
  return {
    size: b.size,
    cols: b.cols,
    neighbors: b.neighbors,
    adjacent(from, to) {
      return b.neighbors[from].includes(to);
    },
  };
}

module.exports = {
  createState,
  cloneState,
  copyState,
  loadBoard,
  step,
  grow,
  executeQueue,
  applyOp,
  attack,
  pushAt,
  connectivity,
  canMove,
  growthAt,
  armyTotal,
  landTotal,
  isolatedArmy,
  countCrowns,
  contextOf,
  ownerOf,
  isCrown,
  isCity,
  isPlain,
  isSwamp,
  isMountain,
  crownCode,
  cityCode,
  MOUNTAIN,
  BUILD_COST,
  BURST_START_TURN,
  BURST_END_TURN,
  PLAIN_GROWTH_INTERVAL,
  ISOLATED_GRACE_TICKS,
  ISOLATED_DECAY_RATIO,
};
