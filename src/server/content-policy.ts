/** Small, explicit review vocabulary; never used to block publication. */
export const CONTENT_CHINESE_TERMS = [
  '傻逼',
  '傻b',
  '煞笔',
  '草泥马',
  '操你妈',
  '肏你妈',
  '你妈死了',
  '死全家',
  '狗娘养',
  '黑鬼',
  '支那猪',
  '强奸',
  '轮奸',
  '鸡巴',
  '卖淫',
  '黄片',
] as const;
export const CONTENT_ENGLISH_TERMS = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'faggot',
  'nigger',
  'whore',
  'slut',
  'porn',
  'rape',
  'nmsl',
] as const;
export const normalizeContentForPolicy = (text: string): string => text.normalize('NFKC').toLowerCase();

export const inspectContent = (text: string): { violated: boolean; terms: string[] } => {
  const normalized = normalizeContentForPolicy(text);
  const compact = normalized.replace(/[\p{P}\p{Z}\p{Cf}\s]/gu, '');
  const terms: string[] = CONTENT_CHINESE_TERMS.filter((term) => compact.includes(term));
  // Latin boundaries avoid grape, Scunthorpe, class and ordinary code identifiers.
  for (const term of CONTENT_ENGLISH_TERMS) {
    const separated = [...term].join('[\\s\\p{P}\\p{Z}\\p{Cf}]*');
    if (new RegExp(`(?<![a-z0-9])${separated}(?![a-z0-9])`, 'u').test(normalized)) terms.push(term);
  }
  return { violated: terms.length > 0, terms };
};
