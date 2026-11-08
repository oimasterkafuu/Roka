'use strict';

const DIRS = Object.freeze([
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]);

// Snapshots use owner + terrain offset.  The offset-only values (0/50/100/150)
// are the neutral forms used by a few replays and by hand-built test frames.
function ownerOf(code) {
  if (!Number.isFinite(code)) return 0;
  const value = Number(code);
  if (value >= 1 && value <= 49) return value;
  if (value >= 51 && value <= 99) return value - 50;
  if (value >= 101 && value <= 149) return value - 100;
  if (value >= 151 && value <= 199) return value - 150;
  return 0;
}

function kindOf(code) {
  if (!Number.isFinite(code)) return 'unknown';
  const value = Number(code);
  if (value === 0 || (value >= 1 && value <= 49) || value === 200) return 'plain';
  if (value === 50 || (value >= 51 && value <= 99)) return 'city';
  if (value === 100 || (value >= 101 && value <= 149)) return 'crown';
  if (value === 150 || (value >= 151 && value <= 199) || value === 204) return 'swamp';
  if (value === 201) return 'mountain';
  return 'unknown';
}

function indexOf(m, x, y) { return x * m + y; }
function coordinates(m, index) { return { x: Math.floor(index / m), y: index % m }; }

const cutCache = new WeakMap();
const adjacencyCache = new Map();
const ADJACENCY_CACHE_LIMIT = 4;

function adjacencyFor(n, m, size) {
  const key = `${n}x${m}`;
  const cached = adjacencyCache.get(key);
  if (cached && cached.length === size) {
    adjacencyCache.delete(key);
    adjacencyCache.set(key, cached);
    return cached;
  }
  const adjacency = Array.from({ length: size }, (_, at) => {
    const x = Math.floor(at / m);
    const y = at % m;
    const next = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < m) next.push(indexOf(m, nx, ny));
    }
    return Object.freeze(next);
  });
  adjacencyCache.set(key, adjacency);
  while (adjacencyCache.size > ADJACENCY_CACHE_LIMIT) adjacencyCache.delete(adjacencyCache.keys().next().value);
  return adjacency;
}

function makeBoard(raw, playerId) {
  const n = Number(raw?.n);
  const m = Number(raw?.m);
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000) {
    throw new Error('invalid board dimensions');
  }
  const grid = Array.isArray(raw.grid_type) ? raw.grid_type.slice() : raw.grid.slice();
  const army = Array.isArray(raw.army_cnt) ? raw.army_cnt.slice() : raw.army.slice();
  if (grid.length !== size || army.length !== size) throw new Error('incomplete board arrays');
  const fog = Array.isArray(raw.fog) && raw.fog.length === size ? raw.fog.slice() : Array(size).fill(0);
  const isolated = Array.isArray(raw.isolated) && raw.isolated.length === size ? raw.isolated.slice() : Array(size).fill(0);
  const teams = raw.teams instanceof Map
    ? new Map(raw.teams)
    : new Map((raw.leaderboard || []).map((entry) => [Number(entry.id), Number(entry.team) || Number(entry.id)]));

  // A bounded per-board adjacency cache.  The board itself is capped at 100k
  // cells, so retaining four short arrays per cell is predictable and much
  // cheaper than repeatedly allocating neighbour lists in the planner.
  // Derived previews pass the original board's private adjacency cache in
  // `_adjacency`; this avoids rebuilding O(n*m) neighbour arrays per action.
  const adjacency = Array.isArray(raw._adjacency) && raw._adjacency.length === size
    ? raw._adjacency
    : adjacencyFor(n, m, size);

  const board = {
    n, m, size, grid, army, fog, isolated, teams,
    turn: Number(raw.turn ?? -1),
    playerId: Number(playerId ?? raw.playerId) || 0,
    dead: Boolean(raw.dead),
    ended: Boolean(raw.ended || raw.game_end),
    leaderboard: Array.isArray(raw.leaderboard) ? raw.leaderboard.map((entry) => ({ ...entry })) : [],
    _adjacency: adjacency,
    neighbors: (at) => (at >= 0 && at < size ? adjacency[at] : []),
    xy: (at) => coordinates(m, at),
    idx: (x, y) => indexOf(m, x, y),
  };
  board.visible = fog.map((value) => Number(value) === 0);
  board.owner = (at) => (board.visible[at] ? ownerOf(board.grid[at]) : 0);
  // Fog hides ownership and army counts, but the wire format deliberately
  // keeps terrain usable for path planning: unseen ordinary cells are 200,
  // mountains 201, and swamps 204.  Treating every unseen tile as unknown
  // stranded the bot at the initial vision ring and made exploration
  // impossible.
  board.kind = (at) => kindOf(board.grid[at]);
  board.teamOf = (owner) => teams.get(Number(owner)) || Number(owner);
  board.sameTeam = (a, b) => a > 0 && b > 0 && board.teamOf(a) === board.teamOf(b);
  board.own = (at) => board.visible[at] && board.owner(at) === board.playerId;
  board.friendly = (at) => board.visible[at] && board.sameTeam(board.playerId, board.owner(at));
  board.enemy = (at) => board.visible[at] && board.owner(at) > 0 && !board.friendly(at);
  board.passable = (at) => board.kind(at) !== 'mountain' && board.kind(at) !== 'unknown';
  return board;
}

