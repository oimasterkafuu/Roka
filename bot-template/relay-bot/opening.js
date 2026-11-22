'use strict';

// Before the burst the total mobile force is small. Search the actual serial
// moves, including a wait for crown growth. Enemy and allied land are walls
// here; the tactical planner takes over as soon as a rival comes close.
function openingOrder(b, teams, myTeam, homes, turn) {
  if (homes.length !== 1 || turn >= 25) return null;
  const root = homes[0],
    cells = [],
    index = new Map();
  const add = (i) => {
    index.set(i, cells.length);
    cells.push(i);
  };
  const depth = Math.min(8, 25 - turn);
  // Only cells reachable within this search can change.
  for (let i = 0; i < b.size; i++) if (b.grid_type[i] < 200 && b.grid_type[i] % 50 === b.me) add(i);
  let tail = cells.length;
  for (let head = 0, step = 0; step < depth; step++) {
    for (; head < tail; head++) {
      for (const j of b.neighbors[cells[head]]) {
        if (index.has(j) || b.grid_type[j] === 201 || teams[j] || b.army_cnt[j] > 0) continue;
        add(j);
      }
    }
    tail = cells.length;
  }
  const adj = cells.map((i) => b.neighbors[i].filter((j) => index.has(j)).map((j) => index.get(j)));
  const plain = cells.map((i) => b.grid_type[i] < 150 || b.grid_type[i] === 200);
  const crown = index.get(root),
    initial = new Uint8Array(cells.length);
  for (const [i, k] of index) if (teams[i] === myTeam) initial[k] = b.army_cnt[i];
  let beam = [{ army: initial, gain: 0, first: null, score: 0 }];
  for (let t = 0; t < depth; t++) {
    const best = new Map();
    for (const node of beam) {
      node.army[crown]++;
      const moves = [[-1, -1]];
      for (let from = 0; from < cells.length; from++) {
        if (node.army[from] < 2) continue;
        for (const to of adj[from]) moves.push([from, to]);
      }
      for (const [from, to] of moves) {
        const army = node.army.slice();
        let gain = node.gain;
        if (from >= 0) {
          if (!army[to]) gain += plain[to] ? 10 : 1;
          army[to] += army[from] - 1;
          army[from] = 1;
        }
        // Reward having another launch available, including stacks returning
        // through the home ring. Break equal plans by earlier captures.
        let ready = 0;
        for (let i = 0; i < cells.length; i++) {
          if (army[i] > 1 && adj[i].some((j) => !army[j] && plain[j])) ready += Math.min(army[i] - 1, 4);
        }
        const score = gain + Math.min(6, ready) * 0.7 + node.gain * 0.025;
        const key = Buffer.from(army.buffer).toString('base64');
        if (!best.has(key) || best.get(key).score < score)
          best.set(key, { army, gain, score, first: node.first ?? [from, to] });
      }
    }
    beam = [...best.values()].sort((a, c) => c.score - a.score).slice(0, 22);
  }
  const [from, to] = beam[0].first;
  return from < 0 ? [] : [{ from: cells[from], to: cells[to], mode: 2 }];
}

module.exports = { openingOrder };
