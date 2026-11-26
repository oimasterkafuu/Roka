import { SeededRandom, shuffle } from './map-core';

const LAYOUT_RESTARTS = 5;
const SWAP_TRIALS = 52;
const NEAR_RADIUS = 6;
const OPENING_RADIUS = 10;

interface DistanceField {
  distances: Int32Array;
  opening: number[];
}

interface LayoutScore {
  separation: number;
  openingFloor: number;
  balance: number;
}

class MazeGraph {
  readonly cells: number[] = [];

  readonly degree: Uint8Array;

  private readonly neighbors: Int32Array;

  private readonly queue: Int32Array;

  private readonly nearestDistance: Int32Array;

  private readonly nearestSeats: Uint32Array;

  private readonly fields = new Map<number, DistanceField>();

  constructor(
    readonly tiles: Uint8Array,
    cols: number,
  ) {
    this.degree = new Uint8Array(tiles.length);
    this.neighbors = new Int32Array(tiles.length * 4);
    this.queue = new Int32Array(tiles.length);
    this.nearestDistance = new Int32Array(tiles.length);
    this.nearestSeats = new Uint32Array(tiles.length);
    for (let cell = 0; cell < tiles.length; cell += 1) {
      if (tiles[cell] === 1) continue;
      this.cells.push(cell);
      const options = [
        cell >= cols ? cell - cols : -1,
        cell + cols < tiles.length ? cell + cols : -1,
        cell % cols > 0 ? cell - 1 : -1,
        cell % cols < cols - 1 ? cell + 1 : -1,
      ];
      for (const next of options) {
        if (next >= 0 && tiles[next] !== 1) {
          this.neighbors[4 * cell + this.degree[cell]++] = next;
        }
      }
    }
  }

  field(start: number): DistanceField {
    const cached = this.fields.get(start);
    if (cached) return cached;
    const distances = new Int32Array(this.tiles.length).fill(-1);
    const opening: number[] = [];
    let tail = 1;
    this.queue[0] = start;
    distances[start] = 0;
    for (let head = 0; head < tail; head += 1) {
      const cell = this.queue[head];
      const distance = distances[cell] + 1;
      for (let edge = 0; edge < this.degree[cell]; edge += 1) {
        const next = this.neighbors[4 * cell + edge];
        if (distances[next] !== -1) continue;
        distances[next] = distance;
        this.queue[tail++] = next;
        if (distance <= OPENING_RADIUS) opening.push(next);
      }
    }
    const field = { distances, opening };
    this.fields.set(start, field);
    return field;
  }

