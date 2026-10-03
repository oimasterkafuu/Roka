/**
 * @ 提及：动态/评论正文中的 @用户名 → 可点击的用户名链接。
 *
 * 用户名规则与注册一致（[A-Za-z0-9_]{3,20}）。解析在写入时落库（parseMentionTokens），
 * 渲染在服务端富文本消毒之后进行（renderMentionsInHtml）——只替换不在 code/pre/a
 * 内的文本，解析不到对应用户（不存在或改名）时按普通文本降级。
 */

// 前一个字符不能是单词字符或 @（排除邮箱 a@b.com 与 @@），后一个字符不能续接单词字符
// （排除 @abcdefghijklmnopqrstuv（21 位）这类超长串）。
const MENTION_SOURCE = '(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])';

const SKIP_TAGS = new Set(['code', 'pre', 'a']);

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const mentionAnchorHtml = (username: string): string => {
  const escaped = escapeHtml(username);
  return `<a href="/u/${encodeURIComponent(username)}" class="mention rt-unrated" data-username="${escaped}">@${escaped}</a>`;
};

/**
 * 提取正文中的提及候选：按出现顺序去重（大小写不敏感），保留原文大小写。
 */
export const parseMentionTokens = (text: string): string[] => {
  const pattern = new RegExp(MENTION_SOURCE, 'g');
  const seen = new Set<string>();
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[1];
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
};

export interface MentionRenderResult {
  html: string;
  /** 实际渲染为链接的用户名（规范大小写、去重、按出现顺序），供前端批量补 rating 颜色。 */
  mentions: string[];
}

/**
 * 把消毒后的 HTML 中的 @提及渲染为用户名链接。
 * resolve 返回用户名规范形式表示用户存在，返回 null 则保持普通文本。
 */
export const renderMentionsInHtml = (
  html: string,
  resolve: (token: string) => string | null,
): MentionRenderResult => {
  const pattern = new RegExp(MENTION_SOURCE, 'g');
  const mentions: string[] = [];
  const seen = new Set<string>();
  let skipDepth = 0;

  // 按标签 / 文本切分：标签原样保留并维护 code/pre/a 跳过深度，只在文本里替换提及。
  const output = html.replace(/(<[^>]*>)|([^<]+)/g, (segment: string, tag?: string) => {
    if (tag) {
      const name = /^<\/?\s*([A-Za-z0-9]+)/.exec(tag)?.[1]?.toLowerCase();
      if (name && SKIP_TAGS.has(name) && !/\/>$/.test(tag)) {
        if (/^<\//.test(tag)) {
          skipDepth = Math.max(0, skipDepth - 1);
        } else {
          skipDepth += 1;
        }
      }
      return tag;
    }
    if (skipDepth > 0) {
      return segment;
    }
    return segment.replace(pattern, (full: string, token: string) => {
      const canonical = resolve(token);
      if (!canonical) {
        return full;
      }
      const key = canonical.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(canonical);
      }
      return mentionAnchorHtml(canonical);
    });
  });

  return { html: output, mentions };
};
