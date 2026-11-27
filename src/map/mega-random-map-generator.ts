import { build2D, computeBaseMapDimensions, SeededRandom, shuffle } from './map-core';
import type { GeneralPos, Tile } from './map-core';
import {
  crossingStart,
  paintCrossing,
  seatDistricts,
  rectangularPartition,
  surroundedPartition,
  insetPartition,
} from './map-geometry';
import type { District, SeatPartition } from './map-geometry';
import { carveMaze } from './maze-map-generator';
import { chooseMegaSeats } from './mega-random-seats';
import { scatterRandomTerrain } from './random-map-generator';

type Brush = (row: number, col: number, vertical: number, horizontal: number) => number;

interface Canvas {
  height: number;
  width: number;
  rng: SeededRandom;
  districts: District[];
  partition: SeatPartition;
  surrounded: boolean;
  teams: number[];
  crossings: number[][][];
}

const brush = ({ height, width }: Canvas, sample: Brush): Uint8Array =>
  Uint8Array.from({ length: height * width }, (_, index) => {
    const row = Math.floor(index / width),
      col = index % width;
    return sample(row, col, (2 * row + 1) / height - 1, (2 * col + 1) / width - 1);
  });

const range = (rng: SeededRandom, low: number, high: number) => low + (high - low) * rng.next();
const radius = Math.hypot;

