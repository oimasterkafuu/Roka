import { FOG_MODES, LeaderboardEntry, ReplayData, ReplayPatchPayload, UpdatePayload } from './types';

/** 当前回放观看二进制魔数（ASCII），供缓存陈旧性校验。 */
export const REPLAY_BINARY_MAGIC = 'RPB5';

const REPLAY_META_EXTENSION_MARKER = 0xa5;

const classToCode = (value: string): number => {
  if (value === 'dead') {
    return 1;
  }
  if (value === 'afk') {
    return 2;
  }
  return 0;
};

// 分块写入：超长回放编码结果可达数十 MB，若像旧实现那样把每个字节压进
// 同一个 JS 数组（2800 万元素），数组扩容与 Buffer.from 转换会把内存打爆
// （issue #83：超长对局回放重建时进程被 OOM killer 杀掉）。
// 改为顺序填满固定大小的块，最后一次性拼接，编码过程只多出最终产物本身的内存。
const WRITE_CHUNK_SIZE = 1024 * 1024;

class ByteWriter {
  private readonly chunks: Buffer[] = [];

  private current: Buffer = Buffer.allocUnsafe(WRITE_CHUNK_SIZE);

  private offset = 0;

  private ensure(size: number): void {
    if (this.offset + size > this.current.length) {
      this.chunks.push(this.current.subarray(0, this.offset));
      this.current = Buffer.allocUnsafe(WRITE_CHUNK_SIZE);
      this.offset = 0;
    }
  }

  writeU8(value: number): void {
    this.ensure(1);
    this.current[this.offset] = value & 0xff;
    this.offset += 1;
  }

  writeU16(value: number): void {
    this.ensure(2);
    this.current.writeUInt16LE(value & 0xffff, this.offset);
    this.offset += 2;
  }

  writeU32(value: number): void {
    this.ensure(4);
    this.current.writeUInt32LE(value >>> 0, this.offset);
    this.offset += 4;
  }

  writeVarUint(value: number): void {
    while (value >= 128) {
      this.writeU8((value & 127) | 128);
      value >>>= 7;
    }
    this.writeU8(value);
  }

  writeBytes(buffer: Uint8Array): void {
    let rest = buffer;
    while (rest.length > 0) {
      if (this.offset >= this.current.length) {
        this.chunks.push(this.current);
        this.current = Buffer.allocUnsafe(WRITE_CHUNK_SIZE);
        this.offset = 0;
      }
      const writable = Math.min(rest.length, this.current.length - this.offset);
      this.current.set(rest.subarray(0, writable), this.offset);
      this.offset += writable;
      rest = rest.subarray(writable);
    }
  }

  writeString(value: string): void {
    const text = String(value ?? '');
    const raw = Buffer.from(text, 'utf-8');
    if (raw.length > 0xffff) {
      throw new Error('字符串长度超过 65535，无法编码到回放二进制。');
    }
    this.writeU16(raw.length);
    this.writeBytes(raw);
  }

  toBuffer(): Buffer {
    this.chunks.push(this.current.subarray(0, this.offset));
    this.current = Buffer.allocUnsafe(0);
    this.offset = 0;
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
  }
}

const normalizeU32 = (value: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num <= 0) {
    return 0;
  }
  if (num >= 0xffffffff) {
    return 0xffffffff;
  }
  return Math.floor(num);
};

const writeLeaderboard = (writer: ByteWriter, leaderboard: LeaderboardEntry[]): void => {
  writer.writeU16(leaderboard.length);
  for (const item of leaderboard) {
    writer.writeU8(normalizeU32(item.team));
    writer.writeString(item.uid);
    writer.writeU32(normalizeU32(item.army));
    writer.writeU32(normalizeU32(item.land));
    writer.writeU8(classToCode(item.class_));
    writer.writeU16(normalizeU32(item.dead));
    writer.writeU8(normalizeU32(item.id));
  }
};

const writeDiffU8 = (writer: ByteWriter, diff: number[]): void => {
  if (diff.length % 2 !== 0) {
    throw new Error('回放 patch grid diff 长度非法。');
  }
  const pairCount = diff.length / 2;
  writer.writeU32(pairCount);
  for (let i = 0; i < diff.length; i += 2) {
    const index = normalizeU32(diff[i]);
    if (index > 0xffff) {
      throw new Error('地图索引超过 65535，当前回放二进制格式不支持。');
    }
    writer.writeU16(index);
    writer.writeU8(normalizeU32(diff[i + 1]));
  }
};