function cellsForTeam(board, owner) {
  const team = board.teamOf(owner);
  const cells = new Set();
  for (let at = 0; at < board.size; at += 1) {
    const cellOwner = board.owner(at);
    if (cellOwner > 0 && board.teamOf(cellOwner) === team && board.kind(at) !== 'mountain') cells.add(at);
  }
  return cells;
}

function anchorCells(board, owner) {
  const team = board.teamOf(owner);
  const anchors = [];
  for (let at = 0; at < board.size; at += 1) {
    const cellOwner = board.owner(at);
    if (cellOwner > 0 && board.teamOf(cellOwner) === team && ['city', 'crown'].includes(board.kind(at))) anchors.push(at);
  }
  return anchors;
}

function connectedSet(board, owner = board.playerId) {
  const cells = cellsForTeam(board, owner);
  const queue = anchorCells(board, owner).filter((at) => cells.has(at));
  const seen = new Set(queue);
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of board.neighbors(queue[head])) {
      if (!seen.has(next) && cells.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function distanceField(board, starts, canEnter = () => true) {
  const distance = Array(board.size).fill(Infinity);
  const parent = Array(board.size).fill(-1);
  const queue = [];
  for (const start of starts) {
    if (start < 0 || start >= board.size || !canEnter(start) || distance[start] === 0) continue;
    distance[start] = 0;
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    for (const next of board.neighbors(at)) {
      if (distance[next] !== Infinity || !canEnter(next)) continue;
      distance[next] = distance[at] + 1;
      parent[next] = at;
      queue.push(next);
    }
  }
  return { distance, parent };
}

function reconstruct(parent, start, goal) {
  if (start === goal) return [start];
  const path = [];
  for (let at = goal; at >= 0; at = parent[at]) {
    path.push(at);
    if (at === start) return path.reverse();
  }
  return null;
}

/**
 * Tarjan cut analysis rooted at a virtual vertex joined to every team anchor.
 * For each removed cell, land/mass count only components that would lose every
 * anchor.  Separating two anchors is therefore harmless and reports zero loss.
 * `separates(removed, at)` is O(number of detached DFS intervals).
 */
function cutAnalysis(board, owner = board.playerId) {
  const key = board.teamOf(owner);
  let byTeam = cutCache.get(board);
  if (!byTeam) { byTeam = new Map(); cutCache.set(board, byTeam); }
  if (byTeam.has(key)) return byTeam.get(key);

  const cells = cellsForTeam(board, owner);
  const anchors = anchorCells(board, owner).filter((at) => cells.has(at));
  const mass = new Float64Array(board.size);
  const land = new Uint32Array(board.size);
  const anchorSet = new Set(anchors);
  const intervals = Array.from({ length: board.size }, () => []);
  const points = new Set();
  if (!anchors.length || !cells.size) {
    const empty = { mass, land, points, separates: () => false };
    byTeam.set(key, empty);
    return empty;
  }

  const root = board.size;
  const disc = new Int32Array(board.size + 1);
  const low = new Int32Array(board.size + 1);
  const parent = new Int32Array(board.size + 1); parent.fill(-1);
  const subLand = new Uint32Array(board.size + 1);
  const subMass = new Float64Array(board.size + 1);
  const tout = new Int32Array(board.size + 1);
  const tin = new Int32Array(board.size + 1);
  let time = 0;
  const stack = [{ v: root, next: 0 }];
  disc[root] = low[root] = ++time; tin[root] = disc[root];

  const getNeighbor = (v, pos) => {
    if (v === root) return pos < anchors.length ? anchors[pos] : -1;
    const list = board.neighbors(v);
    if (pos < list.length) return list[pos];
    if (pos === list.length && anchorSet.has(v)) return root;
    return -1;
  };
  const degree = (v) => v === root ? anchors.length : board.neighbors(v).length + (anchorSet.has(v) ? 1 : 0);
  const valid = (v) => v === root || cells.has(v);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const v = frame.v;
    const deg = degree(v);
    if (frame.next < deg) {
      const next = getNeighbor(v, frame.next++);
      if (!valid(next)) continue;
      if (!disc[next]) {
        parent[next] = v;
        disc[next] = low[next] = ++time;
        tin[next] = disc[next];
        subLand[next] = 1;
        subMass[next] = Math.max(0, Number(board.army[next]) || 0);
        stack.push({ v: next, next: 0 });
      } else if (next !== parent[v]) {
        low[v] = Math.min(low[v], disc[next]);
      }
      continue;
    }
    tout[v] = time;
    // Each visited cell contributes once to its DFS subtree; child totals
    // were accumulated while those child frames completed.
    stack.pop();
    if (parent[v] >= 0) {
      const p = parent[v];
      subLand[p] += subLand[v];
      subMass[p] += subMass[v];
      low[p] = Math.min(low[p], low[v]);
      if (p !== root && low[v] >= disc[p]) {
        // Because the DFS is rooted at the virtual anchor, a child subtree
        // meeting this condition contains no path back to an anchor.
        land[p] += subLand[v];
        mass[p] += subMass[v];
        intervals[p].push([tin[v], tout[v]]);
        points.add(p);
      }
    }
  }

  const separates = (removed, at) => {
    if (!Number.isInteger(removed) || !Number.isInteger(at) || removed === at || removed < 0 || removed >= board.size || at < 0 || at >= board.size) return false;
    const t = tin[at];
    if (!t) return false;
    return intervals[removed].some(([start, end]) => t >= start && t <= end);
  };
  const result = { mass, land, points, separates };
  byTeam.set(key, result);
  return result;
}

function articulationCells(board, owner = board.playerId) {
  return new Set(cutAnalysis(board, owner).points);
}

function countOwner(board, owner, kind = null) {
  let count = 0;
  for (let at = 0; at < board.size; at += 1) {
    if (board.owner(at) === owner && (kind === null || board.kind(at) === kind)) count += 1;
  }
  return count;
}

function totalArmy(board, owner) {
  let total = 0;
  for (let at = 0; at < board.size; at += 1) if (board.owner(at) === owner) total += Math.max(0, board.army[at]);
  return total;
}

module.exports = {
  DIRS,
  ownerOf,
  kindOf,
  makeBoard,
  cellsForTeam,
  anchorCells,
  connectedSet,
  distanceField,
  reconstruct,
  cutAnalysis,
  articulationCells,
  countOwner,
  totalArmy,
};
