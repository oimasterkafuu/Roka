import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { CoalescingFileWriter, readFileWithBackup, writeFileAtomicWithBackup } from './binary-store';
import { encodeRpl, inspectRpl } from './rpl';
import type { ReplayActionData, ReplayListItem } from './types';
const REPLAY_FILENAME_REGEX = /^[0-9A-Za-z+-]+$/;
const REPLAY_EXT = '.rpl';
const REPLAY_INDEX_BIN = 'index.bin';
interface ReplaySaveSummary {
  rank: string[];
  teams: { members: string[]; color: number }[];
  turn: number;
}

export const getReplayId = (content: Buffer): string => {
  const hash = createHash('sha256').update(content).digest().subarray(0, 9);
  return hash.toString('base64').replaceAll('/', '-');
};

export const isReplayIdValid = (id: string): boolean => REPLAY_FILENAME_REGEX.test(id);

export class ReplayStore {
  private readonly replayDir: string;

  private readonly indexFile: string;

  // 索引内存缓存：读路径不再每次读盘反序列化，写路径更新缓存后合并落盘。
  private indexCache: ReplayListItem[] | null = null;

  // 索引写盘合并串行化：突发连续写入只落盘一次（见 binary-store）。
  private readonly indexWriter: CoalescingFileWriter;

  constructor(replayDir: string) {
    this.replayDir = replayDir;
    this.indexFile = path.join(replayDir, REPLAY_INDEX_BIN);
    this.indexWriter = new CoalescingFileWriter(this.indexFile);
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
    const binary = Buffer.from(await encodeRpl(replay));
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

  async readRawReplay(id: string): Promise<Buffer> {
    const bytes = await readFile(this.resolveReplayPath(id, REPLAY_EXT));
    inspectRpl(bytes);
    if (getReplayId(bytes) !== id) throw Error('回放损坏：内容 ID 不匹配');
    return bytes;
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

  async deleteReplay(id: string): Promise<void> {
    if (!isReplayIdValid(id)) {
      return;
    }
    await rm(this.resolveReplayPath(id, REPLAY_EXT), { force: true });
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
