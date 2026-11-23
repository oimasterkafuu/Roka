'use strict';

// Relay queue predictor for multi-line rooms.
//
// Relay is deterministic and a clear 1v1 frame carries the whole grid, so
// replaying its `chooseOrders` on a shadow board reproduces its private
// bookkeeping (opening / openingHome / homeApproach / column / lastFrom /
// lastMove) exactly. The one thing `./shadow` does not model is the multi-line
// queue: relay emits up to sixteen orders only when its pending queue is empty,
// and the engine keeps the ones that were not eligible on the tick. This module
// rebuilds that queue with `./msim` and predicts the whole batch relay will
// have in flight on the next tick.
//
// Verification gate (mandatory, same shape as `./shadow`): every frame the
// model replays the previous tick from the snapshot it took, with the orders we
// actually emitted plus the batch it predicted, and compares the *whole board*
// with the frame the engine produced. A single unexplained frame disables the
// layer for the rest of the game, so a relay-derived opponent (anti) or any
// rules drift can never be mis-priced. Until `ARM_STRICT` consecutive exact
// frames are observed the layer stays unarmed.

const msim = require('./msim');

const ARM_STRICT_DEFAULT = 6;
const armStrict = () => {
  const value = Number(process.env.BOT3_MSEARCH_ARM);
  return Number.isFinite(value) && value > 0 ? value : ARM_STRICT_DEFAULT;
};

let relay = null,
  relayOpening = null,
  unavailable = null;
try {
  // Read-only dependency on the reference bot, exactly like ./shadow. A
  // published bot package that does not ship ../relay-bot degrades to a no-op.
  relay = require('../relay-bot/planner');
  relayOpening = require('../relay-bot/opening');
} catch (error) {
  unavailable = error;
}

const flagOn = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const text = String(value).trim().toLowerCase();
  return text !== '0' && text !== 'false' && text !== 'off';
};
// The search ships on (round 18): with neither `BOT3_M2PLY` nor `BOT3_M3PLY`
// set the predictor is live, and an explicit `0`/`off` on either switch turns it
// off, so `BOT3_M3PLY=0` is the documented way back to the round-16 path.
const enabled = () => {
  if (unavailable) return false;
  if (flagOn(process.env.BOT3_MSEARCH) || flagOn(process.env.BOT3_MSEARCH_DEBUG)) return true;
  const three = process.env.BOT3_M3PLY;
  const two = process.env.BOT3_M2PLY;
  if (three === undefined && two === undefined) return true;
  return flagOn(three) || flagOn(two);
};
const statsOn = () => flagOn(process.env.BOT3_MSEARCH_STATS);

const totals = {
  games: 0,
  frames: 0,
  predicted: 0,
  matched: 0,
  drift: 0,
  gaps: 0,
  unverified: 0,
  arms: 0,
  armedTurns: 0,
  emptyQueue: 0,
  batches: 0,
  batchOps: 0,
  leftovers: 0,
  ms: 0,
};

if (statsOn()) {
  process.on('exit', () => {
    if (!totals.frames) return;
    process.stderr.write(`[msim] ${JSON.stringify(totals)}\n`);
  });
}

function isClear(b) {
  if (b.fogMode) return false;
  for (let i = 0; i < b.size; i++) if (b.fog[i]) return false;
  return true;
}

function snapshot(b) {
  return {
    code: Uint16Array.from(b.grid_type),
    army: Float64Array.from(b.army_cnt),
    iso: Uint8Array.from(b.isolated),
  };
}

function createState() {
  return {
    board: null,
    relayMe: 0,
    lastTurn: -1,
    // Relay's queue as of the last observed frame: the orders the engine will
    // try on the next tick.
    queue: [],
    // Previous frame: what our model predicted and how the board looked.
    prev: null,
    pred: null,
    ok: true,
    armed: false,
    streak: 0,
    bestStreak: 0,
    stats: { ticks: 0, matched: 0, drift: 0, unverified: 0, gaps: 0, batches: 0, leftovers: 0 },
  };
}

function init(st, b, leaderboard, speedHint) {
  const others = leaderboard.filter((p) => p.id !== b.me);
  if (leaderboard.length !== 2 || others.length !== 1) return false;
  st.relayMe = others[0].id;
  st.board = relay.createBoard(b.size / b.cols, b.cols, st.relayMe);
  st.board.openingBudget = speedHint;
  st.board.fogMode = false;
  const teamByOwner = new Map(leaderboard.filter((p) => !p.dead).map((p) => [p.id, p.team]));
  st.teamsOf = (owner) => teamByOwner.get(owner) ?? owner;
  totals.games += 1;
  return true;
}

