'use strict';

// Shadow copy of the relay planner (bot-template/relay-bot/planner.js).
//
// Relay is fully deterministic and a clear 1v1 frame carries the whole grid
// plus the leaderboard, so replaying its `chooseOrders` on the same frames
// reproduces its private bookkeeping (opening/openingHome/homeApproach, column/
// columnTurn, lastFrom/lastMove) exactly. That makes its next order observable
// one tick early: relay queues an order from frame T and the engine executes it
// on tick T+1, the same tick our own order runs on.
//
// The engine resolves seats in index order on odd ticks and reversed on even
// ticks (src/game-engine.ts gameTick), so half of the ticks let us preempt the
// predicted order and half let relay land first. `adjust` prices both cases
// with the real engine push rule (computePush), never the planner's `send`
// variable, which is only an intent.
//
// Safety. The layer is opt-in (`BOT3_SHADOW=1`, default off), gated to clear
// serial rooms, and self-disabling: it only starts pricing orders after
// ARM_AFTER frames in which the predicted order provably executed, and it turns
// itself off for the rest of the game after two frames that do not match. In a
// fog room relay's private map is unobservable and in multi-line its queue is
// not modelled, so both are refused up front. See ./SHADOW.md.

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const city = (code) => code >= 50 && code < 100;
const mountain = (code) => code === 201;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;
const plain = (code) => code > 0 && code < 50;
// Frames of provably executed prediction before the layer prices anything.
const ARM_AFTER = 6;
// Frames of unexplained behaviour before the layer disables itself.
const DRIFT_LIMIT = 2;
const BUILD_COST = 50;

let relay = null;
let relayOpening = null;
let unavailable = null;
try {
  // Read-only dependency on the reference bot. When the path is missing (a
  // published bot package only ships ./bot-3.0) the layer degrades to a no-op.
  relay = require('../relay-bot/planner');
  relayOpening = require('../relay-bot/opening');
} catch (error) {
  unavailable = error;
}

const debugStates = new Set();
const traceOn = () => process.env.BOT3_SHADOW_TRACE === '1';

function enabled() {
  return (process.env.BOT3_SHADOW === '1' || process.env.BOT3_SHADOW_DEBUG === '1') && !unavailable;
}

// Engine growth for one cell at the start of `turn` (src/game-engine/tick-growth):
// crowns +1 every tick, cities every 50 ticks, plain land every 50 ticks plus
// the serial burst between turns 26 and 50.
function growthAt(code, isolated, turn) {
  if (code >= 100 && code < 150) return 1;
  if (isolated) return 0;
  const every50 = turn % 50 === 0;
  const burst = turn >= 26 && turn <= 50;
  if (city(code)) return every50 ? 1 : 0;
  if (plain(code)) return (every50 ? 1 : 0) + (burst ? 1 : 0);
  return 0;
}

// Verbatim engine computePush (src/game-engine.ts): mode 2 sends everything but
// one, mode 0 keeps `defense + 1`, mode 1 keeps half of the surplus.
function pushAt(b, grid, army, from, to, mode, extra = 0) {
  const total = army[from] + extra;
  const cap = Math.max(0, total - 1);
  if (mode === 2) return cap;
  const mine = ownerOf(grid[from]);
  let defense = 0;
  for (const k of b.neighbors[from]) {
    if (k === to || mountain(grid[k])) continue;
    const owner = ownerOf(grid[k]);
    if (owner > 0 && owner === mine) continue;
    defense += army[k] - 1;
  }
  const theoretical = Math.max(0, total - defense - 1);
  const push = mode === 1 ? Math.floor(theoretical / 2) : theoretical;
  return Math.min(push, cap);
}

function createState() {
  return {
    board: null,
    relayMe: 0,
    lastTurn: -1,
    queue: [],
    prev: null,
    prevPred: null,
    prevOrders: null,
    ctx: null,
    ok: true,
    armed: false,
    verified: 0,
    trace: traceOn() ? [] : null,
    driftLog: [],
    stats: {
      ticks: 0,
      matched: 0,
      unverified: 0,
      drift: 0,
      gaps: 0,
      calls: 0,
      hits: 0,
      branches: {},
    },
  };
}

function isClear(b) {
  if (b.fogMode) return false;
  for (let i = 0; i < b.size; i++) if (b.fog[i]) return false;
  return true;
}

function snapshot(b) {
  return {
    grid: Uint8Array.from(b.grid_type),
    army: Float64Array.from(b.army_cnt),
    isolated: Uint8Array.from(b.isolated),
  };
}

