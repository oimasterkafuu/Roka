export const crossingStart = (length: number, fraction: number, width: number): number =>
  Math.round((length - 1) * fraction - (width - 1) / 2);

export const paintCrossing = (
  tiles: Uint8Array,
  stride: number,
  start: number,
  width: number,
  bank: number,
  opposite: number,
  tile: number,
): void => {
  for (let along = start; along < start + width; along++)
    tiles.fill(tile, along * stride + bank, along * stride + opposite + 1);
};

export interface District {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const seatDistricts = (height: number, width: number, count: number): District[] => {
  const rows = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * height) / width))));
  const districts: District[] = [];
  for (let row = 0; row < rows; row++) {
    const first = districts.length;
    const end = Math.round(((row + 1) * count) / rows);
    for (let slot = 0; slot < end - first; slot++) {
      const col = row % 2 ? end - first - 1 - slot : slot;
      districts.push({
        top: first / count,
        bottom: end / count,
        left: col / (end - first),
        right: (col + 1) / (end - first),
      });
    }
  }
  return districts;
};

export interface SeatPartition {
  centers: [number, number][];
  slotAt: (row: number, col: number) => number;
}

export function insetPartition(partition: SeatPartition, scale: number): SeatPartition {
  const inverse = (value: number) => Math.max(0, Math.min(1 - Number.EPSILON, (value - 0.5) / scale + 0.5));
  return {
    centers: partition.centers.map(([row, col]) => [(row - 0.5) * scale + 0.5, (col - 0.5) * scale + 0.5]),
    slotAt: (row, col) => partition.slotAt(inverse(row), inverse(col)),
  };
}

export function rectangularPartition(districts: District[]): SeatPartition {
  return {
    centers: districts.map(({ top, bottom, left, right }) => [(top + bottom) / 2, (left + right) / 2]),
    slotAt: (row, col) =>
      districts.findIndex(
        ({ top, bottom, left, right }) => row >= top && row < bottom && col >= left && col < right,
      ),
  };
}

export function surroundedPartition(count: number, phase: number): SeatPartition {
  const outer = count - 1;
  const centers: [number, number][] = [[0.5, 0.5]];
  for (let slot = 0; slot < outer; slot++) {
    const turn = (((slot + 0.5) / outer + phase) % 1) * 4,
      side = Math.floor(turn),
      offset = turn - side;
    const along = [1 - offset, -offset, offset - 1, offset][side],
      across = [offset, 1 - offset, -offset, offset - 1][side];
    centers.push([0.5 + 0.47 * along, 0.5 + 0.47 * across]);
  }
  return {
    centers,
    slotAt: (row, col) => {
      const vertical = row - 0.5,
        horizontal = col - 0.5,
        distance = Math.abs(vertical) + Math.abs(horizontal);
      if (distance < Math.sqrt(0.5 / count)) return 0;
      const turn =
        vertical >= 0
          ? horizontal >= 0
            ? horizontal / distance
            : 3 + vertical / distance
          : horizontal >= 0
            ? 1 - vertical / distance
            : 2 - horizontal / distance;
      return 1 + Math.min(outer - 1, Math.floor(((turn / 4 - phase + 1) % 1) * outer));
    },
  };
}
