import type { Chunk, ScoredChunk } from '../types.js';
import { noteTypeWeight, type InvertedIndex } from './inverted-index.js';
import { MAX_TOKEN_LENGTH, tokenize } from './tokenizer.js';

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
 * hex embutido num clipping. Sem esse corte, dois termos longos e quase idênticos (ex.: dois
 * blobs base64 que diferem em poucos bytes) fazem `levenshtein` rodar a matriz O(len²) inteira —
 * o early-exit por diferença de comprimento não ajuda (comprimentos iguais) e o early-exit por
 * mínimo de linha não ajuda (o mínimo fica baixo a matriz inteira, porque as strings são quase
 * iguais). Medido: 200 termos de vocabulário de 5.000 caracteres cada, mais um termo de query de
 * 5.000 caracteres, bloqueiam o event loop por ~37s num servidor single-threaded.
 *
 * É o MESMO cap que `tokenizer.ts` aplica por token, e é importado de lá em vez de repetido: os
 * dois números precisam concordar, senão o índice passa a conter termos que o `levenshtein` trata
 * como fora de alcance (nunca sugeridos) sem que nada aponte a divergência. Com o cap no
 * tokenizador, nenhum termo vindo do índice ou da query chega aqui acima do limite; a checagem
 * fica como defesa em profundidade para chamadores futuros que não passem pelo `tokenize`.
 */
const MAX_TERM_LENGTH = MAX_TOKEN_LENGTH;

/**
 * Orçamento de CÉLULAS da matriz de Levenshtein consumidas por chamada de `suggestTerms`, contadas
 * linha a linha e compartilhadas por todos os pares. Ver `MAX_SCANNED_QUERY_TERMS` para o porquê
 * de contar células e não pares.
 */
interface CellBudget {
  remaining: number;
}

/**
 * Distância de Levenshtein entre `a` e `b`, com early-exit assim que o mínimo da linha corrente
 * já ultrapassa `maxDistance`: a partir daí nenhuma célula futura da mesma linha pode descer
 * abaixo desse mínimo (cada célula é >= o mínimo da linha menos as operações restantes), então a
 * distância final também não pode, e o cálculo pode parar sem terminar a matriz inteira.
 *
 * `budget` é debitado do custo real (uma linha = `b.length` células) ANTES de cada linha rodar, e
 * o cálculo aborta como "fora de alcance" se o orçamento acabar no meio — o chamador vê o
 * orçamento zerado e para o scan.
 */
function levenshtein(a: string, b: string, maxDistance: number, budget: CellBudget): number {
  if (a === b) return 0;
  if (a.length > MAX_TERM_LENGTH || b.length > MAX_TERM_LENGTH) return maxDistance + 1;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prevRow = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    budget.remaining -= b.length;
    if (budget.remaining < 0) return maxDistance + 1;

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
 * Quantos termos da query participam do scan. Ambos os lados do laço de `suggestTerms` são
 * influenciáveis por um atacante — o vocabulário vem de conteúdo web recortado, a query é um
 * argumento de tool call — e o laço percorre TODO o vocabulário para CADA termo da query, então o
 * produto cresce sem limite. Medido: vocabulário de 20.000 termos com query de 1.000 termos
 * custava 2.936 ms; com 5.000 termos, 13.295 ms — tudo síncrono, bloqueando o único event loop do
 * servidor. `retrieval.ts` já corta a query em 64 termos; correção ortográfica não precisa nem
 * disso. Um punhado basta: uma query natural de busca tem 3 a 8 termos depois das stopwords, e as
 * palavras que o autor mais quer ver corrigidas estão no começo dela.
 *
 * O corte anterior derivava esse número do tamanho do vocabulário (`750.000 pares / vocabulário`),
 * o que limitava a CONTAGEM de pares supondo cada par O(1) por causa de `MAX_TERM_LENGTH`. A
 * suposição é falsa: termos de 64 caracteres, todos do mesmo comprimento e compartilhando prefixo,
 * derrotam os dois early-exits do `levenshtein` e rodam quase a matriz 64x64 inteira, então
 * 750.000 pares permitiam da ordem de 3e9 células. Medido com 50.000 termos naturais mais um
 * clipping de `01-raw/` com tokens tipo hash de prefixo comum, uma única query de 1 KB: 500 termos
 * envenenados 277 ms, 2.000 939 ms, 8.000 4.948 ms, e 31.357 ms com o vocabulário inteiro nessa
 * forma — contra 94-124 ms num vocabulário natural. Por isso o orçamento de verdade abaixo é de
 * CÉLULAS, a unidade em que o custo realmente é medido; este corte só impede que uma query longa
 * gaste o orçamento todo nos primeiros termos do vocabulário.
 */
const MAX_SCANNED_QUERY_TERMS = 8;

/**
 * Teto de células de matriz de Levenshtein por chamada de `suggestTerms`, debitado linha a linha
 * dentro do `levenshtein` e compartilhado por todos os pares. É o que limita o custo de verdade:
 * o pior caso desta função passa a ser ~2e7 células (~200 ms medidos a ~1e8 células/s), qualquer
 * que seja a forma do vocabulário.
 *
 * O teto não é alto demais: um vocabulário natural gasta pouquíssimo — quase todo par morre no
 * early-exit por diferença de comprimento, e os que rodam param em 3 ou 4 linhas. Medido nos
 * testes desta task: 100.000 termos naturais contra uma query de 6 palavras consomem 5.000.051
 * células, um quarto do teto, e o scan chega ao fim intocado; 12.001 termos naturais consomem
 * 1.032.080. O mesmo vocabulário de 12.001 termos com prefixo comum de 64 caracteres estoura o
 * teto e o scan para no meio. Quando o orçamento acaba, o scan do vocabulário PARA: sugestões que estariam adiante
 * se perdem. É a degradação deliberada, e a alternativa é pior — sugestão é um extra que só roda
 * quando a busca não achou nada, enquanto o event loop travado derruba o servidor inteiro.
 */
const MAX_LEVENSHTEIN_CELLS = 20_000_000;

/**
 * Devolve até `max` termos do vocabulário do índice a distância de Levenshtein <= 2 de algum
 * termo tokenizado de `query`, ordenados por distância crescente e depois alfabeticamente.
 */
export function suggestTerms(index: InvertedIndex, query: string, max: number): string[] {
  const MAX_DISTANCE = 2;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const scannedQueryTerms = queryTerms.slice(0, MAX_SCANNED_QUERY_TERMS);
  const budget: CellBudget = { remaining: MAX_LEVENSHTEIN_CELLS };

  const candidates: Array<{ term: string; distance: number }> = [];
  for (const term of index.vocabulary()) {
    if (budget.remaining <= 0) break;
    let best = MAX_DISTANCE + 1;
    for (const queryTerm of scannedQueryTerms) {
      const distance = levenshtein(term, queryTerm, MAX_DISTANCE, budget);
      if (distance < best) best = distance;
      if (best === 0) break;
    }
    if (best <= MAX_DISTANCE) candidates.push({ term, distance: best });
  }

  candidates.sort((a, b) => a.distance - b.distance || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return candidates.slice(0, max).map((c) => c.term);
}
