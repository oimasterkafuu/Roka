import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CHAT_TEXT_MAX = 500;
export const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CHAT_MAX_ENTRIES = 2000;
export const CHAT_MAX_BYTES = 2 * 1024 * 1024;
export const CHAT_EARLY_MS = 30_000;
export const CHAT_EXIT_MS = 15_000;
export const CHAT_MUTE_MS = 10 * 60 * 1000;

// Only explicit web addresses/domain names are signals; ordinary words never are.
const urlPattern =
  /(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|cn|io|moe|xyz|top|club|site|vip)(?![a-z0-9-])(?:[/:?#][^\s<>]*)?/gi;
export function webOrigins(text: string): string[] {
  const origins = new Set<string>();
  for (const match of text.matchAll(urlPattern)) {
    try {
      const url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
      if (url.hostname.includes('.')) origins.add(url.origin);
    } catch {
      /* Invalid URLs are not evidence. */
    }
  }
  return [...origins];
}

export interface ChatAuditEntry {
  id: string;
  username: string;
  room: string;
  gameId?: string;
  at: number;
  text: string;
  origins: string[];
  candidateAt?: number;
  joinedAt?: number;
  mutedUntil?: number;
  reviewedAt?: number;
  reviewedBy?: string;
}
interface Visit {
  username: string;
  room: string;
  joinedAt: number;
  eligible: boolean;
  link?: ChatAuditEntry;
}
interface ChatState {
  entries: ChatAuditEntry[];
  mutes: Record<string, number>;
}

/** Restricted audit store: no IP, socket/session token, team chat, or URL secrets. */
export class ChatModeration {
  private state: ChatState = { entries: [], mutes: Object.create(null) };
  private visits = new Map<string, Visit>();
  private rates = new Map<string, number[]>();
  private pending?: Promise<void>;
  private dirty = false;
  private file: string;

  constructor(
    dataDir: string,
    private readonly now = Date.now,
  ) {
    this.file = path.join(dataDir, 'chat-audit.json');
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as ChatState;
      if (!Array.isArray(this.state.entries) || !this.state.mutes) throw new Error('Invalid chat audit');
      this.state.mutes = Object.assign(Object.create(null), this.state.mutes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.flush();
  }

  begin(sid: string, username: string, room: string, eligible = true): void {
    if (this.visits.has(sid)) return;
    this.visits.set(sid, { username, room, joinedAt: this.now(), eligible });
  }

  /** Account-scoped limits survive reconnects; blocked attempts are never audited. */
  check(username: string): string | null {
    const now = this.now();
    const key = username.toLowerCase();
    if ((this.state.mutes[key] ?? 0) > now) {
      return '因进房发网址后迅速离开，聊天暂限 10 分钟；可联系管理员复核解除。';
    }
    this.pruneRates(now);
    const recent = this.rates.get(key) ?? [];
    if (recent.length >= 5) return '聊天过于频繁，请稍后再试。';
    recent.push(now);
    this.rates.set(key, recent);
    return null;
  }

  record(sid: string, text: string, gameId?: string): void {
    const visit = this.visits.get(sid);
    if (!visit) return;
    const at = this.now();
    const entry: ChatAuditEntry = {
      id: randomUUID(),
      username: visit.username,
      room: visit.room,
      gameId,
      at,
      // Preserve context but strip entire URL credentials, paths, queries and fragments.
      text: text.replace(urlPattern, (match) => webOrigins(match)[0] ?? '[网址]').slice(0, CHAT_TEXT_MAX),
      origins: webOrigins(text),
    };
    this.state.entries.push(entry);
    if (visit.eligible && at - visit.joinedAt <= CHAT_EARLY_MS && entry.origins.length) {
      visit.link = entry;
    }
    this.prune();
  }

  end(sid: string): void {
    const visit = this.visits.get(sid);
    this.visits.delete(sid);
    const link = visit?.link;
    const now = this.now();
    if (!link || now - link.at > CHAT_EXIT_MS || !this.state.entries.includes(link)) return;
    link.candidateAt = now;
    link.joinedAt = visit.joinedAt;
    link.mutedUntil = now + CHAT_MUTE_MS;
    const key = visit.username.toLowerCase();
    // A bounded account table separate from the log prevents log eviction bypasses.
    this.prune();
    if (Object.keys(this.state.mutes).length < CHAT_MAX_ENTRIES || key in this.state.mutes) {
      this.state.mutes[key] = link.mutedUntil;
    }
  }

  list(query: { username?: string; room?: string; candidates?: boolean; before?: string }): ChatAuditEntry[] {
    this.prune();
    const cursor = query.before
      ? this.state.entries.findIndex((entry) => entry.id === query.before)
      : this.state.entries.length;
    return this.state.entries
      .slice(0, Math.max(0, cursor))
      .filter(
        (entry) =>
          (!query.username || entry.username.toLowerCase() === query.username.toLowerCase()) &&
          (!query.room || entry.room === query.room) &&
          (!query.candidates || !!entry.candidateAt),
      )
      .slice(-100)
      .reverse()
      .map((entry) => ({ ...entry, origins: [...entry.origins] }));
  }

  release(username: string, admin: string): void {
    const now = this.now();
    delete this.state.mutes[username.toLowerCase()];
    for (const entry of this.state.entries) {
      if (entry.username.toLowerCase() === username.toLowerCase() && entry.candidateAt && !entry.reviewedAt) {
        entry.reviewedAt = now;
        entry.reviewedBy = admin;
      }
    }
  }

  private pruneRates(now: number): void {
    for (const [key, times] of this.rates) {
      const recent = times.filter((at) => now - at < 10_000);
      if (recent.length) this.rates.set(key, recent);
      else this.rates.delete(key);
    }
  }

  private prune(): void {
    const now = this.now();
    this.state.entries = this.state.entries
      .filter((entry) => now - entry.at < CHAT_RETENTION_MS)
      .slice(-CHAT_MAX_ENTRIES);
    for (const [key, until] of Object.entries(this.state.mutes)) {
      if (until <= now) delete this.state.mutes[key];
    }
    while (Buffer.byteLength(JSON.stringify(this.state)) > CHAT_MAX_BYTES && this.state.entries.length) {
      this.state.entries.shift();
    }
    this.pruneRates(now);
    for (const visit of this.visits.values()) {
      if (visit.link && now - visit.link.at > CHAT_EXIT_MS) delete visit.link;
    }
  }

  /** Serialized atomic replacement, mode 0600; no backup retaining expired/private data. */
  flush(): Promise<void> {
    this.prune();
    this.dirty = true;
    if (!this.pending) {
      this.pending = (async () => {
        do {
          this.dirty = false;
          this.prune();
          const tmp = `${this.file}.tmp`;
          await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
          await rename(tmp, this.file);
        } while (this.dirty);
      })().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
}
