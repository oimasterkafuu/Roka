import { SeededRandom, shuffle } from './map-core';
import type { SeatPartition } from './map-geometry';
import { MazeGraph, localCounts, variation } from './maze-layout';

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function penalty(
  graph: MazeGraph,
  seats: number[],
  teams: number[],
  crossings: number[][][],
  exits: Uint8Array,
) {
  const fields = seats.map((cell) => graph.field(cell));
  const opening = localCounts(graph, seats, fields);
  const territory = graph.territory(seats).plains;
  const spacing = Math.sqrt(graph.cells.length / seats.length);
  const excess = [variation(territory) - 0.245, 0.56 - Math.min(...territory) / average(territory)];
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
    const nearest = fields.map(({ distances }, seat) =>
      Math.min(...seats.map((cell, index) => (index === seat ? Infinity : distances[cell]))),
    );
    const enemies = fields.map(({ distances }, seat) =>
      Math.min(...seats.map((cell, index) => (teams[index] === teams[seat] ? Infinity : distances[cell]))),
    );
    excess.push((Math.floor(spacing * 0.5) - Math.min(...nearest)) / spacing);
    if (Number.isFinite(enemies[0])) {
      const minimum = Math.min(...enemies);
      excess.push(
        variation(enemies) - 0.245,
        Math.max(...enemies) / minimum - 1.78,
        (Math.floor(spacing * 0.5) - minimum) / spacing,
      );
    }
  }
  return excess.reduce((sum, value) => sum + Math.max(0, value), 0);
}

export function chooseMegaSeats(
  tiles: Uint8Array,
  width: number,
  partition: SeatPartition,
  teams: number[],
  crossings: number[][][],
  rng: SeededRandom,
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
  const sample = (pool: number[]) => pool[rng.intInclusive(0, pool.length - 1)];
  const slots = pools.map((_, slot) => slot);
  for (let restart = 0; restart < 3; restart++) {
    const seats = pools.map(sample);
    let cost = penalty(graph, seats, teams, crossings, exits);
    if (!cost) return seats;
    for (let pass = 0; pass < 6; pass++) {
      shuffle(slots, rng);
      for (const slot of slots) {
        for (let trial = 0; trial < 5; trial++) {
          const candidate = sample(pools[slot]);
          if (seats[slot] === candidate) continue;
          const original = seats[slot];
          seats[slot] = candidate;
          const score = penalty(graph, seats, teams, crossings, exits);
          if (score >= cost) seats[slot] = original;
          else cost = score;
          if (!cost) return seats;
        }
      }
    }
  }
}
