import { GeneralPos, SeededRandom, Tile, build2D, computeBaseMapDimensions, shuffle } from './map-core';
import { CROWN_AREA_PER_SEAT, crownMinimum, openCrownLine } from './crown-spacing';
import { resolveMapSizeRatioByPlayers } from './map-size';
import { MazeGraph, localCounts, variation } from './maze-layout';
import { crossingStart, paintCrossing } from './map-geometry';
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

interface Band {
  start: number;
  end: number;
}

interface Candidate {
  cell: number;
  along: number;
  depth: number;
  approach: number[];
}

const nearestOdd = (value: number): number => 2 * Math.round((value - 1) / 2) + 1;

const fairLayout = (graph: MazeGraph, seats: number[], minimum: number, cross: number): boolean => {
  const fields = seats.map((seat) => graph.field(seat));
  const nearest = fields.map(({ distances }, index) =>
    Math.min(...seats.map((seat, other) => (index === other ? Infinity : distances[seat]))),
  );
  if (
    Math.min(...nearest) < minimum ||
    Math.max(...nearest) > 1.8 * Math.min(...nearest) ||
    variation(nearest) > 0.25 ||
    (seats.length === 3 && Math.max(...nearest) - Math.min(...nearest) > 3) ||
    seats.some((seat, index) =>
      seats.slice(0, index).some((other) => openCrownLine(graph.tiles, cross, seat, other)),
    )
  )
    return false;
  const counts = localCounts(graph, seats, fields);
  for (const [plain, swamp] of [
    ['near', 'swampNear'],
    ['wide', 'swampWide'],
  ] as const) {
    const values = counts.map((count) => count[plain]);
    const weakest = Math.min(...values);
    if (
      weakest < 12 ||
      variation(values) > 0.25 ||
      weakest < (0.65 * values.reduce((sum, value) => sum + value, 0)) / seats.length ||
      Math.max(...counts.map((count) => count[swamp])) > weakest / 3
    )
      return false;
  }
  const territory = graph.territory(seats).plains;
  return (
    variation(territory) <= 0.25 &&
    Math.min(...territory) >= (0.55 * territory.reduce((sum, value) => sum + value, 0)) / seats.length
  );
};