// Whether the engine would consume (execute) a queued op on a tick whose
// pre-op board is `grid`/`army`. Invalid ops are dropped without effect and a
// serial queue tries the next op in the same tick, so `prune` pops until this
// returns true or the queue drains.
function wouldExecute(b, op, grid, army, isolated, growthTurn) {
  const from = op.from;
  if (mountain(grid[from])) return false;
  if (ownerOf(grid[from]) !== op.me) return false;
  if (isolated[from]) return false;
  const extra = growthAt(grid[from], isolated[from], growthTurn);
  if (op.build) {
    if (army[from] + extra < BUILD_COST) return false;
    return op.build === 'c' ? city(grid[from]) : plain(grid[from]);
  }
  if (army[from] <= 0) return false;
  if (mountain(grid[op.to])) return false;
  if (!b.neighbors[from].includes(op.to)) return false;
  return pushAt(b, grid, army, from, op.to, op.mode, extra) > 0;
}

// Ops queued from frame `turn - 1` are attempted on tick `turn`. Rebuild the
// pre-op board from the previous frame plus that tick's growth so the model
// knows whether a queued build or move really consumed the tick.
function prune(st, b, turn) {
  if (!st.prev) return;
  const grid = st.prev.grid;
  const army = st.prev.army;
  const isolated = st.prev.isolated;
  while (st.queue.length) {
    const execute = wouldExecute(b, st.queue[0], grid, army, isolated, turn);
    st.queue.shift();
    if (execute) break;
  }
}

// Check the previous prediction against the frame that just resolved. Frames
// where our own order touched the predicted cells are unobservable and skipped.
function verify(st, b, turn) {
  const pred = st.prevPred;
  if (!pred || !st.prev) return;
  const cells = new Set([pred.from, pred.to]);
  for (const own of st.prevOrders ?? []) {
    if (cells.has(own.from) || cells.has(own.to)) {
      st.stats.unverified++;
      return;
    }
  }
  st.stats.ticks++;
  const grid = b.grid_type;
  const delta = b.army_cnt[pred.from] - st.prev.army[pred.from];
  const growth = growthAt(st.prev.grid[pred.from], st.prev.isolated[pred.from], turn);
  const log = (why) => {
    if (st.trace)
      st.driftLog.push({
        turn,
        why,
        from: pred.from,
        to: pred.to,
        build: pred.build ?? null,
        delta,
        growth,
        spent: pred.push,
        prevCode: st.prev.grid[pred.from],
        code: grid[pred.from],
      });
  };
  if (ownerOf(grid[pred.from]) !== st.relayMe) {
    // The cell left relay's hands. Only a build or move of ours can do that,
    // and those frames are skipped above, so this is unexplained.
    st.stats.drift++;
    log('owner');
    return;
  }
  // Executed: the cost (`push`, or BUILD_COST for a build) left the cell.
  // Dropped before execution: only growth landed. The push is priced on the
  // grown board, exactly like the engine does.
  const spent = pred.build
    ? BUILD_COST
    : pushAt(b, st.prev.grid, st.prev.army, pred.from, pred.to, pred.mode, growth);
  const executed = Math.abs(delta - (growth - spent)) <= 1;
  const dropped = Math.abs(delta - growth) <= 1;
  if (!executed && !dropped) {
    st.stats.drift++;
    log('army');
    return;
  }
  st.stats.matched++;
  // Warm-up: only start pricing orders after ARM_AFTER frames where the
  // predicted order provably executed. A dropped order stays neutral (relay's
  // own army projection can be off), but it is not evidence about the
  // opponent's identity, so it does not count towards arming. Against a bot
  // that is not relay the warm-up never completes.
  if (executed) {
    st.verified++;
    if (st.verified >= ARM_AFTER) st.armed = true;
  }
}

function init(st, b, leaderboard, speedHint) {
  const others = leaderboard.filter((p) => p.id !== b.me);
  if (leaderboard.length !== 2 || others.length !== 1) return false;
  st.relayMe = others[0].id;
  st.board = relay.createBoard(b.size / b.cols, b.cols, st.relayMe);
  st.board.openingBudget = speedHint;
  st.board.fogMode = false;
  return true;
}

