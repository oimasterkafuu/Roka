import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzip, gzip } from 'node:zlib';
import {
  CoalescingFileWriter,
  decodeBinary,
  encodeBinary,
  readFileWithBackup,
  writeFileAtomicWithBackup,
} from './binary-store';
import { encodeReplayPatchBinary, REPLAY_BINARY_MAGIC } from './replay-patch-binary';
import { ReplayActionData, ReplayData, ReplayListItem } from './types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const REPLAY_FILENAME_REGEX = /^[0-9A-Za-z+-]+$/;
const REPLAY_EXT = '.rpl';
const REPLAY_VIEW_EXT = '.rpb.gz';
const REPLAY_INDEX_BIN = 'index.bin';

interface ReplayStoreOptions {
  buildReplayFromActions: (replay: ReplayActionData) => Promise<ReplayData>;
}

interface ReplaySaveSummary {
  rank: string[];
  teams: { members: string[]; color: number }[];
  turn: number;
}

const encodeReplayBinary = <T>(value: T): Promise<Buffer> => encodeBinary(value);

const decodeReplayBinary = <T>(content: Buffer): Promise<T> => decodeBinary<T>(content);

export const getReplayId = (content: Buffer): string => {
  const hash = createHash('sha256').update(content).digest().subarray(0, 9);
  return hash.toString('base64').replaceAll('/', '-');
};

export const isReplayIdValid = (id: string): boolean => REPLAY_FILENAME_REGEX.test(id);

export class ReplayStore {
  private readonly replayDir: string;

  private readonly indexFile: string;

  private readonly buildReplayFromActions: ReplayStoreOptions['buildReplayFromActions'];

  // 索引内存缓存：读路径不再每次读盘反序列化，写路径更新缓存后合并落盘。
  private indexCache: ReplayListItem[] | null = null;

  // 索引写盘合并串行化：突发连续写入只落盘一次（见 binary-store）。
  private readonly indexWriter: CoalescingFileWriter;

