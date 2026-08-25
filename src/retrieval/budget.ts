import type { ScoredChunk } from '../types.js';

/** How many chunks BM25 contributes before graph expansion runs. */
export const BM25_TOP_K = 8;
/** Multiplies the SOURCE chunk's score, never the neighbour's own BM25 score. */
export const GRAPH_DAMPING = 0.4;
export const DEFAULT_LIMIT = 6;
export const DEFAULT_CHAR_BUDGET = 8000;

/** Cuts at whichever limit is reached first: chunk count or total characters. */
export function applyBudget(
  scored: ScoredChunk[],
  limit: number,
  charBudget: number,
): ScoredChunk[] {
  const out: ScoredChunk[] = [];
  let chars = 0;
  for (const item of scored) {
    if (out.length >= limit) break;
    if (out.length > 0 && chars + item.chunk.text.length > charBudget) break;
    out.push(item);
    chars += item.chunk.text.length;
  }
  return out;
}
