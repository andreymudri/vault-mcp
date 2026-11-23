import type { Chunk, FieldName } from '../types.js';
import { splitFields } from './chunker.js';
import { tokenize } from './tokenizer.js';

/**
 * Weight applied to a term's frequency depending on which field of a chunk it
 * came from. Heading terms count for more than prose; code terms count for
 * less, since a chunk padded with a large code example should not read as
 * more relevant than a short, dense prose chunk saying the same thing.
 */
export const FIELD_WEIGHTS: Record<FieldName, number> = {
  heading: 3.0,
  tags: 2.0,
  prose: 1.0,
  code: 0.5,
};

/**
 * Applied to the final chunk score, not to term frequencies. A MOC line restates a note in the
 * query's own words inside a chunk far shorter than average, so BM25 length normalisation ranks
 * the pointer above the thing it points at. Same shape for a daily capture line. These notes are
 * navigation and log, not knowledge.
 */
export const NOTE_TYPE_WEIGHTS: Record<string, number> = { moc: 0.3, daily: 0.3 };

export function noteTypeWeight(tipo: string | undefined): number {
  return (tipo ? NOTE_TYPE_WEIGHTS[tipo] : undefined) ?? 1.0;
}

/**
 * The read-only areas of the vault, and how much a hit inside one is worth.
 *
 * `99-archive/` is already refused by every WRITE (`DENIED_PREFIXES` in `src/write/paths.ts`) and
 * was still ranking identically to live content on the READ side. Measured on the real vault: with
 * six projects sitting in the archive, `vault_learn`'s duplicate check picked a decision note from
 * an ARCHIVED project as its top hit — dead knowledge outranking live knowledge, and the reason the
 * learning was filed the way it was.
 *
 * Demoted, never hidden, and the difference is the whole point. A finished project's decisions are
 * real history and stay findable; they simply stop competing on equal terms with what is still
 * being worked on. `01-raw/` is the other special area and is handled elsewhere — `retrieval.ts`
 * EXCLUDES it by default, because unvalidated capture is a different claim from retired knowledge.
 */
export const ARCHIVE_PATH_WEIGHT = 0.4;

const ARCHIVE_PREFIX = '99-archive';

/**
 * Matched as a whole path SEGMENT, never as a string prefix — the same rule the write guard uses,
 * and for the same reason: `99-archive-notes/` is an ordinary folder that must not be demoted
 * alongside `99-archive/`.
 */
export function pathWeight(path: string | undefined, archiveFolder: string = ARCHIVE_PREFIX): number {
  if (path === undefined) return 1.0;
  const slash = path.indexOf('/');
  const first = slash === -1 ? path : path.slice(0, slash);
  return first === archiveFolder ? ARCHIVE_PATH_WEIGHT : 1.0;
}

const HEADING_LINE_RE = /^#{2,3}\s+.*$/;

/**
 * `chunkNote` (src/index/chunker.ts) starts a chunk's `text` with the very heading line
 * (`##`/`###`) that opened it — `currentLines = [line]` at the moment of the match — so that
 * line survives untouched in `chunk.text` for callers that need the literal source. That line's
 * terms are already counted once via `headingPath`/`FIELD_WEIGHTS.heading` below; without this
 * strip, `splitFields` would route the same line to `prose` (it is not fenced) and `addChunk`
 * would count it a second time at `FIELD_WEIGHTS.prose`, making the effective heading weight
 * `heading + prose` instead of the spec'd `heading`. Only the first line is ever the duplicate —
 * chunkNote flushes and starts a fresh chunk on every `##`/`###` match, so a chunk's text can
 * contain at most one such heading line, and always at position 0. A trailing `\r` (CRLF source)
 * is stripped before matching only, mirroring chunker.ts's own `stripTrailingCR`, and is left
 * untouched in the returned remainder.
 */
function withoutLeadingHeadingLine(text: string): string {
  const newlineIndex = text.indexOf('\n');
  const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  const firstLineNoCR = firstLine.endsWith('\r') ? firstLine.slice(0, -1) : firstLine;
  if (!HEADING_LINE_RE.test(firstLineNoCR)) {
    return text;
  }
  return newlineIndex === -1 ? '' : text.slice(newlineIndex + 1);
}