  constructor(replayDir: string, options: ReplayStoreOptions) {
    this.replayDir = replayDir;
    this.indexFile = path.join(replayDir, REPLAY_INDEX_BIN);
    this.indexWriter = new CoalescingFileWriter(this.indexFile);
    this.buildReplayFromActions = options.buildReplayFromActions;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.replayDir, { recursive: true });
    await this.saveIndex(await this.loadIndex());
  }

  private async loadIndex(): Promise<ReplayListItem[]> {
    if (this.indexCache) {
      return [...this.indexCache];
    }
    let items: ReplayListItem[] = [];
    try {
      // 索引是未压缩的 v8 serialize（历史格式保持不变），损坏时回退 .bak。
      const parsed = await readFileWithBackup(this.indexFile, (content) =>
        content.length === 0 ? [] : (deserialize(content) as ReplayListItem[]),
      );
      if (Array.isArray(parsed)) {
        items = parsed;
      }
    } catch {
      // 索引整体不可读（含备份）：按空索引处理，回放文件仍在，可后续重建。
      console.warn(`[storage] ${this.indexFile} 及其备份均不可读，索引按空处理。`);
    }
    this.indexCache = items;
    return [...items];
  }

  private async saveIndex(items: ReplayListItem[]): Promise<void> {
    this.indexCache = [...items];
    // serialize 同步执行拿到快照；索引不压缩（保持历史格式），写盘经合并队列。
    const raw = serialize(items);
    await this.indexWriter.write(() => Promise.resolve(raw));
  }

  async saveReplay(replay: ReplayActionData, summary: ReplaySaveSummary): Promise<string> {
    const binary = await encodeReplayBinary(replay);
    const replayId = getReplayId(binary);
    const replayPath = path.join(this.replayDir, `${replayId}${REPLAY_EXT}`);

    // 回放文件内容按哈希寻址、不可变；原子写入（临时文件 + rename）。
    await writeFileAtomicWithBackup(replayPath, binary);

    const replayItem: ReplayListItem = {
      time: Math.floor(Date.now() / 1000),
      id: replayId,
      rank: [...summary.rank],
      teams: summary.teams.map((team) => ({ members: [...team.members], color: team.color })),
      turn: summary.turn,
    };

    const items = await this.loadIndex();
    items.push(replayItem);
    items.sort((a, b) => b.time - a.time);
    await this.saveIndex(items);

    return replayId;
  }

  async loadReplay(id: string): Promise<ReplayData> {
    const content = await this.readRawReplay(id);
    const replay = await decodeReplayBinary<ReplayActionData>(content);
    return this.buildReplayFromActions(replay);
  }

  /**
   * 读取回放的原始存储文件（ops-v1 操作流，几百字节），用于“下载回放”。
   */
  async readRawReplay(id: string): Promise<Buffer> {
    return readFile(this.resolveReplayPath(id, REPLAY_EXT));
  }

  private resolveReplayPath(id: string, ext: string): string {
    if (!isReplayIdValid(id)) {
      throw new Error('Invalid replay id.');
    }
    const replayPath = path.resolve(this.replayDir, `${id}${ext}`);
    const replayRoot = `${path.resolve(this.replayDir)}${path.sep}`;
    if (!replayPath.startsWith(replayRoot)) {
      throw new Error('Invalid replay path.');
    }
    return replayPath;
  }

  /**
   * 读取回放的可观看二进制（RPB）gzip 压缩缓存。
   * 回放内容不可变：首次请求时重建整场对局、转码、压缩后落盘缓存，
   * 之后直接读缓存文件，避免每次观看都重复重建。
   * 返回的 size 为解压后大小（缓存命中时取自 gzip 尾部 ISIZE），供客户端显示加载进度。
   */
  async readReplayViewGzip(id: string): Promise<{ gzip: Buffer; size: number }> {
    const cachePath = this.resolveReplayPath(id, REPLAY_VIEW_EXT);
    try {
      const cached = await readFile(cachePath);
      if (cached.length >= 4) {
        // 编码格式升级（如 RPB3→RPB4）后旧缓存作废：校验解压后的魔数，不匹配则重建。
        const raw = (await gunzipAsync(cached)) as Buffer;
        if (raw.length >= 4 && raw.subarray(0, 4).toString('latin1') === REPLAY_BINARY_MAGIC) {
          return { gzip: cached, size: cached.readUInt32LE(cached.length - 4) };
        }
      }
    } catch {
      // 缓存不存在或损坏，走下方重建。
    }

    const replay = await this.loadReplay(id);
    const binary = encodeReplayPatchBinary(replay);
    const compressed = (await gzipAsync(binary)) as Buffer;
    await writeFileAtomicWithBackup(cachePath, compressed);
    return { gzip: compressed, size: binary.length };
  }

  /**
   * 将上传的原始回放文件（ops-v1 操作流）解码并重建为可观看的回放数据。
   * 版本不符或数据损坏时抛错，由上层返回“不兼容”。
   */
  async buildReplayFromRaw(content: Buffer): Promise<ReplayData> {
    const replay = await decodeReplayBinary<ReplayActionData>(content);
    if (!replay || replay.version !== 'ops-v1') {
      throw new Error('回放版本不兼容。');
    }
    return this.buildReplayFromActions(replay);
  }

  /**
   * 删除回放（原始文件 + 索引项）。用于清理已不兼容的旧回放。
   */
  async deleteReplay(id: string): Promise<void> {
    if (!isReplayIdValid(id)) {
      return;
    }
    await rm(this.resolveReplayPath(id, REPLAY_EXT), { force: true });
    await rm(this.resolveReplayPath(id, REPLAY_VIEW_EXT), { force: true });
    const items = await this.loadIndex();
    const next = items.filter((item) => item.id !== id);
    if (next.length !== items.length) {
      await this.saveIndex(next);
    }
  }

  async listReplays(): Promise<ReplayListItem[]> {
    const items = await this.loadIndex();
    items.sort((a, b) => b.time - a.time);
    return items;
  }

  async listReplaysByPlayer(username: string): Promise<ReplayListItem[]> {
    const items = await this.listReplays();
    return items.filter((item) => Array.isArray(item.rank) && item.rank.includes(username));
  }
}
