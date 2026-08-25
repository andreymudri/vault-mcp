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
 * Copies the chunk rather than editing it: the original is the one the index owns, and mutating
 * it would corrupt every later search for the lifetime of the process.
 */
function truncate(item: ScoredChunk, charBudget: number): ScoredChunk {
  const keep = Math.max(0, charBudget - TRUNCATION_MARKER.length);
  return {
    ...item,
    chunk: { ...item.chunk, text: `${item.chunk.text.slice(0, keep)}${TRUNCATION_MARKER}` },
  };
}
