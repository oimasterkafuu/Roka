import type { ReplayFrame } from './types';

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return ~crc >>> 0;
}

export function stateCrc(frame: ReplayFrame): number {
  let crc = -1;
  function word(value: number) {
    for (let shift = 0; shift < 32; shift += 8) crc = (crc >>> 8) ^ table[(crc ^ (value >>> shift)) & 255];
  }
  word(frame.turn);
  for (const field of [frame.grid_type, frame.army_cnt, frame.isolated])
    for (const value of field) word(value);
  for (const player of frame.leaderboard)
    for (const value of [player.id, player.team, player.army, player.land, player.dead]) word(value);
  return ~crc >>> 0;
}
