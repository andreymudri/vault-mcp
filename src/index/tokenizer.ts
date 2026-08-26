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

/**
 * Terms whose meaning lives entirely in characters the split below throws away.
 *
 * `fold('C++')` is `c++`, the split keeps only `c`, and `c` is one character — under the minimum.
 * So `C++` indexed nothing and searched for nothing: measured on the real vault, `vault_search
 * "C++"` answered with zero results AND zero suggestions, a dead end for the `02-wiki/cpp/` domain,
 * for the rustot server and for btbot, all of them C++. Worse, it failed in SILENCE inside a longer
 * query — `servidor C++ TFS` answered normally, carried by `servidor` and `tfs`, so nothing
 * revealed that the discriminating term had been discarded.
 *
 * Rewriting to the spelled-out form is what makes the two spellings ONE key: the vault already has
 * a folder called `cpp`, and a reader who types either should land in the same place.
 *
 * The lookbehind is the whole safety of this table. Without it every identifier ending in `c`
 * followed by `++` would be rewritten mid-word — `abc++` is not C++ — so a symbol only counts when
 * nothing word-like precedes it. Applied inside `tokenize`, never inside `fold`, so folding stays
 * the pure normalisation its other callers expect.
 */
const SYMBOL_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![a-z0-9+#.])c\+\+/g, 'cpp'],
  [/(?<![a-z0-9+#.])c#(?![a-z0-9])/g, 'csharp'],
  [/(?<![a-z0-9+#.])f#(?![a-z0-9])/g, 'fsharp'],
  [/(?<![a-z0-9+#.])node\.js(?![a-z0-9])/g, 'nodejs'],
  [/(?<![a-z0-9+#.])\.net(?![a-z0-9])/g, 'dotnet'],
];

/** Lowercase + accent folding, so `decisão` and `decisao` collapse to one term. */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Splits on anything that is not a letter, digit or hyphen, then trims edge hyphens.
 * No stemming: technical vocabulary (`nestjs`, `bullmq`) must survive intact.
 *
 * A HYPHENATED COMPOUND STAYS ONE TERM, and that was re-decided rather than inherited. Splitting
 * `multi-tenant` into its parts was built and measured, and it cost more than it bought: a note
 * whose only mention of bullmq is a `[[bullmq-worker]]` link started scoring as a DIRECT hit for
 * `bullmq`, which is the link relationship being counted twice — the graph hop already models it,
 * deliberately damped and flagged `viaGraph`, and the decomposed form arrived undamped and
 * unflagged. It also leaked `moc` out of `nestjs-moc` as a standalone term and offered synthetic
 * keys like `bullmqworker` as spelling suggestions.
 *
 * The gap it was meant to close — searching `multitenant` for notes that say `multi-tenant` — is
 * already covered, and better: the query finds nothing, and `suggestTerms` answers `multi-tenant`
 * at edit distance 1. Measured on the real vault.
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
  let folded = fold(input);
  for (const [pattern, replacement] of SYMBOL_ALIASES) folded = folded.replace(pattern, replacement);
  for (const raw of folded.split(/[^a-z0-9-]+/)) {
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
