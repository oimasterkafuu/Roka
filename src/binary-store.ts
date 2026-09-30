import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export const isMissingFileError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT',
  );

/**
 * 统一二进制编码：v8 serialize + brotli（quality 6，与历史文件一致）。
 * 磁盘格式不变，旧数据无需迁移即可直接读取。
 */
export const encodeBinary = async (value: unknown): Promise<Buffer> => {
  const raw = serialize(value);
  return encodeRawBinary(raw);
};

/** 对已 serialize 的快照做 brotli 压缩（供 CoalescingFileWriter 惰性压缩使用）。 */
export const encodeRawBinary = async (raw: Buffer): Promise<Buffer> =>
  (await brotliCompressAsync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  })) as Buffer;

export const decodeBinary = async <T>(content: Buffer): Promise<T> => {
  const raw = (await brotliDecompressAsync(content)) as Buffer;
  return deserialize(raw) as T;
};

const backupPathOf = (filePath: string): string => `${filePath}.bak`;

/**
 * 原子写入（临时文件 + rename），并在替换前把当前文件复制为 `.bak` 备份：
 * 新文件写入/传输损坏或进程崩溃时，下次启动可回退到上一份完好数据。
 */
export const writeFileAtomicWithBackup = async (
  filePath: string,
  content: Buffer | string,
): Promise<void> => {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, content);
  try {
    await copyFile(filePath, backupPathOf(filePath));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  await rename(tmpPath, filePath);
};

/**
 * 读取并解码数据文件，主文件缺失或损坏时自动回退 `.bak` 备份。
 * 主文件与备份均不存在时抛出 ENOENT（调用方据此按「首次运行」处理）。
 */
export const readFileWithBackup = async <T>(
  filePath: string,
  decode: (content: Buffer) => Promise<T> | T,
): Promise<T> => {
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    // 主文件不存在：尝试备份（也不存在时 ENOENT 继续上抛）。
    const backup = await readFile(backupPathOf(filePath));
    return decode(backup);
  }
  try {
    return await decode(content);
  } catch (error) {
    try {
      const backup = await readFile(backupPathOf(filePath));
      const value = await decode(backup);
      console.warn(`[storage] ${filePath} 解析失败，已从 .bak 备份恢复。`);
      return value;
    } catch {
      throw error;
    }
  }
};

interface WriteJob {
  encode: () => Promise<Buffer>;
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

/**
 * 合并写盘器：同一文件的写请求串行执行；尚未开始的排队写请求会被后来的请求合并
 * （encode 闭包替换为最新快照，先到的等待者随合并后的写一并完成——后来的快照
 * 包含先到的全部修改，耐久性语义不变）。突发连续写入因此只产生一次压缩与落盘。
 */
export class CoalescingFileWriter {
  private readonly filePath: string;

  private queued: WriteJob | null = null;

  private running = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** encode 惰性执行：被合并丢弃的快照不会产生压缩开销。 */
  write(encode: () => Promise<Buffer>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.queued) {
        this.queued.encode = encode;
        this.queued.waiters.push({ resolve, reject });
        return;
      }
      this.queued = { encode, waiters: [{ resolve, reject }] };
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queued) {
        const job = this.queued;
        this.queued = null;
        try {
          const content = await job.encode();
          await writeFileAtomicWithBackup(this.filePath, content);
          for (const waiter of job.waiters) {
            waiter.resolve();
          }
        } catch (error) {
          for (const waiter of job.waiters) {
            waiter.reject(error);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