/**
 * One term's postings, as two parallel typed arrays: which chunk (by ordinal) and how often.
 *
 * This used to be a `Map<chunkId, frequency>` per term. Measured on a synthetic vault of twenty
 * thousand notes (3.9 million postings): those maps were 168 MB of a 329 MB index, about 43 bytes
 * a posting, nearly all of it the map's own bookkeeping. Here a posting is twelve bytes.
 *
 * Postings are APPENDED in ordinal order and never moved: a chunk that is removed or re-indexed is
 * marked dead in the index's ordinal table, and its postings are skipped on the way past. A list
 * is rewritten without them once the dead outnumber the live, so removal stays proportional to
 * the chunk being removed — the property `removeChunkById` was written to keep.
 */
class PostingList {
  readonly term: string;
  readonly id: number;
  ordinals = new Uint32Array(4);
  /** `Float64`, not `Float32`: a weighted frequency has to read back exactly as it was summed. */
  freqs = new Float64Array(4);
  /** Slots in use, dead ones included. */
  length = 0;
  /** Postings whose chunk is still indexed: the term's document frequency. */
  live = 0;

  constructor(term: string, id: number) {
    this.term = term;
    this.id = id;
  }

  push(ordinal: number, freq: number): void {
    if (this.length === this.ordinals.length) this.resize(this.length * 2);
    this.ordinals[this.length] = ordinal;
    this.freqs[this.length] = freq;
    this.length += 1;
    this.live += 1;
  }

  /** Drops the postings of chunks that are no longer indexed. Order is preserved. */
  compact(idByOrdinal: ReadonlyArray<string | undefined>): void {
    let kept = 0;
    for (let i = 0; i < this.length; i += 1) {
      const ordinal = this.ordinals[i] ?? 0;
      if (idByOrdinal[ordinal] === undefined) continue;
      this.ordinals[kept] = ordinal;
      this.freqs[kept] = this.freqs[i] ?? 0;
      kept += 1;
    }
    this.length = kept;
    // Give the memory back when the list shrank for real, and keep a little room to grow into.
    if (kept * 4 < this.ordinals.length) this.resize(Math.max(4, kept * 2));
  }

  /** The slot holding `ordinal`, or -1. Ordinals only ever grow, so the list is sorted. */
  slotOf(ordinal: number): number {
    let low = 0;
    let high = this.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const value = this.ordinals[mid] ?? 0;
      if (value === ordinal) return mid;
      if (value < ordinal) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  private resize(capacity: number): void {
    const ordinals = new Uint32Array(capacity);
    ordinals.set(this.ordinals.subarray(0, this.length));
    this.ordinals = ordinals;
    const freqs = new Float64Array(capacity);
    freqs.set(this.freqs.subarray(0, this.length));
    this.freqs = freqs;
  }
}

/** One term's postings as a caller reads them: chunk id to weighted frequency, live chunks only. */
export interface TermPostings extends Iterable<[string, number]> {
  /** How many indexed chunks carry the term — its document frequency. */
  readonly size: number;
  get(chunkId: string): number | undefined;
  has(chunkId: string): boolean;
  keys(): IterableIterator<string>;
}

/** The whole index as a caller reads it: term to postings. Read-only, and Map-shaped on purpose. */
export interface Postings extends Iterable<[string, TermPostings]> {
  /** How many distinct terms are indexed. */
  readonly size: number;
  get(term: string): TermPostings | undefined;
  has(term: string): boolean;
  keys(): IterableIterator<string>;
}

/**
 * Índice invertido sobre chunks: termo -> chunk -> frequência já ponderada por campo
 * (`FIELD_WEIGHTS`). `chunkLengths` guarda a soma das frequências ponderadas de cada chunk (não
 * a contagem crua de tokens), para que um chunk inflado por bloco de código não seja penalizado
 * pela normalização de comprimento do BM25 como se fosse todo prosa.
 *
 * Inside, a chunk is an ORDINAL — a small integer handed out when it is added and never reused —
 * and a term's postings are typed arrays of ordinals and frequencies (`PostingList`). Outside,
 * `postings` still reads as term -> chunk id -> frequency.
 */
export class InvertedIndex {
  readonly chunkLengths = new Map<string, number>();
  readonly chunks = new Map<string, Chunk>();
  totalLength = 0;