const chooseSeats = (
  rng: SeededRandom,
  graph: MazeGraph,
  length: number,
  cross: number,
  bank: number,
  bands: Band[],
  players: number,
): number[] | undefined => {
  if (!players) return [];
  const minimum = crownMinimum(graph.cells.length, players);
  const access = Math.ceil(2 * Math.sqrt(graph.cells.length / players));
  const sizes = [Math.ceil(players / 2), Math.floor(players / 2)];
  const slots = sizes.flatMap((size, side) =>
    Array.from({ length: size }, (_, index) => ({
      side,
      start: Math.floor((index * length) / size),
      end: Math.floor(((index + 1) * length) / size),
      leads: bands.map(
        ({ start, end }) =>
          Math.min(size - 1, Math.floor((((start + end) / 2 + 0.5) * size) / length)) === index,
      ),
    })),
  );
  if (players === 3) {
    // The lone crown contests the first two bridges. The crowded bank shares the far bridge
    // so its crowns can claim some of the opposite bank's opening territory.
    slots[0].leads = [true, true, true];
    slots[1].leads = [false, false, true];
    slots[2].leads = [true, true, false];
  }
  const pools = slots.map(({ side, start, end }) => {
    const interior: Candidate[] = [];
    const fringe: Candidate[] = [];
    for (let along = start; along < end; along++) {
      for (let depth = 1; depth <= bank; depth++) {
        const approach = bands.map(({ start, end }) => depth + Math.max(0, start - along, along - end));
        const closest = Math.min(...approach);
        if (closest < 2 || closest > access) continue;
        const across = side ? cross - 1 - bank + depth : bank - depth;
        const margin = Math.min(along - start + 0.5, end - along - 0.5);
        const pool =
          players >= 4 && (margin < 0.16 * (end - start) || depth < 0.13 * bank || depth > 0.91 * bank)
            ? fringe
            : interior;
        pool.push({ along, depth, approach, cell: along * cross + across });
      }
    }
    shuffle(interior, rng);
    shuffle(fringe, rng);
    return interior.concat(fringe);
  });
  if (players === 1) return [pools[0][0].cell];
  if (players === 2) {
    const signatures = new Map<string, Candidate[]>();
    for (const peer of pools[1]) {
      const key = peer.approach.join(',');
      const peers = signatures.get(key);
      if (peers) peers.push(peer);
      else signatures.set(key, [peer]);
    }
    for (const first of pools[0]) {
      if (2 * Math.min(...first.approach) + cross - 2 * bank - 1 < minimum) continue;
      for (const peer of signatures.get(first.approach.join(',')) ?? []) {
        if (first.along !== peer.along && fairLayout(graph, [first.cell, peer.cell], minimum, cross))
          return [first.cell, peer.cell];
      }
    }
    return;
  }
  const compatible = (
    first: Candidate,
    firstSlot: number,
    second: Candidate,
    secondSlot: number,
  ): boolean => {
    if (openCrownLine(graph.tiles, cross, first.cell, second.cell)) return false;
    const alongSteps = Math.abs(first.along - second.along);
    if (slots[firstSlot].side === slots[secondSlot].side) {
      if (alongSteps + Math.abs(first.depth - second.depth) < minimum) return false;
    } else {
      // Crossing outside the interval between the crowns adds an out-and-back coastal detour.
      const direct = alongSteps + first.depth + second.depth + cross - 2 * bank - 1;
      if (
        direct < minimum &&
        bands.some(
          ({ start, end }) =>
            direct +
              2 *
                Math.max(
                  0,
                  start - Math.max(first.along, second.along),
                  Math.min(first.along, second.along) - end,
                ) <
            minimum,
        )
      )
        return false;
    }
    return bands.every(
      (_, index) =>
        (!slots[firstSlot].leads[index] || first.approach[index] <= second.approach[index]) &&
        (!slots[secondSlot].leads[index] || second.approach[index] <= first.approach[index]),
    );
  };
  const chosen: number[] = [];
  let budget = players === 3 ? 180 : 70;
  const search = (remaining: number[], options: Candidate[][]): number[] | undefined => {
    if (!remaining.length) return fairLayout(graph, chosen, minimum, cross) ? [...chosen] : undefined;
    const slot = remaining.reduce((best, other) =>
      options[other].length < options[best].length ? other : best,
    );
    const next = remaining.filter((other) => other !== slot);
    const trials = next.length < 2 && players >= 4 ? 3 : 15;
    for (const candidate of options[slot].slice(0, trials)) {
      if (--budget < 0) break;
      const filtered = [...options];
      if (
        next.some((other) => {
          filtered[other] = options[other].filter((peer) => compatible(candidate, slot, peer, other));
          return !filtered[other].length;
        })
      )
        continue;
      chosen[slot] = candidate.cell;
      const result = search(next, filtered);
      if (result) return result;
    }
  };
  return search(
    slots.map((_, index) => index),
    pools,
  );
};

