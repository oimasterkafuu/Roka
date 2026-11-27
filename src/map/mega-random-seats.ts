import { crownMinimum, openCrownLine } from './crown-spacing';
import { SeededRandom, shuffle } from './map-core';
import type { SeatPartition } from './map-geometry';
import { MazeGraph, variation } from './maze-layout';

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

interface Opening {
  near: number;
  wide: number;
  swampNear: number;
  swampWide: number;
}

function exclusionFields(tiles: Uint8Array, width: number, minimum: number) {
  const edges = new Uint8Array(tiles.length);
  const offsets = [-width, width, -1, 1];
  for (let cell = 0; cell < tiles.length; cell++) {
    if (cell >= width && tiles[cell - width] !== 1) edges[cell] |= 1;
    if (cell + width < tiles.length && tiles[cell + width] !== 1) edges[cell] |= 2;
    if (cell % width && tiles[cell - 1] !== 1) edges[cell] |= 4;
    if (cell % width < width - 1 && tiles[cell + 1] !== 1) edges[cell] |= 8;
  }
  const queue = new Int32Array(tiles.length);
  const cache = new Map<number, Int32Array>();
  return (start: number) => {
    const cached = cache.get(start);
    if (cached) return cached;
    // On this connected board, unseen cells are at least the cutoff away.
    const distances = new Int32Array(tiles.length).fill(minimum);
    distances[start] = 0;
    queue[0] = start;
    let tail = 1;
    for (let head = 0; head < tail; head++) {
      const cell = queue[head],
        nextDistance = distances[cell] + 1;
      if (nextDistance >= minimum) break;
      for (let mask = edges[cell]; mask; mask &= mask - 1) {
        const next = cell + offsets[31 - Math.clz32(mask & -mask)];
        if (distances[next] !== minimum) continue;
        distances[next] = nextDistance;
        queue[tail++] = next;
      }
    }
    cache.set(start, distances);
    return distances;
  };
}

function penalty(
  graph: MazeGraph,
  seats: number[],
  teams: number[],
  crossings: number[][][],
  exits: Uint8Array,
  profiles: Map<number, Opening>,
) {
  const fields = seats.map((cell) => graph.field(cell));
  const opening = fields.map(({ distances, opening }, slot) => {
    const start = seats[slot];
    let profile = profiles.get(start);
    if (!profile) {
      profile = { near: 0, wide: 0, swampNear: 0, swampWide: 0 };
      for (const cell of opening) {
        const plain = graph.tiles[cell] === 0;
        profile[plain ? 'wide' : 'swampWide']++;
        if (distances[cell] <= 6) profile[plain ? 'near' : 'swampNear']++;
      }
      profiles.set(start, profile);
    }
    let { near, wide } = profile;
    for (const cell of seats) {
      if (cell === start || distances[cell] > 10) continue;
      wide--;
      if (distances[cell] <= 6) near--;
    }
    return { ...profile, near, wide };
  });
  const spacing = Math.sqrt(graph.cells.length / seats.length);
  const excess: number[] = [];
  for (const [plain, swamp] of [
    ['near', 'swampNear'],
    ['wide', 'swampWide'],
  ] as const) {
    const counts = opening.map((row) => row[plain]);
    const minimum = Math.min(...counts);
    excess.push(
      variation(counts) - 0.245,
      0.66 - minimum / average(counts),
      (12 - minimum) / 12,
      Math.max(...opening.map((row) => row[swamp])) / Math.max(1, minimum) - 1 / 3,
    );
  }
  if (seats.length > 1) {
    for (const [seat, { distances }] of fields.entries()) {
      const openExits = seats.reduce(
        (count, cell) => count - Number(distances[cell] === 1),
        exits[seats[seat]],
      );
      excess.push((2 - openExits) / 2);
    }
    for (const channels of crossings) {
      const approaches = channels.map((channel) =>
        fields.map(({ distances }) => Math.min(...channel.map((cell) => distances[cell]))),
      );
      for (let seat = 0; seat < seats.length; seat++) {
        const lead = Math.min(
          ...approaches.map((steps) => Math.min(...steps.filter((_, other) => other !== seat)) - steps[seat]),
        );
        excess.push(lead / spacing);
      }
    }
    const enemies = fields.map(({ distances }, seat) =>
      Math.min(...seats.map((cell, index) => (teams[index] === teams[seat] ? Infinity : distances[cell]))),
    );
    if (Number.isFinite(enemies[0])) {
      const minimum = Math.min(...enemies);
      excess.push(variation(enemies) - 0.245, Math.max(...enemies) / minimum - 1.78);
    }
  }
  const local = excess.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (local) return 1 + local;
  const territory = graph.territory(seats).plains;
  return (
    Math.max(0, variation(territory) - 0.245) +
    Math.max(0, 0.56 - Math.min(...territory) / average(territory))
  );
}

