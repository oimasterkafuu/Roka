'use strict';

// Search over the sixteen slots: pick the order set whose *simulated next
// tick* is best against relay's predicted batch.
//
// Why a search and not more weights. In a multi-line room the engine runs both
// batches on the same tick, so an order is worth what the engine does with it
// after the rival's batch has also run: a capture the rival preempts is a
// dropped order, an attack into a cell the rival just emptied is a free
// capture, and the two seats alternate who resolves first (`turn % 2`). Every
// hand-tuned score knob measured neutral or negative against the mirror (see
// MULTI.md), so this layer stops pricing orders and starts *evaluating
// outcomes*: `./msim` replays the tick, `./mqueue` predicts relay's batch, and
// the candidate set with the best resulting state wins -- but only when it
// beats the planner's own choice by a measured margin, and only after the
// predictor has armed itself with consecutive exact frames.
//
// Gate: multi-line, clear rooms only (in fog the rival's board is unobservable,
// so its batch cannot be predicted and this layer cannot even verify itself),
// `BOT3_MSEARCH=1`, and the relay predictor armed.

const msim = require('./msim');

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Value of a simulated board. Army is the currency the engine converts into
// captures; a crown pays one army per tick and is the only income after tick
// 50, so it is priced as a lump of army rather than as one cell; land only pays
// on `turn % 50 === 0`, which is what makes it worth about a unit here.
// Isolation (a cut branch) is army the rival cannot spend for ten ticks.
function configOf(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_MSEARCH, false),
    crown: overrides.crown ?? number(env.BOT3_MSEARCH_CROWN, 30, 0, 100000),
    land: overrides.land ?? number(env.BOT3_MSEARCH_LAND, 1, 0, 1000),
    cut: overrides.cut ?? number(env.BOT3_MSEARCH_CUT, 0.5, 0, 100),
    march: overrides.march ?? number(env.BOT3_MSEARCH_MARCH, 0, 0, 1000),
    margin: overrides.margin ?? number(env.BOT3_MSEARCH_MARGIN, 1, 0, 100000),
    sims: overrides.sims ?? number(env.BOT3_MSEARCH_SIMS, 10, 1, 64),
    force: overrides.force ?? number(env.BOT3_MSEARCH_FORCE, 6, 0, 64),
    extra: overrides.extra ?? number(env.BOT3_MSEARCH_EXTRA, 4, 0, 32),
  };
}

const totals = { ticks: 0, sims: 0, adopted: 0, gain: 0, extra: 0, extraWins: 0, ms: 0 };

if (process.env.BOT3_MSEARCH_STATS === '1') {
  process.on('exit', () => {
    if (!totals.sims) return;
    process.stderr.write(`[msearch] ${JSON.stringify(totals)}\n`);
  });
}

function freshSearch(size) {
  return { size, sim: msim.createState(size), ticks: 0, sims: 0, adopted: 0, gain: 0 };
}