const findTwinLayout = (
  rng: SeededRandom,
  heightRatio: number,
  widthRatio: number,
  players: number,
): TwinContinentsGeneratedMap | undefined => {
  const base = computeBaseMapDimensions(rng, heightRatio, widthRatio);
  const orientation: TwinContinentsOrientation = rng.next() < 0.5 ? 'horizontal' : 'vertical';
  for (let attempt = 0; attempt < 160; attempt++) {
    const area = Math.max(
      base.n * base.m,
      players * CROWN_AREA_PER_SEAT * (1 + Math.floor(attempt / 40) / 4),
    );
    const aspect = players === 3 ? 3.8 + 1.2 * rng.next() : Math.max(2, players) * (0.42 + 0.19 * rng.next());
    const length = Math.max(15, nearestOdd(Math.sqrt(area * aspect)));
    const cross = Math.max(2 * Math.ceil(players / 2) + 7, nearestOdd(area / length));
    const wallLimit = Math.max(1, Math.min(5, Math.floor(cross * 0.22)));
    const thickness = players === 3 ? 1 : 1 + 2 * rng.intInclusive(0, Math.floor((wallLimit - 1) / 2));
    const wallStart = (cross - thickness) / 2;
    const wallEnd = cross - 1 - wallStart;
    const n = orientation === 'horizontal' ? length : cross;
    const m = orientation === 'horizontal' ? cross : length;
    const tiles = new Uint8Array(length * cross);
    for (let along = 0; along < length; along++)
      tiles.fill(1, along * cross + wallStart, along * cross + wallEnd + 1);
    const fractions =
      players === 2 ? [0.25, 0.5, 0.75] : players === 3 ? [0.08, 0.29, 0.67] : [0.16, 0.5, 0.84];
    const bands = fractions.map((fraction, index) => {
      const width = length >= 27 && rng.next() < 0.65 ? 3 : 2;
      const start = crossingStart(length, fraction + (rng.next() - 0.5) * 0.09, width);
      paintCrossing(tiles, cross, start, width, wallStart, wallEnd, index === 1 ? 2 : 0);
      return { start, end: start + width - 1 };
    });
    if (
      bands.some(
        ({ start }, index) => index && start - bands[index - 1].end < Math.max(2, Math.floor(length * 0.16)),
      )
    )
      continue;
    const graph = new MazeGraph(tiles, cross);
    const seats = chooseSeats(rng, graph, length, cross, wallStart, bands, players);
    if (!seats) continue;
    const flipAlong = rng.next() < 0.5;
    const flipBanks = rng.next() < 0.5;
    const point = (along: number, across: number): GeneralPos => {
      const longCoord = flipAlong ? length - 1 - along : along;
      const crossCoord = flipBanks ? cross - 1 - across : across;
      return orientation === 'horizontal' ? [longCoord, crossCoord] : [crossCoord, longCoord];
    };
    const bridges = bands.map(({ start, end }, index): TwinContinentsBridge => {
      const cells: GeneralPos[] = [];
      const headlands: GeneralPos[] = [];
      for (let along = start; along <= end; along++) {
        for (let across = wallStart; across <= wallEnd; across++) cells.push(point(along, across));
        headlands.push(point(along, wallStart - 1), point(along, wallEnd + 1));
      }
      return {
        index: flipAlong ? 2 - index : index,
        kind: index === 1 ? 'swamp' : 'plain',
        width: end - start + 1,
        cells,
        headlands,
      };
    });
    if (flipAlong) bridges.reverse();
    const spawnPoints = seats.map((cell) => point(Math.floor(cell / cross), cell % cross));
    const gridType = build2D<Tile>(n, m, 0);
    tiles.forEach((tile, cell) => {
      const [row, col] = point(Math.floor(cell / cross), cell % cross);
      gridType[row][col] = tile as Tile;
    });
    for (const [row, col] of spawnPoints) gridType[row][col] = -2;
    return {
      n,
      m,
      gridType,
      st: gridType.map((row) => row.map((tile) => tile !== 1)),
      owner: build2D(n, m, 0),
      armyCnt: build2D(n, m, 0),
      layout: { orientation, wallStart, wallEnd, bridges, spawnPoints },
    };
  }
};

export function repackTwinCrowns(players: number): TwinContinentsGeneratedMap {
  const ratio = 2 * resolveMapSizeRatioByPlayers(players);
  const map = findTwinLayout(new SeededRandom('repack-twin-crowns'), ratio, ratio, players);
  if (!map) throw new Error(`Unverified twin crown packing: ${players}`);
  return map;
}

const generateTwinContinentsMap = (rng: SeededRandom, config: TwinContinentsMapGenerationConfig) =>
  findTwinLayout(rng, config.heightRatio, config.widthRatio, config.requiredPlayers) ??
  repackTwinCrowns(config.requiredPlayers);

export { generateTwinContinentsMap };
export type {
  TwinContinentsBridge,
  TwinContinentsGeneratedMap,
  TwinContinentsLayout,
  TwinContinentsMapGenerationConfig,
  TwinContinentsOrientation,
};
