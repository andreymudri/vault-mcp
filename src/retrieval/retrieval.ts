import { LinkGraph } from '../graph/graph.js';
import { search as bm25Search, suggestTerms } from '../index/bm25.js';
import { chunkNote } from '../index/chunker.js';
import { InvertedIndex } from '../index/inverted-index.js';
import type { Chunk, Note, ScoredChunk, SearchResult } from '../types.js';
import type { VaultScanner } from '../vault/scanner.js';
import {
  applyBudget,
  BM25_TOP_K,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_LIMIT,
  GRAPH_DAMPING,
} from './budget.js';

export interface RetrieverOptions {
  scanner: VaultScanner;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  /** Keeps only chunks whose note declares this `tipo` in its frontmatter. */
  tipo?: string;
  /** Keeps only chunks under this vault-relative folder, matched at path-segment boundaries. */
  folder?: string;
  /** `01-raw/` is capture, not knowledge: excluded unless explicitly asked for. */
  includeRaw?: boolean;
}

/**
 * Notes under this prefix are unprocessed capture (clippings, inbox scraps). They are indexed —
 * a user who knows what they are looking for must be able to find them — but they stay out of
 * ordinary results, where they would compete with curated notes on raw term frequency alone.
 */
const RAW_PREFIX = '01-raw/';

/**
 * The 1-based line of the original file where `Note.body` starts, i.e. the line after the
 * frontmatter block. `Note` (src/types.ts) does not carry it and `VaultScanner` does not expose
 * the raw file, so it cannot be recovered here without re-reading the file — which would put a
 * second filesystem reader beside the scanner and break `FsOps` injection. Chunks are therefore
 * numbered from the start of the body, and `chunk.lineStart` is short of the file's real line by
 * the height of the frontmatter block. Chunk ids stay unique and stable either way; making the
 * numbers absolute means adding the offset to `Note`, in the scanner's own task.
 */
const BODY_START_LINE = 1;

/** Frontmatter is parsed from untrusted files, so `tipo` may be any YAML scalar, not a string. */
function noteTipo(note: Note): string | undefined {
  const tipo = note.frontmatter.tipo;
  return typeof tipo === 'string' ? tipo : undefined;
}

function noteTags(note: Note): string[] {
  const tags = note.frontmatter.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

/**
 * Folder match on whole path segments. A plain `startsWith(folder)` would let `02-wiki/dock`
 * select `02-wiki/docker/`, silently returning notes from a folder the caller did not name.
 */
function inFolder(path: string, folder: string): boolean {
  const normalized = folder.replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized === '') return true;
  return path.startsWith(`${normalized}/`);
}

/**
 * Owns the index and the graph, and is the only thing that decides what a search returns.
 *
 * Retrieval is BM25 plus one hop of link expansion: notes adjacent to a hit inherit a damped
 * share of its score, which is what lets a query reach a note whose own words never matched.
 */
export class Retriever {
  private readonly scanner: VaultScanner;
  private readonly index = new InvertedIndex();
  private readonly graph = new LinkGraph();
  /**
   * Chunks grouped by note, kept in step with the index. Graph expansion needs every chunk of a
   * neighbour, and reading them by scanning `index.chunks` would cost one full pass over the
   * vault for every neighbour of every hit — quadratic in the vault's size on each search.
   */
  private readonly chunksByPath = new Map<string, Chunk[]>();

  constructor(options: RetrieverOptions) {
    this.scanner = options.scanner;
  }

  /**
   * Brings index and graph up to date with the vault, re-chunking only what the scanner reports
   * as moved. Every public entry point calls this first: a search that answers from a stale
   * index is worse than a slow one.
   */
  private sync(): void {
    const { changed, removed } = this.scanner.refresh();

    // Forget first, and for `changed` too, not only for `removed`: chunk ids carry the line the
    // chunk starts at, so an edit that moves or deletes a heading would otherwise leave the old
    // chunk indexed under its old id, and the search would answer with text no longer on disk.
    for (const path of [...changed, ...removed]) {
      this.index.removeByPath(path);
      this.chunksByPath.delete(path);
    }

    for (const path of changed) {
      const note = this.scanner.getNote(path);
      if (note === undefined) continue;
      const chunks = chunkNote(path, note.body, noteTipo(note), noteTags(note), BODY_START_LINE);
      for (const chunk of chunks) this.index.addChunk(chunk);
      if (chunks.length > 0) this.chunksByPath.set(path, chunks);
    }

    // A single added or removed note changes how OTHER notes' links resolve (the scanner
    // re-resolves all of them), so the graph is rebuilt whole rather than patched.
    if (changed.length > 0 || removed.length > 0) this.graph.build(this.scanner.allNotes());
  }