// Replay the tick that just resolved: growth, our orders and the predicted
// batch in engine seat order, then connectivity. The result must equal the
// frame, otherwise the model (or the opponent) is not what we think it is.
function verify(st, b, turn, multi) {
  const prev = st.prev;
  if (!prev) return;
  const sim = (st.sim = st.sim ?? msim.createState(b.size));
  sim.code.set(prev.code);
  sim.army.set(prev.army);
  sim.iso.set(prev.iso);
  sim.age.set(prev.age);
  sim.rein.set(prev.rein);
  sim.dead.fill(0);
  sim.deadCount = 0;
  const queue = prev.pred.map((op) => ({ ...op }));
  const mine = (prev.orders ?? []).map((op) => ({ ...op }));
  const queues = new Map([
    [st.relayMe, queue],
    [b.me, mine],
  ]);
  const players = [st.relayMe, b.me].sort((a, c) => a - c);
  msim.step(sim, st.ctx, { turn, multi, players, queues, teamsOf: st.teamsOf });
  st.queue = queue;
  let bad = -1;
  for (let i = 0; i < b.size; i++) {
    if (sim.code[i] !== b.grid_type[i]) {
      bad = i;
      break;
    }
    if (Math.abs(sim.army[i] - b.army_cnt[i]) > 1e-9) {
      bad = i;
      break;
    }
    if ((sim.iso[i] > 0 ? 1 : 0) !== (b.isolated[i] > 0 ? 1 : 0)) {
      bad = i;
      break;
    }
  }
  st.stats.ticks += 1;
  totals.frames += 1;
  if (bad >= 0) {
    st.stats.drift += 1;
    totals.drift += 1;
    st.ok = false;
    st.armed = false;
    st.queue = [];
    st.pred = null;
    if (process.env.BOT3_MSEARCH_TRACE === '1')
      process.stderr.write(
        `[mseach] drift turn=${turn} cell=${bad} sim=${sim.code[bad]},${sim.army[bad]},${sim.iso[bad]}` +
          ` engine=${b.grid_type[bad]},${b.army_cnt[bad]},${b.isolated[bad]}\n`,
      );
    return;
  }
  // Carry the isolation bookkeeping forward: the next frame starts from the
  // state this replay ended in (ages and "pocket was reinforced" flags).
  st.age = sim.age;
  st.rein = sim.rein;
  st.stats.matched += 1;
  totals.matched += 1;
  st.streak += 1;
  if (st.streak > st.bestStreak) st.bestStreak = st.streak;
  if (!st.armed && st.streak >= armStrict()) {
    st.armed = true;
    totals.arms += 1;
    totals.armedTurns += turn;
  }
}

