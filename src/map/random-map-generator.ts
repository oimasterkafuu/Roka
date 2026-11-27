import {
  Grid,
  MAX_MOUNTAIN_RATIO,
  MAX_SWAMP_RATIO,
  SeededRandom,
  Tile,
  build2D,
  checkConnection,
  computeBaseMapDimensions,
  markLargestComponent,
} from './map-core';

interface MapGenerationConfig {
  widthRatio: number;
  heightRatio: number;
  cityRatio: number;
  mountainRatio: number;
  swampRatio: number;
}

interface GeneratedMap {
  n: number;
  m: number;
  owner: Grid<number>;
  armyCnt: Grid<number>;
  gridType: Grid<Tile>;
  st: Grid<boolean>;
}

const scatterRandomTerrain = (
  rng: SeededRandom,
  length: number,
  mountainRatio: number,
  swampRatio: number,
): Uint8Array => {
  const blockedRatio = swampRatio + mountainRatio;
  return Uint8Array.from({ length }, () => {
    const chance = rng.next();
    return chance < swampRatio ? 2 : chance < blockedRatio ? 1 : 0;
  });
};

const generateRandomMap = (rng: SeededRandom, config: MapGenerationConfig): GeneratedMap => {
  const { n, m } = computeBaseMapDimensions(rng, config.heightRatio, config.widthRatio);
  const owner = build2D(n, m, 0);
  const armyCnt = build2D(n, m, 0);

  // Roka: no neutral cities are generated; cities only appear via player builds.
  const swampRatio = MAX_SWAMP_RATIO * config.swampRatio;
  const mountainRatio = MAX_MOUNTAIN_RATIO * config.mountainRatio;

  let gridType: Grid<Tile> = build2D<Tile>(n, m, 0);
  while (true) {
    const tiles = scatterRandomTerrain(rng, n * m, mountainRatio, swampRatio);
    const candidate = Array.from({ length: n }, (_, row) =>
      Array.from(tiles.subarray(row * m, (row + 1) * m), (tile) => tile as Tile),
    );
    const [x] = checkConnection(candidate, n, m);
    if (x !== -1) {
      gridType = candidate;
      break;
    }
  }

  const st = build2D(n, m, false);
  markLargestComponent(gridType, n, m, st);

  return {
    n,
    m,
    owner,
    armyCnt,
    gridType,
    st,
  };
};

export { generateRandomMap, scatterRandomTerrain };
export type { GeneratedMap, MapGenerationConfig };
