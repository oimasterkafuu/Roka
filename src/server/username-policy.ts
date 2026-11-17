export interface UsernamePolicyResult {
  violated: boolean;
  normalized: string;
}

const LEETSPEAK: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
};

const STRONG_VIOLATIONS = [
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
] as const;
const SAFE_NORMALIZED_NAMES = new Set(['scunthorpe', 'grape', 'grapes']);

export const normalizeUsernameForPolicy = (username: string): string =>
  username
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9@$]/g, '')
    .replace(/[0-9@$]/g, (character) => LEETSPEAK[character] ?? character);

export const inspectUsername = (username: string): UsernamePolicyResult => {
  const normalized = normalizeUsernameForPolicy(username);
  return {
    violated:
      !SAFE_NORMALIZED_NAMES.has(normalized) && STRONG_VIOLATIONS.some((term) => normalized.includes(term)),
    normalized,
  };
};
