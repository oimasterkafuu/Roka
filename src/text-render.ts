import katex from 'katex';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * 服务端富文本渲染：Markdown（marked，GFM + breaks）+ LaTeX（KaTeX）。
 * 数学片段先提取并替换为占位 token，marked 渲染后再换回 KaTeX HTML，
 * 最后用 sanitize-html 白名单过滤整体输出。
 */

const MATH_TOKEN_PREFIX = 'rokamathplaceholder';
const MATH_TOKEN_SUFFIX = 'rokamathplaceholder';

const EM_VALUE = /^[+-]?[0-9]*\.?[0-9]+(?:em|px|%)$/;
const EM_VALUE_OPTIONAL_ZERO = /^[+-]?[0-9]*\.?[0-9]+(?:em|px|%)?$/;

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    // Markdown 输出
    'p',
    'strong',
    'em',
    'b',
    'i',
    'code',
    'pre',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'br',
    'hr',
    'del',
    // KaTeX 输出
    'span',
    'math',
    'semantics',
    'annotation',
    'mrow',
    'mi',
    'mo',
    'mn',
    'mspace',
    'mpadded',
    'mphantom',
    'msqrt',
    'mroot',
    'mstyle',
    'merror',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'mtable',
    'mtr',
    'mtd',
    'mtext',
    'mover',
    'munder',
    'munderover',
    'menclose',
    'svg',
    'path',
    'line',
    'rect',
  ],
  allowedAttributes: {
    '*': ['class', 'style', 'aria-hidden'],
    a: ['href'],
    annotation: ['encoding'],
    math: ['xmlns', 'display'],
    mstyle: ['mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel'],
    menclose: ['notation'],
    mtable: ['rowspacing', 'columnspacing'],
    mtd: ['rowspan', 'colspan'],
    svg: ['width', 'height', 'viewbox', 'preserveaspectratio', 'xmlns'],
    path: ['d'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke-width'],
    rect: ['x', 'y', 'width', 'height', 'fill'],
  },
  allowedStyles: {
    '*': {
      height: [EM_VALUE],
      width: [EM_VALUE],
      'min-width': [EM_VALUE],
      'vertical-align': [EM_VALUE],
      top: [EM_VALUE],
      left: [EM_VALUE],
      margin: [EM_VALUE_OPTIONAL_ZERO],
      'margin-left': [EM_VALUE_OPTIONAL_ZERO],
      'margin-right': [EM_VALUE_OPTIONAL_ZERO],
      padding: [EM_VALUE],
      position: [/^relative$/, /^absolute$/],
      display: [/^inline-block$/, /^block$/],
      color: [/^#[0-9a-f]{3,8}$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i],
      'border-color': [/^#[0-9a-f]{3,8}$/i],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
};

marked.use({ breaks: true, gfm: true });

const renderMath = (source: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(source, { displayMode, throwOnError: false });
  } catch {
    return source;
  }
};

/**
 * 提取 $$...$$（块级）与 $...$（行内）数学片段（\$ 转义跳过），
 * 替换为不会被 marked 改写的占位 token。
 */
const extractMath = (text: string): { text: string; rendered: string[] } => {
  const rendered: string[] = [];
  const stash = (html: string): string => {
    rendered.push(html);
    return `${MATH_TOKEN_PREFIX}${rendered.length - 1}${MATH_TOKEN_SUFFIX}`;
  };

  let working = text.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_match, source: string) =>
    stash(renderMath(source, true)),
  );
  working = working.replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_match, source: string) =>
    stash(renderMath(source, false)),
  );
  return { text: working, rendered };
};

const restoreMath = (html: string, rendered: string[]): string =>
  html.replace(
    new RegExp(`${MATH_TOKEN_PREFIX}(\\d+)${MATH_TOKEN_SUFFIX}`, 'g'),
    (match, index: string) => rendered[Number.parseInt(index, 10)] ?? match,
  );

export const renderRichText = (text: string): string => {
  const { text: withoutMath, rendered } = extractMath(text);
  const markdownHtml = marked.parse(withoutMath, { async: false });
  const withMath = restoreMath(markdownHtml, rendered);
  return sanitizeHtml(withMath, sanitizeOptions);
};
