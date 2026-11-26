import { MAX_SWAMP_RATIO, SeededRandom, build2D, computeBaseMapDimensions, shuffle } from './map-core';
import type { GeneralPos, Tile } from './map-core';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';
import {
  MazeGraph,
  compareLayoutScores,
  optimizeMazeLayout,
  placeMazeSwamps,
  scoreMazeLayout,
} from './maze-layout';

const TERRAIN_CANDIDATES = 6;

const carveMaze = (rng: SeededRandom, rows: number, cols: number, players: number): Uint8Array => {
  const tiles = new Uint8Array(rows * cols).fill(1);
  const start =
    (1 + 2 * rng.intInclusive(0, (rows - 3) / 2)) * cols + 1 + 2 * rng.intInclusive(0, (cols - 3) / 2);
  const stack = [start];
  const neighbors: number[] = [];
  tiles[start] = 0;
  while (stack.length) {
    const cell = stack[stack.length - 1];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    neighbors.length = 0;
    if (row > 2 && tiles[cell - 2 * cols]) neighbors.push(cell - 2 * cols);
    if (row + 2 < rows - 1 && tiles[cell + 2 * cols]) neighbors.push(cell + 2 * cols);
    if (col > 2 && tiles[cell - 2]) neighbors.push(cell - 2);
    if (col + 2 < cols - 1 && tiles[cell + 2]) neighbors.push(cell + 2);
    if (!neighbors.length) {
      stack.pop();
      continue;
    }
    const next = neighbors[rng.intInclusive(0, neighbors.length - 1)];
    tiles[(cell + next) / 2] = 0;
    tiles[next] = 0;
    stack.push(next);
  }

  const walls: number[] = [];
  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      const cell = row * cols + col;
      if (tiles[cell] && row % 2 !== col % 2) walls.push(cell);
    }
  }
  shuffle(walls, rng);
  const openings = Math.floor(tiles.length * (0.009 + rng.next() * 0.013));
  for (let index = 0; index < Math.min(walls.length, openings); index += 1) tiles[walls[index]] = 0;

  let passable = tiles.length - tiles.reduce((sum, tile) => sum + tile, 0);
  for (const cell of walls) {
    if (passable >= players) break;
    if (tiles[cell] === 1) {
      tiles[cell] = 0;
      passable += 1;
    }
  }
  return tiles;
};

const generateMazeMap = (
  rng: SeededRandom,
  config: MapGenerationConfig & { requiredPlayers: number },
): GeneratedMap & { generals: GeneralPos[] } => {
  const { n, m } = computeBaseMapDimensions(rng, config.heightRatio, config.widthRatio);
  const requested = Math.max(0, config.requiredPlayers);
  const swampBudget = Math.max(0, Math.floor(n * m * MAX_SWAMP_RATIO * config.swampRatio));
  let best:
    | {
        tiles: Uint8Array;
        spawns: number[];
        internalSpawns: number;
        score: ReturnType<typeof scoreMazeLayout>;
      }
    | undefined;

  for (let candidate = 0; candidate < TERRAIN_CANDIDATES; candidate += 1) {
    const tiles = carveMaze(rng, n, m, requested);
    const graph = new MazeGraph(tiles, m);
    const players = Math.min(requested, graph.cells.length);
    const distanceTarget = Math.round(
      Math.sqrt((n * m) / Math.max(1, players)) * (2.8 + 1.25 / Math.max(1, players)),
    );
    const spawns = optimizeMazeLayout(graph, players, distanceTarget, rng);
    placeMazeSwamps(graph, spawns, swampBudget, rng);
    const internalSpawns = spawns.filter((cell) => graph.degree[cell] >= 2).length;
    const score = scoreMazeLayout(graph, spawns, distanceTarget);
    if (!best || (internalSpawns - best.internalSpawns || compareLayoutScores(score, best.score)) > 0) {
      best = { tiles, spawns, internalSpawns, score };
    }
  }

  if (!best) throw new Error('Maze terrain candidates exhausted');
  const gridType = Array.from({ length: n }, (_, row) =>
    Array.from(best.tiles.subarray(row * m, (row + 1) * m), (tile) => tile as Tile),
  );
  const generals: GeneralPos[] = best.spawns
    .sort((left, right) => left - right)
    .map((cell) => [Math.floor(cell / m), cell % m]);
  return {
    n,
    m,
    owner: build2D(n, m, 0),
    armyCnt: build2D(n, m, 0),
    gridType,
    st: gridType.map((row) => row.map((tile) => tile !== 1)),
    generals,
  };
};

const assignMazeSeats = (layout: GeneralPos[], mapSeed: string): GeneralPos[] => {
  const seats = [...layout];
  shuffle(seats, new SeededRandom(`${mapSeed}:maze-seats`));
  return seats;
};

export { assignMazeSeats, generateMazeMap };