  private readonly lists = new Map<string, PostingList>();
  /** By `PostingList.id`. A slot is cleared when its term loses its last chunk. */
  private readonly listById: Array<PostingList | undefined> = [];
  /** By ordinal: the chunk's id, or `undefined` once it was removed or re-indexed. */
  private readonly idByOrdinal: Array<string | undefined> = [];
  /** By ordinal: the chunk's weighted length, read in the scoring loop without a map lookup. */
  private readonly lengthByOrdinal: number[] = [];
  private readonly ordinalById = new Map<string, number>();

  /**
   * Os termos de cada chunk — os ids das listas deles —, guardados no momento do `addChunk` para
   * que a remoção não precise varrer o vocabulário inteiro procurando quem referencia o chunk
   * removido — ver `removeChunkById`.
   */
  private readonly chunkTerms = new Map<string, Uint32Array>();

  /** Term -> chunk id -> weighted frequency, read-only. See `eachPosting` for the scoring loop. */
  readonly postings: Postings = this.postingsView();

  /**
   * Tokeniza cada campo do chunk separadamente (heading a partir de `headingPath`, tags a partir
   * de `tags`, prose/code a partir de `splitFields(text)`), acumula a frequência de cada termo
   * ponderada por `FIELD_WEIGHTS`, e registra o resultado nas estruturas do índice. Reindexar um
   * chunk com o mesmo `id` substitui o registro anterior por inteiro.
   */
  addChunk(chunk: Chunk): void {
    this.removeChunkById(chunk.id);

    const { prose, code } = splitFields(withoutLeadingHeadingLine(chunk.text));
    const headingText = chunk.headingPath.join(' ');
    const tagsText = chunk.tags.join(' ');

    const weighted = new Map<string, number>();
    const accumulate = (text: string, weight: number): void => {
      for (const term of tokenize(text)) {
        weighted.set(term, (weighted.get(term) ?? 0) + weight);
      }
    };
    accumulate(headingText, FIELD_WEIGHTS.heading);
    accumulate(tagsText, FIELD_WEIGHTS.tags);
    accumulate(prose, FIELD_WEIGHTS.prose);
    accumulate(code, FIELD_WEIGHTS.code);

    const ordinal = this.idByOrdinal.length;
    const termIds = new Uint32Array(weighted.size);
    let chunkLength = 0;
    let slot = 0;
    for (const [term, freq] of weighted) {
      chunkLength += freq;
      let list = this.lists.get(term);
      if (list === undefined) {
        list = new PostingList(term, this.listById.length);
        this.listById.push(list);
        this.lists.set(term, list);
      }
      list.push(ordinal, freq);
      termIds[slot] = list.id;
      slot += 1;
    }

    this.idByOrdinal.push(chunk.id);
    this.lengthByOrdinal.push(chunkLength);
    this.ordinalById.set(chunk.id, ordinal);
    this.chunks.set(chunk.id, chunk);
    this.chunkLengths.set(chunk.id, chunkLength);
    this.chunkTerms.set(chunk.id, termIds);
    this.totalLength += chunkLength;
  }

