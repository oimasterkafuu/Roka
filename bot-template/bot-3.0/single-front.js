'use strict';

// A bridge cell can reconnect several pockets. Count each component once,
// including its surviving garrisons, without feeding units into isolation.
function rescueValues(b, teams, myTeam, units) {
  const recovered = new Float64Array(b.size);
  const seen = new Uint8Array(b.size);
  for (let start = 0; start < b.size; start++) {
    if (!b.isolated[start] || teams[start] !== myTeam || seen[start]) continue;
    const pocket = [start],
      links = new Set();
    seen[start] = 1;
    let value = 0;
    for (let head = 0; head < pocket.length; head++) {
      const i = pocket[head];
      value += units[i] + 2;
      for (const j of b.neighbors[i]) {
        if (teams[j] !== myTeam) {
          if (b.grid_type[j] !== 201) links.add(j);
        } else if (b.isolated[j] && !seen[j]) {
          seen[j] = 1;
          pocket.push(j);
        }
      }
    }
    for (const link of links) recovered[link] += value;
  }
  return recovered;
}

// Compare the cost of eliminating each rival from our actual frontage.
// Visible pressure on a rival from a third team is an opportunity. Pressure
// on our other borders increases the price of committing to a single front.
function assessOpponents(b, leaderboard, targets, borderDistance, teams, myTeam, units, self) {
  const rivals = new Map();
  for (const p of leaderboard) {
    if (!p.dead && p.team !== myTeam) rivals.set(p.id, { player: p, crowns: [], contact: 0, pressure: 0 });
  }
  for (const i of targets) rivals.get(b.memory[i] % 50)?.crowns.push(i);
  for (let i = 0; i < b.size; i++) {
    const team = teams[i];
    if (!team || team === myTeam) continue;
    const rival = rivals.get(b.grid_type[i] % 50);
    if (!rival) continue;
    for (const j of b.neighbors[i]) {
      if (teams[j] === myTeam) rival.contact = Math.max(rival.contact, units[i]);
      else if (teams[j] && teams[j] !== team) rival.pressure = Math.max(rival.pressure, units[j]);
    }
  }
  let selected,
    best = -Infinity;
  for (const rival of rivals.values()) {
    if (!rival.crowns.length) continue;
    const distance = rival.crowns.reduce((d, i) => Math.min(d, borderDistance[i]), Infinity);
    const strength = rival.player.army / Math.max(1, self.army);
    const third = [...rivals.values()].reduce((v, r) => (r === rival ? v : Math.max(v, r.contact)), 0);
    const value =
      -distance * 5 -
      25 * Math.log1p(strength) -
      9 * Math.log2(rival.crowns.length) +
      Math.min(18, (30 * rival.pressure) / Math.max(1, rival.player.army)) -
      Math.min(30, (third / Math.max(1, self.army)) * distance * 8) +
      (b.focusOwner === rival.player.id ? 4 : 0);
    rival.otherFront = third;
    if (value > best) {
      selected = rival;
      best = value;
    }
  }
  b.focusOwner = selected?.player.id;
  return selected;
}

