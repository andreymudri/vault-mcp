import type { ScoredChunk } from '../types.js';

/** How many chunks BM25 contributes before graph expansion runs. */
export const BM25_TOP_K = 8;
/** Multiplies the SOURCE chunk's score, never the neighbour's own BM25 score. */
export const GRAPH_DAMPING = 0.4;
export const DEFAULT_LIMIT = 6;
export const DEFAULT_CHAR_BUDGET = 8000;

/** Appended to the one chunk the budget is allowed to cut mid-text, so the cut is never silent. */
export const TRUNCATION_MARKER = '\n[…trecho truncado pelo orçamento de caracteres]';

/**
 * Cuts at whichever limit is reached first: chunk count or total characters.
 *
 * A chunk bigger than the whole budget is still returned rather than leaving the caller with
 * nothing on a technicality — but it is returned TRUNCATED to the budget, with an explicit
 * marker. The plan asks for the guard and not for the truncation; returning the chunk whole
 * would make `charBudget` unenforceable in exactly the case it exists for, since a note with no
 * `##` headings is a single chunk of unbounded size (measured: 10.800.014 characters against a
 * declared budget of 8.000) and that text goes verbatim into a context window.
 */
export function applyBudget(
  scored: ScoredChunk[],
  limit: number,
  charBudget: number,
): ScoredChunk[] {
  const out: ScoredChunk[] = [];
  let chars = 0;
  for (const item of scored) {
    if (out.length >= limit) break;
    const length = item.chunk.text.length;
    if (chars + length > charBudget) {
      // Something already fits, so stop: the result is a prefix of the ranking, never a
      // cherry-pick that skips a better-placed chunk because a worse one happened to fit.
      if (out.length > 0) break;
      // Nothing fits yet and this one chunk is bigger than the whole budget. Returning it
      // truncated beats both alternatives: empty on a technicality, or a chunk of unbounded size.
      out.push(truncate(item, charBudget));
      chars = charBudget;
      continue;
    }
    out.push(item);
    chars += length;
  }
  return out;
}

/**
 * `text` cut to at most `max` UTF-16 code units, never between the halves of a surrogate pair.
 *
 * A plain `slice` can leave a lone high surrogate at the end. That string is not well-formed
 * Unicode: a client re-encoding it to UTF-8 without WTF-8 tolerance either substitutes U+FFFD or
 * throws, and the vault is full of text where this matters — one emoji in a note, one accented
 * character past the cut. Backing off one unit costs nothing and the result is always valid.
 */
export function sliceAtCodePointBoundary(text: string, max: number): string {
  // Non-positive means nothing fits. Falling through would hand `String.slice` a negative count,
  // which it reads as an offset from the end.
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  // A HIGH surrogate in the last kept position has its pair outside the cut. A low surrogate
  // there is already closing a pair that started inside it, so it stays.
  const isSplitPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, isSplitPair ? max - 1 : max);
}

/**
 * Copies the chunk rather than editing it: the original is the one the index owns, and mutating
 * it would corrupt every later search for the lifetime of the process.
 *
 * `lineEnd` is pulled back to the last line that survived the cut. Without that, the chunk keeps
 * advertising the range of text it no longer carries, and a consumer that re-reads
 * `path:lineStart-lineEnd` from disk — which is exactly what the note-reading tools do — gets
 * the whole untruncated chunk back and the budget buys nothing. `lineStart` is untouched: the
 * chunk still begins where it began.
 *
 * What this still cannot express is "this text was cut" in a form a program can trust:
 * `TRUNCATION_MARKER` is ordinary text and a note could contain it verbatim. Saying it properly
 * means a `truncated?: boolean` on `ScoredChunk`, which lives in `src/types.ts` — outside this
 * task's files — so it is left for whoever owns that type.
 */
function truncate(item: ScoredChunk, charBudget: number): ScoredChunk {
  // May go negative when the budget is smaller than the marker itself; the slice below floors
  // it at zero. Left to `String.slice`, a negative count reads from the END of the string and
  // hands back nearly the whole chunk — the opposite of a budget.
  const keep = charBudget - TRUNCATION_MARKER.length;
  const kept = sliceAtCodePointBoundary(item.chunk.text, keep);
  const lines = kept.split('\n').length - 1;
  return {
    ...item,
    chunk: {
      ...item.chunk,
      text: `${kept}${TRUNCATION_MARKER}`,
      lineEnd: item.chunk.lineStart + lines,
    },
  };
}