// Called once per planning frame (from ./planner). Returns
//   { ops, relayMe, armed, state }  with `ops` the batch relay will have in
//   flight on tick `turn + 1`, or null when the layer is off / unsupported.
function predict(b, turn, leaderboard, multi) {
  if (!enabled()) return null;
  if (!multi) return null;
  if (!isClear(b)) return null;
  const st = (b.mqueue = b.mqueue ?? createState());
  if (!st.ok) return null;
  if (turn === st.lastTurn) return st.pred ?? null;
  if (!st.board) {
    const speedHint = b.openingBudget ?? relayOpening.openingBudget(1);
    if (!init(st, b, leaderboard, speedHint)) {
      st.ok = false;
      return null;
    }
    st.ctx = msim.contextOf(b);
  }
  const relayEntry = leaderboard.find((p) => p.id === st.relayMe);
  if (!relayEntry || relayEntry.dead) {
    st.ok = false;
    st.pred = null;
    return null;
  }
  const contiguous = st.lastTurn >= 0 && turn === st.lastTurn + 1;
  if (!contiguous) {
    if (st.lastTurn >= 0) {
      st.stats.gaps += 1;
      totals.gaps += 1;
    }
    st.queue = [];
    st.prev = null;
  } else if (st.prev) {
    verify(st, b, turn, multi);
    if (!st.ok) return null;
  }
  // Relay's shadow board is fed from the frame we are holding, exactly like
  // ./shadow does for the serial case.
  st.board.grid_type.set(b.grid_type);
  st.board.army_cnt.set(b.army_cnt);
  st.board.isolated.set(b.isolated);
  st.board.fog.fill(0);
  if (!st.queue.length) {
    totals.emptyQueue += 1;
    const started = performance.now();
    const orders = relay.chooseOrders(st.board, turn, leaderboard, true);
    totals.ms += performance.now() - started;
    st.queue = orders.map((op) => ({
      from: op.from,
      to: op.to,
      mode: op.mode,
      build: op.build ?? null,
      me: st.relayMe,
    }));
    st.stats.batches += 1;
    totals.batches += 1;
    totals.batchOps += st.queue.length;
  } else {
    st.stats.leftovers += 1;
    totals.leftovers += 1;
  }
  const pred = {
    ops: st.queue.map((op) => ({ ...op })),
    relayMe: st.relayMe,
    armed: st.armed,
    turn,
    ages: st.age,
    state: st,
  };
  const ages = (st.age = st.age ?? new Int32Array(b.size));
  st.prev = {
    code: Uint16Array.from(b.grid_type),
    army: Float64Array.from(b.army_cnt),
    iso: Uint8Array.from(b.isolated),
    age: Int32Array.from(ages),
    rein: Uint8Array.from(st.rein ?? new Uint8Array(b.size)),
    pred: pred.ops.map((op) => ({ ...op })),
    orders: null,
  };
  st.lastTurn = turn;
  st.pred = pred;
  totals.predicted += pred.ops.length;
  return pred;
}

// Our own emitted orders for this frame, needed by the verification replay.
function record(b, turn, orders) {
  const st = b.mqueue;
  if (!st || !st.prev || st.lastTurn !== turn) return;
  st.prev.orders = orders.map((op) => ({
    from: op.from,
    to: op.to,
    mode: op.mode ?? 0,
    build: op.build ?? null,
    me: b.me,
  }));
}

module.exports = {
  predict,
  predictAhead,
  record,
  enabled,
  isClear,
  snapshot,
  createState,
  totals,
  ARM_STRICT_DEFAULT,
};

// Predict relay's batch on a *hypothetical* board one tick ahead of the frame
// (used by `./m2ply` to price the second tick). Relay's planner is replayed on
// the shadow board with its own bookkeeping, and every field it touches is
// restored afterwards, so the frame-to-frame prediction and the verification
// gate stay exactly where they were. Returns null when the layer is off or the
// predictor never initialised.
function predictAhead(pred, state, turn, players, me) {
  const st = pred?.state;
  const board = st?.board;
  if (!relay || !board || !state || state.size !== board.size) return null;
  const save = {
    code: Uint8Array.from(board.grid_type),
    army: Float64Array.from(board.army_cnt),
    iso: Uint8Array.from(board.isolated),
    memory: Uint8Array.from(board.memory),
    lastSeen: Int32Array.from(board.lastSeen),
    lastFrom: Int32Array.from(board.lastFrom),
    lastMove: Int32Array.from(board.lastMove),
    opening: board.opening,
    openingHome: board.openingHome,
    homeApproach: board.homeApproach,
    column: board.column,
    columnTurn: board.columnTurn,
  };
  board.grid_type.set(state.code);
  board.army_cnt.set(state.army);
  board.isolated.set(state.iso);
  board.fog.fill(0);
  const leaderboard = players.map((id) => ({
    id,
    team: st.teamsOf(id),
    army: msim.armyTotal(state, id),
    land: msim.landTotal(state, id),
    dead: state.dead[id] ? 1 : 0,
  }));
  let orders = [];
  try {
    orders = relay.chooseOrders(board, turn, leaderboard, true) ?? [];
  } finally {
    board.grid_type.set(save.code);
    board.army_cnt.set(save.army);
    board.isolated.set(save.iso);
    board.memory.set(save.memory);
    board.lastSeen.set(save.lastSeen);
    board.lastFrom.set(save.lastFrom);
    board.lastMove.set(save.lastMove);
    board.opening = save.opening;
    board.openingHome = save.openingHome;
    board.homeApproach = save.homeApproach;
    board.column = save.column;
    board.columnTurn = save.columnTurn;
  }
  return orders.map((op) => ({
    from: op.from,
    to: op.to,
    mode: op.mode,
    build: op.build ?? null,
    me: st.relayMe,
  }));
}