// Replay relay's decision for the current frame. Returns the order relay will
// execute on the next tick, or null when the layer is off, unsupported or has
// already drifted.
function predict(b, turn, leaderboard, multi) {
  if (!enabled()) return null;
  if (multi || b.multiLine) return null;
  if (!isClear(b)) return null;
  const st = (b.shadow = b.shadow ?? createState());
  if (!st.ok) return null;
  if (turn === st.lastTurn) return st.pred ?? null;
  if (!st.board) {
    const speedHint = b.openingBudget ?? relayOpening.openingBudget(1);
    if (!init(st, b, leaderboard, speedHint)) {
      st.ok = false;
      return null;
    }
    debugStates.add(st);
  }
  const relayEntry = leaderboard.find((p) => p.id === st.relayMe);
  if (!relayEntry || relayEntry.dead) {
    // Relay is out: nothing left to predict, and a finishing kill rewrites its
    // cells in ways the shadow does not follow.
    st.ok = false;
    st.pred = null;
    return null;
  }
  const contiguous = st.lastTurn >= 0 && turn === st.lastTurn + 1;
  if (!contiguous) {
    // The planner skipped frames (the opening and finish branches return
    // before pricing) or this is the first frame: relay's queue is not
    // reconstructible, so start it empty.
    if (st.lastTurn >= 0) st.stats.gaps++;
    st.prevPred = null;
    st.queue = [];
  }
  if (st.prevPred) {
    verify(st, b, turn);
    if (st.stats.drift >= DRIFT_LIMIT) {
      st.ok = false;
      st.pred = null;
      return null;
    }
  }
  if (contiguous) prune(st, b, turn);
  st.board.grid_type.set(b.grid_type);
  st.board.army_cnt.set(b.army_cnt);
  st.board.isolated.set(b.isolated);
  st.board.fog.fill(0);
  st.stats.calls++;
  if (!st.queue.length) {
    const orders = relay.chooseOrders(st.board, turn, leaderboard, false);
    st.queue = orders.map((op) => ({ ...op, me: st.relayMe }));
  }
  let pred = null;
  if (st.queue.length) {
    const op = st.queue[0];
    pred = {
      from: op.from,
      to: op.to,
      mode: op.mode,
      build: op.build,
      // A build costs BUILD_COST instead of a push.
      push: op.build ? BUILD_COST : pushAt(b, b.grid_type, b.army_cnt, op.from, op.to, op.mode),
      relayMe: st.relayMe,
      armed: st.armed,
      state: st,
    };
    st.stats.hits++;
  }
  st.prevPred = pred;
  st.lastTurn = turn;
  st.prev = snapshot(b);
  st.prevOrders = null;
  st.ctx = null;
  st.pred = pred;
  if (st.trace)
    st.trace.push({
      turn,
      from: pred?.from ?? -1,
      to: pred?.to ?? -1,
      mode: pred?.mode ?? -1,
      build: pred?.build ?? null,
      armed: st.armed,
    });
  return pred;
}

// Our own order for this frame: an order that touches the predicted cells makes
// the frame unobservable, and the selected order's own delta is what the layer
// actually changed (debug counters only).
function record(b, turn, orders) {
  const st = b.shadow;
  if (!st || !st.ok) return;
  st.prevOrders = orders.map((op) => ({ from: op.from, to: op.to }));
  if (!st.trace || !st.ctx) return;
  for (const op of orders) {
    const delta = adjust(st.ctx, b, op);
    if (!delta) continue;
    const key = delta > 0 ? 'selectedBonus' : 'selectedPenalty';
    st.stats.branches[key] = (st.stats.branches[key] ?? 0) + 1;
  }
}

// Per-frame context for every candidate: who resolves first, and the real push
// and defence on the predicted order's cells.
function contest(pred, b, turn, mySeat) {
  if (!pred.armed) return null;
  const tick = turn + 1;
  const grid = b.grid_type;
  const army = b.army_cnt;
  const reversed = tick % 2 === 1;
  const relaySeat = pred.relayMe - 1;
  const weFirst = reversed ? mySeat >= relaySeat : mySeat <= relaySeat;
  const relayGrowth = growthAt(grid[pred.from], b.isolated[pred.from], tick);
  const push = pred.build ? 0 : pushAt(b, grid, army, pred.from, pred.to, pred.mode, relayGrowth);
  const defense = army[pred.to] + growthAt(grid[pred.to], b.isolated[pred.to], tick);
  const ctx = {
    pred,
    weFirst,
    push,
    defense,
    relayGrowth,
    tick,
    me: b.me,
    state: pred.state,
  };
  const key = weFirst ? 'turnFirst' : 'turnSecond';
  ctx.state.stats.branches[key] = (ctx.state.stats.branches[key] ?? 0) + 1;
  ctx.state.ctx = ctx;
  return ctx;
}