function evaluateFrontMove(s, move) {
  const {
    b,
    units,
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
    wide,
    anchorDist,
    enemyDist,
  } = s;
  const { i, j, own, hostile, strike, send, remaining, support, exposure, intercept, base } = move;
  if (strike) return 2500 + Math.min(100, remaining);
  const economical = b.grid_type[j] < 150 || b.grid_type[j] === 200;
  const exposedLink =
    !own &&
    support <= 1 &&
    !base &&
    !(b.grid_type[i] >= 50 && b.grid_type[i] < 150) &&
    exposure >= units[i] - send;
  const repulse = own ? 0 : Math.max(0, immediate[j] - remaining);
  const valueOfCut = hostile ? cut[j] : 0;
  const recovery = !own ? rescue[j] : 0;
  const targetMoves = goal[j];
  const movingToCrown = targetMoves < goal[i];
  const finalApproach = movingToCrown && targetMoves <= 4 && remaining >= required[j] + targetMoves * 2;
  const reserve = rival ? rival.player.army / Math.max(1, self.army) : 1;
  const contested = ffa && rival && rival.otherFront > Math.max(15, self.army * 0.07);
  let score = 0;
  if (!own) {
    // Fill cheap gaps and widen a corridor before extending it. Spending a
    // large stack on an exposed plain is expensive even if capture succeeds.
    score =
      63 +
      (economical ? 12 : 0) +
      Math.min(3, support) * 5 -
      Math.min(26, anchorDist[j] * 2) -
      Math.min(60, units[j] * 0.8);
    if (hostile) score += 12 + Math.min(530, (valueOfCut / Math.max(1, send * 0.08)) * 85);
    if (recovery > 0) score += Math.min(300, recovery * 1.5);
    if (b.grid_type[j] >= 50 && b.grid_type[j] < 100 && hostile) score += 90;
    if (s.beforeBurstEnd && economical && !repulse) score += 530 + Math.min(5, remaining);
    if (repulse > 0) score -= Math.min(180, 25 + send * 1.4);
  } else if (!b.isolated[j]) {
    if (frontDist[j] < frontDist[i]) score = 25 + Math.min(52, Math.sqrt(send) * 3);
    if (j === site && units[j] < (b.grid_type[j] >= 50 ? 50 : 100) && send > 1)
      score = (s.backup ? 735 : s.invest ? 580 : 374) + Math.min(35, send / 3);
  }
  const towardFront = route[j] < route[i];
  const column = b.column === i && turn - b.columnTurn <= 2;
  const progress = column ? 22 : 0;
  if (towardFront && !b.isolated[j] && send >= 6) {
    const pickup = own ? Math.min(units[j] - 1, send) : 0;
    // Compare useful mass with current garrisons, not a fixed unit cap.
    const scale = Math.max(15, self.army * 0.065);
    const mass = Math.max(0, remaining - immediate[j] * 0.7);
    const concentration = Math.min(2, mass / scale);
    const reach = anchorDist[j];
    const longRaid = !own && reach > (wide ? 4 : 6) && support < 2 && (immediate[j] > 1 || exposure > 1);
    const credible = remaining >= required[j] + targetMoves * 2;
    const canCommit = credible && (targetMoves <= 4 || (!longRaid && reserve < (ffa ? 0.85 : 1.3)));
    const march =
      62 +
      75 * concentration +
      progress +
      Math.min(40, (pickup / scale) * 60) +
      (canCommit ? 70 : 0) -
      Math.min(38, route[j] * 0.45) -
      (longRaid && !finalApproach ? 135 : 0);
    score = Math.max(score, march);
  }
  if (finalApproach) score = Math.max(score, 455 - targetMoves * 12 + progress);
  const surplus = remaining - required[j] - targetMoves * 2;
  const protectedAdvance = own || support >= 2 || anchorDist[j] < (wide ? 5 : 9);
  if (
    wide &&
    rival &&
    towardFront &&
    !underPressure(s, i) &&
    !repulse &&
    (own || support >= 2 || anchorDist[j] <= 5 || (exposure <= 1 && immediate[j] < 2)) &&
    remaining > Math.max(24, Math.min(rival.player.army * 0.085, self.army * 0.16))
  ) {
    const advantage = self.army / Math.max(1, rival.player.army);
    const priority =
      (advantage >= 1.15 || homes.length >= rival.crowns.length + 3 ? 510 : 300) +
      Math.min(65, (30 * remaining) / Math.max(40, self.army * 0.14)) -
      Math.min(70, targetMoves * 2) +
      progress;
    score = Math.max(score, priority);
  }
  if (
    movingToCrown &&
    surplus >= 0 &&
    (protectedAdvance || finalApproach) &&
    targetMoves <= (wide || ffa ? 11 : 17) &&
    send >= 6
  ) {
    score = Math.max(score, 495 - targetMoves * 7 + Math.min(28, Math.sqrt(surplus) * 2) + progress);
  }
  if (hostile && units[j] > 3 && !repulse && homeDist[j] < 6)
    score = Math.max(score, 130 + Math.min(360, (230 * units[j]) / Math.max(12, self.army * 0.12)));
  if (s.closing && s.lead >= 0 && s.leadDist && !b.isolated[j] && send >= 12) {
    // Closing phase on a compact serial room: the whole empire funnels into its
    // heaviest stack, and that stack pushes only once it can pay for the rest
    // of the path. sqrt(mass) keeps the funnel ordered (a 2000-army pool 1547
    // outranks a 55-unit detachment 1003) and both sit above the economy build
    // (675) and land (630) scores, so a tick is never spent on a 50-unit
    // deposit while 2000 army waits at the back of the map.
    //
    // `required` already prices every defender on the route and one unit lost
    // per step, so a 119-army lead facing a fifteen-cell approach through
    // defended cells stages at the frontier instead of walking into the enemy
    // line to die, and the rear garrisons keep arriving until it can commit.
    // A plain mass march (no staging gate) captured three crowns and then lost
    // the column mid-way; the staged version converts the whole hoard first.
    if (i === s.lead) {
      if (goal[j] < goal[i] && remaining >= required[i])
        score = Math.max(score, 1000 + Math.min(620, Math.sqrt(Math.max(send, remaining)) * 14));
    } else if (s.leadDist[j] < s.leadDist[i] && enemyDist[i] >= 3) {
      const mass = own ? send + units[j] : send;
      score = Math.max(score, 940 + Math.min(500, Math.sqrt(mass) * 14));
    }
  }
  if (!rival && route[j] < route[i] && !b.isolated[j] && send >= 6 && !repulse) {
    score = Math.max(
      score,
      120 +
        progress +
        Math.min(42, Math.sqrt(remaining) * 2) -
        Math.min(24, route[j] * 0.4) -
        (exposedLink ? 160 : 0),
    );
  }
  if (own && s.defense[j] < s.defense[i] && send >= 2 && (homes.length <= 2 || s.defense[i] <= 2))
    score = Math.max(score, 600 + Math.min(80, send) - 6 * s.defense[j]);
  if (hostile && danger.length && homeDist[j] <= 4 && intercept && units[j] >= 8)
    score = Math.max(score, 760 + Math.min(100, units[j]));
  if (exposedLink && !finalApproach) score -= Math.min(340, 80 + remaining);
  if (repulse && !own && valueOfCut + recovery < send * 0.6) score -= 120;
  if (own && b.isolated[j]) return 0;
  if (
    contested &&
    !own &&
    anchorDist[j] > 3 &&
    !recovery &&
    !valueOfCut &&
    (targetMoves > 2 || rival.crowns.length > 1)
  )
    score -= 260;
  if (b.lastFrom[i] === j && turn - b.lastMove[i] < 7 && s.defense[j] >= s.defense[i]) score -= 150;
  return score;
}

