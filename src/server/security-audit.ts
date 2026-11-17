import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SECURITY_AUDIT_MAX_ENTRIES = 2000;
export const SECURITY_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
export const USERNAME_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const USERNAME_SCAN_START_DELAY_MS = 10_000;
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REGISTRATION_MAX_SUCCESSFUL_PER_WINDOW = 2;
export const REGISTRATION_DENIAL_MS = 24 * 60 * 60 * 1000;
export const IP_HISTORY_MAX = 20;
export const IP_ACTIVITY_WRITE_THROTTLE_MS = 5 * 60 * 1000;

export interface UsernameScanResult {
  scanned: number;
  hits: number;
  autoBanned: number;
  skipped: number;
  completedAt: number;
}

export interface ContentCursor {
  time: number;
  keys: string[];
}
export interface ContentScanResult {
  scanned: number;
  posts: number;
  comments: number;
  hits: number;
  completedAt: number;
  cursor: ContentCursor;
}
export interface ContentEvidence {
  kind: 'post' | 'comment';
  postId: string;
  commentId?: string;
  versionTime: number;
  terms: string[];
  text: string;
}
export type SecurityEventType =
  | 'content_manual_review'
  | 'content_scan_completed'
  | 'username_rejected'
  | 'username_auto_banned'
  | 'username_manual_review'
  | 'possible_ban_evasion'
  | 'registration_rate_limited'
  | 'username_scan_completed';

export interface SecurityAuditEntry {
  id: string;
  at: number;
  type: SecurityEventType;
  action: string;
  reason: string;
  username?: string;
  ip?: string;
  relatedUsernames?: string[];
  result?: UsernameScanResult;
  content?: ContentEvidence;
  contentResult?: ContentScanResult;
}

interface SecurityAuditFile {
  contentCursor?: ContentCursor;
  entries: SecurityAuditEntry[];
}

export interface SecurityAuditQuery {
  type?: string;
  username?: string;
  ip?: string;
}

export class SecurityAuditStore {
  private contentCursor?: ContentCursor;
  private entries: SecurityAuditEntry[] = [];
  private readonly file: string;
  private pending?: Promise<void>;
  private dirty = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'security-audit.json');
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as SecurityAuditFile;
      if (!Array.isArray(parsed.entries)) throw new Error('Invalid security audit');
      if (
        parsed.contentCursor &&
        Number.isFinite(parsed.contentCursor.time) &&
        Array.isArray(parsed.contentCursor.keys) &&
        parsed.contentCursor.keys.every((key) => typeof key === 'string')
      ) {
        this.contentCursor = structuredClone(parsed.contentCursor);
      }
      this.entries = parsed.entries.filter(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.at === 'number' &&
          Number.isFinite(entry.at) &&
          typeof entry.type === 'string' &&
          typeof entry.action === 'string' &&
          typeof entry.reason === 'string',
      );
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.flush();
  }

  async record(entry: Omit<SecurityAuditEntry, 'id' | 'at'> & { at?: number }): Promise<SecurityAuditEntry> {
    const stored: SecurityAuditEntry = {
      ...entry,
      id: randomUUID(),
      at: entry.at ?? Date.now(),
      relatedUsernames: entry.relatedUsernames ? [...entry.relatedUsernames] : undefined,
      result: entry.result ? { ...entry.result } : undefined,
    };
    this.entries.push(stored);
    this.prune();
    await this.flush();
    return {
      ...stored,
      relatedUsernames: stored.relatedUsernames ? [...stored.relatedUsernames] : undefined,
    };
  }

  list(query: SecurityAuditQuery = {}, limit = 100): SecurityAuditEntry[] {
    const username = query.username?.trim().toLowerCase() ?? '';
    const ip = query.ip?.trim().toLowerCase() ?? '';
    const capped = Math.max(1, Math.min(100, Math.floor(limit) || 100));
    return this.entries
      .filter(
        (entry) =>
          (!query.type || entry.type === query.type) &&
          (!username ||
            entry.username?.toLowerCase().includes(username) ||
            entry.relatedUsernames?.some((item) => item.toLowerCase().includes(username))) &&
          (!ip || entry.ip?.toLowerCase().includes(ip)),
      )
      .slice(-capped)
      .reverse()
      .map((entry) => ({
        ...entry,
        relatedUsernames: entry.relatedUsernames ? [...entry.relatedUsernames] : undefined,
        result: entry.result ? { ...entry.result } : undefined,
      }));
  }

  count(type: SecurityEventType, since = 0): number {
    return this.entries.filter((entry) => entry.type === type && entry.at >= since).length;
  }

  latest(type: SecurityEventType, ip?: string): SecurityAuditEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === type && (!ip || entry.ip === ip)) return { ...entry };
    }
    return null;
  }

  latestScan(): UsernameScanResult | null {
    const entry = this.latest('username_scan_completed');
    return entry?.result ? { ...entry.result } : null;
  }

  getContentCursor(): ContentCursor | undefined {
    return this.contentCursor ? structuredClone(this.contentCursor) : undefined;
  }

  /** Commit a complete scan and its checkpoint in one atomic audit write. */
  async completeContentScan(entries: Omit<SecurityAuditEntry, 'id'>[], cursor: ContentCursor): Promise<void> {
    await this.flush();
    const previousEntries = [...this.entries];
    const previousCursor = this.contentCursor;
    const batch = entries.map((entry) => ({ ...structuredClone(entry), id: randomUUID() }));
    const batchIds = new Set<string>(batch.map((entry) => entry.id));
    this.entries.push(...batch);
    this.contentCursor = structuredClone(cursor);
    try {
      await this.flush();
    } catch (error) {
      // Retain unrelated events appended while the write was pending.
      this.entries = [
        ...previousEntries,
        ...this.entries.filter((entry) => !batchIds.has(entry.id) && !previousEntries.includes(entry)),
      ];
      this.contentCursor = previousCursor;
      throw error;
    }
  }

  private prune(): void {
    this.entries = this.entries.slice(-SECURITY_AUDIT_MAX_ENTRIES);
    while (
      this.entries.length > 0 &&
      Buffer.byteLength(JSON.stringify({ entries: this.entries, contentCursor: this.contentCursor })) >
        SECURITY_AUDIT_MAX_BYTES
    ) {
      this.entries.shift();
    }
  }

  flush(): Promise<void> {
    this.dirty = true;
    if (!this.pending) {
      this.pending = (async () => {
        do {
          this.dirty = false;
          this.prune();
          const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
          const serialized = JSON.stringify({ entries: this.entries, contentCursor: this.contentCursor });
          if (Buffer.byteLength(serialized) > SECURITY_AUDIT_MAX_BYTES)
            throw new Error('Content checkpoint exceeds audit size limit');
          await writeFile(tmp, serialized, {
            mode: 0o600,
          });
          await rename(tmp, this.file);
        } while (this.dirty);
      })().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
}