  territory(spawns: number[]): { passable: number[]; plains: number[] } {
    const distance = this.nearestDistance.fill(-1);
    const masks = this.nearestSeats;
    const passable = spawns.map(() => 0);
    const plains = spawns.map(() => 0);
    let tail = 0;
    for (const [seat, cell] of spawns.entries()) {
      distance[cell] = 0;
      masks[cell] = 1 << seat;
      this.queue[tail++] = cell;
    }
    for (let head = 0; head < tail; head += 1) {
      const cell = this.queue[head];
      const nextDistance = distance[cell] + 1;
      const mask = masks[cell];
      for (let edge = 0; edge < this.degree[cell]; edge += 1) {
        const next = this.neighbors[4 * cell + edge];
        if (distance[next] === -1) {
          distance[next] = nextDistance;
          masks[next] = mask;
          this.queue[tail++] = next;
        } else if (distance[next] === nextDistance) {
          masks[next] |= mask;
        }
      }
    }
    for (const cell of this.cells) {
      if (distance[cell] < 0) continue;
      const mask = masks[cell];
      let tied = 0;
      for (let remaining = mask; remaining; remaining &= remaining - 1) tied += 1;
      const share = 1 / tied;
      for (let remaining = mask; remaining; remaining &= remaining - 1) {
        const seat = 31 - Math.clz32(remaining & -remaining);
        passable[seat] += share;
        if (distance[cell] > 0 && this.tiles[cell] === 0) plains[seat] += share;
      }
    }
    return { passable, plains };
  }
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const variation = (values: number[]): number => {
  const average = mean(values);
  return average > 0 ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / average : 0;
};

const localCounts = (graph: MazeGraph, spawns: number[], fields: DistanceField[]) => {
  const reserved = new Set(spawns);
  return fields.map(({ distances, opening }) => {
    let near = 0;
    let wide = 0;
    let swampNear = 0;
    let swampWide = 0;
    for (const cell of opening) {
      if (reserved.has(cell)) continue;
      if (graph.tiles[cell] === 0) {
        if (distances[cell] <= NEAR_RADIUS) near += 1;
        wide += 1;
      } else {
        if (distances[cell] <= NEAR_RADIUS) swampNear += 1;
        swampWide += 1;
      }
    }
    return { near, wide, swampNear, swampWide };
  });
};

const compareLayoutScores = (left: LayoutScore, right: LayoutScore): number =>
  left.separation - right.separation ||
  left.openingFloor - right.openingFloor ||
  left.balance - right.balance;

const scoreMazeLayout = (graph: MazeGraph, spawns: number[], distanceTarget: number): LayoutScore => {
  if (spawns.length < 2) return { separation: 0, openingFloor: 0, balance: 0 };
  const fields = spawns.map((cell) => graph.field(cell));
  const nearest = spawns.map((_, seat) => {
    let closest = Infinity;
    for (let other = 0; other < spawns.length; other += 1) {
      if (seat !== other) closest = Math.min(closest, fields[seat].distances[spawns[other]]);
    }
    return closest;
  });
  const minimum = Math.min(...nearest);
  const separation = Math.floor(Math.min(1, minimum / distanceTarget) * 20);
  const range = localCounts(graph, spawns, fields);
  const near = range.map((count) => count.near);
  const wide = range.map((count) => count.wide);
  const weakest = Math.min(1, Math.min(...near) / 12, Math.min(...wide) / 22);
  const { passable, plains } = graph.territory(spawns);
  const shareFloor = Math.min(...plains) / Math.max(1, mean(plains));
  const exitScore = mean(spawns.map((cell) => graph.degree[cell]));
  const balance =
    5 * Math.min(1, minimum / distanceTarget) +
    8 * shareFloor -
    8 * (variation(near) + variation(wide)) -
    16 * variation(plains) -
    10 * variation(passable) -
    12 * variation(nearest) -
    0.6 *
      (variation(range.map((count) => count.swampNear)) + variation(range.map((count) => count.swampWide))) +
    0.6 * exitScore;
  return { separation, openingFloor: Math.floor(weakest * 10 + 1e-9), balance };
};

const optimizeMazeLayout = (
  graph: MazeGraph,
  players: number,
  distanceTarget: number,
  rng: SeededRandom,
): number[] => {
  if (!players) return [];
  const interior = graph.cells.filter((cell) => graph.degree[cell] >= 2);
  const endpoints = graph.cells.filter((cell) => graph.degree[cell] < 2);
  const eligible = interior.length >= players ? interior : graph.cells;
  const bestLayouts: { spawns: number[]; score: LayoutScore }[] = [];
  for (let attempt = 0; attempt < LAYOUT_RESTARTS; attempt += 1) {
    const firstPool = interior.length ? interior : eligible;
    const spawns = [firstPool[rng.intInclusive(0, firstPool.length - 1)]];
    const picked = new Set(spawns);
    const distanceToLayout = new Int32Array(graph.tiles.length).fill(graph.tiles.length);
    while (spawns.length < players) {
      const distances = graph.field(spawns[spawns.length - 1]).distances;
      const pool = spawns.length < interior.length ? interior : endpoints;
      for (const cell of eligible) distanceToLayout[cell] = Math.min(distanceToLayout[cell], distances[cell]);
      let farthest = -1;
      let farthestScore = -Infinity;
      for (const cell of pool) {
        if (picked.has(cell)) continue;
        const score = distanceToLayout[cell] + rng.next();
        if (score > farthestScore) {
          farthest = cell;
          farthestScore = score;
        }
      }
      spawns.push(farthest);
      picked.add(farthest);
    }
    bestLayouts.push({ spawns, score: scoreMazeLayout(graph, spawns, distanceTarget) });
  }

  bestLayouts.sort((left, right) => compareLayoutScores(right.score, left.score));
  if (players === 1 || eligible.length === players) return bestLayouts[0].spawns;
  for (let trial = 0; trial < SWAP_TRIALS; trial += 1) {
    const layout = bestLayouts[trial % 3 === 0 ? 1 : 0];
    const seat = rng.intInclusive(0, players - 1);
    const current = layout.spawns[seat];
    const field = graph.field(current);
    const options = trial % 5 !== 0 && field.opening.length ? field.opening : eligible;
    const replacement = options[rng.intInclusive(0, options.length - 1)];
    const sameExitClass = graph.degree[current] >= 2 === graph.degree[replacement] >= 2;
    if (!sameExitClass || layout.spawns.includes(replacement)) {
      continue;
    }
    const spawns = [...layout.spawns];
    spawns[seat] = replacement;
    const score = scoreMazeLayout(graph, spawns, distanceTarget);
    if (compareLayoutScores(score, layout.score) <= 0) continue;
    layout.spawns = spawns;
    layout.score = score;
    if (compareLayoutScores(bestLayouts[1].score, bestLayouts[0].score) > 0) {
      [bestLayouts[0], bestLayouts[1]] = [bestLayouts[1], bestLayouts[0]];
    }
  }
  return bestLayouts[0].spawns;
};

interface SwampCandidate {
  cell: number;
  shares: number[];
  near: number[];
  wide: number[];
}

const placeMazeSwamps = (
  graph: MazeGraph,
  spawns: number[],
  swampBudget: number,
  rng: SeededRandom,
): void => {
  const target = Math.min(swampBudget, graph.cells.length - spawns.length);
  if (!target || !spawns.length) return;
  const fields = spawns.map((cell) => graph.field(cell));
  const local = localCounts(graph, spawns, fields);
  const territory = spawns.map(() => 0);
  const regions: SwampCandidate[][] = spawns.map(() => []);
  for (const cell of graph.cells) {
    const shares: number[] = [];
    const near: number[] = [];
    const wide: number[] = [];
    let closest = Infinity;
    for (let seat = 0; seat < fields.length; seat += 1) {
      const distance = fields[seat].distances[cell];
      if (distance <= NEAR_RADIUS) near.push(seat);
      if (distance <= OPENING_RADIUS) wide.push(seat);
      if (distance > closest) continue;
      if (distance < closest) shares.length = 0;
      closest = distance;
      shares.push(seat);
    }
    if (!closest) continue;
    for (const seat of shares) territory[seat] += 1 / shares.length;
    const owner = shares.length === 1 ? shares[0] : shares[rng.intInclusive(0, shares.length - 1)];
    regions[owner].push({ cell, shares, near, wide });
  }
  for (const region of regions) {
    shuffle(region, rng);
    region.sort(
      (left, right) => right.near.length - left.near.length || right.wide.length - left.wide.length,
    );
  }

  const quota = (graph.cells.length - spawns.length - target) / spawns.length;
  for (let count = 0; count < target; count += 1) {
    let bestOwner = -1;
    let bestValue = -Infinity;
    for (let owner = 0; owner < regions.length; owner += 1) {
      const candidate = regions[owner].at(-1);
      if (!candidate) continue;
      let value = mean(candidate.shares.map((seat) => territory[seat] - quota)) / Math.max(1, quota);
      for (const seat of candidate.near)
        value -= 20 + local[seat].swampNear + 10 / Math.max(1, local[seat].near);
      for (const seat of candidate.wide)
        value -= 8 + local[seat].swampWide + 6 / Math.max(1, local[seat].wide);
      if (value > bestValue) {
        bestValue = value;
        bestOwner = owner;
      }
    }
    const picked = regions[bestOwner].pop()!;
    graph.tiles[picked.cell] = 2;
    for (const seat of picked.shares) territory[seat] -= 1 / picked.shares.length;
    for (const seat of picked.near) {
      local[seat].near -= 1;
      local[seat].swampNear += 1;
    }
    for (const seat of picked.wide) {
      local[seat].wide -= 1;
      local[seat].swampWide += 1;
    }
  }
};

export { MazeGraph, compareLayoutScores, optimizeMazeLayout, placeMazeSwamps, scoreMazeLayout };