function underPressure(s, i) {
  return s.danger.length > 0 && s.homes.length <= 2 && s.homeDist[i] <= 3;
}

// Non-capturing attacks still remove defenders. Only start a two-tick siege
// if a different connected garrison can finish after growth and one reply.
function siegeValue(s, from, target, send) {
  const { b, units, teams, immediate, homes, cut } = s;
  const owner = b.grid_type[target] % 50;
  if (!teams[target] || teams[target] === s.myTeam || !send) return 0;
  const castle = b.grid_type[target] === 100 + owner;
  if (!castle && cut[target] < units[target]) return 0;
  const nextGuard = units[target] - send + (castle ? 1 : 0);
  let follow = 0,
    reply = 0;
  for (const j of b.neighbors[target]) {
    if (j === from || b.isolated[j]) continue;
    if (teams[j] === teams[target]) reply = Math.max(reply, units[j] - 1);
    if (
      b.grid_type[j] < 200 &&
      b.grid_type[j] % 50 === b.me &&
      !(homes.length === 1 && homes[0] === j && immediate[j] > 1)
    )
      follow = Math.max(follow, units[j] - 1);
  }
  // Allow for reinforcement, or a counterattack from the crown followed by
  // a one-unit garrison and crown growth before our second move.
  if (follow <= nextGuard + Math.max(3, reply)) return 0;
  if (s.danger.length && homes.length === 1) return 0;
  return (castle ? 790 : 565) + Math.min(45, (follow - nextGuard - reply) / 4);
}

