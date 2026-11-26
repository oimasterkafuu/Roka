import {
  GeneralPos,
  MAX_MOUNTAIN_RATIO,
  SeededRandom,
  Tile,
  build2D,
  computeBaseMapDimensions,
} from './map-core';
import { MazeGraph } from './maze-layout';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';

type TwinContinentsOrientation = 'horizontal' | 'vertical';

interface TwinContinentsBridge {
  index: number;
  kind: 'plain' | 'swamp';
  width: number;
  cells: GeneralPos[];
  headlands: GeneralPos[];
}

interface TwinContinentsLayout {
  orientation: TwinContinentsOrientation;
  wallStart: number;
  wallEnd: number;
  bridges: TwinContinentsBridge[];
  spawnPoints: GeneralPos[];
}

interface TwinContinentsMapGenerationConfig extends MapGenerationConfig {
  requiredPlayers: number;
}

interface TwinContinentsGeneratedMap extends GeneratedMap {
  layout: TwinContinentsLayout;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const nearestOdd = (value: number): number => 2 * Math.round((value - 1) / 2) + 1;

const evenSeats = (
  length: number,
  bank: number,
  cross: number,
  players: number,
  openings: number[],
): number[] => {
  const pairs = players / 2;
  const rows = Math.max(1, Math.round(Math.sqrt((pairs * bank) / length)));
  const bridgeBudget = Math.floor(2 * Math.sqrt((2 * length * bank) / players));
  const seats: number[] = [];
  let used = 0;
  for (let row = 0; row < rows; row += 1) {
    const end = Math.round(((row + 1) * pairs) / rows);
    const count = end - used;
    const depth = clamp(Math.floor((bank * (used + count / 2)) / pairs), 1, bank - 2);
    for (let column = 0; column < count; column += 1) {
      const along = Math.floor((length * (column + 0.5)) / count);
      const detour = Math.min(...openings.map((opening) => Math.abs(along - opening)));
      const across = Math.max(depth, bank + detour - bridgeBudget);
      seats.push(along * cross + across, along * cross + cross - 1 - across);
    }
    used = end;
  }
  return seats;
};

const variation = (values: number[]): number => {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return mean
    ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length) / mean
    : 0;
};

const scoreSeats = (graph: MazeGraph, seats: number[], bridgeEntries: number[], spacing: number): number => {
  if (new Set(seats).size !== seats.length) return Infinity;
  const fields = seats.map((start) => graph.field(start));
  const nearest = fields.map((field, seat) =>
    Math.min(...seats.map((start, other) => (seat === other ? Infinity : field.distances[start]))),
  );
  const local = fields.map(({ distances, opening }) => {
    let near = 0;
    let wide = 0;
    let swamp = 0;
    for (const target of opening) {
      if (graph.tiles[target] === 2) swamp++;
      else if (!seats.includes(target)) {
        wide++;
        if (distances[target] <= 6) near++;
      }
    }
    return { near, wide, swamp };
  });
  const territory = graph.territory(seats).plains;
  const weakestShare =
    (seats.length * Math.min(...territory)) / territory.reduce((sum, area) => sum + area, 0);
  const deviations = [
    variation(nearest),
    variation(territory),
    variation(local.map((row) => row.near)),
    variation(local.map((row) => row.wide)),
  ];
  const swampCounts = local.map((row) => row.swamp);
  const furthestBridgeAccess = Math.max(
    ...fields.map((field) => Math.min(...bridgeEntries.map((entry) => field.distances[entry]))),
  );
  const peak = Math.max(...deviations);
  return (
    4 * peak +
    12 * Math.max(0, peak - 0.2) +
    deviations.reduce((total, value) => total + value, 0) +
    4 * Math.max(0, Math.max(...nearest) / Math.min(...nearest) - 1.45) +
    6 * Math.max(0, 0.7 - weakestShare) +
    4 * Math.max(0, 0.65 - Math.min(...nearest) / spacing) +
    Math.max(0, furthestBridgeAccess / spacing - 1.25) +
    0.01 * (Math.max(...swampCounts) - Math.min(...swampCounts))
  );
};

