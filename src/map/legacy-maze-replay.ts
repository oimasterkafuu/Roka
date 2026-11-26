import {
  MAX_SWAMP_RATIO,
  MOVE_DX,
  MOVE_DY,
  GeneralPos,
  Grid,
  SeededRandom,
  Tile,
  build2D,
  computeBaseMapDimensions,
  markLargestComponent,
  shuffle,
} from './map-core';
import { generateRandomMap } from './random-map-generator';
import type { GeneratedMap, MapGenerationConfig } from './random-map-generator';

const generateLegacyMazeMap = (rng: SeededRandom, config: MapGenerationConfig): GeneratedMap => {
  const { n, m } = computeBaseMapDimensions(rng, config.heightRatio, config.widthRatio);
  const owner = build2D(n, m, 0);
  const armyCnt = build2D(n, m, 0);
  const gridType = build2D<Tile>(n, m, 1);

  const mazeRows: number[] = [];
  const mazeCols: number[] = [];
  for (let i = 1; i < n; i += 2) {
    mazeRows.push(i);
  }
  for (let j = 1; j < m; j += 2) {
    mazeCols.push(j);
  }

  if (mazeRows.length === 0 || mazeCols.length === 0) {
    return generateRandomMap(rng, config);
  }

  const visited = build2D(n, m, false);
  const stack: Array<[number, number]> = [];
  const start: [number, number] = [
    mazeRows[rng.intInclusive(0, mazeRows.length - 1)],
    mazeCols[rng.intInclusive(0, mazeCols.length - 1)],
  ];
  stack.push(start);
  visited[start[0]][start[1]] = true;
  gridType[start[0]][start[1]] = 0;

  while (stack.length > 0) {
    const [x, y] = stack[stack.length - 1];
    const nexts: Array<{ nx: number; ny: number; wx: number; wy: number }> = [];

    for (let d = 0; d < 4; d += 1) {
      const nx = x + MOVE_DX[d] * 2;
      const ny = y + MOVE_DY[d] * 2;
      if (nx <= 0 || nx >= n || ny <= 0 || ny >= m || visited[nx][ny]) {
        continue;
      }
      nexts.push({ nx, ny, wx: x + MOVE_DX[d], wy: y + MOVE_DY[d] });
    }

    if (nexts.length === 0) {
      stack.pop();
      continue;
    }

    const choice = nexts[rng.intInclusive(0, nexts.length - 1)];
    visited[choice.nx][choice.ny] = true;
    gridType[choice.wx][choice.wy] = 0;
    gridType[choice.nx][choice.ny] = 0;
    stack.push([choice.nx, choice.ny]);
  }

  const extraOpeningsTarget = Math.floor(n * m * 0.03);
  let extraOpenings = 0;
  const createsOpen2x2 = (x: number, y: number): boolean => {
    for (let ax = x - 1; ax <= x; ax += 1) {
      for (let ay = y - 1; ay <= y; ay += 1) {
        if (ax < 0 || ay < 0 || ax + 1 >= n || ay + 1 >= m) {
          continue;
        }
        let allEmpty = true;
        for (let dx = 0; dx <= 1; dx += 1) {
          for (let dy = 0; dy <= 1; dy += 1) {
            const cx = ax + dx;
            const cy = ay + dy;
            const isOpeningCell = cx === x && cy === y;
            const isEmpty = isOpeningCell ? true : gridType[cx][cy] === 0;
            if (!isEmpty) {
              allEmpty = false;
              break;
            }
          }
          if (!allEmpty) {
            break;
          }
        }
        if (allEmpty) {
          return true;
        }
      }
    }
    return false;
  };

  for (
    let attempt = 0;
    attempt < extraOpeningsTarget * 10 && extraOpenings < extraOpeningsTarget;
    attempt += 1
  ) {
    if (n <= 2 || m <= 2) {
      break;
    }
    const x = rng.intInclusive(1, n - 2);
    const y = rng.intInclusive(1, m - 2);
    if (gridType[x][y] !== 1) {
      continue;
    }
    const openLR = gridType[x][y - 1] !== 1 && gridType[x][y + 1] !== 1;
    const openUD = gridType[x - 1][y] !== 1 && gridType[x + 1][y] !== 1;
    if (!openLR && !openUD) {
      continue;
    }
    if (createsOpen2x2(x, y)) {
      continue;
    }
    gridType[x][y] = 0;
    extraOpenings += 1;
  }

  const st = build2D(n, m, false);
  markLargestComponent(gridType, n, m, st);

  const passable: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (st[i][j] && gridType[i][j] === 0) {
        passable.push([i, j]);
      }
    }
  }

  shuffle(passable, rng);
  // Roka: no pre-placed cities in the maze; cities only appear via player builds.
  const swampCandidates = passable;
  shuffle(swampCandidates, rng);
  const swampTarget = Math.min(
    swampCandidates.length,
    Math.floor(n * m * MAX_SWAMP_RATIO * config.swampRatio),
  );
  for (let i = 0; i < swampTarget; i += 1) {
    const [x, y] = swampCandidates[i];
    gridType[x][y] = 2;
  }

  return {
    n,
    m,
    owner,
    armyCnt,
    gridType,
    st,
  };
};

interface GeneralSelectionContext {
  n: number;
  m: number;
  st: Grid<boolean>;
  gridType: Grid<Tile>;
  rng: SeededRandom;
}