// Search one moving army. Friendly troops can be collected once per path.
// Beam states at the same endpoint compete on force, time and exposure.
function searchCampaign(s, moves) {
  const { b, teams, myTeam, units, goal, immediate, cut, rival, self, wide, turn, homes, danger } = s;
  if (!rival || !moves.length) return;
  const targetOwner = rival.player.id;
  const scale = Math.max(20, Math.min(self.army * 0.14, rival.player.army * 0.22 + 40));
  const maxDepth = wide ? 12 : 15;
  const underAttack = danger.length > 0 && homes.length <= 2;
  let bestValue = 0,
    best;
  function extend(parent, from, to, first, sent, depth) {
    const ally = teams[to] === myTeam;
    if (!ally && sent <= units[to]) return;
    const power = sent + (ally ? units[to] : -units[to]);
    const relief = ally ? 0 : cut[to];
    const capital = !ally && b.grid_type[to] === 100 + targetOwner;
    const connected =
      teams[from] === myTeam &&
      ((b.grid_type[from] >= 50 && b.grid_type[from] < 150) ||
        b.neighbors[to].some((j) => j !== from && teams[j] === myTeam && !b.isolated[j]));
    const flank =
      ally || connected
        ? 0
        : Math.max(
            0,
            ...b.neighbors[from]
              .filter((j) => j !== to && teams[j] !== myTeam && teams[j] && !b.isolated[j])
              .map((j) => units[j] - 1),
          );
    const exposure = (parent?.exposure ?? 0) + (flank > 1 ? 2 : 0) + (!ally && immediate[to] > power ? 4 : 0);
    const distance = goal[to];
    const approach =
      8 * Math.min(5, power / scale) + 20 * Math.log1p(power / scale) - 4 * distance - 7 * exposure;
    let value = 0;
    // Opponents can use one serial action per tick to reinforce. Discount
    // hypothetical finishes if a neighbouring reserve can defeat the column.
    if (capital) {
      const guard =
        depth === 1
          ? 0
          : Math.max(0, ...b.neighbors[to].filter((j) => teams[j] === teams[to]).map((j) => units[j] - 1));
      if (power > guard * 0.65 + depth - 1)
        value = 1080 + (rival.crowns.length === 1 ? 160 : 0) - 18 * depth - 62 * exposure;
    } else if (relief > Math.max(28, units[to] * 2) && power > immediate[to] * 0.5) {
      value = 570 + Math.min(160, (relief / scale) * 100) - depth * 25 - exposure * 60;
    }
    if (underAttack && depth > 2) value -= 640;
    if (s.ffa && rival.crowns.length > 1 && depth > 3) value -= Math.min(450, 25 * rival.crowns.length);
    if (s.ffa && rival.otherFront > self.army * 0.07 && depth > 3) value -= 420;
    const gathered = power - units[first.from];
    const advance = goal[first.from] - distance;
    if (
      !s.invest &&
      !underAttack &&
      !exposure &&
      advance >= 2 &&
      depth <= 8 &&
      gathered >= scale * 0.65 &&
      power >= scale * 1.5 &&
      power > immediate[to] &&
      (!s.ffa || rival.otherFront < self.army * 0.07)
    ) {
      const assembly = 350 + Math.min(90, (gathered / scale) * 30) + advance * 5 - depth * 6;
      value = Math.max(value, assembly);
    }
    if (turn < 48 && depth > 5) value -= 720;
    if (value > bestValue) {
      bestValue = value;
      best = first;
    }
    return { first, from, to, power, exposure, parent, approach };
  }
  function prune(states) {
    states.sort((a, c) => c.approach - a.approach);
    const fronts = new Set(),
      beam = [];
    for (const state of states) {
      if (fronts.has(state.to)) continue;
      beam.push(state);
      fronts.add(state.to);
      if (beam.length >= 18) break;
    }
    return beam;
  }
  let states = [];
  for (const move of moves) {
    if (move.build || move.mode !== 2 || b.isolated[move.to] || goal[move.to] > maxDepth + 4) continue;
    const state = extend(null, move.from, move.to, move, units[move.from] - 1, 1);
    if (state) states.push(state);
  }
  let beam = prune(states);
  for (let depth = 2; depth <= maxDepth && beam.length; depth++) {
    states = [];
    for (const node of beam) {
      if (node.power < 2 || goal[node.to] === 0) continue;
      for (const j of b.neighbors[node.to]) {
        if (b.grid_type[j] === 201 || b.isolated[j] || (teams[j] === myTeam && b.grid_type[j] % 50 !== b.me))
          continue;
        let previous = node;
        while (previous && previous.from !== j) previous = previous.parent;
        if (previous) continue;
        const state = extend(node, node.to, j, node.first, node.power - 1, depth);
        if (state) states.push(state);
      }
    }
    beam = prune(states);
  }
  if (best) best.score = Math.max(best.score, bestValue);
}

module.exports = { rescueValues, assessOpponents, evaluateFrontMove, searchCampaign, siegeValue };