const oddSeats = (
  tiles: Uint8Array,
  length: number,
  cross: number,
  bank: number,
  leftEnd: number,
  middleStart: number,
  players: number,
  rng: SeededRandom,
): number[] => {
  const graph = new MazeGraph(tiles, cross);
  const spacing = Math.sqrt(graph.cells.length / players);
  const bridgeEntries = graph.cells.filter(
    (start) => start % cross === bank || start % cross === cross - 1 - bank,
  );
  const cell = (along: number, depth: number, opposite = false): number =>
    along * cross + (opposite ? cross - 1 - bank + depth : bank - depth);

  // Moving out along either diagonal trades one step along the coast for one step inland.
  // The left bridge therefore ties hinge/left, and the other two tie hinge/right.
  const layout = (params: number[]): number[] => {
    const [hinge, depth, left, right] = params;
    const seats = [
      cell(hinge, depth),
      cell(hinge - left, depth + left, true),
      cell(hinge + right, depth + right),
    ];
    for (let index = 4; index < params.length; index += 2) {
      seats.push(cell(params[index], params[index + 1]), cell(params[index], params[index + 1], true));
    }
    return seats;
  };
  const constrain = (params: number[]): void => {
    params[0] = clamp(params[0], leftEnd + 1, middleStart - 1);
    params[1] = clamp(params[1], 2, bank - 1);
    params[2] = clamp(params[2], 1, Math.min(params[0] - leftEnd, bank - params[1]));
    params[3] = clamp(params[3], 1, Math.min(middleStart - params[0], bank - params[1]));
    for (let index = 4; index < params.length; index += 2) {
      params[index] = clamp(params[index], 1, length - 2);
      params[index + 1] = clamp(params[index + 1], 2, bank - 1);
    }
  };
  let best: number[] = [];
  let bestScore = Infinity;
  for (let restart = 0; restart < 4; restart++) {
    const hinge = Math.round((leftEnd + middleStart) / 2);
    let params = [hinge, Math.max(2, Math.round(bank * 0.25)), hinge - leftEnd, middleStart - hinge];
    constrain(params);
    while (layout(params).length < players) {
      const occupied = layout(params);
      let bestPair: number[] = [];
      let room = -1;
      for (let trial = 0; trial < 48; trial++) {
        const along = rng.intInclusive(1, length - 2);
        const depth = rng.intInclusive(2, bank - 1);
        const pair = [cell(along, depth), cell(along, depth, true)];
        const clearance = Math.min(
          ...occupied.flatMap((start) => pair.map((target) => graph.field(start).distances[target])),
          depth * 2,
          2 * (bank - depth + 1),
          2 * Math.min(along + 1, length - along),
        );
        if (clearance > room) {
          room = clearance;
          bestPair = [along, depth];
        }
      }
      params.push(...bestPair);
    }
    let current = scoreSeats(graph, layout(params), bridgeEntries, spacing);
    for (const scale of [0.45, 0.2, 0.08]) {
      const stride = Math.max(1, Math.round(spacing * scale));
      for (let pass = 0; pass < 2; pass++) {
        for (let index = 0; index < params.length; index++) {
          const origin = params;
          for (const delta of [-stride, stride]) {
            const candidate = [...origin];
            candidate[index] += delta;
            constrain(candidate);
            if (candidate.every((value, offset) => value === params[offset])) continue;
            const cost = scoreSeats(graph, layout(candidate), bridgeEntries, spacing);
            if (cost < current) {
              current = cost;
              params = candidate;
            }
          }
        }
      }
    }
    if (current < bestScore) {
      bestScore = current;
      best = layout(params);
    }
    if (bestScore < 0.65 || players === 3) break;
  }
  return best;
};

