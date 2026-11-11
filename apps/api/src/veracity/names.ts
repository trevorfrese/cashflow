/**
 * Name matching for the ownership checks. Explicit rules, no model:
 *
 *   - Lower case; "&" reads "and"; punctuation is removed without leaving a gap, so
 *     "L.L.C." is "llc" and "Joe's" is "joes".
 *   - Legal suffixes and fillers are dropped: llc, inc, incorporated, corp, corporation, co,
 *     company, ltd, limited, lp, llp, pllc, pc, plc, the.
 *   - "A dba B" (or d/b/a) is two names, either of which may match.
 *   - Two tokens are equal when identical, or when both have 5 or more letters and differ by
 *     one edit (a typo).
 *   - Similarity is the Dice coefficient of the two token sets: 2 x shared / (|a| + |b|).
 *     Names that are identical with spaces removed ("Bluedoor" and "Blue Door") score 1.
 *   - Two business names match at `threshold` (0.8 in policy v3): "Blue Door Bakery" and
 *     "Blue Door Bakery Cafe" (0.86) match; "Blue Door Bakery" and "Blue Door Coffee" (0.67)
 *     do not.
 *
 * People: the last names must be equal (or one edit apart at 5+ letters), and the first names
 * equal, one an initial of the other, or a common nickname pair.
 */

const SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'lp',
  'llp',
  'pllc',
  'pc',
  'plc',
  'the',
]);

const NICKNAMES: ReadonlyArray<readonly string[]> = [
  ['robert', 'bob', 'rob', 'bobby'],
  ['william', 'bill', 'will', 'billy', 'liam'],
  ['elizabeth', 'liz', 'beth', 'betty', 'eliza'],
  ['katherine', 'kate', 'katie', 'kathy', 'catherine', 'cathy'],
  ['michael', 'mike', 'mick'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['thomas', 'tom', 'tommy'],
  ['richard', 'rick', 'dick', 'rich'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['jennifer', 'jen', 'jenny'],
  ['joseph', 'joe', 'joey'],
  ['daniel', 'dan', 'danny'],
  ['christopher', 'chris'],
  ['christina', 'chris', 'tina'],
  ['alexander', 'alex'],
  ['alexandra', 'alex', 'sasha'],
  ['patricia', 'pat', 'patty', 'trish'],
  ['patrick', 'pat'],
  ['anthony', 'tony'],
  ['samantha', 'sam'],
  ['samuel', 'sam'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['jonathan', 'jon'],
  ['steven', 'steve', 'stephen'],
  ['deborah', 'deb', 'debbie'],
  ['susan', 'sue', 'suzy'],
  ['victoria', 'vicky', 'tori'],
  ['nicholas', 'nick'],
  ['benjamin', 'ben'],
  ['andrew', 'andy', 'drew'],
];

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'`’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Tokens of a business name with legal suffixes removed. */
export function businessTokens(name: string): string[] {
  return normalize(name)
    .split(' ')
    .filter((t) => t !== '' && !SUFFIXES.has(t));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b);
}

/** Dice similarity of two token lists, with typo tolerant token equality. 0..1. */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join('') === b.join('')) return 1;
  const used = new Set<number>();
  let shared = 0;
  for (const t of a) {
    const k = b.findIndex((u, idx) => !used.has(idx) && tokensEqual(t, u));
    if (k >= 0) {
      used.add(k);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Split "A dba B" into its names. */
export function aliases(name: string): string[] {
  return name
    .split(/\s+(?:dba|d\/b\/a|d b a|aka|t\/a)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export interface NameMatch {
  matched: boolean;
  score: number;
}

/** Best similarity of `candidate` (and its aliases) against any of `references`. */
export function matchBusinessName(
  candidate: string,
  references: readonly (string | null | undefined)[],
  threshold: number,
): NameMatch {
  let best = 0;
  for (const c of aliases(candidate)) {
    for (const r of references) {
      if (!r) continue;
      for (const ref of aliases(r)) {
        best = Math.max(best, tokenSimilarity(businessTokens(c), businessTokens(ref)));
      }
    }
  }
  return { matched: best >= threshold, score: Math.round(best * 100) / 100 };
}

const PERSON_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'mr', 'mrs', 'ms', 'dr']);

function personTokens(name: string): string[] {
  return normalize(name)
    .split(' ')
    .filter((t) => t !== '' && !PERSON_SUFFIXES.has(t));
}

function sameFirstName(a: string, b: string): boolean {
  if (tokensEqual(a, b)) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return NICKNAMES.some((group) => group.includes(a) && group.includes(b));
}

/** Is `candidate` the same person as `person`. */
export function samePerson(candidate: string, person: string): boolean {
  const a = personTokens(candidate);
  const b = personTokens(person);
  if (a.length < 2 || b.length < 2) return false;
  return tokensEqual(a.at(-1)!, b.at(-1)!) && sameFirstName(a[0]!, b[0]!);
}

/**
 * Is a bank account holder name the business or one of its owners. A holder name can be
 * either: a business account carries the business name, a sole proprietor's the owner's.
 */
export function holderIsApplicant(
  holder: string,
  applicant: { legalName: string; dba: string | null; ownerNames: readonly string[] },
  threshold: number,
): { matched: boolean; as: 'BUSINESS' | 'OWNER' | null; score: number } {
  const business = matchBusinessName(holder, [applicant.legalName, applicant.dba], threshold);
  if (business.matched) return { matched: true, as: 'BUSINESS', score: business.score };
  if (applicant.ownerNames.some((o) => samePerson(holder, o))) {
    return { matched: true, as: 'OWNER', score: 1 };
  }
  return { matched: false, as: null, score: business.score };
}
