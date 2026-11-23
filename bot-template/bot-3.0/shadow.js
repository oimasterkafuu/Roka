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
// Safety. The layer is on by default (`BOT3_SHADOW=0` disables it), gated to clear
// serial rooms, and self-disabling: it only starts pricing orders after
// ARM_STRICT consecutive frames in which the predicted order was exactly the
// order relay executed *and* the two economies look like mirrors of one policy,
// and the first frame that does not match turns it off for the rest of the
// game. That gate is what keeps a relay-derived opponent (anti) from arming the
// layer and being mis-priced. In a fog room relay's private map is unobservable
// and in multi-line its queue is not modelled, so both are refused up front.
// See ./SHADOW.md.

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const city = (code) => code >= 50 && code < 100;
const mountain = (code) => code === 201;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;
const plain = (code) => code > 0 && code < 50;
// Strict arming. The layer only influences scoring after `ARM_STRICT` *in a
// row* frames in which the predicted order was exactly the order relay
// executed; one unexplained frame disables the layer for the rest of the game.
// A relay-derived bot (anti) shares relay's opening, so a 6-frame warm-up
// armed against it and mis-priced its play (measured: anti clear archipelago
// 16/32 vs 19/32 baseline). The default is 32; SHADOW.md records the sweep.
const ARM_STRICT_DEFAULT = 28;
// Read lazily so a test (or a sweep) can change the strictness in-process.
const armStrict = () => {
  const value = Number(process.env.BOT3_SHADOW_ARM);
  return Number.isFinite(value) && value > 0 ? value : ARM_STRICT_DEFAULT;
};
// Mirror signature at the arming tick. In a relay duel the two economies are
// mirror images at the moment the streak completes; a bot that only copies
// relay's opening (or a lobby where the two sides already diverged) does not
// match and stays unarmed.
const MIRROR_LAND = 2;
const MIRROR_ARMY = 8;
// The mirror condition is implemented and measurable (`BOT3_SHADOW_MIRROR=1`)
// but off by default: at ARM_STRICT=28 it adds no protection (anti's longest
// streak is 25) while a legitimate relay game can have diverged by more than 8
// army when the streak completes, which cost 2 maze wins. See SHADOW.md.
const mirrorOn = () => process.env.BOT3_SHADOW_MIRROR === '1';
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
  const flag = process.env.BOT3_SHADOW;
  const off = flag === '0' || flag === 'false' || flag === 'off';
  const on = flag === undefined || flag === '' || !off;
  return (on || process.env.BOT3_SHADOW_DEBUG === '1') && !unavailable;
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
    // Consecutive exact prediction frames (see verify).
    streak: 0,
    bestStreak: 0,
    // One-tick approach memory (see planApproach): the objective relay is
    // playing for and the step we are willing to spend on it.
    plan: null,
    // Land/army race snapshot from the last leaderboard (see planRace).
    lead: null,
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

// Sub-flags. `INVALID` is the only item that is on by default under
// BOT3_SHADOW=1: it never spends the single serial order on a cell the
// predicted attack takes first, and it measured clean on all four clear cells.
// The candidate-creation items are opt-in (`BOT3_SHADOW_APPROACH=1`,
// `_PUNISH=1`, `_RACE=1`, `_GUARD=1`, `_HOLD=1`, `_FREE=1`) because none of
// them moved archipelago or mediterranean to the acceptance line; SHADOW.md
// records each measured delta.
const SUB_DEFAULT = { INVALID: true, PUNISH: true };
const subOn = (name) => {
  const value = process.env[`BOT3_SHADOW_${name}`];
  if (value === '1') return true;
  if (value === '0') return false;
  return SUB_DEFAULT[name] === true;
};

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
  // A dropped order stays neutral (relay's own army projection can be off), but
  // it is not evidence that this is relay, so it breaks the streak. When both
  // classifications fit (a one-unit push), the executed one is the evidence.
  if (!executed) {
    st.streak = 0;
    return;
  }
  st.streak++;
  st.verified++;
  if (st.streak > (st.bestStreak ?? 0)) st.bestStreak = st.streak;
  // Arm only after ARM_STRICT consecutive exact executions *and* a mirror
  // economy. Both conditions are re-checked every frame until they hold.
  if (!st.armed && st.streak >= armStrict() && (!mirrorOn() || mirrorEconomy(st))) {
    st.armed = true;
    st.stats.armedTurn = turn;
  }
}

