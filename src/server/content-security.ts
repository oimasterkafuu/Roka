import type { FeedPost, FeedComment } from '../types';
import { inspectContent } from './content-policy';
import { SecurityAuditStore } from './security-audit';

// Called only after a successful create/edit. No scan, cursor or timer.
export class ContentSecurityService {
  constructor(private readonly audit: SecurityAuditStore) {}
  reviewPost(post: FeedPost): Promise<void> {
    return this.review('post', post.id, undefined, post.author, post.text, post.editedAt ?? post.time);
  }
  reviewComment(postId: string, comment: FeedComment): Promise<void> {
    return this.review('comment', postId, comment.id, comment.author, comment.text, comment.time);
  }
  private async review(
    kind: 'post' | 'comment',
    postId: string,
    commentId: string | undefined,
    username: string,
    text: string,
    versionTime: number,
  ): Promise<void> {
    const inspection = inspectContent(text);
    if (!inspection.violated) return;
    await this.audit.record({
      at: Date.now(),
      type: 'content_manual_review',
      action: 'flag_for_review',
      reason: '动态/评论内容命中，待人工复核',
      username,
      content: {
        kind,
        postId,
        commentId,
        versionTime,
        terms: inspection.terms,
        text: text.slice(0, kind === 'post' ? 300 : 200),
      },
    });
  }
}
