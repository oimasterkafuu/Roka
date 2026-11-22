'use strict';

const {
  rescueValues,
  assessOpponents,
  evaluateFrontMove,
  searchCampaign,
  siegeValue,
} = require('./single-front');
const { openingOrder } = require('./opening');

const INF = 1e6;
const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const anchor = (code) => code >= 50 && code < 150;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

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

function distances(board, seeds, allowed) {
  const dist = new Int32Array(board.size).fill(INF);
  const queue = [...seeds];
  for (const i of seeds) dist[i] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
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

function selectBuildSite(b, units, threat, frontDist, homeDist, supplyDistance) {
  const { size, me, neighbors, grid_type: tile } = b;
  // In serial play, depositing several garrisons at the same safe site is
  // cheaper than marching each one to the front. Prefer sites we can finish.
  let site = -1,
    siteValue = -Infinity;
  for (let i = 0; i < size; i++) {
    if (ownerOf(tile[i]) !== me || crown(tile[i]) || swamp(tile[i]) || b.isolated[i] || threat[i] > 0)
      continue;
    const city = anchor(tile[i]);
    const cost = city ? 50 : 100;
    const donors = neighbors[i].filter(
      (j) => ownerOf(tile[j]) === me && !b.isolated[j] && units[j] > 2 && threat[j] < 2,
    );
    const funds = units[i] + donors.reduce((sum, j) => sum + units[j] - 1, 0);
    if (funds < cost) continue;
    const largest = Math.max(0, ...donors.map((j) => units[j] - 1));
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
    burst = next >= 26 && next <= 50;
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
  if (clearSerial && turn < 25 && homes.length === 1 && borders.every((i) => enemyDist[i] > 4)) {
    return openingOrder(b, teams, myTeam, homes, turn);
  }
  const scouting = distances(b, scouts).dist;
  const single = clearSerial && turn >= 28;
  const self = leaderboard.find((p) => p.id === me);
  const borderDistance = single ? distances(b, borders).dist : null;
  const rival = single
    ? assessOpponents(b, leaderboard, targets, borderDistance, teams, myTeam, units, self)
    : null;
  const objectives = single ? (rival?.crowns ?? []) : targets;
  const { dist: goal, queue } = distances(b, objectives);
  const heading = targets.length ? goal : enemies.length ? enemyDist : scouting;
  const required = assaultStrength(b, queue, goal, units, teams, myTeam);
  const { threat, immediate } = incomingStrength(b, enemies, units, teams, myTeam);
  const danger = homes.filter((i) => threat[i] > units[i]);
  const defense = distances(b, danger, (j) => teams[j] === myTeam && !b.isolated[j]).dist;
  const mobileArmy = self.army - self.land;
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
    (homes.length < productiveTarget || mobileArmy > homes.length * 240) &&
    (!danger.length || homes.length > 2);
  const limit = single
    ? invest
      ? Math.max(productiveTarget, homes.length + 1)
      : Math.max(2, 1 + Math.floor(mobileArmy / 140))
    : Math.max(2, Math.min(longFront ? 12 : 32, 1 + Math.floor(mobileArmy / 185)));
  const develop = !single || invest || homes.length <= 2 || turn % 12 < (longFront ? 6 : 5);
  const backup = single && !longFront && !ffa && homes.length === 1 && enemyDist[homes[0]] <= 12;
  const buildingStart = clearSerial ? (backup ? 39 : 50) : 38;
  const site =
    develop && turn >= buildingStart && homes.length < limit
      ? selectBuildSite(b, units, threat, frontDist, homeDist, anchorDist)
      : -1;
  if (single) {
    const route = campaignRoute(b, objectives, units, teams, myTeam, Math.max(3, mobileArmy / 70));
    const rescue = rescueValues(b, teams, myTeam, units);
    front = {
      b,
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
    };
  }
  const candidates = [];
  const propose = (score, from, to, mode = 2, build) => {
    if (score > 0) candidates.push({ score, from, to, mode, build });
  };
  for (let i = 0; i < size; i++) {
    if (ownerOf(tile[i]) !== me || b.isolated[i]) continue;
    const base = crown(tile[i]),
      critical = base || cut[i] > 20;
    const nearFight = enemyDist[i] < 5;
    if (!base && !swamp(tile[i]) && units[i] >= 50 && turn >= buildingStart) {
      const city = anchor(tile[i]);
      const safe = immediate[i] <= units[i] - 50;
      const outpost = single && anchorDist[i] >= 5 && (cut[i] > 25 || units[i] >= 85);
      if (
        safe &&
        (develop || outpost) &&
        (homes.length < limit || outpost) &&
        (city || units[i] >= 100 || (cut[i] > 30 && nearFight) || outpost)
      ) {
        const buildScore =
          i === site
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
          backup && i === site ? 820 : buildScore - (nearFight && homes.length > 1 ? 82 : 0),
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
      const needed = intercept ? exposure : threat[i];
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
      if (!own && send <= units[j]) {
        if (front && hostile) propose(siegeValue(front, i, j, send), i, j, mode);
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
        );
        continue;
      }
      let score = 0;
      if (!own) {
        score = turn < 50 ? 62 : 32;
        if (swamp(tile[j])) score -= turn < 49 ? 29 : 8;
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
      if (hostile && danger.length && homeDist[j] <= 4 && units[j] >= 8 && intercept)
        score = Math.max(score, 680 + Math.min(100, units[j]));
      // A narrow advance is fragile when an adjacent enemy can take the
      // vacated connection. Independent routes and anchors avoid that risk.
      if (!own && support === 1 && !anchor(tile[i]) && exposure >= units[i] - send && !strike) score -= 180;
      if (b.lastFrom[i] === j && turn - b.lastMove[i] <= 4 && defense[j] >= defense[i] && !strike)
        score -= 110;
      if (score > 0) propose(score, i, j, mode);
    }
  }
  if (front) searchCampaign(front, candidates);
  candidates.sort((a, c) => c.score - a.score);
  const used = new Set(),
    orders = [];
  for (const op of candidates) {
    if (used.has(op.from) || used.has(op.to)) continue;
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
    }
    if (!multi || orders.length >= 16) break;
  }
  return orders;
}

module.exports = { createBoard, chooseOrders };
