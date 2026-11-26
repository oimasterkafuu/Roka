import { GeneralPos, Grid, SeededRandom, Tile, shuffle } from '../map/map-core';

interface GeneralSelectionContext {
  n: number;
  m: number;
  st: Grid<boolean>;
  gridType: Grid<Tile>;
  rng: SeededRandom;
}

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

export { selectRandomGenerals };
