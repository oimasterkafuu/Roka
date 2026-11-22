'use strict';

const END_TICK = 24;
const openingBudget = (speed) => Math.floor(160000 / Math.max(1, speed * speed));

// Pool all spare troops outside the crown, give them an unlimited frontier,
// and keep the number of unused exits at the crown. Sending a whole stack
// dominates a partial transfer in this relaxation: any surplus away from
// home can take a tile without using an exit. This bounds even split moves.
const boundCache = new Map();
function freeCaptures(left, home, away, exits, transit = 1) {
  if (!left) return 0;
  home = Math.min(home, left);
  away = Math.min(away, left);
  if (away >= left) return left;
  const key = (((left * 26 + home) * 26 + away) * 5 + exits) * 26 + transit;
  const cached = boundCache.get(key);
  if (cached !== undefined) return cached;
  const stock = home + 1;
  let best = freeCaptures(left - 1, stock, away, exits, transit);
  // Before the nearest vacancy, a batch must cross at least this many
  // occupied tiles. Consolidating batches that meet in transit and delaying
  // their departure until just before forwarding can only add recruits.
  if (transit <= left)
    best = Math.max(best, freeCaptures(left - transit, transit - 1, away + stock, exits, transit));
  if (away) best = Math.max(best, 1 + freeCaptures(left - 1, stock, away - 1, exits, transit));
  if (exits) best = Math.max(best, 1 + freeCaptures(left - 1, 0, away + stock - 1, exits - 1));
  boundCache.set(key, best);
  return best;
}

// Pool troops by distance from the crown. An order can advance all spare
// troops by one layer and may claim one vacancy there. Troops farther out
// can pay for any closer capture for free. Every real order is covered,
// including inward moves and splits. This relaxation retains the cost of
// transporting recruits through occupied layers in a narrow entrance.
function radialSearch(spare, vacant) {
  const depth = spare.length - 1,
    memo = new Map();
  function possible(left, needed, away) {
    if (!needed) return true;
    let d0 = 1;
    while (d0 <= depth && !vacant[d0]) d0++;
    if (needed > freeCaptures(left, spare[0], away, vacant[1], Math.max(1, d0 - 1))) return false;
    const key = String.fromCharCode(left, needed, ...spare, ...vacant);
    if (memo.has(key)) return memo.get(key);
    if (memo.size >= 15000) return true;
    spare[0]++;
    for (let d = 1; d <= depth + 1; d++) {
      const from = d - 1,
        outer = Math.min(d, depth);
      const sent = from === outer ? 0 : spare[from];
      spare[from] -= sent;
      spare[outer] += sent;
      let payer = outer;
      while (payer <= depth && !spare[payer]) payer++;
      const outside = d > depth;
      let found = false;
      if (payer <= depth && (outside || vacant[d])) {
        spare[payer]--;
        if (!outside) vacant[d]--;
        found = possible(left - 1, needed - 1, away + (from === 0 ? sent : 0) - 1);
        spare[payer]++;
        if (!outside) vacant[d]++;
      }
      if (!found && sent && left > needed) found = possible(left - 1, needed, away + (from === 0 ? sent : 0));
      spare[from] += sent;
      spare[outer] -= sent;
      if (found) {
        spare[0]--;
        memo.set(key, true);
        return true;
      }
    }
    const found = left > needed && possible(left - 1, needed, away);
    spare[0]--;
    memo.set(key, found);
    return found;
  }
  return possible;
}