const painters = {
  meadow(canvas) {
    const { rng } = canvas;
    const clumps = Array.from({ length: rng.intInclusive(3, 7) }, () => ({
      vertical: range(rng, -0.85, 0.85),
      horizontal: range(rng, -0.85, 0.85),
      size: range(rng, 0.1, 0.24),
      tile: rng.next() < 0.75 ? 1 : 2,
    }));
    return brush(
      canvas,
      (_row, _col, vertical, horizontal) =>
        clumps.find(({ vertical: cy, horizontal: cx, size }) => radius(vertical - cy, horizontal - cx) < size)
          ?.tile ?? 0,
    );
  },
  massif(canvas) {
    const scale = canvas.surrounded ? 0.48 : 1;
    const width = range(canvas.rng, 0.3, 0.64) * scale,
      height = range(canvas.rng, 0.3, 0.57) * scale;
    return brush(canvas, (_row, _col, vertical, horizontal) =>
      Math.abs(vertical) / height + Math.abs(horizontal) / width < 1
        ? 1
        : Math.abs(vertical) < height / 3 && Math.abs(horizontal) < width * 0.87
          ? 2
          : 0,
    );
  },
  twin_basins(canvas) {
    const offset = range(canvas.rng, 0.34, 0.56),
      size = range(canvas.rng, 0.18, 0.3);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      const shore = radius(vertical * 0.8, Math.abs(horizontal) - offset) / size;
      return shore < 0.68 ? 1 : shore < 1 ? 2 : 0;
    });
  },
  moat(canvas) {
    const ring = range(canvas.rng, 0.43, 0.66),
      width = range(canvas.rng, 0.07, 0.14),
      gate = range(canvas.rng, 0.12, 0.24);
    return brush(canvas, (_row, _col, vertical, horizontal) =>
      Math.abs(radius(vertical, horizontal) - ring) > width || Math.abs(horizontal) < gate
        ? 0
        : Math.abs(vertical) < gate
          ? 2
          : 1,
    );
  },
  meander(canvas) {
    const bend = range(canvas.rng, 0.16, 0.38),
      phase = range(canvas.rng, -1, 1),
      gates = canvas.rng.intInclusive(2, 4);
    const span = Math.max(1, Math.round(canvas.height / (gates * 3)));
    const starts = Array.from({ length: gates }, (_, gate) =>
      crossingStart(canvas.height, (gate + 0.5) / gates, span),
    );
    const channels = starts.map(() => [] as number[]);
    canvas.crossings.push(channels);
    const axis = (row: number) =>
      Math.round(
        (canvas.width - 1) *
          (0.5 + bend * 0.5 * Math.sin(((2 * row + 1) / canvas.height - 1) * Math.PI + phase)),
      );
    return brush(canvas, (row, col) => {
      const current = axis(row),
        previous = axis(Math.max(0, row - 1)),
        half = Math.floor(canvas.width * 0.035);
      if (col < Math.min(current, previous) - half || col > Math.max(current, previous) + half) return 0;
      const gate = starts.findIndex((start) => row >= start && row < start + span);
      if (gate < 0) return 1;
      channels[gate].push(row * canvas.width + col);
      return gate % 2 ? 0 : 2;
    });
  },
  corner_lakes(canvas) {
    const size = range(canvas.rng, 0.36, 0.67) * Math.min(1, 2.4 / Math.sqrt(canvas.districts.length)),
      rim = range(canvas.rng, 0.65, 0.88);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      const shore = radius(1 - Math.abs(vertical), 1 - Math.abs(horizontal)) / size;
      return shore < rim ? 1 : shore < 1 ? 2 : 0;
    });
  },
  inland_continent(canvas) {
    const coast = range(canvas.rng, 0.78, 0.88),
      peninsula = range(canvas.rng, 0.13, 0.31);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      const edge = (Math.abs(vertical) ** 3 + Math.abs(horizontal) ** 3) ** (1 / 3);
      if (edge < coast || (Math.abs(vertical) < peninsula && edge < coast + 0.055)) return 0;
      return edge < coast + 0.08 || (Math.abs(horizontal) < peninsula && edge > 0.9) ? 2 : 1;
    });
  },
  home_atolls(canvas) {
    const breadth = range(canvas.rng, 0.75, 0.9);
    const islands = brush(canvas, (_row, _col, vertical, horizontal) => {
      const slot = canvas.partition.slotAt((vertical + 1) / 2, (horizontal + 1) / 2);
      if (canvas.surrounded) {
        const [row, col] = canvas.partition.centers[slot];
        return Math.hypot((vertical + 1) / 2 - row, (horizontal + 1) / 2 - col) > breadth * 0.46 ? 1 : 0;
      }
      const district = canvas.districts[slot];
      const dy = (vertical + 1 - district.top - district.bottom) / (district.bottom - district.top);
      const dx = (horizontal + 1 - district.left - district.right) / (district.right - district.left);
      return radius(dx, dy) < breadth + 0.32 ? 0 : 1;
    });
    return linkDistricts(
      canvas,
      islands,
      canvas.districts.map((_, slot) => slot),
    );
  },
  team_shelves(canvas) {
    return linkDistricts(canvas, new Uint8Array(canvas.height * canvas.width), canvas.teams);
  },
  tidal_hub(canvas) {
    const ring = range(canvas.rng, 0.33, 0.53),
      ford = range(canvas.rng, 0.16, 0.32);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      const edge = Math.max(Math.abs(vertical), Math.abs(horizontal));
      const diagonal = Math.abs(Math.abs(vertical) - Math.abs(horizontal));
      if (Math.abs(edge - ring) < Math.max(0.085, 1 / Math.min(canvas.height, canvas.width)))
        return diagonal < ford ? 2 : 1;
      return edge > ring && Math.min(Math.abs(vertical), Math.abs(horizontal)) < 0.12 && edge < 0.78 ? 1 : 0;
    });
  },
  parallel_belts(canvas) {
    const offset = range(canvas.rng, 0.26, 0.51),
      reach = range(canvas.rng, 0.62, 0.86);
    return brush(canvas, (_row, _col, vertical, horizontal) =>
      Math.abs(Math.abs(vertical) - offset) < Math.max(0.075, 1 / canvas.height) &&
      Math.abs(horizontal) < reach
        ? Math.abs(horizontal) < 0.15
          ? 0
          : vertical * horizontal > 0
            ? 1
            : 2
        : 0,
    );
  },
  opposed_coasts(canvas) {
    const edge = range(canvas.rng, 0.64, 0.84),
      capes = canvas.rng.intInclusive(2, 4);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      const shore = edge + 0.12 * Math.cos(capes * vertical * Math.PI);
      return horizontal < -shore ? 1 : horizontal > shore ? (Math.abs(vertical) > 0.68 ? 1 : 2) : 0;
    });
  },
  three_marches(canvas) {
    const { height, width, rng } = canvas;
    const tiles = new Uint8Array(height * width);
    const offset = range(rng, 0.25, 0.37),
      gates = rng.intInclusive(2, 4);
    for (const [side, centre] of [offset, 1 - offset].entries()) {
      const channels: number[][] = [];
      canvas.crossings.push(channels);
      const wall = Math.round((width - 1) * centre);
      paintCrossing(tiles, width, 0, height, wall, wall, 1);
      for (let gate = 0; gate < gates; gate++) {
        const span = Math.max(1, Math.round(height / (gates * 4)));
        const start = crossingStart(height, (gate + (side ? 0.62 : 0.38)) / gates, span);
        paintCrossing(tiles, width, start, span, wall, wall, gate % 2 ? 2 : 0);
        channels.push(Array.from({ length: span }, (_, along) => (start + along) * width + wall));
      }
    }
    return tiles;
  },
  clearing(canvas) {
    const { rng } = canvas;
    const reach = range(rng, 0.56, 0.76),
      frequency = rng.intInclusive(3, 6);
    return brush(canvas, (_row, _col, vertical, horizontal) => {
      if (Math.max(Math.abs(vertical), Math.abs(horizontal)) < reach) return 0;
      const ridge = Math.cos(vertical * frequency * Math.PI) * Math.cos(horizontal * frequency * Math.PI);
      return ridge > 0 ? 1 : ridge < -0.5 ? 2 : 0;
    });
  },
  standard_scatter({ height, width, rng }) {
    const tiles = scatterRandomTerrain(rng, height * width, range(rng, 0.16, 0.24), range(rng, 0.04, 0.08));
    const mountains: number[] = [];
    for (const [cell, tile] of tiles.entries()) {
      if (tile !== 1) continue;
      const row = Math.floor(cell / width),
        col = cell % width;
      if (row > 0 && row < height - 1 && col > 0 && col < width - 1) mountains.push(cell);
      tiles[cell] = 0;
    }
    shuffle(mountains, rng);
    for (const cell of mountains) {
      const passableRing = [cell - width, cell, cell + width].every(
        (middle) => tiles[middle - 1] !== 1 && tiles[middle] !== 1 && tiles[middle + 1] !== 1,
      );
      if (passableRing) tiles[cell] = 1;
    }
    return tiles;
  },
  canyon_corridors({ height, width, rng }) {
    const stride = width + 2;
    const maze = carveMaze(rng, height + 2, stride, 0);
    const tiles = new Uint8Array(height * width);
    for (let row = 0; row < height; row++) {
      const start = (row + 1) * stride + 1;
      tiles.set(maze.subarray(start, start + width), row * width);
    }
    return tiles;
  },
} satisfies Record<string, (canvas: Canvas) => Uint8Array>;

