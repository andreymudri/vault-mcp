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
   * Tokeniza cada campo do chunk separadamente (heading a partir de `headingPath`, tags a partir
   * de `tags`, prose/code a partir de `splitFields(text)`), acumula a frequência de cada termo
   * ponderada por `FIELD_WEIGHTS`, e registra o resultado nas estruturas do índice. Reindexar um
   * chunk com o mesmo `id` substitui o registro anterior por inteiro.
   */
  addChunk(chunk: Chunk): void {
    this.removeChunkById(chunk.id);

    const { prose, code } = splitFields(chunk.text);
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
    this.totalLength += chunkLength;
  }

  /** Remove todos os chunks indexados de um dado path (reindexação incremental). */
  removeByPath(path: string): void {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.path === path) this.removeChunkById(chunk.id);
    }
  }

  private removeChunkById(chunkId: string): void {
    if (!this.chunks.has(chunkId)) return;
    const length = this.chunkLengths.get(chunkId) ?? 0;
    this.totalLength -= length;
    this.chunkLengths.delete(chunkId);
    this.chunks.delete(chunkId);
    for (const [term, postings] of this.postings) {
      if (postings.delete(chunkId) && postings.size === 0) {
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
