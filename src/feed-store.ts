import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serialize } from 'node:v8';
import {
  CoalescingFileWriter,
  decodeBinary,
  encodeRawBinary,
  isMissingFileError,
  readFileWithBackup,
} from './binary-store';
import { parseMentionTokens } from './mentions';
import { FeedComment, FeedPost } from './types';

interface FeedFile {
  posts: FeedPost[];
}

const POST_TEXT_MAX = 300;
const COMMENT_TEXT_MAX = 200;
const COMMENTS_PER_POST_MAX = 200;
const POST_COOLDOWN_MS = 30 * 1000;

export interface FeedPage {
  items: FeedPost[];
  total: number;
  page: number;
  pages: number;
}

export class FeedCooldownException extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('发布太频繁，请稍后再试。');
    this.name = 'FeedCooldownException';
    this.retryAfter = retryAfter;
  }
}

const decodeFeedFileBinary = async (content: Buffer): Promise<FeedFile> => decodeBinary<FeedFile>(content);

/**
 * 首页「动态」存储：推特式帖子，支持点赞与评论。
 */
export class FeedStore {
  private readonly binaryFilePath: string;

  private posts: FeedPost[] = [];

  private readonly lastPostTimeByAuthor = new Map<string, number>();

  // 写盘合并串行化：突发连续写入只压缩落盘一次（见 binary-store）。
  private readonly writer: CoalescingFileWriter;

  constructor(dataDir: string) {
    this.binaryFilePath = path.join(dataDir, 'feeds.bin');
    this.writer = new CoalescingFileWriter(this.binaryFilePath);
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.binaryFilePath), { recursive: true });

    try {
      const parsed = await readFileWithBackup(this.binaryFilePath, decodeFeedFileBinary);
      this.posts = Array.isArray(parsed.posts) ? parsed.posts : [];
      this.posts.sort((a, b) => b.time - a.time);
      return;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error('feeds.bin 解析失败。', { cause: error });
      }
    }

    await this.persist();
  }

  getById(id: string): FeedPost | null {
    return this.posts.find((item) => item.id === id) ?? null;
  }

  /** 返回供历史迁移使用的只读快照，避免暴露内部动态数组。 */
  listAll(): FeedPost[] {
    return this.posts.map((post) => ({
      ...post,
      likes: [...post.likes],
      comments: post.comments.map((comment) => ({ ...comment })),
    }));
  }

  listPage(pageInput: number, limitInput: number): FeedPage {
    const limit = Math.max(1, Math.min(50, Math.floor(limitInput) || 10));
    const total = this.posts.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.max(1, Math.min(pages, Math.floor(pageInput) || 1));
    const items = this.posts.slice((page - 1) * limit, page * limit);
    return { items, total, page, pages };
  }

  listByAuthor(author: string, pageInput: number, limitInput: number): FeedPage {
    const limit = Math.max(1, Math.min(50, Math.floor(limitInput) || 10));
    const filtered = this.posts.filter((item) => item.author === author);
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.max(1, Math.min(pages, Math.floor(pageInput) || 1));
    const items = filtered.slice((page - 1) * limit, page * limit);
    return { items, total, page, pages };
  }

  async create(author: string, textInput: string): Promise<FeedPost> {
    const text = textInput.trim();
    if (text.length === 0 || text.length > POST_TEXT_MAX) {
      throw new Error(`动态内容需为 1-${POST_TEXT_MAX} 字。`);
    }
    const lastPostTime = this.lastPostTimeByAuthor.get(author);
    if (typeof lastPostTime === 'number') {
      const elapsed = Date.now() - lastPostTime;
      if (elapsed < POST_COOLDOWN_MS) {
        throw new FeedCooldownException(Math.ceil((POST_COOLDOWN_MS - elapsed) / 1000));
      }
    }
    const mentions = parseMentionTokens(text);
    const post: FeedPost = {
      id: randomBytes(8).toString('hex'),
      author,
      text,
      time: Date.now(),
      likes: [],
      comments: [],
      mentions: mentions.length ? mentions : undefined,
    };
    this.posts.unshift(post);
    this.lastPostTimeByAuthor.set(author, Date.now());
    await this.persist();
    return post;
  }

  async update(id: string, textInput: string): Promise<FeedPost | null> {
    const post = this.posts.find((item) => item.id === id);
    if (!post) {
      return null;
    }
    const text = textInput.trim();
    if (text.length === 0 || text.length > POST_TEXT_MAX) {
      throw new Error(`动态内容需为 1-${POST_TEXT_MAX} 字。`);
    }
    post.text = text;
    const mentions = parseMentionTokens(text);
    post.mentions = mentions.length ? mentions : undefined;
    await this.persist();
    return post;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.posts.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }
    this.posts.splice(index, 1);
    await this.persist();
    return true;
  }

  async toggleLike(id: string, username: string): Promise<{ liked: boolean; likes: number } | null> {
    const post = this.posts.find((item) => item.id === id);
    if (!post) {
      return null;
    }
    const index = post.likes.indexOf(username);
    const liked = index === -1;
    if (liked) {
      post.likes.push(username);
    } else {
      post.likes.splice(index, 1);
    }
    await this.persist();
    return { liked, likes: post.likes.length };
  }

  async addComment(id: string, author: string, textInput: string): Promise<FeedComment | null> {
    const post = this.posts.find((item) => item.id === id);
    if (!post) {
      return null;
    }
    const text = textInput.trim();
    if (text.length === 0 || text.length > COMMENT_TEXT_MAX) {
      throw new Error(`评论需为 1-${COMMENT_TEXT_MAX} 字。`);
    }
    if (post.comments.length >= COMMENTS_PER_POST_MAX) {
      throw new Error('评论数量已达上限。');
    }
    const mentions = parseMentionTokens(text);
    const comment: FeedComment = {
      id: randomBytes(8).toString('hex'),
      author,
      text,
      time: Date.now(),
      mentions: mentions.length ? mentions : undefined,
    };
    post.comments.push(comment);
    await this.persist();
    return comment;
  }

  // 返回 null 表示动态不存在，false 表示评论不存在。
  async removeComment(id: string, commentId: string): Promise<boolean | null> {
    const post = this.posts.find((item) => item.id === id);
    if (!post) {
      return null;
    }
    const index = post.comments.findIndex((item) => item.id === commentId);
    if (index === -1) {
      return false;
    }
    post.comments.splice(index, 1);
    await this.persist();
    return true;
  }

  private persist(): Promise<void> {
    const data: FeedFile = { posts: this.posts };
    // serialize 同步执行，调用时即拿到状态快照；brotli 压缩惰性执行，
    // 被合并丢弃的排队写不产生压缩开销。
    const raw = serialize(data);
    return this.writer.write(() => encodeRawBinary(raw));
  }
}