  search(options: SearchOptions): SearchResult {
    this.sync();

    const keep = this.predicate(options);

    // `keep` goes INTO the BM25 call: filtering after the top-K cut would return nothing whenever
    // the eight best candidates all failed the filter, even with valid candidates further down.
    const direct = bm25Search(this.index, options.query, BM25_TOP_K, keep);

    // `bm25Search` accumulates into a `Map` keyed by chunk id, so `direct` is already unique.
    const merged = new Map<string, ScoredChunk>();
    for (const scored of direct) merged.set(scored.chunk.id, scored);

    for (const [path, score] of this.inheritedScores(direct)) {
      for (const chunk of this.chunksOf(path)) {
        const previous = merged.get(chunk.id);
        // Strictly greater: a chunk that arrived directly keeps its own score and its
        // `viaGraph: false`, so a hit is never demoted into an inherited one.
        if (previous === undefined || score > previous.score) {
          merged.set(chunk.id, { chunk, score, viaGraph: true });
        }
      }
    }

    // Re-filter after the merge. Expansion adds neighbours that never went through `keep`, and a
    // filter the caller asked for has to hold over what is returned, not over an intermediate
    // stage: without this, `{ query: 'potentia', tipo: 'projeto' }` answers with the notes the
    // project README links to.
    const scored = [...merged.values()].filter((item) => keep(item.chunk));

    // Explicit tie-break, not cosmetics: expansion gives every chunk of every neighbour the same
    // inherited score, so ties are the common case. Without it the budget cut would return
    // different sets depending on `Map` insertion order — i.e. on the order notes were indexed.
    scored.sort(
      (a, b) =>
        b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0),
    );

    const results = applyBudget(scored, options.limit ?? DEFAULT_LIMIT, DEFAULT_CHAR_BUDGET);
    if (results.length > 0) return { results };
    return { results, suggestions: suggestTerms(this.index, options.query, 5) };
  }

  /**
   * Best score each neighbour note inherits: `GRAPH_DAMPING` times the score of the source chunk
   * that reached it, taking the largest when several do. The damping multiplies the SOURCE's
   * score — the neighbour has no BM25 score of its own here, that is the whole point.
   */
  private inheritedScores(direct: ScoredChunk[]): Map<string, number> {
    const bestBySourcePath = new Map<string, number>();
    for (const scored of direct) {
      const previous = bestBySourcePath.get(scored.chunk.path);
      if (previous === undefined || scored.score > previous) {
        bestBySourcePath.set(scored.chunk.path, scored.score);
      }
    }

    // One hop only: neighbours are read from the direct hits alone, never from other neighbours.
    const inherited = new Map<string, number>();
    for (const [path, score] of bestBySourcePath) {
      const value = score * GRAPH_DAMPING;
      for (const neighbour of this.graph.neighbors(path)) {
        const previous = inherited.get(neighbour);
        if (previous === undefined || value > previous) inherited.set(neighbour, value);
      }
    }
    return inherited;
  }

  private chunksOf(path: string): readonly Chunk[] {
    return this.chunksByPath.get(path) ?? [];
  }

  private predicate(options: SearchOptions): (chunk: Chunk) => boolean {
    const { tipo, folder, includeRaw } = options;
    return (chunk) => {
      if (includeRaw !== true && chunk.path.startsWith(RAW_PREFIX)) return false;
      if (tipo !== undefined && chunk.tipo !== tipo) return false;
      if (folder !== undefined && !inFolder(chunk.path, folder)) return false;
      return true;
    };
  }
}
