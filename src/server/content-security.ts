import { createHash } from 'node:crypto';
import type { FeedStore } from '../feed-store';
import { inspectContent } from './content-policy';
import {
  SecurityAuditStore,
  ContentScanResult,
  SecurityAuditEntry,
  USERNAME_SCAN_INTERVAL_MS,
  USERNAME_SCAN_START_DELAY_MS,
} from './security-audit';

export class ContentSecurityService {
  private running?: Promise<ContentScanResult>;
  private initialTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  constructor(
    private readonly feeds: FeedStore,
    private readonly audit: SecurityAuditStore,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now = Date.now,
  ) {}

  scan(): Promise<ContentScanResult> {
    if (this.running) return this.running;
    this.running = this.performScan().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  start(delayMs = USERNAME_SCAN_START_DELAY_MS): void {
    if (this.initialTimer || this.intervalTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.scan().catch(this.onError);
      this.intervalTimer = setInterval(() => void this.scan().catch(this.onError), USERNAME_SCAN_INTERVAL_MS);
      this.intervalTimer.unref();
    }, delayMs);
    this.initialTimer.unref();
  }
  async stop(): Promise<void> {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
    await this.running;
  }
  private async performScan(): Promise<ContentScanResult> {
    const previous = this.audit.getContentCursor();
    const cursor = previous ?? { time: 0, keys: [] };
    const keys = new Set(cursor.keys);
    const versions = this.feeds
      .listAll()
      .flatMap((post) => [
        {
          kind: 'post' as const,
          postId: post.id,
          commentId: undefined,
          author: post.author,
          text: post.text,
          time: post.editedAt ?? post.time,
        },
        ...post.comments.map((comment) => ({
          kind: 'comment' as const,
          postId: post.id,
          commentId: comment.id,
          author: comment.author,
          text: comment.text,
          time: comment.time,
        })),
      ])
      .map((version) => ({
        ...version,
        key: createHash('sha256')
          .update(JSON.stringify([version.kind, version.postId, version.commentId, version.time]))
          .digest('hex'),
      }))
      .filter(
        (version) =>
          !previous || version.time > cursor.time || (version.time === cursor.time && !keys.has(version.key)),
      )
      .sort((a, b) => a.time - b.time);
    const result: ContentScanResult = {
      scanned: versions.length,
      posts: 0,
      comments: 0,
      hits: 0,
      completedAt: 0,
      cursor: { time: cursor.time, keys: [...keys] },
    };
    const events: Omit<SecurityAuditEntry, 'id'>[] = [];
    for (const version of versions) {
      if (version.kind === 'post') result.posts++;
      else result.comments++;
      const inspection = inspectContent(version.text);
      if (inspection.violated) {
        result.hits++;
        events.push({
          at: this.now(),
          type: 'content_manual_review',
          action: 'flag_for_review',
          reason: '动态/评论内容命中，待人工复核',
          username: version.author,
          content: {
            kind: version.kind,
            postId: version.postId,
            commentId: version.commentId,
            versionTime: version.time,
            terms: inspection.terms,
            text: version.text.slice(0, version.kind === 'post' ? 300 : 200),
          },
        });
      }
      if (version.time > result.cursor.time) result.cursor = { time: version.time, keys: [] };
      if (version.time === result.cursor.time) result.cursor.keys.push(version.key);
    }
    result.completedAt = this.now();
    events.push({
      at: result.completedAt,
      type: 'content_scan_completed',
      action: 'complete_scan',
      reason: '周期内容核查完成',
      contentResult: result,
    });
    await this.audit.completeContentScan(events, result.cursor);
    return result;
  }
}