const generateTwinContinentsMap = (
  rng: SeededRandom,
  config: TwinContinentsMapGenerationConfig,
): TwinContinentsGeneratedMap => {
  const base = computeBaseMapDimensions(rng, config.heightRatio, config.widthRatio);
  const orientation: TwinContinentsOrientation = rng.intInclusive(0, 1) === 0 ? 'horizontal' : 'vertical';
  const players = config.requiredPlayers;
  let length = orientation === 'horizontal' ? base.n : base.m;
  let cross = orientation === 'horizontal' ? base.m : base.n;
  if (players % 2 && players >= 3) {
    const area = length * cross;
    const aspect = players === 3 ? 2.7 : players === 5 ? 1.85 : 1.55;
    length = Math.max(25, nearestOdd(Math.sqrt(area * aspect)));
    cross = Math.max(13, nearestOdd(area / length));
  }
  const n = orientation === 'horizontal' ? length : cross;
  const m = orientation === 'horizontal' ? cross : length;
  const diagonalOpening = players === 3 || players === 5;
  const wallLimit = Math.min(
    5,
    Math.max(1, Math.floor(cross * (diagonalOpening ? 0.1 : MAX_MOUNTAIN_RATIO))),
  );
  const thickness = 1 + 2 * rng.intInclusive(0, Math.floor((wallLimit - 1) / 2));
  const wallStart = (cross - thickness) / 2;
  const wallEnd = cross - 1 - wallStart;
  const flipAlong = rng.next() < 0.5;
  const flipBanks = rng.next() < 0.5;
  const point = (along: number, across: number): GeneralPos => {
    const longCoord = flipAlong ? length - 1 - along : along;
    const crossCoord = flipBanks ? cross - 1 - across : across;
    return orientation === 'horizontal' ? [longCoord, crossCoord] : [crossCoord, longCoord];
  };
  const tiles = new Uint8Array(length * cross);
  for (let along = 0; along < length; along++)
    tiles.fill(1, along * cross + wallStart, along * cross + wallEnd + 1);
  const starts: number[] = [];
  const bridges = [0.18, 0.5, 0.82].map((fraction, index): TwinContinentsBridge => {
    const width = length >= 27 && rng.next() > 0.35 ? 3 : 2;
    const start = Math.round((length - 1) * fraction - (width - 1) / 2);
    starts.push(start);
    const cells: GeneralPos[] = [];
    const headlands: GeneralPos[] = [];
    for (let along = start; along < start + width; along++) {
      for (let across = wallStart; across <= wallEnd; across++) {
        tiles[along * cross + across] = index === 1 ? 2 : 0;
        cells.push(point(along, across));
      }
      headlands.push(point(along, wallStart - 1), point(along, wallEnd + 1));
    }
    return { index, kind: index === 1 ? 'swamp' : 'plain', width, cells, headlands };
  });
  const seats =
    players === 1
      ? [Math.floor(length / 2) * cross + Math.floor(wallStart / 2)]
      : players % 2
        ? oddSeats(tiles, length, cross, wallStart, starts[0] + bridges[0].width - 1, starts[1], players, rng)
        : evenSeats(
            length,
            wallStart,
            cross,
            players,
            starts.flatMap((start, index) =>
              Array.from({ length: bridges[index].width }, (_, offset) => start + offset),
            ),
          );
  const spawnPoints = seats.map((start) => point(Math.floor(start / cross), start % cross));
  const gridType = build2D<Tile>(n, m, 0);
  tiles.forEach((tile, index) => {
    const [x, y] = point(Math.floor(index / cross), index % cross);
    gridType[x][y] = tile as Tile;
  });
  for (const [x, y] of spawnPoints) gridType[x][y] = -2;
  if (flipAlong)
    bridges.reverse().forEach((bridge, index) => {
      bridge.index = index;
    });
  return {
    n,
    m,
    gridType,
    st: gridType.map((row) => row.map((tile) => tile !== 1)),
    owner: build2D(n, m, 0),
    armyCnt: build2D(n, m, 0),
    layout: { orientation, wallStart, wallEnd, bridges, spawnPoints },
  };
};

export { generateTwinContinentsMap };
export type {
  TwinContinentsBridge,
  TwinContinentsGeneratedMap,
  TwinContinentsLayout,
  TwinContinentsMapGenerationConfig,
  TwinContinentsOrientation,
};