// Score delta for one candidate order. Positive means the order interferes with
// the order relay is about to execute in a way that wins tempo, army or a
// crown; negative means it walks into that order and is wasted.
function adjust(ctx, b, op) {
  const { pred, weFirst, push, defense, me } = ctx;
  const bump = (name, value) => {
    const st = ctx.state;
    if (value) st.stats.branches[name] = (st.stats.branches[name] ?? 0) + 1;
    return value;
  };
  const grid = b.grid_type;
  const army = b.army_cnt;
  const tick = ctx.tick;
  const pf = pred.from;
  const pt = pred.to;
  const grow = (cell) => growthAt(grid[cell], b.isolated[cell], tick);
  if (op.build) {
    // A builder is a sitting duck for the predicted attack on that cell.
    if (!pred.build && op.from === pt) return bump('buildLost', push > defense ? -700 : -220);
    return 0;
  }
  const mine = pushAt(b, grid, army, op.from, op.to, op.mode, grow(op.from));
  if (mine <= 0) return 0;
  const toCode = grid[op.to];
  if (weFirst) {
    if (!pred.build && op.to === pf) {
      // Capture relay's departure cell before it leaves: its order loses its
      // source, is dropped, and its whole serial tick is wasted on top of the
      // stack we take.
      if (mine > army[pf] + ctx.relayGrowth)
        return bump('preempt', 620 + Math.min(320, push * 1.2) + (crown(grid[pf]) ? 220 : 0));
      // Wounding the stack before it strikes: a failed attack still removes
      // `mine` from relay's garrison, and if that drops its push below the
      // defence of its target the whole attack dies and the cell is saved.
      if (push > defense) {
        const after = pushAt(b, grid, army, pf, pt, pred.mode, -mine);
        if (after <= defense) {
          const saved = defense + (crown(grid[pt]) && ownerOf(grid[pt]) === me ? 900 : 0);
          return bump('wound', 260 + Math.min(340, saved * 0.8));
        }
      }
      return 0;
    }
    if (pred.build && op.to === pt) {
      // Relay is about to spend 50 army to found a city here; taking the cell
      // first denies the city and pockets the garrison.
      if (mine > defense) return bump('denyBuild', 460 + Math.min(260, army[pt]));
      return 0;
    }
    if (!pred.build && op.to === pt) {
      // Our crown anchors the whole economy, so a rescue there outranks a
      // frontier move or a city by a wide margin.
      const own = ownerOf(toCode) === me;
      const weight = own && crown(toCode) ? 900 : 0;
      if (own) {
        // Reinforcement lands before relay's attack: defender plus our push is
        // what relay has to beat, and a failed attack burns its whole stack.
        if (defense + mine > push) return bump('hold', 560 + weight + Math.min(320, push * 0.9));
        return bump('holdShort', crown(toCode) ? -320 : -110);
      }
      // Meeting the incoming stack on a cell nobody owns yet: holding it needs
      // the arriving push to clear what relay sends (its defender is empty).
      if (mine > defense + push) return bump('meetHold', 520 + weight + Math.min(280, push));
      if (mine > defense) return bump('meetLose', -240);
      return 0;
    }
    return 0;
  }
  // Relay resolves first: its order already landed when ours is validated.
  if (!pred.build && op.to === pf) {
    // Take what the departed stack left behind on its source cell.
    if (mine > army[pf] + ctx.relayGrowth - push) return bump('vacated', 300 + Math.min(160, army[pf]));
    return 0;
  }
  if (op.from === pt) {
    // Walking out of (or building on) the cell relay is about to hit.
    if (push > defense) return bump('leaveCell', -620);
    return bump('leaveDry', -320);
  }
  if (op.to === pt) {
    if (push > defense) {
      // Recapture right after relay takes the cell: the surviving garrison is
      // `push - defense`, so a bigger push kills the stack and takes it back.
      const left = push - defense;
      const weight = crown(toCode) && ownerOf(toCode) === me ? 700 : 0;
      if (mine > left) return bump('recapture', 600 + weight + Math.min(300, push * 0.8));
      return bump('recaptureShort', crown(toCode) ? -420 : -120);
    }
    // Reinforce a cell that holds this tick; relay's follow-up has to beat the
    // new garrison.
    if (swamp(toCode)) return 0;
    return bump('reinforce', 180);
  }
  return 0;
}

module.exports = { predict, record, contest, adjust, debugStates, enabled, unavailable };
