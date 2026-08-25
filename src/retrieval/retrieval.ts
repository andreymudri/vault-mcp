import { LinkGraph } from '../graph/graph.js';
import { search as bm25Search, suggestTerms } from '../index/bm25.js';
import { chunkNote } from '../index/chunker.js';
import { InvertedIndex } from '../index/inverted-index.js';
import { tokenize } from '../index/tokenizer.js';
import type { Chunk, Note, ScoredChunk, SearchResult } from '../types.js';
import type { VaultScanner } from '../vault/scanner.js';
import {
  applyBudget,
  BM25_TOP_K,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_LIMIT,
  GRAPH_DAMPING,
  sliceAtCodePointBoundary,
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

/**
 * Ceiling on how many query terms reach the index, applied here because `search` in
 * `src/index/bm25.ts` iterates the token LIST rather than the distinct set and walks a full
 * posting list per occurrence. The query is a tool-call argument, so its length is attacker
 * controlled, and the server is a single-threaded stdio process: measured on this vault, a
 * one-word query repeated 80.000 times costs 11.9s of synchronous work and stalls every other
 * tool call, while producing the same ranking as the word typed once.
 *
 * The cap is on the COUNT, not on distinctness. Deduplicating would be cheaper still, but it is
 * not ranking-neutral: this BM25 sums one contribution per occurrence, so `jwt jwt docker`
 * deliberately weighs `jwt` twice, and collapsing it would silently rewrite the user's query.
 * Truncating instead leaves every query anyone actually types — a handful of words, a whole
 * sentence — scored exactly as before, and only the pathological tail is dropped.
 */
const MAX_QUERY_TERMS = 64;

/**
 * Ceiling on the raw LENGTH of the query, and the one that actually bounds the work.
 *
 * A term cap alone is the wrong dimension: `tokenize` (src/index/tokenizer.ts) trims edge hyphens
 * with `raw.replace(/-+$/, '')`, whose backtracking is quadratic in the length of a single token,
 * and `a` + 5.000 hyphens + `b` is exactly ONE term. Measured end to end through `search`: 5.000
 * hyphens 78,9ms; 10.000 301,3ms; 20.000 1.162,6ms; 40.000 4.694,3ms; 80.000 18.322,0ms — a 78 KB
 * argument freezing a single-threaded stdio server for eighteen seconds, versus 3,0ms for 64
 * ordinary words. A term cap cannot see any of it, and a variant of 64 such tokens (500 KB, 64
 * terms exactly) sits entirely inside the cap at 11.929ms.
 *
 * 1024 characters is roughly a dense paragraph — about 150 words — so no query a person or an
 * agent writes comes near it; the longest golden query here is 32 characters. 4096 would also be
 * beyond human queries but leaves a ~48ms worst case that the passes below pay more than once,
 * and there is no legitimate query in the gap between the two.
 *
 * The clamp is UNCONDITIONAL and its result is what gets returned, not merely what gets
 * tokenized here: `search` runs the returned string through `bm25Search`, `matchesVocabulary`
 * and `suggestTerms`, each of which tokenizes again — and the last two run precisely when the
 * payload matches nothing, which is the pathological case.
 *
 * This closes the query path only. The same quadratic trim is reachable from note CONTENT, which
 * `InvertedIndex.addChunk` tokenizes on every scan, so a clipping carrying a long hyphen run
 * still slows indexing. That fix belongs in `tokenizer.ts`, outside this task's files.
 */
const MAX_QUERY_CHARS = 1024;

/**
 * The query as the index should see it: clamped to `MAX_QUERY_CHARS` first, then to
 * `MAX_QUERY_TERMS` terms if it still has more. Rejoining the terms is lossless — `tokenize`
 * output is already folded, hyphen-trimmed, stopword-free and free of separators, so tokenizing
 * it again yields the same list.
 */
function boundedQuery(query: string): string {
  const clamped = sliceAtCodePointBoundary(query, MAX_QUERY_CHARS);
  const terms = tokenize(clamped);
  if (terms.length <= MAX_QUERY_TERMS) return clamped;
  return terms.slice(0, MAX_QUERY_TERMS).join(' ');
}

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

    for (const path of removed) this.forget(path);

    for (const path of changed) {
      const note = this.scanner.getNote(path);
      // Unreachable while the scanner reports what it just read, but a path we cannot read must
      // not stay indexed: answering from a copy nobody can verify is the one outcome to avoid.
      if (note === undefined) {
        this.forget(path);
        continue;
      }

      const chunks = chunkNote(path, note.body, noteTipo(note), noteTags(note), BODY_START_LINE);
      const rewritten = new Set(chunks.map((chunk) => chunk.id));
      const previous = this.chunksByPath.get(path) ?? [];

      // Forgetting the old chunks matters — a chunk id carries the line it starts at, so an edit
      // that moves or deletes a heading would otherwise leave the old chunk indexed under its old
      // id and the search would answer with text no longer on disk. But `removeByPath` scans
      // every chunk in the vault, while `addChunk` replaces a same-id chunk at a cost
      // proportional to that one chunk. So the scan runs only when this note really does leave an
      // id behind. That is what keeps a touch-everything event linear: `git checkout` or a sync
      // client restamps every file without changing a byte, and the scanner reports all of them
      // as changed — measured at 992ms inside `removeByPath` alone for 4.000 notes, growing with
      // the square of the vault.
      if (previous.some((chunk) => !rewritten.has(chunk.id))) this.index.removeByPath(path);
      for (const chunk of chunks) this.index.addChunk(chunk);

      if (chunks.length > 0) this.chunksByPath.set(path, chunks);
      else this.chunksByPath.delete(path);
    }

    // A single added or removed note changes how OTHER notes' links resolve (the scanner
    // re-resolves all of them), so the graph is rebuilt whole rather than patched.
    if (changed.length > 0 || removed.length > 0) this.graph.build(this.scanner.allNotes());
  }

  search(options: SearchOptions): SearchResult {
    this.sync();

    const keep = this.predicate(options);
    const query = boundedQuery(options.query);

    // `keep` goes INTO the BM25 call: filtering after the top-K cut would return nothing whenever
    // the eight best candidates all failed the filter, even with valid candidates further down.
    const direct = bm25Search(this.index, query, BM25_TOP_K, keep);

    // `bm25Search` accumulates into a `Map` keyed by chunk id, so `direct` is already unique.
    const merged = new Map<string, ScoredChunk>();
    for (const scored of direct) merged.set(scored.chunk.id, scored);

    for (const [path, score] of this.inheritedScores(direct)) {
      for (const chunk of this.chunksOf(path)) {
        const previous = merged.get(chunk.id);
        if (previous === undefined) {
          merged.set(chunk.id, { chunk, score, viaGraph: true });
          continue;
        }
        // Reached both ways. The score is the greater of the two, as the spec asks — and the
        // inherited one wins often, because it is a share of a neighbour's UNDAMPED score while
        // the direct one already paid `NOTE_TYPE_WEIGHTS` (0.3 for a MOC or a daily). But
        // `viaGraph` answers "did this chunk enter the result set through expansion?"
        // (src/types.ts), and this one did not: it matched the query on its own terms and would
        // be here with the graph switched off. Overwriting the whole record would relabel a
        // genuine BM25 hit as a graph neighbour, which is exactly backwards for a reader deciding
        // how much to trust the result.
        if (score > previous.score) merged.set(chunk.id, { ...previous, score });
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

    // Suggestions are spelling repair, so they are gated on the QUERY having found nothing in the
    // vocabulary — not on the final list being empty, which is what the plan's wording says
    // literally. An empty list after a filter, or after `limit: 0`, means the query was
    // understood and the caller narrowed it away; answering that with "did you mean jwt?" for a
    // query that is already the word `jwt`, spelled correctly and genuinely matching, is noise
    // that reads as a bug.
    if (results.length > 0 || this.matchesVocabulary(query)) return { results };

    // The key is omitted rather than set to `[]`: `SearchResult.suggestions` is documented as
    // "populated only when results is empty" (src/types.ts), which a consumer reads as
    // `if (result.suggestions)`. An empty array is truthy, so an empty or stopword-only query
    // would send it down the "here are some corrections" branch with nothing to show.
    const suggestions = suggestTerms(this.index, query, 5);
    return suggestions.length > 0 ? { results, suggestions } : { results };
  }

  /** True when at least one query term is in the index — i.e. the query itself matched something. */
  private matchesVocabulary(query: string): boolean {
    for (const term of tokenize(query)) {
      if (this.index.postings.has(term)) return true;
    }
    return false;
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

  /**
   * Drops every trace of a note. A deleted note still costs one full scan of the index, because
   * `InvertedIndex` exposes no per-id removal — that lives in `src/index/inverted-index.ts`,
   * outside this task's files. Deletions are rare next to edits, which the loop above keeps
   * linear.
   *
   * The `chunksByPath` line is memory hygiene, not behaviour, and no test can see it: a deleted
   * note has no edges left in the rebuilt graph, so expansion can never ask for its chunks. What
   * it prevents is a vault that deletes notes over a long session holding their text forever.
   */
  private forget(path: string): void {
    this.index.removeByPath(path);
    this.chunksByPath.delete(path);
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
