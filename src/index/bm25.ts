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
 * Nenhum termo de vocabulário real (linguagem natural, identificadores de código) passa disso —
 * o comprimento existe para descartar lixo tokenizado como um único termo enorme: um base64 ou
 * hex embutido num clipping, que `tokenizer.ts` não corta por não ter cap de tamanho de token.
 * Sem esse corte, dois termos longos e quase idênticos (ex.: dois blobs base64 que diferem em
 * poucos bytes) fazem `levenshtein` rodar a matriz O(len²) inteira — o early-exit por diferença
 * de comprimento não ajuda (comprimentos iguais) e o early-exit por mínimo de linha não ajuda
 * (o mínimo fica baixo a matriz inteira, porque as strings são quase iguais). Medido: 200 termos
 * de vocabulário de 5.000 caracteres cada, mais um termo de query de 5.000 caracteres, bloqueiam
 * o event loop por ~37s num servidor single-threaded. Termos além do cap são tratados como fora
 * de alcance (nunca sugeridos), sem rodar a matriz.
 */
const MAX_TERM_LENGTH = 64;

/**
 * Distância de Levenshtein entre `a` e `b`, com early-exit assim que o mínimo da linha corrente
 * já ultrapassa `maxDistance`: a partir daí nenhuma célula futura da mesma linha pode descer
 * abaixo desse mínimo (cada célula é >= o mínimo da linha menos as operações restantes), então a
 * distância final também não pode, e o cálculo pode parar sem terminar a matriz inteira.
 */
function levenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (a.length > MAX_TERM_LENGTH || b.length > MAX_TERM_LENGTH) return maxDistance + 1;
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
 * `MAX_TERM_LENGTH` faz cada PAR (termo do vocabulário, termo da query) O(1), mas nada limitava
 * quantos pares rodam: o laço de `suggestTerms` percorre TODO o vocabulário e, para cada termo,
 * TODA a query. Ambos os lados são influenciáveis por um atacante — o vocabulário vem de conteúdo
 * web recortado, a query é um argumento de tool call — então o produto pode crescer sem limite
 * mesmo com cada par barato. Medido: vocabulário de 20.000 termos com query de 1.000 termos
 * custava 2.936 ms; com query de 5.000 termos, 13.295 ms — tudo síncrono, bloqueando o único
 * event loop do servidor.
 *
 * Este orçamento limita o total de pares escaneados por chamada, derivando quantos termos da
 * query participam do escaneamento a partir do tamanho do vocabulário (`MAX_CANDIDATE_PAIRS /
 * vocabularySize`, arredondado para baixo, nunca menos de 1). Escalar o corte pelo tamanho do
 * vocabulário — em vez de um número fixo de termos de query — é o que deixa uso legítimo
 * intocado: um vocabulário de 100.000 termos com uma query de 6 palavras (100.000 × 6 = 600.000
 * pares) fica abaixo do orçamento e não sofre corte nenhum, exatamente como hoje.
 */
const MAX_CANDIDATE_PAIRS = 750_000;

/**
 * Devolve até `max` termos do vocabulário do índice a distância de Levenshtein <= 2 de algum
 * termo tokenizado de `query`, ordenados por distância crescente e depois alfabeticamente.
 */
export function suggestTerms(index: InvertedIndex, query: string, max: number): string[] {
  const MAX_DISTANCE = 2;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const vocabularySize = index.postings.size;
  const scannedQueryTerms =
    vocabularySize === 0
      ? queryTerms
      : queryTerms.slice(0, Math.max(1, Math.floor(MAX_CANDIDATE_PAIRS / vocabularySize)));

  const candidates: Array<{ term: string; distance: number }> = [];
  for (const term of index.vocabulary()) {
    let best = MAX_DISTANCE + 1;
    for (const queryTerm of scannedQueryTerms) {
      const distance = levenshtein(term, queryTerm, MAX_DISTANCE);
      if (distance < best) best = distance;
      if (best === 0) break;
    }
    if (best <= MAX_DISTANCE) candidates.push({ term, distance: best });
  }

  candidates.sort((a, b) => a.distance - b.distance || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return candidates.slice(0, max).map((c) => c.term);
}
