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

export type SecurityEventType =
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
}

interface SecurityAuditFile {
  entries: SecurityAuditEntry[];
}

export interface SecurityAuditQuery {
  type?: string;
  username?: string;
  ip?: string;
}

export class SecurityAuditStore {
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
    return entry.result ? { ...entry.result } : null;
  }

  private prune(): void {
    this.entries = this.entries.slice(-SECURITY_AUDIT_MAX_ENTRIES);
    while (
      this.entries.length > 0 &&
      Buffer.byteLength(JSON.stringify({ entries: this.entries })) > SECURITY_AUDIT_MAX_BYTES
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
          await writeFile(tmp, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
          await rename(tmp, this.file);
        } while (this.dirty);
      })().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
}
