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
 * Índice invertido sobre chunks: termo -> chunkId -> frequência já ponderada por campo
 * (`FIELD_WEIGHTS`). `chunkLengths` guarda a soma das frequências ponderadas de cada chunk (não
 * a contagem crua de tokens), para que um chunk inflado por bloco de código não seja penalizado
 * pela normalização de comprimento do BM25 como se fosse todo prosa.
 */
export class InvertedIndex {
  readonly postings = new Map<string, Map<string, number>>();
  readonly chunkLengths = new Map<string, number>();
  readonly chunks = new Map<string, Chunk>();
  totalLength = 0;

  /**
   * Termos indexados de cada chunk, guardados no momento do `addChunk` para que a remoção não
   * precise varrer `postings` inteiro procurando quem referencia o chunk removido — ver
   * `removeChunkById`.
   */
  private readonly chunkTerms = new Map<string, string[]>();

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

    let chunkLength = 0;
    for (const [term, freq] of weighted) {
      chunkLength += freq;
      let postings = this.postings.get(term);
      if (!postings) {
        postings = new Map<string, number>();
        this.postings.set(term, postings);
      }
      postings.set(chunk.id, freq);
    }

    this.chunks.set(chunk.id, chunk);
    this.chunkLengths.set(chunk.id, chunkLength);
    this.chunkTerms.set(chunk.id, [...weighted.keys()]);
    this.totalLength += chunkLength;
  }

  /** Remove todos os chunks indexados de um dado path (reindexação incremental). */
  removeByPath(path: string): void {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.path === path) this.removeChunkById(chunk.id);
    }
  }

  /**
   * Remove um chunk usando a lista de termos guardada por `addChunk` em vez de varrer `postings`
   * inteiro: sem isso, remover N chunks custa O(N × tamanho do vocabulário) e cresce com o vault
   * todo (medido: ~501ms para remover uma nota de 200 chunks de um vocabulário de 100.000 termos),
   * mesmo que cada chunk só referencie um punhado de termos. Com a lista, o custo por chunk é
   * O(termos do próprio chunk).
   */
  private removeChunkById(chunkId: string): void {
    if (!this.chunks.has(chunkId)) return;
    const length = this.chunkLengths.get(chunkId) ?? 0;
    this.totalLength -= length;
    this.chunkLengths.delete(chunkId);
    this.chunks.delete(chunkId);
    const terms = this.chunkTerms.get(chunkId);
    this.chunkTerms.delete(chunkId);
    for (const term of terms ?? []) {
      const postings = this.postings.get(term);
      if (postings?.delete(chunkId) && postings.size === 0) {
        this.postings.delete(term);
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
    return this.postings.keys();
  }

  /** Número de chunks indexados — a unidade de "documento" para o BM25. */
  size(): number {
    return this.chunks.size;
  }

  avgLength(): number {
    return this.chunks.size === 0 ? 0 : this.totalLength / this.chunks.size;
  }
}
