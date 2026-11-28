import { crc32 } from './rpl-check';
import {
  FOG_MODES,
  REPLAY_OPS_VERSION,
  type ReplayActionData,
  type ReplayExecutedOp,
  type ReplayMeta,
} from './types';
import { buildScheduledReplayActions } from './game-engine/replay-scheduling';
import { resolveMapSeed, resolveSeededTerrainRatio, normalizeMapToken } from './map/map-core';

// RKL + version; flags, metadata length, metadata, operation stream; CHECK followed by
// ticks:u32, seats:u8, rows/cols:u16, actions/state CRC/file CRC:u32 (little endian).
const MAGIC = [82, 75, 76, 1];
const CHECK = [67, 72, 69, 67, 75];
const TAIL = 26;
const MAX_BYTES = 8 << 20;
const MAX_ACTIONS = 500_000;
const modes = ['random', 'maze', 'archipelago', 'mediterranean', 'huaxia', 'mega_random'] as const;
const regions = ['china', 'qin', 'han', 'tang', 'liao', 'song', 'yuan', 'ming', 'taiwan'] as const;
const directions = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
function valid(condition: unknown): asserts condition {
  if (!condition) throw Error('回放损坏');
}
class Writer extends Array<number> {
  uint(value: number) {
    valid(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff);
    while (value >= 128) {
      this.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    this.push(value);
  }
  number(value: number) {
    valid(Number.isFinite(value) && value >= 0);
    const cents = Math.round(value * 100);
    if (cents < 254 && cents / 100 === value) this.push(cents);
    else {
      const buf = new DataView(new ArrayBuffer(8));
      buf.setFloat64(0, value, true);
      this.push(255, ...new Uint8Array(buf.buffer));
    }
  }
}
class Reader {
  pos = 0;
  constructor(readonly data: Uint8Array) {}
  byte() {
    valid(this.pos < this.data.length);
    return this.data[this.pos++];
  }
  take(len: number) {
    valid(this.pos + len <= this.data.length);
    const start = this.pos;
    this.pos += len;
    return this.data.subarray(start, this.pos);
  }
  uint(max = 0xffffffff) {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) {
        valid((!shift || byte) && value <= max);
        return value;
      }
    }
    throw Error('回放损坏');
  }
  number(max: number) {
    const code = this.byte();
    valid(code !== 254);
    const bytes = code === 255 ? this.take(8) : null;
    const value = bytes ? new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true) : code / 100;
    valid(Number.isFinite(value) && value >= 0 && value <= max);
    return value;
  }
  end() {
    valid(this.pos === this.data.length);
  }
}

function writeMeta(meta: ReplayMeta) {
  const out = new Writer();
  out.push(
    modes.indexOf(meta.map_mode),
    regions.indexOf(meta.map_region),
    FOG_MODES.indexOf(meta.fog_mode) |
      (+meta.allow_team << 2) |
      (+!!meta.multi_line << 3) |
      (+(meta.map_size === 'large') << 4) |
      (+(meta.ai_difficulty === 'simple') << 5),
  );
  for (const value of [meta.width_ratio, meta.height_ratio, meta.swamp_ratio, meta.speed]) out.number(value);
  const dict = Array.from(new Set([meta.map_token, ...meta.player_names]));
  out.uint(dict.length);
  for (const value of dict) {
    const bytes = utf8.encode(value);
    valid(bytes.length <= 1024);
    out.uint(bytes.length);
    out.push(...bytes);
  }
  for (const [seat, name] of meta.player_names.entries()) {
    out.uint(dict.indexOf(name));
    out.uint(meta.player_teams[seat] * 2 + Number(meta.server_bot_seats.includes(seat + 1)));
  }
  return out;
}