const writeDiffU32 = (writer: ByteWriter, diff: number[]): void => {
  if (diff.length % 2 !== 0) {
    throw new Error('回放 patch army diff 长度非法。');
  }
  const pairCount = diff.length / 2;
  writer.writeU32(pairCount);
  for (let i = 0; i < diff.length; i += 2) {
    const index = normalizeU32(diff[i]);
    if (index > 0xffff) {
      throw new Error('地图索引超过 65535，当前回放二进制格式不支持。');
    }
    writer.writeU16(index);
    writer.writeU32(normalizeU32(diff[i + 1]));
  }
};

const writeFullGrid = (writer: ByteWriter, grid: number[]): void => {
  writer.writeU32(grid.length);
  for (let i = 0; i < grid.length; i += 1) {
    writer.writeU8(normalizeU32(grid[i]));
  }
};

const writeFullArmy = (writer: ByteWriter, army: number[]): void => {
  writer.writeU32(army.length);
  for (let i = 0; i < army.length; i += 1) {
    writer.writeU32(normalizeU32(army[i]));
  }
};

const writeInitialPayload = (writer: ByteWriter, initial: UpdatePayload): void => {
  writer.writeU32(normalizeU32(initial.turn));
  writer.writeU8(initial.game_end ? 1 : 0);
  writeLeaderboard(writer, initial.leaderboard);
  writeFullGrid(writer, initial.grid_type);
  writeFullArmy(writer, initial.army_cnt);
  writeFullGrid(writer, initial.isolated);
};

const writePatchPayload = (writer: ByteWriter, payload: ReplayPatchPayload): void => {
  writer.writeU32(normalizeU32(payload.turn));
  writer.writeU8(payload.game_end ? 1 : 0);
  writeLeaderboard(writer, payload.leaderboard);
  writeDiffU8(writer, payload.grid_type);
  writeDiffU32(writer, payload.army_cnt);
  writeDiffU8(writer, payload.isolated);
};

const writeReplayMeta = (writer: ByteWriter, replay: ReplayData): void => {
  const { player_names: playerNames, player_teams: playerTeams, fog_mode: mode } = replay.meta;
  const aiDifficulty = replay.meta.ai_difficulty === 'simple' ? 1 : 0;
  const serverBotSeats = replay.meta.server_bot_seats ?? [];
  const count = playerNames.length;
  writer.writeU16(count);
  for (let i = 0; i < count; i += 1) {
    writer.writeString(playerNames[i]);
    writer.writeU8(normalizeU32(playerTeams[i]));
  }
  writer.writeU8(FOG_MODES.indexOf(mode));
  writer.writeU8(REPLAY_META_EXTENSION_MARKER);
  writer.writeU8(aiDifficulty);
  writer.writeU8(serverBotSeats.length);
  for (const seat of serverBotSeats) {
    if (!Number.isInteger(seat) || seat < 1 || seat > count) {
      throw new Error('回放托管席位元数据非法。');
    }
    writer.writeU8(seat);
  }
  if (mode === 'visible') return;
  writer.writeU8(replay.vision.size);
  for (const [team, { omniscientFrom, cells }] of replay.vision) {
    writer.writeU8(team);
    writer.writeU32(omniscientFrom ?? 0xffffffff);
    writer.writeU32(cells.size);
    for (const [cell, turns] of cells) {
      writer.writeU16(cell);
      writer.writeVarUint(turns.length);
      let previous = 0;
      for (const turn of turns) {
        writer.writeVarUint(turn - previous);
        previous = turn;
      }
    }
  }
};

export const encodeReplayPatchBinary = (replay: ReplayData): Buffer => {
  if (replay.n > 0xffff || replay.m > 0xffff || replay.n * replay.m > 0x10000) {
    throw new Error('地图尺寸超过当前回放二进制格式限制。');
  }
  const writer = new ByteWriter();
  writer.writeBytes(Buffer.from(REPLAY_BINARY_MAGIC, 'ascii'));
  writer.writeU16(replay.n);
  writer.writeU16(replay.m);
  writer.writeU32(replay.patches.length);
  writeInitialPayload(writer, replay.initial);
  for (const patch of replay.patches) {
    writePatchPayload(writer, patch.forward);
    writePatchPayload(writer, patch.backward);
  }
  writeReplayMeta(writer, replay);
  return writer.toBuffer();
};