// Try parallel launches against the serial witness. Every batch uses
// disjoint endpoints, so the server executes it in one tick in queue order.
function parallelOpening(left, cells, adj, initial, weight, serial, upper) {
  let best = serial;
  for (let trial = 0; trial < 96 && best.land < upper; trial++) {
    let seed = (trial + 1) * 7919;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const army = initial.slice(),
      moves = [];
    const owned = cells.flatMap((_, k) => (army[k] ? [k] : []));
    const launch = 1 + (trial % 8),
      noise = 3 + (trial % 11);
    for (let tick = 1; tick <= left; tick++) {
      army[0]++;
      const options = [];
      const frontier = owned.filter((i) => adj[i].some((j) => !army[j]));
      const distance = new Int16Array(cells.length).fill(-1);
      for (const i of frontier) distance[i] = 0;
      for (const i of frontier) {
        for (const j of adj[i]) {
          if (!army[j] || distance[j] >= 0) continue;
          distance[j] = distance[i] + 1;
          frontier.push(j);
        }
      }
      for (const from of owned) {
        const send = army[from] - 1;
        if (!send || (from === 0 && send < launch && tick < left - 1)) continue;
        for (const to of adj[from]) {
          const capture = Number(!army[to]);
          const exits = adj[to].filter((j) => !army[j]).length;
          // Transport through a filled ring only when it brings troops
          // closer to some vacancy. This avoids cycling a stack at home.
          if (!capture && distance[to] >= distance[from] && !(trial % 3 && distance[to] === 0)) continue;
          const reserveExit =
            tick < left - 2 &&
            adj[0].includes(to) &&
            capture &&
            (from !== 0 || (trial % 3 !== 0 && adj[0].some((j) => army[j] && adj[j].some((k) => !army[k]))));
          const score =
            capture * 28 +
            exits * 3 +
            weight[to] * 0.4 +
            next() * noise -
            (reserveExit ? 36 : 0) -
            (to === 0 ? 10 : 0) -
            (!capture && adj[from].some((k) => !army[k]) ? 24 : 0);
          options.push({ from, to, send, capture, score });
        }
      }
      options.sort((a, b) => b.score - a.score);
      const used = new Set(),
        batch = [];
      for (const { from, to, send, capture } of options) {
        if (used.has(from) || used.has(to)) continue;
        batch.push({
          from: cells[from],
          to: cells[to],
          mode: 2,
          source: army[from],
          destination: army[to],
          send,
          capture,
        });
        used.add(from);
        used.add(to);
        army[from] -= send;
        army[to] += send;
        if (capture) owned.push(to);
        if (batch.length === 16) break;
      }
      moves.push(batch);
    }
    if (owned.length > best.land) best = { ...serial, moves, land: owned.length };
  }
  return { ...best, upper };
}

