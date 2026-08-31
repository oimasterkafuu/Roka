import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Announcement {
  text: string;
  updatedAt: number;
  updatedBy: string;
}

export const ANNOUNCEMENT_TEXT_MAX = 500;

const isMissingFileError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT',
  );

/**
 * 全站公告存储：单个 JSON 文件，原子写入（临时文件 + rename）。
 */
export class AnnouncementStore {
  private readonly filePath: string;

  private current: Announcement = { text: '', updatedAt: 0, updatedBy: '' };

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'announcement.json');
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        this.current = {
          text: typeof record.text === 'string' ? record.text : '',
          updatedAt:
            typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
          updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : '',
        };
      }
      return;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error('announcement.json 解析失败。', { cause: error });
      }
    }

    await this.persist();
  }

  get(): Announcement {
    return { ...this.current };
  }

  async set(textInput: string, by: string): Promise<Announcement> {
    const text = textInput.trim();
    if (text.length > ANNOUNCEMENT_TEXT_MAX) {
      throw new Error(`公告内容不能超过 ${ANNOUNCEMENT_TEXT_MAX} 字。`);
    }
    this.current = { text, updatedAt: Date.now(), updatedBy: by };
    await this.persist();
    return this.get();
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.current, null, 2));
    await rename(tmpPath, this.filePath);
  }
}
