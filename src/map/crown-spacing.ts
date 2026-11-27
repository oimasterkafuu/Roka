export const ABSOLUTE_CROWN_STEPS = 14;
const RELATIVE_CROWN_FACTOR = 1.5;
export const CROWN_AREA_PER_SEAT = Math.ceil(ABSOLUTE_CROWN_STEPS / RELATIVE_CROWN_FACTOR) ** 2;

export const crownMinimum = (passable: number, seats: number): number =>
  Math.max(ABSOLUTE_CROWN_STEPS, Math.floor(RELATIVE_CROWN_FACTOR * Math.sqrt(passable / seats)));

export function openCrownLine(tiles: Uint8Array, width: number, first: number, second: number): boolean {
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const step = Math.floor(low / width) === Math.floor(high / width) ? 1 : width;
  if (step !== 1 && low % width !== high % width) return false;
  for (let cell = low + step; cell < high; cell += step) if (tiles[cell] === 1) return false;
  return true;
}