function makeOpening(
  b,
  teams,
  homes,
  turn,
  enemyDistance,
  horizon = END_TICK,
  budget = 160000,
  multi = false,
) {
  const root = homes[0],
    left = horizon - turn;
  const own = [],
    cells = [],
    local = new Int32Array(b.size).fill(-1);
  const distance = new Int16Array(b.size).fill(-1);
  const startOnly =
    turn === 0 &&
    b.army_cnt[root] === 1 &&
    !b.grid_type.some((tile, i) => i !== root && tile < 200 && tile % 50 === b.me);
  // On reconnect all mobile stacks originated at the sole crown. Include
  // their current territory and every cell they can still enter.
  const radius = startOnly
    ? Math.floor((left + 1) / 2)
    : left + b.grid_type.reduce((n, t) => n + Number(t < 200 && t % 50 === b.me), 0);
  function add(i, d) {
    local[i] = cells.length;
    distance[i] = d;
    cells.push(i);
  }
  add(root, 0);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (distance[i] >= radius) continue;
    for (const j of b.neighbors[i]) {
      const mine = b.grid_type[j] < 200 && b.grid_type[j] % 50 === b.me && !b.isolated[j];
      if (local[j] >= 0 || b.grid_type[j] === 201 || (!mine && (teams[j] || b.army_cnt[j]))) continue;
      add(j, distance[i] + 1);
    }
  }
  const adj = cells.map((i) => b.neighbors[i].map((j) => local[j]).filter((k) => k >= 0));
  const besideRivalCrown = cells.map((i) =>
    b.neighbors[i].some((j) => b.grid_type[j] >= 100 && b.grid_type[j] < 150 && teams[j] !== teams[root]),
  );
  const army = new Uint16Array(cells.length);
  for (const [k, i] of cells.entries()) {
    if (teams[i] && b.grid_type[i] % 50 === b.me) {
      army[k] = b.army_cnt[i];
      own.push(k);
    }
  }
  const initialLand = own.length;
  const initialAway = own.reduce((sum, k) => sum + (k ? army[k] - 1 : 0), 0);
  const exits = () => adj[0].reduce((n, j) => n + Number(!army[j]), 0);
  let upper = Math.min(cells.length, initialLand + freeCaptures(left, army[0] - 1, initialAway, exits()));
  if (startOnly && initialLand === 1) {
    // At distance >=d there can be at most t-2d+2 units: the last move
    // across that layer needs the troops one tick earlier and leaves one
    // behind. Also bound the number of cells available inside each layer.
    for (let d = 1; d <= radius; d++) {
      const inside = cells.reduce((n, i) => n + Number(distance[i] < d), 0);
      upper = Math.min(upper, inside + Math.max(0, left - 2 * d + 2));
    }
  }
  const depth = 3,
    vacant = Array(depth + 1).fill(0),
    spare = Array(depth + 1).fill(0);
  const layer = cells.map((i) => Math.min(depth, distance[i]));
  for (const [k, i] of cells.entries()) {
    if (army[k]) spare[layer[k]] += army[k] - 1;
    else if (distance[i] <= depth) vacant[layer[k]]++;
  }
  const possible = radialSearch(spare, vacant);
  while (upper > initialLand && !possible(left, upper - initialLand, initialAway)) upper--;
  const path = [];
  let best = [],
    land = initialLand,
    nodes = 0,
    quality = 0,
    bestQuality = 0;
  const fallbackWeight = (k) =>
    Math.min(16, enemyDistance[cells[k]]) * 1.5 +
    (b.grid_type[cells[k]] === 204 ? 0 : 9) +
    adj[k].length -
    Math.max(0, distance[cells[k]] + 2 - enemyDistance[cells[k]]) * 3;
  const weight = cells.map((_, k) => fallbackWeight(k));
  const value = cells.map(
    (i) =>
      (b.grid_type[i] === 204 ? 0 : 18) +
      Math.min(12, enemyDistance[i] - distance[i]) -
      Math.max(0, 5 - enemyDistance[i]) * 5,
  );
  // Count work, not wall time. A route that meets upper is a certificate;
  // otherwise retain both bounds for diagnostics and the best legal prefix.
  let fullOnly = true,
    ceiling = budget,
    variation = 0;
  function search(steps, away, target, seen) {
    if (own.length > land || (own.length === land && quality > bestQuality)) {
      best = path.slice();
      land = own.length;
      bestQuality = quality;
    }
    if (own.length >= target) return true;
    if (!steps || nodes >= ceiling) return false;
    let nearest = 1;
    while (nearest < cells.length && army[nearest]) nearest++;
    if (nearest === cells.length) return false;
    const transit = Math.max(1, distance[cells[nearest]] - 1);
    const portsNow = exits();
    if (
      own.length + freeCaptures(steps, army[0] - 1, away, portsNow, transit) < target ||
      !possible(steps, target - own.length, away)
    )
      return false;
    const waited = path.length > 0 && path.at(-1) === null;
    const key = String.fromCharCode(steps, Number(waited)) + Buffer.from(army.buffer).toString('base64');
    if (seen.has(key)) return false;
    seen.add(key);
    nodes++;
    army[0]++;
    spare[0]++;
    const moves = [];
    function candidate(from, to, send, mode) {
      const capture = to >= 0 && !army[to] ? 1 : 0;
      const futureAway = away + (from === 0 ? send : 0) - (to === 0 ? send : 0) - capture;
      const ports = portsNow - Number(capture && adj[0].includes(to));
      const stock = army[0] - 1 - (from === 0 ? send : 0) + (to === 0 ? send : 0);
      const nextBound = freeCaptures(steps - 1, stock, futureAway, ports, transit);
      if (own.length + capture + nextBound < target) return;
      let priority = (capture + nextBound) * 120 + capture * 35 + (to >= 0 ? weight[to] : 0);
      if (from === 0 && !capture && to >= 0 && !adj[to].some((j) => !army[j])) priority -= 65;
      if (from < 0 && !away) priority += 60;
      if (to >= 0 && !adj[to].some((j) => !army[j])) priority -= Math.min(7, send - 1) * 8;
      if (to >= 0 && from !== 0 && adj[0].includes(to) && capture) priority -= 50;
      if (!capture && from >= 0) priority -= 20;
      if (mode === 1 || mode === 0) priority -= 3;
      if (variation && to >= 0)
        priority += ((Math.imul(to + 1, variation * 733 + 47) ^ Math.imul(from + 2, 97)) >>> 0) % 28;
      moves.push({ from, to, send, mode, capture, futureAway, priority });
    }
    candidate(-1, -1, 0, 2);
    for (const from of own) {
      // Waiting commutes with any move not departing from the crown. Move
      // that wait to just before the next departure to avoid permutations.
      if (waited && from !== 0 && !besideRivalCrown[from]) continue;
      const cap = army[from] - 1;
      if (cap < 1) continue;
      for (const to of adj[from]) {
        candidate(from, to, cap, 2);
        // Other directions contribute defender-1 in the server's split
        // formula, including empty neutral cells outside the search radius.
        if (fullOnly) continue;
        let reserve = 0;
        for (const n of b.neighbors[cells[from]]) {
          if (n === cells[to] || b.grid_type[n] === 201 || army[local[n]] || teams[n] === teams[root])
            continue;
          reserve +=
            b.army_cnt[n] -
            1 +
            (b.grid_type[n] >= 100 && b.grid_type[n] < 150 && teams[n] ? left - steps + 1 : 0);
        }
        const smart = Math.max(0, cap - reserve);
        const full = Math.min(cap, smart),
          half = Math.min(cap, Math.floor(smart / 2));
        if (full > 0 && full < cap) candidate(from, to, full, 0);
        if (half > 0 && half < cap && half !== full) candidate(from, to, half, 1);
      }
    }
    moves.sort((a, c) => c.priority - a.priority);
    for (const move of moves) {
      const { from, to, send, capture, mode, futureAway } = move;
      const toLayer = layer[to],
        fromLayer = layer[from];
      if (from >= 0) {
        army[from] -= send;
        army[to] += send;
        spare[fromLayer] -= send;
        spare[toLayer] += send - capture;
        if (capture) {
          own.push(to);
          quality += value[to];
          if (distance[cells[to]] <= depth) vacant[toLayer]--;
        }
      }
      path.push(
        from < 0
          ? null
          : {
              from: cells[from],
              to: cells[to],
              mode,
              send,
              source: army[from] + send,
              destination: army[to] - send,
              capture,
            },
      );
      const found = search(steps - 1, futureAway, target, seen);
      path.pop();
      if (from >= 0) {
        if (capture) {
          own.pop();
          quality -= value[to];
          if (distance[cells[to]] <= depth) vacant[toLayer]++;
        }
        army[from] += send;
        army[to] -= send;
        spare[fromLayer] += send;
        spare[toLayer] -= send - capture;
      }
      if (found || nodes >= ceiling) {
        army[0]--;
        spare[0]--;
        return found;
      }
    }
    army[0]--;
    spare[0]--;
    return false;
  }
  // A whole-stack witness is cheap to find. Try different final sizes to
  // avoid spending the whole search on an optimistic but unreachable bound.
  for (let target = upper; target > land; target--) {
    ceiling = Math.min(budget, nodes + 700);
    if (search(left, initialAway, target, new Set())) break;
  }
  fullOnly = false;
  for (variation = 1; variation <= 6 && upper > land; variation++) {
    ceiling = Math.min(budget, nodes + 600);
    search(left, initialAway, upper, new Set());
  }
  variation = 0;
  if (upper > land + 1) {
    ceiling = Math.min(budget, nodes + 3500);
    search(left, initialAway, land + 1, new Set());
  }
  ceiling = budget;
  for (let target = upper; target > land && nodes < budget; target--) {
    if (search(left, initialAway, target, new Set())) break;
    if (nodes < budget) upper = target - 1;
  }
  // Compare possessions at the same area. A plain earns a burst and a
  // shorter approach from a rival makes an otherwise equal tile fragile.
  for (variation = 1; variation <= 5 && nodes < budget; variation++) {
    ceiling = Math.min(budget, nodes + 350);
    search(left, initialAway, land, new Set());
  }
  const plan = { start: turn, moves: best.map((op) => (op ? [op] : [])), land, upper, nodes };
  if (!multi) return plan;
  return parallelOpening(
    left,
    cells,
    adj,
    army,
    weight,
    plan,
    Math.min(cells.length, initialLand + initialAway + army[0] - 1 + left),
  );
}