function terrainResolution(family: keyof typeof painters, length: number) {
  if (family === 'standard_scatter') return length;
  if (family === 'canyon_corridors') return 2 * Math.floor((length + 2) / 6) + 1;
  return Math.floor(length / 2);
}

function linkDistricts(canvas: Canvas, tiles: Uint8Array, owners: number[]) {
  const { height, width, partition, rng } = canvas;
  const slots = brush(canvas, (_row, _col, vertical, horizontal) =>
    partition.slotAt((vertical + 1) / 2, (horizontal + 1) / 2),
  );
  const borders = new Map<string, { cell: number; step: number }[]>();
  for (let cell = 0; cell < tiles.length; cell++) {
    for (const step of [1, width]) {
      if ((step === 1 && cell % width === width - 1) || cell + step >= height * width) continue;
      const first = slots[cell],
        second = slots[cell + step];
      if (owners[first] === owners[second]) continue;
      const key = `${first}:${second}`;
      const edge = borders.get(key) ?? [];
      edge.push({ cell, step });
      borders.set(key, edge);
      tiles[cell] = 1;
    }
  }
  for (const edge of borders.values()) {
    for (const fraction of [range(rng, 0.18, 0.37), range(rng, 0.63, 0.82)]) {
      const { cell, step } = edge[Math.floor(edge.length * fraction)];
      tiles[cell] = 2;
      for (const [start, delta] of [
        [cell - step, -step],
        [cell + step, step],
      ]) {
        for (
          let pos = start;
          pos >= 0 &&
          pos < tiles.length &&
          (step !== 1 || Math.floor(pos / width) === Math.floor(cell / width)) &&
          slots[pos] === slots[start] &&
          tiles[pos] === 1;
          pos += delta
        )
          tiles[pos] = 2;
      }
    }
  }
  return tiles;
}