const isInBounds = (n: number, m: number, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < n && y < m;

const buildShortestPathDistance = (ctx: GeneralSelectionContext, start: GeneralPos): Int32Array => {
  const total = ctx.n * ctx.m;
  const dist = new Int32Array(total);
  dist.fill(-1);

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const startIndex = start[0] * ctx.m + start[1];
  dist[startIndex] = 0;
  queue[tail] = startIndex;
  tail += 1;

  while (head < tail) {
    const index = queue[head];
    head += 1;

    const x = Math.floor(index / ctx.m);
    const y = index % ctx.m;
    const current = dist[index];

    for (let d = 0; d < 4; d += 1) {
      const nx = x + MOVE_DX[d];
      const ny = y + MOVE_DY[d];
      if (!isInBounds(ctx.n, ctx.m, nx, ny) || ctx.gridType[nx][ny] === 1) {
        continue;
      }
      const nextIndex = nx * ctx.m + ny;
      if (dist[nextIndex] !== -1) {
        continue;
      }
      dist[nextIndex] = current + 1;
      queue[tail] = nextIndex;
      tail += 1;
    }
  }

  return dist;
};

const selectLegacyMazeGenerals = (ctx: GeneralSelectionContext, requiredPlayers: number): GeneralPos[] => {
  const fixed: GeneralPos[] = [];
  const spaces: GeneralPos[] = [];

  for (let i = 0; i < ctx.n; i += 1) {
    for (let j = 0; j < ctx.m; j += 1) {
      if (!ctx.st[i][j]) {
        continue;
      }
      if (ctx.gridType[i][j] === -2) {
        fixed.push([i, j]);
      } else if (ctx.gridType[i][j] === 0) {
        spaces.push([i, j]);
      }
    }
  }

  if (requiredPlayers <= fixed.length) {
    shuffle(fixed, ctx.rng);
    return fixed.slice(0, requiredPlayers);
  }
  if (requiredPlayers <= 0 || spaces.length === 0) {
    return fixed;
  }

  const candidateIndexes = spaces.map(([x, y]) => x * ctx.m + y);
  const targetCount = requiredPlayers;
  const restartCount = Math.min(80, Math.max(20, requiredPlayers * 10));
  let bestSelection: GeneralPos[] = [];
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < restartCount; attempt += 1) {
    const selected: GeneralPos[] = fixed.map(([x, y]) => [x, y]);
    const selectedIndexes = selected.map(([x, y]) => x * ctx.m + y);
    const selectedSet = new Set<number>(selectedIndexes);
    const distMaps = selected.map((pos) => buildShortestPathDistance(ctx, pos));

    while (selected.length < targetCount) {
      if (selected.length === 0) {
        const pick = ctx.rng.intInclusive(0, spaces.length - 1);
        const firstPos = spaces[pick];
        const firstIndex = candidateIndexes[pick];
        selected.push([firstPos[0], firstPos[1]]);
        selectedIndexes.push(firstIndex);
        selectedSet.add(firstIndex);
        distMaps.push(buildShortestPathDistance(ctx, firstPos));
        continue;
      }

      let bestCandidate = -1;
      let bestCandidateScore = -Infinity;

      for (let c = 0; c < spaces.length; c += 1) {
        const idx = candidateIndexes[c];
        if (selectedSet.has(idx)) {
          continue;
        }

        let minDist = Number.POSITIVE_INFINITY;
        let sumDist = 0;
        let reachable = true;

        for (let k = 0; k < distMaps.length; k += 1) {
          const d = distMaps[k][idx];
          if (d < 0) {
            reachable = false;
            break;
          }
          if (d < minDist) {
            minDist = d;
          }
          sumDist += d;
        }
        if (!reachable) {
          continue;
        }

        const [x, y] = spaces[c];
        const borderDistance = Math.min(x, ctx.n - 1 - x, y, ctx.m - 1 - y);
        const score = minDist * 1_000_000 + sumDist * 1_000 + borderDistance;
        if (score > bestCandidateScore || (score === bestCandidateScore && ctx.rng.next() < 0.5)) {
          bestCandidateScore = score;
          bestCandidate = c;
        }
      }

      if (bestCandidate === -1) {
        break;
      }

      const picked = spaces[bestCandidate];
      const pickedIndex = candidateIndexes[bestCandidate];
      selected.push([picked[0], picked[1]]);
      selectedIndexes.push(pickedIndex);
      selectedSet.add(pickedIndex);
      distMaps.push(buildShortestPathDistance(ctx, picked));
    }

    let minPairDist = ctx.n + ctx.m;
    let sumPairDist = 0;
    let pairCount = 0;
    for (let i = 0; i < selectedIndexes.length; i += 1) {
      for (let j = i + 1; j < selectedIndexes.length; j += 1) {
        const d = distMaps[i][selectedIndexes[j]];
        if (d < 0) {
          continue;
        }
        minPairDist = Math.min(minPairDist, d);
        sumPairDist += d;
        pairCount += 1;
      }
    }
    const avgPairDist = pairCount > 0 ? sumPairDist / pairCount : minPairDist;
    const score =
      selected.length * 1_000_000_000 + minPairDist * 1_000_000 + avgPairDist * 1_000 + ctx.rng.next();

    if (score > bestScore) {
      bestScore = score;
      bestSelection = selected.map(([x, y]) => [x, y]);
    }
  }

  const selectedSet = new Set(bestSelection.map(([x, y]) => x * ctx.m + y));
  if (bestSelection.length < targetCount) {
    const fallbackSpaces = [...spaces];
    shuffle(fallbackSpaces, ctx.rng);
    for (const [x, y] of fallbackSpaces) {
      const idx = x * ctx.m + y;
      if (selectedSet.has(idx)) {
        continue;
      }
      bestSelection.push([x, y]);
      selectedSet.add(idx);
      if (bestSelection.length >= targetCount) {
        break;
      }
    }
  }

  return bestSelection.slice(0, targetCount);
};

export { generateLegacyMazeMap, selectLegacyMazeGenerals };