function readMeta(reader: Reader, seats: number): ReplayMeta {
  const map_mode = modes[reader.byte()],
    map_region = regions[reader.byte()],
    flags = reader.byte(),
    fog_mode = FOG_MODES[flags & 3];
  valid(map_mode && map_region && fog_mode && flags < 64);
  const width_ratio = reader.number(3),
    height_ratio = reader.number(3),
    swamp_ratio = reader.number(1),
    speed = reader.number(100);
  const count = reader.uint(seats + 1);
  valid(count > 0);
  const dict = Array.from({ length: count }, () => text.decode(reader.take(reader.uint(1024))));
  const map_token = dict[0],
    player_names: string[] = [],
    player_teams: number[] = [],
    server_bot_seats: number[] = [];
  for (let seat = 1; seat <= seats; seat++) {
    player_names.push(dict[reader.uint(count - 1)]);
    const team = reader.uint(33);
    player_teams.push(team >>> 1);
    if (team & 1) server_bot_seats.push(seat);
  }
  reader.end();
  const token = normalizeMapToken(map_token) || 'default';
  const seed = resolveMapSeed(map_mode, map_mode === 'huaxia' ? `${map_region}:${token}` : token);
  return {
    map_mode,
    map_region,
    fog_mode,
    allow_team: !!(flags & 4),
    multi_line: !!(flags & 8),
    map_size: flags & 16 ? 'large' : 'normal',
    ai_difficulty: flags & 32 ? 'simple' : 'normal',
    width_ratio,
    height_ratio,
    swamp_ratio,
    speed,
    map_token,
    player_names,
    player_teams,
    server_bot_seats,
    city_ratio: resolveSeededTerrainRatio(seed, 'city_ratio'),
    mountain_ratio: resolveSeededTerrainRatio(seed, 'mountain_ratio'),
  };
}

function writeOps(
  raw: ReplayActionData,
  scheduledBatches: Map<number, ReplayExecutedOp[]>[],
  interleaved: boolean,
  predict: boolean,
  split: boolean,
) {
  const out = new Writer();
  out.uint(raw.surrenders.length);
  for (const [tick, seat, phase] of raw.surrenders) {
    out.uint(tick);
    out.uint(seat * 2 + phase);
  }
  const tags = new Writer(),
    coordinates = new Writer();
  const events = scheduledBatches.flatMap((map, seat) =>
    Array.from(map, ([tick, actions]) => ({ seat, tick, actions })),
  );
  const previous = scheduledBatches.map(() => 0),
    cells = previous.slice();
  let last = 0,
    count = 0;
  if (interleaved) events.sort((left, right) => left.tick - right.tick || left.seat - right.seat);
  else for (const map of scheduledBatches) out.uint(map.size);
  for (const { seat, tick, actions } of events) {
    if (interleaved) out.uint((tick - last) * previous.length + seat);
    else out.uint(tick - previous[seat] - 1);
    last = previous[seat] = tick;
    if (raw.meta.multi_line) out.uint(actions.length - 1);
    for (const action of actions) {
      const cell = action.x * raw.cols + action.y,
        delta = cell - cells[seat];
      const dir =
        action.kind === 'm'
          ? directions.findIndex(([dx, dy]) => action.dx === action.x + dx && action.dy === action.y + dy)
          : 0;
      valid(dir >= 0);
      const tag = action.kind === 'm' ? action.mode * 4 + dir : action.kind === 'b' ? 12 : 13;
      const coord = predict ? (delta < 0 ? -delta * 2 - 1 : delta * 2) : cell;
      if (split) {
        coordinates.uint(coord);
        if (count & 1) tags[tags.length - 1] |= tag << 4;
        else tags.push(tag);
      } else out.uint(coord * 16 + tag);
      cells[seat] = action.kind === 'm' ? action.dx * raw.cols + action.dy : cell;
      count++;
    }
  }
  if (split) {
    const controlLength = new Writer();
    controlLength.uint(out.length);
    const bytes = new Uint8Array(controlLength.length + out.length + tags.length + coordinates.length);
    bytes.set(controlLength);
    bytes.set(out, controlLength.length);
    bytes.set(tags, controlLength.length + out.length);
    bytes.set(coordinates, bytes.length - coordinates.length);
    return { bytes, count };
  }
  return { bytes: Uint8Array.from(out), count };
}