// The two sides must look like mirrors of one policy at the arming tick.
function mirrorEconomy(st) {
  const lead = st.lead;
  if (!lead) return false;
  return (
    Math.abs(lead.myLand - lead.foeLand) <= MIRROR_LAND && Math.abs(lead.myArmy - lead.foeArmy) <= MIRROR_ARMY
  );
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
  const selfEntry = leaderboard.find((p) => p.id === b.me);
  // Material race state for BOT3_SHADOW_RACE (land is the growth engine).
  st.lead = selfEntry
    ? {
        myLand: selfEntry.land ?? 0,
        foeLand: relayEntry.land ?? 0,
        myArmy: selfEntry.army ?? 0,
        foeArmy: relayEntry.army ?? 0,
      }
    : null;
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
    // Strict: the first unexplained frame is proof that this is not the bot
    // being replayed, so the layer steps aside for the rest of the game.
    if (st.stats.drift > 0) {
      st.ok = false;
      st.armed = false;
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
  if (st.trace) {
    const entry = st.trace.at(-1);
    if (entry && entry.turn === turn)
      entry.orders = orders.map((op) => ({ from: op.from, to: op.to, build: op.build ?? null }));
  }
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
    invalid: subOn('INVALID') && pred.armed,
    hard: pred.armed,
  };
  const key = weFirst ? 'turnFirst' : 'turnSecond';
  ctx.state.stats.branches[key] = (ctx.state.stats.branches[key] ?? 0) + 1;
  // Diagnostic: how often the prediction is worth anything tactically. A
  // predicted order that neither builds nor touches a cell next to ours cannot
  // be contested this tick at all (see SHADOW.md, archipelago/mediterranean).
  if (pred.build) ctx.state.stats.branches.predBuild = (ctx.state.stats.branches.predBuild ?? 0) + 1;
  let near = false;
  for (const k of b.neighbors[pred.to]) {
    if (ownerOf(grid[k]) === b.me) {
      near = true;
      break;
    }
  }
  if (!near && !pred.build) {
    for (const k of b.neighbors[pred.from]) {
      if (ownerOf(grid[k]) === b.me) {
        near = true;
        break;
      }
    }
  }
  if (near) ctx.state.stats.branches.predNear = (ctx.state.stats.branches.predNear ?? 0) + 1;
  const takes = !pred.build && ownerOf(grid[pred.to]) === b.me && push > defense;
  if (takes) ctx.state.stats.branches.predTakes = (ctx.state.stats.branches.predTakes ?? 0) + 1;
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
  if (!pred.build && op.to === pt && push > defense) {
    // Relay takes the cell this tick, so our order is validated against the
    // post-attack board: an op that cannot beat the surviving garrison is an
    // order spent for nothing. Drop it and let a different highest-score op
    // take the single serial slot.
    if (ctx.invalid && mine <= push - defense) {
      op.veto = true;
      return bump('invalidDrop', -1);
    }
  }
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

// ---------------------------------------------------------------------------
// Candidate creation (BOT3_SHADOW_APPROACH / _PUNISH).
//
// `adjust` can only re-price orders the planner already proposed, and the
// frontier loop only ever considers a one-tick move from an adjacent cell. The
// prediction says where relay's army is going two to four ticks early, so the
// layer builds the candidates re-ranking cannot produce: the one-tick approach
// step toward the predicted objective and the counter-capture of the tile
// relay abandons. Every extra candidate is an ordinary candidate afterwards:
// `take` in the planner writes the same lastFrom/lastMove bookkeeping, so the
// usual anti-undo rules apply, and `plan` keeps one memory per game so the
// approach does not oscillate between two equally short steps.

const APPROACH_MIN_UNITS = 6;
const APPROACH_STEPS = 4;
const APPROACH_MAX = 2;
const PUNISH_MAX = 2;
// Punish bid. `250` is the shipped shape: relay's abandoned source is recaptured
// for its own value, which converts the mediterranean mid-game (see LAND.md,
// round 13) and is neutral on archipelago once the structural gate below is on.
// `keep` is how much relay may leave behind on the source tile (mode 2 keeps
// one army, plus the tick growth).
const DEFAULT_PUNISH_BID = 250;
const DEFAULT_PUNISH_KEEP = 2;
// Structural gate for the punish candidate. The recapture pays only where the
// abandoned tile is worth keeping: on a swamp-heavy clear room a plain is the
// only land that pays income (`applyTickGrowth`), so leaving relay's source
// alive hands it the race, while on a plain-rich room the same tick is better
// spent on the frontier (measured: random/maze lose a win with it on). The
// default matches ./land's structural threshold.
const DEFAULT_PUNISH_SWAMP = 0.35;

function shadowNumber(name, fallback, min, max) {
  const value = Number(process.env[`BOT3_SHADOW_${name}`]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Structural swamp share (fog keeps the code, so this is valid on a hidden
// board too). Cached on the board: the grid only changes by ownership.
function boardSwamp(b) {
  if (b.shadowSwampShare !== undefined) return b.shadowSwampShare;
  let cells = 0;
  for (let i = 0; i < b.size; i++) if (swamp(b.grid_type[i])) cells++;
  b.shadowSwampShare = b.size ? cells / b.size : 0;
  return b.shadowSwampShare;
}
// Land-race bid. Tuned on the archipelago cell: high enough to beat the
// planner's gather scores (~150-390), low enough that every real defence
// (560+) and crown strike (2000) still wins the sort.
const RACE_BID = 320;
const RACE_MIN = 2;

// Terrain distance over passable cells; mountains block like they do for the
// planner. -1 means unreachable inside `limit`.
function stepsFrom(b, target, limit) {
  const dist = new Int32Array(b.size).fill(-1);
  dist[target] = 0;
  const queue = [target];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (dist[i] >= limit) continue;
    for (const j of b.neighbors[i]) {
      if (dist[j] !== -1 || b.grid_type[j] === 201) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// What the predicted order is worth to relay, and therefore to us. A build is
// a permanent +1/tick for 50 army, so racing the site outranks almost
// everything; a crown is the economy, a city the next anchor. Plain land is
// only worth walking toward when it is ours (defence); chasing relay's every
// small capture with a multi-tick march is what the archipelago cell punishes.
function objectiveValue(ctx, b) {
  const { pred, me } = ctx;
  const code = b.grid_type[pred.to];
  const owner = ownerOf(code);
  if (pred.build) return owner === pred.relayMe ? 1.35 : 0;
  if (owner === me) return crown(code) ? 1.3 : city(code) ? 1.0 : 0.35;
  if (owner === pred.relayMe) return crown(code) ? 1.1 : 0;
  if (!(ctx.push > ctx.defense)) return 0;
  return city(code) ? 0.85 : 0;
}

function planApproach(ctx, b, turn, add) {
  const { pred, me } = ctx;
  const st = ctx.state;
  const grid = b.grid_type;
  const army = b.army_cnt;
  const target = pred.to;
  const value = objectiveValue(ctx, b);
  if (!value) return;
  const dist = stepsFrom(b, target, APPROACH_STEPS);
  const picks = [];
  for (let i = 0; i < b.size; i++) {
    const d = dist[i];
    if (d < 2 || d > APPROACH_STEPS) continue;
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    if (army[i] < APPROACH_MIN_UNITS) continue;
    let step = null;
    let stepScore = 0;
    for (const j of b.neighbors[i]) {
      if (dist[j] !== d - 1) continue;
      const code = grid[j];
      if (code === 201) continue;
      const owner = ownerOf(code);
      // Never walk a stack into a cell it cannot take: the approach must be a
      // capture or a friendly merge, not a donation.
      if (owner > 0 && owner !== me && army[i] - 1 <= army[j]) continue;
      let score = (140 + 90 * (APPROACH_STEPS - d)) * value;
      score *= 1 + Math.min(0.6, army[i] / 150);
      // Same plan as last frame: keep walking the ladder (and prefer the cell
      // we just stepped into) instead of hopping between equal paths.
      if (st.plan && st.plan.target === target && turn - st.plan.tick <= 4) {
        if (st.plan.from === i) score += 90;
        else if (st.plan.to === i) score += 60;
      }
      if (owner === 0) score += 20;
      if (score > stepScore) {
        stepScore = score;
        step = { score, from: i, to: j, mode: 2, send: army[i] - 1 };
      }
    }
    if (step) picks.push(step);
  }
  if (!picks.length) return;
  picks.sort((a, c) => c.score - a.score);
  st.plan = { target, from: picks[0].from, to: picks[0].to, tick: turn };
  for (const pick of picks.slice(0, APPROACH_MAX)) add(pick, 'approach');
}

// Relay's op sends `units[from] - 1` in mode 2 and leaves one army behind. When
// it resolves first that tile is a one-tick counter-capture for any adjacent
// stack, and taking the source also cuts whatever it just captured.
function planPunish(ctx, b, turn, add) {
  const { pred, weFirst, push, defense, me } = ctx;
  if (weFirst || pred.build) return;
  if (!(push > defense)) return;
  if (boardSwamp(b) < shadowNumber('PUNISH_SWAMP', DEFAULT_PUNISH_SWAMP, 0, 1)) return;
  const grid = b.grid_type;
  const army = b.army_cnt;
  const pf = pred.from;
  const keep = army[pf] + ctx.relayGrowth - push;
  if (keep > shadowNumber('PUNISH_KEEP', DEFAULT_PUNISH_KEEP, 0, 16)) return;
  const bid = shadowNumber('PUNISH_BID', DEFAULT_PUNISH_BID, 0, 4000);
  const picks = [];
  for (const i of b.neighbors[pf]) {
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    const send = army[i] - 1;
    if (send <= keep || send < 2) continue;
    const code = grid[pf];
    let score = bid + Math.min(140, army[pf] * 2) + (crown(code) ? 200 : city(code) ? 90 : 0);
    picks.push({ score, from: i, to: pf, mode: 2, send });
  }
  if (!picks.length) return;
  picks.sort((a, c) => c.score - a.score);
  for (const pick of picks.slice(0, PUNISH_MAX)) add(pick, 'punish');
}

// Extra candidates for the current frame. `candidates` is the planner's live
// list: an existing candidate on the same edge is steered (the score is added)
// instead of duplicated, so the layer can amplify the planner's own pick.
// Land race (BOT3_SHADOW_RACE, opt-in). In a clear serial duel each side emits
// one order per tick, so between turns 26 and 50 the game is a +1 land/tick
// auction: every cell held is one army per tick. When relay is ahead on land it
// is buying a cell per tick from a two-army stack while our planner merges a
// column and stands still, so this bids for the same tempo with our cheapest
// frontier stack. Measured on 16 seeds: archipelago 16 -> 19 wins, but
// mediterranean 19 -> 11, so it stays off unless asked for explicitly.
function planRace(ctx, b, turn, add) {
  const st = ctx.state;
  const lead = st.lead;
  if (!lead) return;
  const deficit = lead.foeLand - lead.myLand;
  if (deficit < RACE_MIN) return;
  const grid = b.grid_type;
  const army = b.army_cnt;
  const me = ctx.me;
  const base = RACE_BID + Math.min(180, 40 * deficit);
  for (let i = 0; i < b.size; i++) {
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    if (army[i] < 2) continue;
    for (const j of b.neighbors[i]) {
      if (grid[j] === 201) continue;
      if (ownerOf(grid[j]) !== 0 || army[j] > 0) continue;
      // A small frontier garrison is the cheap expander relay uses.
      const score = base + (army[i] <= 8 ? 40 : 0) - Math.min(30, army[i] * 0.5);
      add({ score, from: i, to: j, mode: 2, send: army[i] - 1 }, 'race');
    }
  }
}

// Defence creation (BOT3_SHADOW_HOLD). `adjust` already prices a reinforcement
// into the cell relay attacks, but on archipelago and mediterranean the frontier
// stack is usually one cell off that line, so there is no candidate to price and
// the attack lands uncontested. When we resolve first we can put a stack into
// the target before the attack is validated: relay's whole committed push then
// has to beat the reinforced garrison, fails, and burns its serial tick.
function planHold(ctx, b, turn, add) {
  const { pred, push, weFirst, me, defense } = ctx;
  if (!weFirst || pred.build) return;
  const pt = pred.to;
  const code = b.grid_type[pt];
  if (ownerOf(code) !== me) return;
  if (!(push > defense)) return;
  let crowns = 0;
  for (let i = 0; i < b.size; i++) if (ownerOf(b.grid_type[i]) === me && crown(b.grid_type[i])) crowns++;
  const last = crowns === 1;
  const weight = crown(code) ? (last ? 1100 : 760) : city(code) ? 430 : 0;
  if (!weight) return;
  const need = push + 1 - defense;
  const grid = b.grid_type;
  const army = b.army_cnt;
  let best = null;
  for (const i of b.neighbors[pt]) {
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    const mine = pushAt(b, grid, army, i, pt, 2, growthAt(grid[i], b.isolated[i], ctx.tick));
    if (mine < need) continue;
    const score = weight + Math.min(240, push * 3) - Math.min(60, army[i] * 0.2);
    if (!best || score > best.score) best = { score, from: i, to: pt, mode: 2, send: mine };
  }
  if (best) add(best, 'hold');
}

// Our own anchors, for the decapitation guard.
function myAnchors(ctx, b) {
  const cells = [];
  for (let i = 0; i < b.size; i++) {
    const code = b.grid_type[i];
    if (ownerOf(code) === ctx.me && (crown(code) || city(code))) cells.push(i);
  }
  return cells;
}

// Decapitation guard (BOT3_SHADOW_GUARD). Losing the *last* crown ends the game
// on the spot (engine `kill`), so the one thing that must never be a surprise is
// a relay stack walking up to it. `adjust` only prices the order relay emitted
// this tick; the stack that decapitates two ticks later may be sitting still
// right now. A clear serial frame shows every relay cell and the predicted push,
// so this measures the strongest stack that can reach the last crown within two
// ticks and pre-reinforces it before the strike. Measured on 16 seeds it is
// negative on archipelago (15/32) and neutral on mediterranean, so it is off by
// default: the strike usually lands on a cell with no adjacent spare stack.
function planGuard(ctx, b, turn, add) {
  const { pred, push } = ctx;
  const anchors = myAnchors(ctx, b);
  if (anchors.length !== 1) return;
  const crownCell = anchors[0];
  if (!crown(b.grid_type[crownCell])) return;
  const garrison = b.army_cnt[crownCell];
  const dist = stepsFrom(b, crownCell, 2);
  let best = 0;
  for (let i = 0; i < b.size; i++) {
    if (ownerOf(b.grid_type[i]) !== pred.relayMe) continue;
    if (dist[i] < 0 || dist[i] > 2) continue;
    // A stack loses its guard on every hop (mode 2 leaves one behind).
    const reach = b.army_cnt[i] - (dist[i] - 1) - 1;
    if (reach > best) best = reach;
  }
  if (!pred.build && dist[pred.to] >= 0 && dist[pred.to] <= 2 && push - 1 > best) best = push - 1;
  if (best < 10 || best < garrison - 2) return;
  const need = best + 2 - garrison;
  const score = 620 + Math.min(360, need * 8) + Math.min(200, best * 2);
  const army = b.army_cnt;
  const grid = b.grid_type;
  const me = ctx.me;
  for (const i of b.neighbors[crownCell]) {
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    if (army[i] < 2) continue;
    add({ score, from: i, to: crownCell, mode: 2, send: army[i] - 1 }, 'guard');
  }
}

// Free-tick advance (BOT3_SHADOW_FREE). The predicted order also says what
// relay is *not* doing: when its army walks away from our crown, the next two
// ticks are the cheap window to push our column at its crown. This is the only
// prediction use with range on archipelago, where the two empires spend most
// ticks out of contact and the score is decided by who reaches a crown first.
function planFree(ctx, b, turn, add) {
  const { pred, push, defense, me } = ctx;
  if (pred.build) return;
  const anchors = myAnchors(ctx, b);
  if (!anchors.length) return;
  const homeDist = stepsFrom(b, anchors[0], 8);
  const dFrom = homeDist[pred.from],
    dTo = homeDist[pred.to];
  // Only when relay is stepping away from (or sideways to) our crown.
  if (dFrom < 0 || dTo < 0 || dTo <= dFrom) return;
  // Its stack must be the one that matters: the predicted push has to be a
  // real army, not a two-unit expansion walk.
  if (push < 12) return;
  const crowns = [];
  for (let i = 0; i < b.size; i++)
    if (ownerOf(b.grid_type[i]) === pred.relayMe && crown(b.grid_type[i])) crowns.push(i);
  if (!crowns.length) return;
  const grid = b.grid_type;
  const army = b.army_cnt;
  const dist = new Float64Array(b.size).fill(1e9);
  for (const goal of crowns) {
    const field = stepsFrom(b, goal, 4);
    for (let i = 0; i < b.size; i++) if (field[i] >= 0 && field[i] < dist[i]) dist[i] = field[i];
  }
  let best = null;
  for (let i = 0; i < b.size; i++) {
    const d = dist[i];
    if (d < 2 || d > 4) continue;
    if (ownerOf(grid[i]) !== me || b.isolated[i]) continue;
    if (army[i] < 20) continue;
    for (const j of b.neighbors[i]) {
      if (dist[j] !== d - 1 || grid[j] === 201) continue;
      const owner = ownerOf(grid[j]);
      if (owner > 0 && owner !== me && army[i] - 1 <= army[j]) continue;
      const score = (280 + 55 * (4 - d)) * (1 + Math.min(0.6, army[i] / 150));
      if (!best || score > best.score) best = { score, from: i, to: j, mode: 2, send: army[i] - 1 };
    }
  }
  if (best) add(best, 'free');
}

function plan(ctx, b, turn, candidates) {
  if (!ctx || !ctx.hard || !candidates) return 0;
  let added = 0;
  const st = ctx.state;
  const add = (op, kind) => {
    const key = `${kind}Add`;
    const steerKey = `${kind}Steer`;
    const existing = candidates.find((c) => !c.build && c.from === op.from && c.to === op.to);
    if (existing) {
      existing.score += op.score;
      st.stats.branches[steerKey] = (st.stats.branches[steerKey] ?? 0) + 1;
      return;
    }
    candidates.push(op);
    added++;
    st.stats.branches[key] = (st.stats.branches[key] ?? 0) + 1;
  };
  if (subOn('APPROACH')) planApproach(ctx, b, turn, add);
  if (subOn('PUNISH')) planPunish(ctx, b, turn, add);
  if (subOn('RACE')) planRace(ctx, b, turn, add);
  if (subOn('GUARD')) planGuard(ctx, b, turn, add);
  if (subOn('HOLD')) planHold(ctx, b, turn, add);
  if (subOn('FREE')) planFree(ctx, b, turn, add);
  return added;
}

module.exports = {
  predict,
  record,
  contest,
  adjust,
  plan,
  debugStates,
  enabled,
  unavailable,
};
