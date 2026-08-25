import { STOPWORDS_EN, STOPWORDS_PT } from './stopwords.js';

/** `'-'`, compared by code unit so the edge trim never allocates or backtracks. */
const HYPHEN = 45;

/**
 * Upper bound on the length of an indexed term. No real vocabulary — natural language, code
 * identifiers, hyphenated compounds — reaches it: the longest token in the whole fixture vault is
 * under 40 characters. It exists to drop tokenised garbage: a base64 data-URI or a hex digest
 * pasted into a clipping in `01-raw/`, which splits into ONE enormous token and becomes a
 * posting-list key nobody can ever type.
 *
 * Tokens past the cap are DISCARDED, not truncated, and the choice matters:
 * - truncating fuses distinct terms that share the first 64 characters into a single key, so two
 *   unrelated blobs end up sharing a posting list and inflating each other's frequencies;
 * - truncating also manufactures precisely the vocabulary shape that costs the most downstream —
 *   many terms of EQUAL length sharing a long prefix, which defeats both of `levenshtein`'s
 *   early exits in `bm25.ts` and forces the full 64x64 matrix per pair;
 * - and a term nobody can type is worthless as a search key, so nothing is lost by dropping it.
 *
 * `bm25.ts` reuses this constant for its Levenshtein guard, so the two caps cannot drift apart.
 */
export const MAX_TOKEN_LENGTH = 64;

/** Lowercase + accent folding, so `decisão` and `decisao` collapse to one term. */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Splits on anything that is not a letter, digit or hyphen, then trims edge hyphens.
 * No stemming: technical vocabulary (`nestjs`, `bullmq`) must survive intact.
 *
 * The edge trim is a linear index scan on purpose. It used to be
 * `raw.replace(/^-+/, '').replace(/-+$/, '')`, and the second replace is quadratic on a token
 * shaped `[alnum][hyphen run][alnum]`: it has no start anchor, so the greedy `-+` is retried from
 * every position inside the run and `$` fails at each one. Measured here: 10.000 hyphens 73,9ms,
 * 20.000 284,2ms, 40.000 1.165ms, 80.000 4.514ms, 160.000 20.421ms — 4x per doubling. The query
 * path is clamped upstream by `retrieval.ts`, but `InvertedIndex.addChunk` tokenizes note BODIES
 * on every scan, so one clipping carrying a long hyphen run stalled every search with no query
 * needed. Scanning from both ends and slicing once is O(length) and allocates nothing extra.
 *
 * The length check runs on the trimmed BOUNDS, before `slice`, so an over-cap token is dropped
 * without ever materialising a copy of it.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const raw of fold(input).split(/[^a-z0-9-]+/)) {
    let start = 0;
    let end = raw.length;
    while (start < end && raw.charCodeAt(start) === HYPHEN) start += 1;
    while (end > start && raw.charCodeAt(end - 1) === HYPHEN) end -= 1;

    const length = end - start;
    if (length < 2 || length > MAX_TOKEN_LENGTH) continue;

    const term = raw.slice(start, end);
    if (STOPWORDS_PT.has(term) || STOPWORDS_EN.has(term)) continue;
    out.push(term);
  }
  return out;
}