function openingOrder(b, teams, homes, turn, enemyDistance, multi) {
  if (turn >= END_TICK || homes.length !== 1) return null;
  if (
    !b.opening ||
    turn < b.opening.start ||
    (b.opening.lastTurn != null && turn !== b.opening.lastTurn + 1)
  ) {
    b.opening = makeOpening(b, teams, homes, turn, enemyDistance, END_TICK, b.openingBudget, multi);
  }
  let plan = b.opening;
  let orders = plan.moves[turn - plan.start] ?? [];
  const own = (i) => b.grid_type[i] < 200 && b.grid_type[i] % 50 === b.me;
  const units = (i) => b.army_cnt[i] + Number(i === homes[0]);
  const effectiveSend = (op) => {
    const cap = units(op.from) - 1;
    if (op.mode === 2) return cap;
    let reserve = 0;
    for (const n of b.neighbors[op.from])
      if (n !== op.to && b.grid_type[n] !== 201 && teams[n] !== teams[homes[0]])
        reserve += b.army_cnt[n] - 1 + Number(teams[n] && b.grid_type[n] >= 100 && b.grid_type[n] < 150);
    const smart = Math.max(0, cap - reserve);
    return Math.min(cap, op.mode === 1 ? Math.floor(smart / 2) : smart);
  };
  if (
    orders.some(
      (op) =>
        !own(op.from) ||
        b.isolated[op.from] ||
        (op.capture ? teams[op.to] || b.grid_type[op.to] === 201 : !own(op.to)) ||
        units(op.to) !== op.destination ||
        units(op.from) !== op.source ||
        effectiveSend(op) !== op.send,
    )
  ) {
    b.opening = plan = makeOpening(b, teams, homes, turn, enemyDistance, END_TICK, b.openingBudget, multi);
    orders = plan.moves[0] ?? [];
  }
  plan.lastTurn = turn;
  return orders;
}

module.exports = { openingOrder, makeOpening, openingBudget, END_TICK };
