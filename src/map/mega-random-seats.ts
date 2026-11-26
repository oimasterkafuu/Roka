import { SeededRandom } from './map-core';
import type { SeatPartition } from './map-geometry';
import { MazeGraph, localCounts, variation } from './maze-layout';

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function penalty(graph: MazeGraph, seats: number[], teams: number[], crossings: number[][][]) {
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
  const eligible = graph.cells.filter((cell) => {
    if (tiles[cell] !== 0) return false;
    const exits =
      Number(cell >= width && tiles[cell - width] === 0) +
      Number(cell + width < tiles.length && tiles[cell + width] === 0) +
      Number(cell % width > 0 && tiles[cell - 1] === 0) +
      Number(cell % width < width - 1 && tiles[cell + 1] === 0);
    return exits >= 2;
  });
  const pools: number[][] = partition.centers.map(() => []);
  for (const cell of eligible)
    pools[partition.slotAt((Math.floor(cell / width) + 0.5) / height, ((cell % width) + 0.5) / width)].push(
      cell,
    );
  for (const [slot, cells] of pools.entries()) {
    const [row, col] = partition.centers[slot];
    const distance = (cell: number) =>
      ((Math.floor(cell / width) + 0.5) / height - row) ** 2 + (((cell % width) + 0.5) / width - col) ** 2;
    cells.sort((first, second) => distance(first) - distance(second));
  }
  if (pools.some((pool) => !pool.length)) return;
  const seats = pools.map((pool) => pool[0]);
  const distances = graph.field(seats[0]).distances;
  if (graph.cells.some((cell) => distances[cell] < 0)) return;
  let cost = penalty(graph, seats, teams, crossings);
  for (let pass = 0; cost > 0 && pass < 5; pass++) {
    for (const [slot, pool] of pools.entries()) {
      for (let trial = 0; trial < 5; trial++) {
        const candidate =
          pool[rng.intInclusive(0, Math.min(pool.length - 1, Math.ceil((pool.length * (pass + 1)) / 6)))];
        if (seats[slot] === candidate) continue;
        const original = seats[slot];
        seats[slot] = candidate;
        const score = penalty(graph, seats, teams, crossings);
        if (score >= cost) seats[slot] = original;
        else cost = score;
        if (!cost) return seats;
      }
    }
  }
  return cost ? undefined : seats;
}
