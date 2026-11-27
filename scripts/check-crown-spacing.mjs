import assert from 'node:assert/strict';
import { GameEngine } from '../src/game-engine.ts';

const incidents = {
  mega_random: [
    [
      'KKZzzbd4cphk',
      'ee609ace4ffe035bafe5c3658e3f7958',
      [
        [6, 10],
        [3, 7],
      ],
      0.48985885404745555,
      0.7766186007476921,
      true,
    ],
  ],
};

function canonicalLayout({ n, m }, points) {
  const keys = [];
  for (const swap of [false, true])
    for (const flipRow of [false, true])
      for (const flipCol of [false, true]) {
        const cells = points.map(([row, col]) => {
          const vertical = flipRow ? n - 1 - row : row;
          const horizontal = flipCol ? m - 1 - col : col;
          return swap ? horizontal * n + vertical : vertical * m + horizontal;
        });
        keys.push(`${swap ? m : n}x${swap ? n : m}:${cells.sort((left, right) => left - right)}`);
      }
  return keys.sort()[0];
}

export function crownAudit() {
  const groups = new Map(),
    coordinates = new Set(),
    nearest = [],
    mapMinimum = [];
  let maps = 0,
    enemyPairs = 0,
    blockedPairs = 0,
    straightPairs = 0;

  function check(board, meta, group) {
    const { m, grid_type: tiles } = board;
    const seats = meta.player_teams.flatMap((team, seat) =>
      team === 0 ? [] : [{ team, cell: tiles.indexOf(101 + seat) }],
    );
    assert.ok(
      seats.every(({ cell }) => cell >= 0),
      meta.map_token,
    );
    const passable = tiles.filter((tile) => tile !== 201).length;
    const minimum = Math.max(14, Math.floor(1.5 * Math.sqrt(passable / seats.length)));
    const points = seats.map(({ cell }) => [Math.floor(cell / m), cell % m]);
    for (const point of points) coordinates.add(point.join(','));
    const steps = seats.map(() => Infinity);
    let closestPair;
    const queue = new Int32Array(tiles.length),
      distances = new Int32Array(tiles.length);
    for (let first = 0; first < seats.length - 1; first++) {
      distances.fill(-1);
      const start = seats[first].cell;
      distances[start] = 0;
      let tail = 1;
      queue[0] = start;
      for (let head = 0; head < tail; head++) {
        const cell = queue[head];
        for (const next of [cell - m, cell + m, cell % m ? cell - 1 : -1, cell % m < m - 1 ? cell + 1 : -1]) {
          if (next < 0 || next >= tiles.length || tiles[next] === 201 || distances[next] !== -1) continue;
          distances[next] = distances[cell] + 1;
          queue[tail++] = next;
        }
      }
      assert.equal(tail, passable, `${meta.map_token}: disconnected board`);
      for (let other = first + 1; other < seats.length; other++) {
        if (seats[first].team === seats[other].team) continue;
        enemyPairs++;
        const end = seats[other].cell,
          distance = distances[end];
        const label = `${meta.map_token}: ${points[first]} vs ${points[other]}`;
        if (!closestPair || distance < closestPair.distance) closestPair = { label, distance };
        steps[first] = Math.min(steps[first], distance);
        steps[other] = Math.min(steps[other], distance);
        if (points[first][0] !== points[other][0] && points[first][1] !== points[other][1]) continue;
        const stride = points[first][0] === points[other][0] ? 1 : m;
        let wall = false;
        for (let cell = Math.min(start, end) + stride; cell < Math.max(start, end); cell += stride)
          if (tiles[cell] === 201) wall = true;
        if (wall) blockedPairs++;
        else straightPairs++;
        assert.ok(wall, `${label}: every intermediate cell is traversable`);
      }
    }
    if (closestPair)
      assert.ok(
        closestPair.distance >= minimum,
        `${closestPair.label}: ${closestPair.distance} steps, requires ${minimum}`,
      );
    maps++;
    nearest.push(...steps.filter(Number.isFinite));
    if (Number.isFinite(Math.min(...steps))) mapMinimum.push(Math.min(...steps));
    if (group) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(canonicalLayout(board, points));
    }
    return { points, steps, minimum };
  }

  function summary() {
    assert.equal(straightPairs, 0, 'enemy crowns with fully traversable axis');
    const layouts = Object.fromEntries(
      [...groups].map(([group, entries]) => {
        const distinct = new Set(entries).size;
        assert.ok(
          distinct >= Math.min(12, Math.max(2, Math.ceil(entries.length / 2))),
          `${group}: ${distinct} distinct layouts`,
        );
        const bySize = Map.groupBy(entries, (entry) => entry.split(':')[0]);
        for (const [dimensions, sameSize] of bySize)
          if (sameSize.length >= 8)
            assert.ok(new Set(sameSize).size >= 3, `${group}/${dimensions}: fixed layout up to symmetry`);
        return [group, distinct];
      }),
    );
    const percentiles = (values) => {
      values.sort((left, right) => left - right);
      return Object.fromEntries(
        [0, 10, 50, 90, 100].map((pct) => [pct, values[Math.floor(((values.length - 1) * pct) / 100)]]),
      );
    };
    return {
      maps,
      seats: nearest.length,
      enemyPairs,
      straightPairs,
      blockedPairs,
      coordinates: coordinates.size,
      nearestSteps: percentiles(nearest),
      mapMinimumSteps: percentiles(mapMinimum),
      layouts,
    };
  }
  return { check, summary };
}

export async function checkIncidents(mode, config, audit) {
  const results = {};
  for (const [id, token, oldPoints, city_ratio, mountain_ratio, multi_line] of incidents[mode]) {
    const meta = {
      ...config(2, 'normal', token),
      city_ratio,
      mountain_ratio,
      multi_line,
      speed: multi_line ? 4 : 2,
    };
    const result = audit.check(await GameEngine.buildReplayBaseMap(meta), meta);
    const [[firstRow, firstCol], [secondRow, secondCol]] = oldPoints;
    const oldDistance = Math.abs(firstRow - secondRow) + Math.abs(firstCol - secondCol);
    assert.ok(result.steps[0] > oldDistance, `${id}: old rush distance ${oldDistance}`);
    assert.notDeepEqual(result.points.map(String).sort(), oldPoints.map(String).sort(), id);
    results[id] = result;
  }
  return results;
}

export async function checkSeatConfigurations(config, audit) {
  const cramped = {};
  for (const players of [8, 12, 16]) {
    for (let index = 0; index < 4; index++) {
      const meta = {
        ...config(players, 'normal', `cramped-crowns-${players}-${index}`),
        width_ratio: 0.34,
        height_ratio: 0.34,
      };
      const result = audit.check(await GameEngine.buildReplayBaseMap(meta), meta, `cramped/${players}`);
      cramped[meta.map_token] = Math.min(...result.steps);
    }
  }
  for (const size of ['normal', 'large'])
    for (const players of [4, 8, 16]) {
      const meta = config(players, size, `grouped-crowns-${size}-${players}`);
      meta.allow_team = true;
      meta.player_teams = meta.player_teams.map((_, seat) => 1 + (seat % 2));
      meta.player_teams.splice(1, 0, 0);
      meta.player_names.splice(1, 0, 'Observer');
      audit.check(await GameEngine.buildReplayBaseMap(meta), meta);
    }
  return cramped;
}