async function transform(bytes: Uint8Array, compress: boolean) {
  const stream = compress ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw');
  const source = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(stream);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.length;
    if (length > MAX_BYTES) throw Error('回放损坏');
    chunks.push(chunk);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function encodeRpl(raw: ReplayActionData) {
  valid(
    raw.version === REPLAY_OPS_VERSION &&
      Number.isInteger(raw.state_crc) &&
      raw.state_crc >= 0 &&
      raw.state_crc <= 0xffffffff,
  );
  valid(
    Number.isSafeInteger(raw.rows) &&
      Number.isSafeInteger(raw.cols) &&
      raw.rows > 0 &&
      raw.cols > 0 &&
      raw.rows * raw.cols <= 65535 &&
      raw.player_ops.length <= 64 &&
      raw.total_turns <= 200000,
  );
  const { scheduledBatches } = buildScheduledReplayActions(raw, raw.rows, raw.cols);
  const meta = writeMeta(raw.meta);
  readMeta(new Reader(Uint8Array.from(meta)), raw.player_ops.length);
  let selected: Uint8Array,
    flags = 0,
    count = 0;
  for (const layout of [0, 1, 2, 3, 8, 9, 10, 11]) {
    const ops = writeOps(raw, scheduledBatches, !!(layout & 1), !!(layout & 2), !!(layout & 8));
    count = ops.count;
    valid(count <= MAX_ACTIONS && ops.bytes.length <= MAX_BYTES);
    for (const packed of [false, true]) {
      const bytes = packed ? await transform(ops.bytes, true) : ops.bytes;
      if (!selected || bytes.length < selected.length) {
        selected = bytes;
        flags = layout + (packed ? 4 : 0);
      }
    }
  }
  const head = new Writer();
  head.push(...MAGIC, flags);
  head.uint(meta.length);
  for (const byte of meta) head.push(byte);
  const bytes = new Uint8Array(head.length + selected.length + TAIL);
  bytes.set(head);
  bytes.set(selected, head.length);
  const tail = bytes.length - TAIL;
  bytes.set(CHECK, tail);
  const view = new DataView(bytes.buffer, tail);
  view.setUint32(5, raw.total_turns, true);
  view.setUint8(9, raw.player_ops.length);
  view.setUint16(10, raw.rows, true);
  view.setUint16(12, raw.cols, true);
  view.setUint32(14, count, true);
  view.setUint32(18, raw.state_crc, true);
  view.setUint32(22, crc32(bytes.subarray(0, -4)), true);
  inspectRpl(bytes);
  return bytes;
}

export function inspectRpl(bytes: Uint8Array) {
  if (!MAGIC.every((value, index) => bytes[index] === value)) throw Error('回放格式不支持');
  valid(bytes.length >= TAIL + 6 && bytes.length <= MAX_BYTES);
  const tail = bytes.length - TAIL;
  valid(CHECK.every((value, index) => bytes[tail + index] === value));
  const view = new DataView(bytes.buffer, bytes.byteOffset + tail, TAIL);
  valid(view.getUint32(22, true) === crc32(bytes.subarray(0, -4)));
  const ticks = view.getUint32(5, true),
    seats = view.getUint8(9),
    rows = view.getUint16(10, true),
    cols = view.getUint16(12, true),
    actions = view.getUint32(14, true);
  valid(
    ticks <= 200000 &&
      seats > 0 &&
      seats <= 64 &&
      rows > 0 &&
      cols > 0 &&
      rows * cols <= 65535 &&
      actions <= MAX_ACTIONS,
  );
  const header = new Reader(bytes.subarray(0, tail));
  header.pos = 4;
  const layout = header.byte();
  valid(layout < 16);
  const metaBytes = header.uint(70000),
    headerBytes = header.pos;
  header.take(metaBytes);
  return {
    headerBytes,
    metaBytes,
    opBytes: tail - header.pos,
    checkBytes: TAIL,
    explorationBytes: 0,
    layout,
    ticks,
    seats,
    rows,
    cols,
    actions,
    state_crc: view.getUint32(18, true),
  };
}

export async function decodeRpl(bytes: Uint8Array): Promise<ReplayActionData> {
  const { headerBytes, metaBytes, layout, ticks, seats, rows, cols, actions, state_crc } = inspectRpl(bytes);
  try {
    const meta = readMeta(new Reader(bytes.subarray(headerBytes, headerBytes + metaBytes)), seats);
    const payload = bytes.subarray(headerBytes + metaBytes, -TAIL),
      stream = new Reader(layout & 4 ? await transform(payload, false) : payload);
    const reader = layout & 8 ? new Reader(stream.take(stream.uint(MAX_BYTES))) : stream;
    const tags = layout & 8 ? stream.take(Math.ceil(actions / 2)) : null;
    if (tags && actions % 2) valid(tags.at(-1) < 16);
    const surrenders: ReplayActionData['surrenders'] = [];
    const seen = new Set<number>();
    let lastPhase = -1;
    for (let left = reader.uint(seats); left > 0; left--) {
      const tick = reader.uint(ticks),
        code = reader.uint(seats * 2 - 1),
        seat = code >>> 1,
        phase = code & 1;
      valid((tick > 0 || phase === 1) && tick * 2 + phase >= lastPhase && !seen.has(seat));
      seen.add(seat);
      lastPhase = tick * 2 + phase;
      surrenders.push([tick, seat, phase]);
    }
    const player_ops: ReplayActionData['player_ops'] = Array.from({ length: seats }, () => []);
    const previous = player_ops.map(() => 0),
      cells = previous.slice();
    let count = 0,
      last = 0;
    const batch = (seat: number, tick: number) => {
      valid(tick <= ticks && tick > previous[seat]);
      const wait = tick - previous[seat] - 1;
      if (wait) player_ops[seat].push({ op: 'w', n: wait });
      previous[seat] = tick;
      const size = meta.multi_line ? reader.uint(actions) + 1 : 1;
      valid(size <= actions - count);
      const batch: ReplayExecutedOp[] = [];
      for (let index = 0; index < size; index++) {
        const value = tags ? 0 : reader.uint(),
          tag = tags ? (tags[count >> 1] >> ((count & 1) * 4)) & 15 : value % 16,
          coordinate = tags ? stream.uint() : Math.floor(value / 16);
        count++;
        const cell =
          layout & 2 ? cells[seat] + (coordinate & 1 ? -(coordinate + 1) / 2 : coordinate / 2) : coordinate;
        valid(cell >= 0 && cell < rows * cols && tag < 14);
        const x = Math.floor(cell / cols),
          y = cell % cols;
        if (tag >= 12) {
          batch.push({ kind: tag === 12 ? 'b' : 'c', x, y });
          cells[seat] = cell;
        } else {
          const dir = directions[tag % 4],
            dx = x + dir[0],
            dy = y + dir[1];
          valid(dx >= 0 && dx < rows && dy >= 0 && dy < cols);
          batch.push({ kind: 'm', x, y, dx, dy, mode: (tag >>> 2) as 0 | 1 | 2 });
          cells[seat] = dx * cols + dy;
        }
      }
      player_ops[seat].push({ op: 'q', actions: batch });
    };
    if (layout & 1) {
      while (reader.pos < reader.data.length) {
        const key = reader.uint();
        last += Math.floor(key / seats);
        batch(key % seats, last);
      }
    } else {
      const sizes = previous.map(() => reader.uint(actions));
      for (const [seat, size] of sizes.entries())
        for (let index = 0; index < size; index++) batch(seat, previous[seat] + 1 + reader.uint(ticks));
    }
    valid(count === actions);
    reader.end();
    stream.end();
    return {
      version: REPLAY_OPS_VERSION,
      meta,
      total_turns: ticks,
      player_ops,
      surrenders,
      rows,
      cols,
      state_crc,
    };
  } catch {
    throw Error('回放损坏');
  }
}
