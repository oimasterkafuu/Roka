import { GeneralPos, Grid, MOVE_DX, MOVE_DY, SeededRandom, Tile, shuffle } from '../map/map-core';

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

const selectMazeGenerals = (ctx: GeneralSelectionContext, requiredPlayers: number): GeneralPos[] => {
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

// 出生点最小间距目标：按可通行面积与人均占地折算（理想网格间距的 0.6 倍），
// 达不到时自适应放宽到实际可达的最优值，保证人多图小时也不会出生相邻。
const MIN_SPAWN_DISTANCE_AREA_FACTOR = 0.6;

const computeMinSpawnDistance = (playableCells: number, requiredPlayers: number): number => {
  if (requiredPlayers <= 1 || playableCells <= 0) {
    return 0;
  }
  return Math.max(2, Math.floor(Math.sqrt(playableCells / requiredPlayers) * MIN_SPAWN_DISTANCE_AREA_FACTOR));
};

const selectRandomGenerals = (ctx: GeneralSelectionContext, requiredPlayers: number): GeneralPos[] => {
  const preset: GeneralPos[] = [];
  const spaces: GeneralPos[] = [];

  for (let i = 0; i < ctx.n; i += 1) {
    for (let j = 0; j < ctx.m; j += 1) {
      if (!ctx.st[i][j]) {
        continue;
      }
      if (ctx.gridType[i][j] === -2) {
        preset.push([i, j]);
      } else if (ctx.gridType[i][j] === 0) {
        spaces.push([i, j]);
      }
    }
  }

  const spaceIndexes = spaces.map(([x, y]) => x * ctx.m + y);
  const minDistanceTarget = computeMinSpawnDistance(preset.length + spaces.length, requiredPlayers);

  const geCandidates: GeneralPos[][] = [];
  const geValues: number[] = [];
  const geMinDistances: number[] = [];
  let bestMinDistance = 0;

  while (geCandidates.length < 500) {
    shuffle(preset, ctx.rng);
    const ge = preset.slice(0, Math.min(requiredPlayers, preset.length));

    // 最大-最小贪心补位：每步从空格中挑与已选点曼哈顿距离最远的（同分随机），
    // 保证候选布局的两两最小间距尽量大。
    const minDist = new Int32Array(ctx.n * ctx.m).fill(1 << 28);
    const selectedSet = new Set<number>(ge.map(([x, y]) => x * ctx.m + y));
    const applyPick = (px: number, py: number): void => {
      for (let c = 0; c < spaces.length; c += 1) {
        const d = Math.abs(spaces[c][0] - px) + Math.abs(spaces[c][1] - py);
        if (d < minDist[spaceIndexes[c]]) {
          minDist[spaceIndexes[c]] = d;
        }
      }
    };
    for (const [px, py] of ge) {
      applyPick(px, py);
    }

    while (ge.length < requiredPlayers && selectedSet.size < spaces.length) {
      let bestDist = -1;
      for (let c = 0; c < spaces.length; c += 1) {
        if (!selectedSet.has(spaceIndexes[c]) && minDist[spaceIndexes[c]] > bestDist) {
          bestDist = minDist[spaceIndexes[c]];
        }
      }
      const ties: number[] = [];
      for (let c = 0; c < spaces.length; c += 1) {
        if (!selectedSet.has(spaceIndexes[c]) && minDist[spaceIndexes[c]] === bestDist) {
          ties.push(c);
        }
      }
      const pick = ties[ctx.rng.intInclusive(0, ties.length - 1)];
      ge.push(spaces[pick]);
      selectedSet.add(spaceIndexes[pick]);
      applyPick(spaces[pick][0], spaces[pick][1]);
    }
    while (ge.length < requiredPlayers) {
      ge.push([-1, -1]);
    }

    shuffle(ge, ctx.rng);

    let score = 0;
    let minPairDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < requiredPlayers; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (ge[i][0] === -1 || ge[j][0] === -1) {
          continue;
        }
        const distance = Math.abs(ge[i][0] - ge[j][0]) + Math.abs(ge[i][1] - ge[j][1]);
        score += 0.88 ** distance + Math.max(0, 9 - distance);
        if (distance < minPairDistance) {
          minPairDistance = distance;
        }
      }
    }
    if (!Number.isFinite(minPairDistance)) {
      minPairDistance = 0;
    }

    score += 1e-8;
    score = 1 / score;
    score = score ** 2.2;

    geCandidates.push(ge.map(([x, y]) => [x, y]));
    geValues.push(score);
    geMinDistances.push(minPairDistance);
    if (minPairDistance > bestMinDistance) {
      bestMinDistance = minPairDistance;
    }
  }

  // 硬约束：只在满足最小间距目标的候选里轮盘；目标不可达时放宽到实际最优值。
  const effectiveMinDistance = Math.min(minDistanceTarget, bestMinDistance);
  const feasibleIndexes: number[] = [];
  for (let i = 0; i < geCandidates.length; i += 1) {
    if (geMinDistances[i] >= effectiveMinDistance) {
      feasibleIndexes.push(i);
    }
  }

  const maxValue = Math.max(...feasibleIndexes.map((i) => geValues[i]));
  const normalized = feasibleIndexes.map((i) => Math.floor((geValues[i] / maxValue) * 100000));
  let randomPick = ctx.rng.intInclusive(0, normalized.reduce((sum, value) => sum + value, 0) - 1);

  let selected = geCandidates[feasibleIndexes[0]];
  for (let i = 0; i < feasibleIndexes.length; i += 1) {
    if (normalized[i] > randomPick) {
      selected = geCandidates[feasibleIndexes[i]];
      break;
    }
    randomPick -= normalized[i];
  }
  return selected;
};

export { selectMazeGenerals, selectRandomGenerals };