// BFS distance from a set of anchor cells over passable cells.
function field(b, anchors) {
  const INF = 100000;
  const dist = new Int32Array(b.size).fill(INF);
  const queue = [];
  for (const i of anchors) {
    if (dist[i] === 0) continue;
    dist[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of b.neighbors[i]) {
      if (dist[j] !== INF || msim.isMountain(b.grid_type[j])) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// Distance fields for the march term, refreshed once per frame.
function fieldsFor(b, me, foe) {
  const myCrowns = [],
    foeCrowns = [];
  for (let i = 0; i < b.size; i++) {
    const code = b.grid_type[i];
    if (!msim.isCrown(code)) continue;
    const owner = msim.ownerOf(code);
    if (owner === me) myCrowns.push(i);
    else if (owner === foe) foeCrowns.push(i);
  }
  if (!myCrowns.length || !foeCrowns.length) return null;
  return { toFoe: field(b, foeCrowns), toMe: field(b, myCrowns) };
}

// Positional potential: army next to the rival crown is army that can end the
// game, army at the back of the map is not. The same field prices both sides,
// so the term is symmetric.
function marchTerm(st, fields, me, foe) {
  const { toFoe, toMe } = fields;
  let sum = 0;
  for (let i = 0; i < st.size; i++) {
    const owner = msim.ownerOf(st.code[i]);
    if (!owner || st.iso[i]) continue;
    if (owner === me) sum += st.army[i] / (1 + toFoe[i]);
    else if (owner === foe) sum -= st.army[i] / (1 + toMe[i]);
  }
  return sum;
}

function value(st, me, foe, config, fields) {
  const foeCrowns = msim.countCrowns(st, foe);
  const myCrowns = msim.countCrowns(st, me);
  if (foeCrowns === 0) return 1e7;
  if (myCrowns === 0) return -1e7;
  const base =
    msim.armyTotal(st, me) -
    msim.armyTotal(st, foe) +
    config.crown * (myCrowns - foeCrowns) +
    config.land * (msim.landTotal(st, me) - msim.landTotal(st, foe)) +
    config.cut * (msim.isolatedArmy(st, foe) - msim.isolatedArmy(st, me));
  if (!config.march || !fields) return base;
  return base + config.march * marchTerm(st, fields, me, foe);
}

// Seat order on tick `tick`: player ids 1..n in index order, reversed on odd
// ticks (src/game-engine.ts gameTick). 1v1 rooms have exactly two ids.
function resolvesFirst(id, tick) {
  return id === (tick % 2 === 1 ? 2 : 1);
}

// Orders the planner cannot propose in a multi-line room. Its candidate loop
// only offers captures it can already make (`front`/`siegeValue` are
// clear-*serial* only, and `send <= units[j]` is skipped), so two orders the
// predicted batch makes obvious never reach the sixteen slots:
//   * the counter-capture of a cell relay is about to empty (its push leaves
//     one army behind, so two units take it) -- only when relay resolves first;
//   * the reinforcement of our cell relay is about to capture -- only when we
//     resolve first, and it kills relay's push instead of losing the cell.
function synth(b, pred, me, turn, config) {
  if (!config.extra) return [];
  const relayFirst = resolvesFirst(pred.relayMe, turn + 1);
  const out = [];
  const seen = new Set();
  const push = (from, to, why) => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) return;
    if (msim.ownerOf(b.grid_type[from]) !== me || b.isolated[from]) return;
    if (b.army_cnt[from] < 2) return;
    if (msim.isMountain(b.grid_type[to]) || !b.neighbors[from].includes(to)) return;
    seen.add(key);
    out.push({ from, to, mode: 2, build: null, score: 0, why });
  };
  for (const op of pred.ops) {
    if (op.build) continue;
    if (relayFirst) {
      const source = op.from;
      const code = b.grid_type[source];
      if (msim.ownerOf(code) !== pred.relayMe) continue;
      const worth = (msim.isCrown(code) ? 4 : msim.isCity(code) ? 2 : 0) + b.army_cnt[source] / 100;
      if (msim.isCrown(code) || msim.isCity(code) || b.army_cnt[source] >= 1)
        for (const k of b.neighbors[source]) push(k, source, 'counter:' + worth);
    } else {
      const target = op.to;
      if (msim.ownerOf(b.grid_type[target]) !== me) continue;
      if (msim.isCrown(b.grid_type[target])) for (const k of b.neighbors[target]) push(k, target, 'hold');
    }
  }
  totals.extra += out.length;
  return out;
}

// The planner's own selection: greedy over the score-sorted candidate list with
// disjoint source and target cells, up to sixteen orders.
function selectFrom(order, limit = 16) {
  const used = new Set();
  const set = [];
  for (const op of order) {
    if (used.has(op.from) || used.has(op.to)) continue;
    used.add(op.from);
    used.add(op.to);
    set.push(op);
    if (set.length >= limit) break;
  }
  return set;
}

function asOps(set, me) {
  return set.map((op) => ({
    from: op.from,
    to: op.to,
    mode: op.mode ?? 0,
    build: op.build ?? null,
    me,
  }));
}

// Replay tick `turn + 1` on a copy of the current board with `mine` and the
// predicted relay batch. Returns the value of the resulting position.
function runTick(store, b, ctx, turn, mine, theirs, me, relayMe, config, ages, fields) {
  const st = store.sim;
  msim.loadBoard(st, b, ages);
  const queues = new Map([
    [me, asOps(mine, me)],
    [relayMe, theirs.map((op) => ({ ...op }))],
  ]);
  const players = [me, relayMe].sort((a, c) => a - c);
  msim.step(st, ctx, { turn: turn + 1, multi: true, players, queues });
  store.sims += 1;
  return value(st, me, relayMe, config, fields);
}

// Choose an order set. Returns null when the planner's own set is already the
// best (the common case: it is a good action chooser), otherwise the winning
// set in the order it should be taken.
function choose({ b, turn, candidates, pred, config = configOf() }) {
  if (!pred || !pred.armed || !pred.ops || !candidates.length) return null;
  const started = performance.now();
  const ctx = b.msimCtx ?? (b.msimCtx = msim.contextOf(b));
  const me = b.me;
  const relayMe = pred.relayMe;
  const store = (b.msearch = b.msearch ?? freshSearch(b.size));
  if (store.size !== b.size) return null;
  const ages = pred.ages ?? null;
  if (store.fieldsTurn !== turn) {
    store.fieldsTurn = turn;
    store.fields = config.march ? fieldsFor(b, me, relayMe) : null;
  }
  const fields = store.fields;
  const base = selectFrom(candidates);
  if (!base.length) return null;
  const baseValue = runTick(store, b, ctx, turn, base, pred.ops, me, relayMe, config, ages, fields);
  let best = base;
  let bestValue = baseValue;
  let sims = 1;
  const consider = (set) => {
    if (sims >= config.sims || !set.length) return;
    const same = set.length === base.length && set.every((op, i) => op === base[i]);
    if (same) return;
    sims += 1;
    const score = runTick(store, b, ctx, turn, set, pred.ops, me, relayMe, config, ages, fields);
    if (score > bestValue) {
      best = set;
      bestValue = score;
    }
  };
  // 1. Force each of the best candidates the planner did not take into the set:
  //    the sixteen slots are a matching, so one order can displace two.
  const inBase = new Set(base);
  let forced = 0;
  for (const op of candidates) {
    if (forced >= config.force || sims >= config.sims) break;
    if (inBase.has(op)) continue;
    forced += 1;
    consider(selectFrom([op, ...candidates.filter((other) => other !== op)]));
  }
  // 2. Drop one of the planner's weakest orders and refill the slots.
  for (let i = base.length - 1; i >= 0 && sims < config.sims; i--) {
    consider(selectFrom(candidates.filter((op) => op !== base[i])));
  }
  // 3. Orders the planner cannot propose but the predicted batch makes obvious.
  const extras = synth(b, pred, me, turn, config);
  for (const extra of extras) {
    if (sims >= config.sims) break;
    consider(selectFrom([extra, ...candidates]));
  }
  if (extras.length > 1 && sims < config.sims) consider(selectFrom([...extras, ...candidates]));
  store.ticks += 1;
  totals.ticks += 1;
  totals.sims += sims;
  totals.ms += performance.now() - started;
  if (best === base || bestValue - baseValue < config.margin) return null;
  store.adopted += 1;
  store.gain += bestValue - baseValue;
  totals.adopted += 1;
  totals.gain += bestValue - baseValue;
  if (!candidates.includes(best[0])) totals.extraWins += 1;
  return best;
}

// Put the chosen set at the head of the candidate list so the planner's own
// greedy `take` loop reproduces it exactly (the set is disjoint by
// construction). The remaining candidates keep their relative order, so an
// unused slot is still filled by the next best order.
function reorder(candidates, set) {
  const chosen = new Set(set);
  const rest = candidates.filter((op) => !chosen.has(op));
  candidates.length = 0;
  for (const op of set) candidates.push(op);
  for (const op of rest) candidates.push(op);
}

module.exports = {
  configOf,
  choose,
  reorder,
  selectFrom,
  synth,
  value,
  runTick,
  fieldsFor,
  resolvesFirst,
  freshSearch,
  totals,
};