  /** Remove todos os chunks indexados de um dado path (reindexação incremental). */
  removeByPath(path: string): void {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.path === path) this.removeChunkById(chunk.id);
    }
  }

  /**
   * Remove um chunk usando a lista de termos guardada por `addChunk` em vez de varrer o
   * vocabulário inteiro: sem isso, remover N chunks custa O(N × tamanho do vocabulário) e cresce
   * com o vault todo (medido: ~501ms para remover uma nota de 200 chunks de um vocabulário de
   * 100.000 termos), mesmo que cada chunk só referencie um punhado de termos. Com a lista, o custo
   * por chunk é O(termos do próprio chunk).
   *
   * The postings themselves are not touched here: clearing the ordinal's slot is what kills them,
   * and each list is rewritten without its dead entries once those outnumber the live ones.
   */
  private removeChunkById(chunkId: string): void {
    const ordinal = this.ordinalById.get(chunkId);
    if (ordinal === undefined) return;
    this.totalLength -= this.chunkLengths.get(chunkId) ?? 0;
    this.chunkLengths.delete(chunkId);
    this.chunks.delete(chunkId);
    this.ordinalById.delete(chunkId);
    this.idByOrdinal[ordinal] = undefined;
    const termIds = this.chunkTerms.get(chunkId);
    this.chunkTerms.delete(chunkId);
    for (const id of termIds ?? []) {
      const list = this.listById[id];
      if (list === undefined) continue;
      list.live -= 1;
      if (list.live === 0) {
        this.lists.delete(list.term);
        this.listById[id] = undefined;
      } else if (list.length - list.live > list.live) {
        list.compact(this.idByOrdinal);
      }
    }
  }

  has(path: string): boolean {
    for (const chunk of this.chunks.values()) {
      if (chunk.path === path) return true;
    }
    return false;
  }

  vocabulary(): IterableIterator<string> {
    return this.lists.keys();
  }

  /** Número de chunks indexados — a unidade de "documento" para o BM25. */
  size(): number {
    return this.chunks.size;
  }

  avgLength(): number {
    return this.chunks.size === 0 ? 0 : this.totalLength / this.chunks.size;
  }

  /** How many indexed chunks carry `term`. Zero for a term that is not in the vocabulary. */
  documentFrequency(term: string): number {
    return this.lists.get(term)?.live ?? 0;
  }

  /**
   * Calls `visit` once per indexed chunk carrying `term`, with the chunk's id, the term's weighted
   * frequency in it and the chunk's weighted length — everything BM25 needs for one posting.
   *
   * The scoring loop goes through here rather than through `postings` because it runs once per
   * posting of every query term: reading the arrays directly costs no iterator object and no map
   * lookup for the length.
   */
  eachPosting(term: string, visit: (chunkId: string, freq: number, length: number) => void): void {
    const list = this.lists.get(term);
    if (list === undefined) return;
    for (let i = 0; i < list.length; i += 1) {
      const ordinal = list.ordinals[i] ?? 0;
      const chunkId = this.idByOrdinal[ordinal];
      if (chunkId === undefined) continue;
      visit(chunkId, list.freqs[i] ?? 0, this.lengthByOrdinal[ordinal] ?? 0);
    }
  }

  private termView(list: PostingList): TermPostings {
    const idByOrdinal = this.idByOrdinal;
    const ordinalById = this.ordinalById;
    function* entries(): IterableIterator<[string, number]> {
      for (let i = 0; i < list.length; i += 1) {
        const chunkId = idByOrdinal[list.ordinals[i] ?? 0];
        if (chunkId !== undefined) yield [chunkId, list.freqs[i] ?? 0];
      }
    }
    const get = (chunkId: string): number | undefined => {
      const ordinal = ordinalById.get(chunkId);
      if (ordinal === undefined) return undefined;
      const slot = list.slotOf(ordinal);
      return slot === -1 ? undefined : list.freqs[slot];
    };
    return {
      get size() {
        return list.live;
      },
      get,
      has: (chunkId) => get(chunkId) !== undefined,
      *keys() {
        for (const [chunkId] of entries()) yield chunkId;
      },
      [Symbol.iterator]: entries,
    };
  }

  private postingsView(): Postings {
    const lists = this.lists;
    const view = (list: PostingList): TermPostings => this.termView(list);
    return {
      get size() {
        return lists.size;
      },
      get: (term) => {
        const list = lists.get(term);
        return list === undefined ? undefined : view(list);
      },
      has: (term) => lists.has(term),
      keys: () => lists.keys(),
      *[Symbol.iterator]() {
        for (const [term, list] of lists) yield [term, view(list)];
      },
    };
  }
}
