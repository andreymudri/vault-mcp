import type { Chunk, ScoredChunk } from '../types.js';
import { noteTypeWeight, type InvertedIndex } from './inverted-index.js';
import { tokenize } from './tokenizer.js';

export const K1 = 1.2;
export const B = 0.75;

export function idf(totalDocs: number, docsWithTerm: number): number {
  return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

/**
 * Busca `query` no índice invertido usando BM25 sobre as frequências já ponderadas por campo,
 * devolvendo até `limit` chunks ordenados por score decrescente.
 *
 * `keep`, quando fornecido, filtra os chunks candidatos ANTES do corte por `limit` — um filtro
 * restritivo aplicado depois do corte devolveria uma lista vazia sempre que os `limit` melhores
 * candidatos falhassem nele, mesmo havendo candidatos válidos mais abaixo no ranking.
 */
export function search(
  index: InvertedIndex,
  query: string,
  limit: number,
  keep?: (chunk: Chunk) => boolean,
): ScoredChunk[] {
  const terms = tokenize(query);
  const N = index.size();
  const avgdl = index.avgLength();
  const scores = new Map<string, number>();

  for (const term of terms) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    const termIdf = idf(N, postings.size);
    for (const [chunkId, freq] of postings) {
      const dl = index.chunkLengths.get(chunkId) ?? 0;
      const denom = freq + K1 * (1 - B + (B * dl) / avgdl);
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + (termIdf * freq * (K1 + 1)) / denom);
    }
  }

  // Peso por tipo de nota aplicado UMA VEZ, sobre o score acumulado do chunk — não sobre as
  // frequências de termo, o que distorceria a saturação por termo do BM25.
  for (const [chunkId, score] of scores) {
    scores.set(chunkId, score * noteTypeWeight(index.chunks.get(chunkId)?.tipo));
  }

  // Filtra antes de fatiar: um `keep` restritivo aplicado depois do corte devolveria nada sempre
  // que os `limit` melhores candidatos falhassem nele.
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score]) => ({ chunk: index.chunks.get(chunkId)!, score, viaGraph: false }))
    .filter((sc) => (keep ? keep(sc.chunk) : true))
    .slice(0, limit);
}

/**
 * Distância de Levenshtein entre `a` e `b`, com early-exit assim que o mínimo da linha corrente
 * já ultrapassa `maxDistance`: a partir daí nenhuma célula futura da mesma linha pode descer
 * abaixo desse mínimo (cada célula é >= o mínimo da linha menos as operações restantes), então a
 * distância final também não pode, e o cálculo pode parar sem terminar a matriz inteira.
 */
function levenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prevRow = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const currRow = new Array<number>(b.length + 1);
    currRow[0] = i;
    let rowMin = currRow[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const candidate = Math.min(
        (prevRow[j] ?? Infinity) + 1,
        (currRow[j - 1] ?? Infinity) + 1,
        (prevRow[j - 1] ?? Infinity) + cost,
      );
      currRow[j] = candidate;
      if (candidate < rowMin) rowMin = candidate;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prevRow = currRow;
  }

  return prevRow[b.length] ?? maxDistance + 1;
}

/**
 * Devolve até `max` termos do vocabulário do índice a distância de Levenshtein <= 2 de algum
 * termo tokenizado de `query`, ordenados por distância crescente e depois alfabeticamente.
 */
export function suggestTerms(index: InvertedIndex, query: string, max: number): string[] {
  const MAX_DISTANCE = 2;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const candidates: Array<{ term: string; distance: number }> = [];
  for (const term of index.vocabulary()) {
    let best = MAX_DISTANCE + 1;
    for (const queryTerm of queryTerms) {
      const distance = levenshtein(term, queryTerm, MAX_DISTANCE);
      if (distance < best) best = distance;
      if (best === 0) break;
    }
    if (best <= MAX_DISTANCE) candidates.push({ term, distance: best });
  }

  candidates.sort((a, b) => a.distance - b.distance || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return candidates.slice(0, max).map((c) => c.term);
}