export function chooseMegaSeats(
  tiles: Uint8Array,
  width: number,
  partition: SeatPartition,
  teams: number[],
  crossings: number[][][],
  rng: SeededRandom,
  guide: [number, number][],
): number[] | undefined {
  const height = tiles.length / width,
    graph = new MazeGraph(tiles, width);
  if (!teams.length) return [];
  if (!graph.cells.length) return;
  const { distances } = graph.field(graph.cells[0]);
  if (graph.cells.some((cell) => distances[cell] < 0)) return;
  const exits = new Uint8Array(tiles.length);
  const pools: number[][] = partition.centers.map(() => []);
  for (const cell of graph.cells) {
    if (tiles[cell] !== 0) continue;
    exits[cell] =
      Number(cell >= width && tiles[cell - width] === 0) +
      Number(cell + width < tiles.length && tiles[cell + width] === 0) +
      Number(cell % width > 0 && tiles[cell - 1] === 0) +
      Number(cell % width < width - 1 && tiles[cell + 1] === 0);
    if (exits[cell] < 2) continue;
    const slot = partition.slotAt((Math.floor(cell / width) + 0.5) / height, ((cell % width) + 0.5) / width);
    pools[slot].push(cell);
  }
  if (pools.some((pool) => !pool.length)) return;
  const enemyMinimum = crownMinimum(graph.cells.length, teams.length);
  const allyMinimum = Math.floor(Math.sqrt(graph.cells.length / teams.length) * 0.5);
  const compatible = (slot: number, cell: number, other: number, candidate: number, distance: number) =>
    teams[slot] === teams[other]
      ? distance >= allyMinimum
      : distance >= enemyMinimum && !openCrownLine(tiles, width, cell, candidate);
  const slots = pools.map((_, slot) => slot);
  const seats = pools.map(() => -1);
  const profiles = new Map<number, Opening>();
  const exclusion = exclusionFields(tiles, width, enemyMinimum);
  for (let restart = 0; restart < 3; restart++) {
    shuffle(slots, rng);
    for (const pool of pools) shuffle(pool, rng);
    let budget = 100;
    const place = (domains: number[][], remaining: number[]): boolean => {
      if (!remaining.length) return true;
      const slot = remaining.reduce((best, next) =>
        domains[next].length < domains[best].length ? next : best,
      );
      const rest = remaining.filter((other) => other !== slot);
      for (const cell of domains[slot]) {
        if (--budget < 0) return false;
        const distances = exclusion(cell);
        const next = domains.slice();
        if (
          !rest.every((other) => {
            next[other] = domains[other].filter((candidate) =>
              compatible(slot, cell, other, candidate, distances[candidate]),
            );
            return next[other].length > 0;
          })
        )
          continue;
        seats[slot] = cell;
        if (place(next, rest)) return true;
      }
      return false;
    };
    const domains = pools.map((pool, slot) => {
      let sample = pool.slice(0, 64);
      if (teams.length >= 5 && restart !== 1) {
        const [row, col] = guide[slot];
        const jitter = Math.sqrt(graph.cells.length / teams.length) * (restart ? 0.5 : 0.2);
        const targetRow = row * height + (rng.next() - 0.5) * jitter;
        const targetCol = col * width + (rng.next() - 0.5) * jitter;
        const offset = (cell: number) =>
          (Math.floor(cell / width) + 0.5 - targetRow) ** 2 + ((cell % width) + 0.5 - targetCol) ** 2;
        const closest = pool
          .slice()
          .sort((first, second) => offset(first) - offset(second))
          .slice(0, 12);
        sample.sort((first, second) => offset(first) - offset(second));
        sample = [...new Set([...closest, ...sample])];
      }
      return sample;
    });
    if (!place(domains, slots)) continue;
    let cost = penalty(graph, seats, teams, crossings, exits, profiles);
    if (!cost) return seats;
    for (let pass = 0; pass < 6; pass++) {
      shuffle(slots, rng);
      for (const slot of slots) {
        shuffle(pools[slot], rng);
        let trials = 0;
        for (const candidate of pools[slot]) {
          if (
            seats[slot] === candidate ||
            !seats.every(
              (cell, other) =>
                slot === other ||
                compatible(other, cell, slot, candidate, graph.field(cell).distances[candidate]),
            )
          )
            continue;
          const original = seats[slot];
          seats[slot] = candidate;
          const score = penalty(graph, seats, teams, crossings, exits, profiles);
          if (score >= cost) seats[slot] = original;
          else cost = score;
          if (!cost) return seats;
          if (++trials === 6) break;
        }
      }
    }
  }
}