function sealPockets(tiles: Uint8Array, width: number) {
  const seen = new Uint8Array(tiles.length);
  const regions: number[][] = [];
  for (let start = 0; start < tiles.length; start++) {
    if (seen[start] || tiles[start] === 1) continue;
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (const next of [
        cell - width,
        cell + width,
        cell % width ? cell - 1 : -1,
        cell % width === width - 1 ? -1 : cell + 1,
      ]) {
        if (next < 0 || next >= tiles.length || seen[next] || tiles[next] === 1) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    regions.push(queue);
  }
  regions.sort((first, second) => second.length - first.length);
  for (const pocket of regions.slice(1)) for (const cell of pocket) tiles[cell] = 1;
}

export const megaFamilies = Object.keys(painters) as (keyof typeof painters)[];
export const drawMegaFamily = (rng: SeededRandom) =>
  megaFamilies[rng.intInclusive(0, megaFamilies.length - 1)];

export function generateMegaRandomMap(
  rng: SeededRandom,
  heightRatio: number,
  widthRatio: number,
  teams: number[],
) {
  const family = drawMegaFamily(rng);
  for (let shape = 0; shape < 20; shape++) {
    const base = computeBaseMapDimensions(rng, heightRatio, widthRatio);
    const transpose = rng.next() < 0.5,
      flipRows = rng.next() < 0.5,
      flipCols = rng.next() < 0.5;
    const extra = 2 * Math.min(9, Math.floor(shape / 2));
    const height = Math.max(transpose ? base.m : base.n, 19) + extra,
      width = Math.max(transpose ? base.n : base.m, 19) + extra;
    const n = transpose ? width : height,
      m = transpose ? height : width;
    const point = (row: number, col: number): GeneralPos => {
      const vertical = flipRows ? height - 1 - row : row,
        horizontal = flipCols ? width - 1 - col : col;
      return transpose ? [horizontal, vertical] : [vertical, horizontal];
    };
    const order = teams.map((_, index) => index);
    shuffle(order, rng);
    const groups = [...new Set(order.map((index) => teams[index]))];
    order.sort((left, right) => groups.indexOf(teams[left]) - groups.indexOf(teams[right]));
    const districts = seatDistricts(height, width, Math.max(1, order.length));
    const counts = groups.map((group) => teams.filter((team) => team === group).length);
    const surrounded = groups.length === 2 && Math.max(...counts) === teams.length - 1 && teams.length >= 6;
    const partition = surrounded
      ? surroundedPartition(order.length, rng.next())
      : rectangularPartition(districts);
    if (groups.length > 1 && Math.max(...counts) > teams.length * 0.66) {
      order.sort(
        (first, second) => counts[groups.indexOf(teams[first])] - counts[groups.indexOf(teams[second])],
      );
      const centered = [...districts.keys()].sort((first, second) => {
        const distance = (slot: number) => {
          const { top, bottom, left, right } = districts[slot];
          return Math.hypot(top + bottom - 1, left + right - 1);
        };
        return distance(first) - distance(second);
      });
      if (!surrounded) {
        const ordered = [...order];
        centered.forEach((slot, index) => {
          order[slot] = ordered[index];
        });
      }
    }
    if (shape % 3 === 1 && !surrounded && groups.length > 1 && groups.length < teams.length) {
      const grouped = [...order];
      grouped.forEach((player, index) => {
        order[index % 2 === 0 ? index / 2 : order.length - 1 - Math.floor(index / 2)] = player;
      });
    }
    const seatedTeams = order.map((index) => teams[index]);
    const coarseHeight = terrainResolution(family, height),
      coarseWidth = terrainResolution(family, width);
    const terrainRow = (row: number) => Math.floor((row * coarseHeight) / height);
    const terrainCol = (col: number) => Math.floor((col * coarseWidth) / width);
    const landPartition =
      family === 'inland_continent'
        ? insetPartition(partition, 0.8)
        : family === 'home_atolls' || family === 'team_shelves'
          ? {
              ...partition,
              slotAt: (row: number, col: number) =>
                partition.slotAt(
                  (terrainRow(Math.floor(row * height)) + 0.5) / coarseHeight,
                  (terrainCol(Math.floor(col * width)) + 0.5) / coarseWidth,
                ),
            }
          : partition;
    for (let attempt = 0; attempt < 3; attempt++) {
      const coarseCrossings: number[][][] = [];
      const coarse = painters[family]({
        height: coarseHeight,
        width: coarseWidth,
        rng,
        districts,
        partition,
        surrounded,
        teams: seatedTeams,
        crossings: coarseCrossings,
      });
      sealPockets(coarse, coarseWidth);
      const tiles = Uint8Array.from(
        { length: height * width },
        (_, index) => coarse[terrainRow(Math.floor(index / width)) * coarseWidth + terrainCol(index % width)],
      );
      if (tiles.reduce((sum, tile) => sum + Number(tile === 0), 0) < tiles.length / 2) continue;
      const crossings = coarseCrossings.map((channels) =>
        channels.map((channel) =>
          channel.flatMap((cell) => {
            const row = Math.floor(cell / coarseWidth),
              col = cell % coarseWidth,
              cells: number[] = [];
            for (
              let vertical = Math.ceil((row * height) / coarseHeight);
              vertical < Math.ceil(((row + 1) * height) / coarseHeight);
              vertical++
            )
              for (
                let horizontal = Math.ceil((col * width) / coarseWidth);
                horizontal < Math.ceil(((col + 1) * width) / coarseWidth);
                horizontal++
              )
                cells.push(vertical * width + horizontal);
            return cells;
          }),
        ),
      );
      const seats = chooseMegaSeats(tiles, width, landPartition, seatedTeams, crossings, rng);
      if (!seats) continue;
      const gridType = build2D<Tile>(n, m, 0);
      tiles.forEach((tile, index) => {
        const [row, col] = point(Math.floor(index / width), index % width);
        gridType[row][col] = tile as Tile;
      });
      const generals: GeneralPos[] = [];
      seats.forEach((cell, slot) => {
        const pos = point(Math.floor(cell / width), cell % width);
        generals[order[slot]] = pos;
        gridType[pos[0]][pos[1]] = -2;
      });
      return {
        n,
        m,
        gridType,
        st: gridType.map((row) => row.map((tile) => tile !== 1)),
        owner: build2D(n, m, 0),
        armyCnt: build2D(n, m, 0),
        generals,
        family,
        crossings: crossings.map((channels) =>
          channels.map((channel) => channel.map((cell) => point(Math.floor(cell / width), cell % width))),
        ),
      };
    }
  }
  throw new Error(`No fair ${family} layout for ${teams.length} seats`);
}
