import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkNote } from '../src/index/chunker.js';
import {
  ARCHIVE_PATH_WEIGHT,
  FIELD_WEIGHTS,
  InvertedIndex,
  NOTE_TYPE_WEIGHTS,
} from '../src/index/inverted-index.js';
import { B, idf, K1, search, suggestTerms } from '../src/index/bm25.js';
import { MAX_TOKEN_LENGTH, tokenize } from '../src/index/tokenizer.js';
import type { Chunk } from '../src/types.js';

const FIXTURE_ROOT = join(__dirname, 'fixtures/vault');

/**
 * Divide um arquivo bruto em frontmatter + corpo por linha, sem depender do parser de
 * frontmatter (T3 não é dependência desta task — só T1, T2, T4, T5). Mesma lógica usada em
 * test/chunker.test.ts.
 */
function splitFrontmatter(raw: string): { body: string; bodyStartLine: number } {
  const lines = raw.split('\n');
  if (lines[0] !== '---') {
    return { body: raw, bodyStartLine: 1 };
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return { body: raw, bodyStartLine: 1 };
  }
  const bodyStartLine = closeIndex + 2;
  const body = lines.slice(bodyStartLine - 1).join('\n');
  return { body, bodyStartLine };
}

function loadChunks(relPath: string, tipo: string | undefined, tags: string[]): Chunk[] {
  const raw = readFileSync(join(FIXTURE_ROOT, relPath), 'utf-8');
  const { body, bodyStartLine } = splitFrontmatter(raw);
  return chunkNote(relPath, body, tipo, tags, bodyStartLine);
}

const BULLMQ_PATH = '02-wiki/nestjs/bullmq-worker.md';
const AUTH_GUARD_PATH = '02-wiki/nestjs/auth-guard.md';
const NESTJS_MOC_PATH = '02-wiki/nestjs/nestjs-moc.md';

/** Índice pequeno com os três arquivos da fixture relevantes para as asserções desta task. */
function buildNestjsIndex(): InvertedIndex {
  const index = new InvertedIndex();
  for (const chunk of loadChunks(BULLMQ_PATH, 'wiki', ['nestjs', 'bullmq', 'filas'])) {
    index.addChunk(chunk);
  }
  for (const chunk of loadChunks(AUTH_GUARD_PATH, 'wiki', ['nestjs', 'auth', 'jwt'])) {
    index.addChunk(chunk);
  }
  for (const chunk of loadChunks(NESTJS_MOC_PATH, 'moc', ['nestjs'])) {
    index.addChunk(chunk);
  }
  return index;
}

/** Chunk mínimo sintético, só com os campos necessários para exercitar addChunk isoladamente. */
function makeChunk(overrides: Partial<Chunk> & { id: string }): Chunk {
  return {
    path: overrides.path ?? 'sintetico.md',
    headingPath: [],
    lineStart: 1,
    lineEnd: 1,
    text: '',
    tipo: undefined,
    tags: [],
    ...overrides,
  };
}

describe('InvertedIndex.addChunk — pesos de campo testados no mecanismo', () => {
  it('termo só no heading recebe frequência ponderada igual a FIELD_WEIGHTS.heading (3.0)', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'h#1', headingPath: ['Alpha'] }));

    expect(index.postings.get('alpha')?.get('h#1')).toBe(3.0);
    expect(index.chunkLengths.get('h#1')).toBe(3.0);
  });

  it('termo só no heading de um chunk REAL (via chunkNote em markdown real) recebe peso 3.0, não 4.0', () => {
    // Regressão: chunk.text inclui a própria linha do heading que abriu o chunk (chunkNote faz
    // `currentLines = [line]` no momento do match), e splitFields roteia toda linha não cercada —
    // inclusive essa — para `prose`. Um addChunk ingênuo soma headingText (3.0) E prose (1.0) para
    // o mesmo termo, produzindo peso efetivo 4.0 em vez dos 3.0 do spec. Um chunk sintético com
    // `text: ''` (como o teste acima) não expõe esse bug porque não tem heading duplicado dentro
    // do texto — só chunkNote sobre markdown real reproduz a condição.
    const index = new InvertedIndex();
    const chunks = loadChunks(BULLMQ_PATH, 'wiki', ['nestjs', 'bullmq', 'filas']);
    const retryChunk = chunks.find((c) => c.headingPath.join('/') === 'Contexto/Retry e backoff');
    expect(retryChunk).toBeDefined();

    // "backoff" só ocorre na linha "### Retry e backoff" deste chunk — a próxima ocorrência no
    // arquivo (`backoff: { type: 'exponential', ... }`) está dentro do bloco de código do chunk
    // ## Exemplo, um chunk diferente. Isso isola o termo: se ele aparecer com peso > 3.0 aqui, é
    // porque a linha do heading foi contada de novo como prosa.
    index.addChunk(retryChunk!);

    expect(index.postings.get('backoff')?.get(retryChunk!.id)).toBe(FIELD_WEIGHTS.heading);
  });

  it('termo só nas tags recebe frequência ponderada igual a FIELD_WEIGHTS.tags (2.0)', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 't#1', tags: ['alpha'] }));

    expect(index.postings.get('alpha')?.get('t#1')).toBe(2.0);
    expect(index.chunkLengths.get('t#1')).toBe(2.0);
  });

  it('termo só na prosa recebe frequência ponderada igual a FIELD_WEIGHTS.prose (1.0)', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'p#1', text: 'alpha' }));

    expect(index.postings.get('alpha')?.get('p#1')).toBe(1.0);
    expect(index.chunkLengths.get('p#1')).toBe(1.0);
  });

  it('termo só dentro de cerca de código recebe frequência ponderada igual a FIELD_WEIGHTS.code (0.5)', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'c#1', text: '```\nalpha\n```' }));

    expect(index.postings.get('alpha')?.get('c#1')).toBe(0.5);
    expect(index.chunkLengths.get('c#1')).toBe(0.5);
  });

  it('chunkLength somando os quatro campos fixa a definição de comprimento ponderado', () => {
    const index = new InvertedIndex();
    index.addChunk(
      makeChunk({
        id: 'all#1',
        headingPath: ['Beta'],
        tags: ['beta'],
        text: 'beta\n```\nbeta\n```',
      }),
    );

    const expectedLength =
      FIELD_WEIGHTS.heading + FIELD_WEIGHTS.tags + FIELD_WEIGHTS.prose + FIELD_WEIGHTS.code;
    expect(index.postings.get('beta')?.get('all#1')).toBe(expectedLength);
    expect(index.chunkLengths.get('all#1')).toBe(expectedLength);
  });

  it('addChunk repetido para o mesmo id substitui o registro anterior sem acumular', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'r#1', headingPath: ['Alpha'] }));
    index.addChunk(makeChunk({ id: 'r#1', headingPath: ['Alpha'] }));

    expect(index.postings.get('alpha')?.get('r#1')).toBe(3.0);
    expect(index.chunkLengths.get('r#1')).toBe(3.0);
  });
});

describe('InvertedIndex — estrutura e navegação', () => {
  it('has() reflete a presença de chunks de um path', () => {
    const index = buildNestjsIndex();
    expect(index.has(BULLMQ_PATH)).toBe(true);
    expect(index.has('caminho/que/nao/existe.md')).toBe(false);
  });

  it('removeByPath remove todos os chunks daquele path e ajusta totalLength', () => {
    const index = buildNestjsIndex();
    const lengthBefore = index.totalLength;
    const bullmqChunks = [...index.chunks.values()].filter((c) => c.path === BULLMQ_PATH);
    const bullmqLength = bullmqChunks.reduce(
      (sum, c) => sum + (index.chunkLengths.get(c.id) ?? 0),
      0,
    );

    index.removeByPath(BULLMQ_PATH);

    expect(index.has(BULLMQ_PATH)).toBe(false);
    expect(index.totalLength).toBeCloseTo(lengthBefore - bullmqLength);
    for (const [, postings] of index.postings) {
      for (const chunkId of postings.keys()) {
        expect(chunkId.startsWith(BULLMQ_PATH)).toBe(false);
      }
    }
  });

  it('removeByPath de uma nota permanece rápido mesmo com um vocabulário grande no resto do índice', () => {
    // Reproduz a cena de risco: um vocabulário de 100.000 termos distintos (outras notas do
    // vault) e uma nota-alvo de 200 chunks a remover. Uma implementação de removeChunkById que
    // varre `postings` inteiro por chunk removido custa O(chunks removidos × vocabulário) — medido
    // ~501ms neste cenário exato. Com a lista de termos por chunk guardada em addChunk, o custo é
    // O(termos do próprio chunk) e deve terminar em milissegundos.
    const index = new InvertedIndex();
    for (let i = 0; i < 100_000; i++) {
      index.addChunk(
        makeChunk({ id: `vocab#${i}`, path: `outras-notas/${i}.md`, headingPath: [`termovocab${i}`] }),
      );
    }
    const TARGET_PATH = 'nota-alvo.md';
    for (let i = 0; i < 200; i++) {
      index.addChunk(
        makeChunk({ id: `${TARGET_PATH}#${i}`, path: TARGET_PATH, text: `conteudo chunk ${i} da nota alvo` }),
      );
    }
    expect(index.has(TARGET_PATH)).toBe(true);

    const start = Date.now();
    index.removeByPath(TARGET_PATH);
    const elapsedMs = Date.now() - start;

    expect(index.has(TARGET_PATH)).toBe(false);
    // Bound folgado o bastante para não ser flaky em CI, mas bem abaixo dos ~501ms medidos com o
    // scan completo de postings — qualquer regressão que volte a varrer o vocabulário todo por
    // chunk removido estoura isso.
    expect(elapsedMs).toBeLessThan(200);
  }, 10000);

  it('vocabulary() devolve os termos indexados', () => {
    const index = buildNestjsIndex();
    const vocab = new Set(index.vocabulary());

    expect(vocab.has('bullmq')).toBe(true);
    expect(vocab.has('jwt')).toBe(true);
    expect(vocab.has('worker')).toBe(true);
  });

  it('avgLength() é totalLength dividido pelo número de chunks', () => {
    const index = buildNestjsIndex();
    expect(index.avgLength()).toBeCloseTo(index.totalLength / index.size());
  });
});

describe('constantes do BM25 do spec (K1, B, idf)', () => {
  it('K1 e B têm os valores exatos do spec', () => {
    expect(K1).toBe(1.2);
    expect(B).toBe(0.75);
  });

  it('idf segue Math.log(1 + (N - n + 0.5) / (n + 0.5))', () => {
    expect(idf(10, 1)).toBeCloseTo(Math.log(1 + (10 - 1 + 0.5) / (1 + 0.5)));
    expect(idf(10, 5)).toBeCloseTo(Math.log(1 + (10 - 5 + 0.5) / (5 + 0.5)));
    expect(idf(10, 10)).toBeCloseTo(Math.log(1 + (10 - 10 + 0.5) / (10 + 0.5)));
  });
});

describe('search — sanidade de integração', () => {
  it('buscar "bullmq" devolve apenas chunks de bullmq-worker.md', () => {
    const index = buildNestjsIndex();
    const results = search(index, 'bullmq', 10);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.chunk.path).toBe(BULLMQ_PATH);
    }
  });

  it('buscar "jwt" traz auth-guard.md no topo', () => {
    const index = buildNestjsIndex();
    const results = search(index, 'jwt', 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.path).toBe(AUTH_GUARD_PATH);
  });

  it('query pelos termos do ## Contexto de bullmq-worker.md devolve esse chunk acima do ## Exemplo', () => {
    const index = buildNestjsIndex();
    // "potentia" só aparece na prosa do chunk ## Contexto; não aparece no chunk ## Exemplo
    // (código + parágrafo final), então é um termo discriminante o bastante para uma checagem
    // de sanidade de integração sem depender de nenhum peso específico.
    const results = search(index, 'potentia processamento', 10);

    const contexto = results.find(
      (r) => r.chunk.path === BULLMQ_PATH && r.chunk.headingPath.join('/') === 'Contexto',
    );
    const exemplo = results.find(
      (r) => r.chunk.path === BULLMQ_PATH && r.chunk.headingPath.join('/') === 'Exemplo',
    );

    expect(contexto).toBeDefined();
    const contextoIndex = results.indexOf(contexto!);
    const exemploIndex = exemplo ? results.indexOf(exemplo) : Infinity;
    expect(contextoIndex).toBeLessThan(exemploIndex);
  });

  it('termo inexistente devolve lista vazia', () => {
    const index = buildNestjsIndex();
    const results = search(index, 'termoquenaoexisteinequivocamente', 10);
    expect(results).toEqual([]);
  });

  it('limit corta a lista de resultados quando há mais candidatos do que o limite', () => {
    const index = buildNestjsIndex();
    // "nestjs" está nas tags de todo chunk das três notas da fixture — 10 candidatos ao todo
    // (verificado por inspeção), bem mais do que o limit=3 abaixo. Deletar o `.slice(0, limit)`
    // deixaria a suíte inteira verde até este teste: os `limit: 1` testes de `keep` passam só
    // porque `keep` reduz os candidatos a exatamente um, então nunca exercitam o corte em si.
    const full = search(index, 'nestjs', 100);
    expect(full.length).toBe(10);

    const limited = search(index, 'nestjs', 3);

    expect(limited.length).toBe(3);
    expect(limited).toEqual(full.slice(0, 3));
  });

  it('keep filtra ANTES de fatiar por limit — não retorna vazio quando o topo falha no filtro', () => {
    const index = buildNestjsIndex();
    // Sem filtro, o topo de "jwt" é auth-guard.md (verificado no teste acima). Com limit=1 e um
    // filtro que exclui justamente esse path, uma implementação que corta para `limit` ANTES de
    // filtrar devolveria lista vazia (o único candidato do corte falha no filtro); a
    // implementação correta filtra antes, então o segundo colocado (outro path com "jwt")
    // aparece no resultado.
    const unfiltered = search(index, 'jwt', 1);
    expect(unfiltered[0]?.chunk.path).toBe(AUTH_GUARD_PATH);

    const filtered = search(index, 'jwt', 1, (chunk) => chunk.path !== AUTH_GUARD_PATH);

    expect(filtered.length).toBe(1);
    expect(filtered[0]?.chunk.path).not.toBe(AUTH_GUARD_PATH);
  });

  it('score retornado bate com o cálculo manual do BM25 — não é um placeholder', () => {
    // Índice de um único chunk: N=1, docsWithTerm=1, freq=1.0 (só prosa), dl=avgdl (único chunk),
    // tipo indefinido (noteTypeWeight=1.0). Isso reduz o score a uma fórmula fechada que pode ser
    // recalculada aqui à mão a partir do texto do spec, sem reusar a implementação de `search`.
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'score#1', text: 'unicotermo' }));

    const results = search(index, 'unicotermo', 10);
    expect(results).toHaveLength(1);

    const N = 1;
    const n = 1;
    const freq = 1.0;
    const dl = 1.0;
    const avgdl = 1.0;
    const expectedIdf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const expectedScore =
      (expectedIdf * freq * (1.2 + 1)) / (freq + 1.2 * (1 - 0.75 + (0.75 * dl) / avgdl));

    expect(results[0]?.score).toBeCloseTo(expectedScore);
  });

  it('viaGraph vem false para todo resultado de search — esta função não faz travessia de grafo', () => {
    const index = buildNestjsIndex();
    const results = search(index, 'bullmq', 10);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.viaGraph).toBe(false);
    }
  });
});

/**
 * `99-archive/` é somente leitura para a escrita (`DENIED_PREFIXES` em `src/write/paths.ts`) e
 * continuava rankeando IGUAL ao conteúdo vivo. Medido no vault real: enquanto seis projetos ainda
 * estavam arquivados, a checagem de duplicata do `vault_learn` elegeu como TOPO uma decisão de
 * projeto arquivado — conhecimento morto ganhando de conhecimento vivo.
 *
 * O peso demove, nunca esconde: a nota arquivada continua achável, porque a história de um projeto
 * encerrado é história de verdade. Ela só deixa de competir de igual para igual.
 */
describe('ARCHIVE_PATH_WEIGHT — nota arquivada continua achável, mas não compete de igual', () => {
  it('o mesmo texto pontua menos em 99-archive/ do que em 02-wiki/', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'vivo#1', path: '02-wiki/nestjs/vivo.md', text: 'zzarquivotermo' }));
    index.addChunk(makeChunk({ id: 'morto#1', path: '99-archive/03-projects/x/morto.md', text: 'zzarquivotermo' }));

    const results = search(index, 'zzarquivotermo', 10);

    expect(results).toHaveLength(2);
    expect(results[0]?.chunk.path).toBe('02-wiki/nestjs/vivo.md');
    expect(results[1]?.chunk.path).toBe('99-archive/03-projects/x/morto.md');
    // Demovida, não escondida.
    expect(results[1]?.score).toBeGreaterThan(0);
    expect(results[1]?.score).toBeCloseTo((results[0]?.score ?? 0) * ARCHIVE_PATH_WEIGHT);
  });

  it('casa o prefixo em fronteira de segmento, não por começo de string', () => {
    // `99-archive-notes/` é uma pasta comum e não pode ser demovida junto com `99-archive/`,
    // exatamente como o guard de escrita distingue as duas.
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'a#1', path: '02-wiki/x.md', text: 'zzfronteira' }));
    index.addChunk(makeChunk({ id: 'b#1', path: '99-archive-notes/y.md', text: 'zzfronteira' }));

    const results = search(index, 'zzfronteira', 10);
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBeCloseTo(results[1]?.score ?? 0);
  });

  it('o peso do tipo e o do caminho se multiplicam', () => {
    const index = new InvertedIndex();
    index.addChunk(makeChunk({ id: 'w#1', path: '02-wiki/a.md', text: 'zzcombinado', tipo: 'wiki' }));
    index.addChunk(makeChunk({ id: 'm#1', path: '99-archive/b.md', text: 'zzcombinado', tipo: 'moc' }));

    const results = search(index, 'zzcombinado', 10);
    const vivo = results.find((r) => r.chunk.path === '02-wiki/a.md');
    const arquivado = results.find((r) => r.chunk.path === '99-archive/b.md');
    expect(arquivado?.score).toBeCloseTo(
      (vivo?.score ?? 0) * NOTE_TYPE_WEIGHTS.moc! * ARCHIVE_PATH_WEIGHT,
    );
  });
});

describe('NOTE_TYPE_WEIGHTS — peso por tipo de nota aplicado ao score acumulado', () => {
  it('sem o fator, o MOC (chunk curto que restate a nota) venceria; com o fator, o conteúdo real vence', () => {
    const index = buildNestjsIndex();
    // A linha "- [[bullmq-worker]] — worker de fila separado do API" do chunk ## Notas de
    // nestjs-moc.md (tipo: moc) casa com os mesmos termos do chunk ## Contexto do corpo real de
    // bullmq-worker.md (tipo: wiki). O chunk do MOC é muito mais curto, então sem o fator de tipo
    // de nota o BM25 o ranquearia acima do conteúdo que ele aponta.
    const results = search(index, 'worker fila', 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.path).toBe(BULLMQ_PATH);

    const mocResult = results.find((r) => r.chunk.path === NESTJS_MOC_PATH);
    expect(mocResult).toBeDefined();
    expect(results.indexOf(mocResult!)).toBeGreaterThan(0);
  });

  it('NOTE_TYPE_WEIGHTS.moc é 0.3 — mutação-alvo: removê-lo faz o MOC vencer', () => {
    expect(NOTE_TYPE_WEIGHTS.moc).toBe(0.3);
  });

  it('NOTE_TYPE_WEIGHTS.daily é 0.3 — mutação-alvo: mutar esse valor sobrevive sem esta asserção', () => {
    expect(NOTE_TYPE_WEIGHTS.daily).toBe(0.3);
  });
});

describe('suggestTerms', () => {
  it('devolve termos do vocabulário a distância de Levenshtein <= 2 da query', () => {
    const index = buildNestjsIndex();
    // "jwtt" está a distância 1 de "jwt" (uma inserção).
    const suggestions = suggestTerms(index, 'jwtt', 5);
    expect(suggestions).toContain('jwt');
  });

  it('respeita o limite `max`', () => {
    const index = buildNestjsIndex();
    // No vocabulário real da fixture nestjs, "worker" é o único termo a distância <= 2 de
    // "workor" (verificado por inspeção: suggestTerms(index, 'workor', 5) também devolve só
    // ['worker']). Uma asserção de `.length <= 1` também seria satisfeita por `[]`, o que não
    // prova que `max` cortou nada — aqui fixamos o conteúdo exato esperado.
    const suggestions = suggestTerms(index, 'workor', 1);
    expect(suggestions).toEqual(['worker']);
  });

  it('`max` corta a lista de candidatos quando há mais do que o limite', () => {
    // Com "workor" há um único candidato no vocabulário real (verificado acima), então esse caso
    // sozinho não exercita o corte por `max` — deletar `.slice(0, max)` de `suggestTerms` deixaria
    // aquele teste verde do mesmo jeito. Aqui, 4 termos qualificam (foo=0, fooa=1, foob=1,
    // fooxy=2), mais do que max=2, então o corte é observável.
    const index = new InvertedIndex();
    for (const term of ['foo', 'fooa', 'foob', 'fooxy', 'bar']) {
      index.addChunk(makeChunk({ id: `syn#${term}`, headingPath: [term] }));
    }

    const suggestions = suggestTerms(index, 'foo', 2);

    expect(suggestions).toEqual(['foo', 'fooa']);
  });

  it('ordena por distância crescente e depois alfabeticamente', () => {
    // Vocabulário sintético com distâncias conhecidas a partir de "foo":
    // foo=0, fooa=1, foob=1 (empate de distância, desempate alfabético), fooxy=2, bar=fora do
    // alcance (>2) e não deve aparecer.
    const index = new InvertedIndex();
    for (const term of ['foo', 'fooa', 'foob', 'fooxy', 'bar']) {
      index.addChunk(makeChunk({ id: `syn#${term}`, headingPath: [term] }));
    }

    const suggestions = suggestTerms(index, 'foo', 10);

    expect(suggestions).toEqual(['foo', 'fooa', 'foob', 'fooxy']);
  });

  it('query sem termos válidos (só stopwords/curtos) devolve lista vazia', () => {
    const index = buildNestjsIndex();
    expect(suggestTerms(index, 'a de', 5)).toEqual([]);
  });

  it('termos de vocabulário absurdamente longos (base64/hex sem separadores) nem chegam ao vocabulário', () => {
    // Cena de risco original: 200 termos de vocabulário de 5.000 caracteres cada, todos do MESMO
    // comprimento da query (o early-exit por diferença de comprimento não ajuda) e quase idênticos
    // entre si (o early-exit por mínimo de linha também não ajuda). Um clipping cheio de data-URIs
    // base64 ou hex digests produz exatamente esse vocabulário. A defesa era só o cap de
    // comprimento DENTRO de `levenshtein`, e este teste a media com relógio (`elapsedMs < 2000`).
    //
    // Com `MAX_TOKEN_LENGTH` em `tokenizer.ts`, a defesa passou a agir uma camada antes: um termo
    // de 5.000 caracteres é descartado na tokenização e nunca vira chave de posting list, então
    // `levenshtein` sequer é chamado com ele. Isso tornaria a asserção de relógio VÁCUA — com o
    // vocabulário vazio não sobra trabalho nenhum a cronometrar, e o teste passaria mesmo que o
    // cap do `levenshtein` fosse removido. Ela foi trocada pela asserção determinística do
    // invariante mais forte, que é o que agora protege o `suggestTerms`: esses termos não existem
    // no índice. Remover o cap do tokenizador falha aqui.
    const index = new InvertedIndex();
    const LONG = 5000;
    const prefix = 'x'.repeat(LONG - 3);
    for (let i = 0; i < 200; i++) {
      const suffix = String(i).padStart(3, '0');
      const term = prefix + suffix;
      index.addChunk(makeChunk({ id: `long#${i}`, headingPath: [term] }));
    }
    const queryTerm = 'x'.repeat(LONG);

    // Os 200 chunks entraram no índice; nenhum termo deles entrou no vocabulário.
    expect(index.size()).toBe(200);
    expect(index.postings.size).toBe(0);
    expect(suggestTerms(index, queryTerm, 10)).toEqual([]);
  });

  it('um termo de exatamente MAX_TOKEN_LENGTH continua no vocabulário e continua sugerível', () => {
    // Bracket superior do cap por token visto pela via do índice: o corte é em 64, não abaixo
    // dele, e um termo no limite continua sendo um termo de busca normal.
    const index = new InvertedIndex();
    const atCap = `${'x'.repeat(MAX_TOKEN_LENGTH - 2)}ab`;
    expect(atCap).toHaveLength(64);
    index.addChunk(makeChunk({ id: 'cap#1', headingPath: [atCap] }));

    expect([...index.vocabulary()]).toEqual([atCap]);
    expect(suggestTerms(index, `${'x'.repeat(MAX_TOKEN_LENGTH - 2)}ax`, 5)).toEqual([atCap]);
  });

  it('cap de comprimento não é baixo demais: um termo real de 13 caracteres ainda é sugerido', () => {
    // Bracket inferior de MAX_TERM_LENGTH. O teste acima só prova que o cap não é ALTO demais
    // (não deixa passar termos absurdos). Nada até aqui prova que ele não é BAIXO demais — um cap
    // de, digamos, 8 sobreviveria ao resto da suíte inteira e ainda assim rejeitaria "bullmq-worker"
    // (13 caracteres), um termo de vocabulário real e comum na fixture, antes mesmo de calcular a
    // distância. "bullmq-workor" (erro de digitação de um caractere em "worker") deve continuar
    // sugerindo "bullmq-worker" — se MAX_TERM_LENGTH cair abaixo de 13, este teste falha porque
    // levenshtein passa a tratar ambos os termos como fora de alcance por comprimento, não por
    // distância de edição.
    const index = buildNestjsIndex();
    const suggestions = suggestTerms(index, 'bullmq-workor', 5);
    expect(suggestions).toEqual(['bullmq-worker']);
  });
});

describe('suggestTerms — corte de termos da query e orçamento de células', () => {
  /** Chunk sintético mínimo, um termo de vocabulário por chunk. */
  function vocabChunk(id: string, term: string): Chunk {
    return {
      id,
      path: 'sintetico.md',
      headingPath: [term],
      lineStart: 1,
      lineEnd: 1,
      text: '',
      tipo: undefined,
      tags: [],
    };
  }

  it('query com milhares de termos devolve exatamente o que devolvem os primeiros termos escaneados', () => {
    // MAX_TERM_LENGTH torna cada PAR O(1), mas nada limitava quantos pares rodam: o laço externo
    // de suggestTerms percorre TODO o vocabulário e, para cada termo, TODA a query. Query é um
    // argumento de tool call (atacante controla o número de "termos" que tokenize produz) e
    // vocabulário vem de conteúdo web recortado (atacante também o influencia), então o produto
    // pode crescer sem limite mesmo com cada par barato. Medido antes deste fix: vocabulário de
    // 20.000 termos com query de 5.000 termos custava dezenas de segundos de event loop bloqueado
    // num servidor single-threaded.
    //
    // A prova é determinística, não cronometrada (um relógio nesta fixture mede sobretudo o custo
    // de MONTAR o índice, e passaria mesmo sem corte nenhum): uma query de 5.000 termos devolve
    // exatamente o que devolve o prefixo de MAX_SCANNED_QUERY_TERMS termos, o que só acontece se o
    // resto da query nunca tiver sido escaneado.
    //
    // O que este teste NÃO faz é isolar MAX_SCANNED_QUERY_TERMS: nesta fixture as duas defesas
    // suprimem o mesmo resultado. Com o corte elevado a 64, os 20.001 termos de vocabulário vezes
    // 64 termos de query passam de 5e7 células, o orçamento de MAX_LEVENSHTEIN_CELLS estoura, o
    // scan do vocabulário para antes de chegar a "workers" (inserido por último) e o resultado
    // volta a ser `[]` — igual, por outro motivo. Ou seja: aqui só se prova que a cauda da query
    // não muda o resultado, por uma das duas defesas. Quem fixa a CONSTANTE, com o orçamento de
    // células comprovadamente fora do caminho, é o teste seguinte.
    const index = new InvertedIndex();
    for (let i = 0; i < 20000; i++) {
      index.addChunk(vocabChunk(`v#${i}`, `voc${String(i).padStart(6, '0')}xy`));
    }
    index.addChunk(vocabChunk('v#workers', 'workers'));

    const queryTerms: string[] = [];
    for (let i = 0; i < 8; i++) queryTerms.push(`qry${String(i).padStart(6, '0')}xy`);
    queryTerms.push('workorx');
    for (let i = 8; i < 5000; i++) queryTerms.push(`qry${String(i).padStart(6, '0')}xy`);
    const scannedPrefix = queryTerms.slice(0, 8).join(' ');

    // Sanidade da fixture: o termo tardio realmente casaria se fosse escaneado, e o prefixo
    // sozinho não casa nada. Sem isto a igualdade abaixo poderia ser vácuo (`[] === []`).
    expect(suggestTerms(index, 'workorx', 10)).toEqual(['workers']);

    expect(suggestTerms(index, queryTerms.join(' '), 10)).toEqual(suggestTerms(index, scannedPrefix, 10));
    expect(suggestTerms(index, queryTerms.join(' '), 10)).toEqual([]);
  }, 15000);

  it('MAX_SCANNED_QUERY_TERMS fixa em 8 os termos escaneados, com o orçamento de células fora do caminho', () => {
    // Fixa a CONSTANTE, e é o único teste que consegue: o de cima não distingue os dois
    // mecanismos, porque naquele vocabulário elevar o corte estoura o orçamento de células e
    // suprime o mesmo resultado por outro motivo. Aqui o vocabulário tem QUATRO termos curtos, e
    // uma query de 12 termos gasta 623 células (medido por instrumentação do contador; 919 com o
    // corte elevado a 64, isto é, escaneando a query inteira), quatro ordens de grandeza abaixo de
    // MAX_LEVENSHTEIN_CELLS (2e7). O orçamento não é atingido em nenhuma das variantes, então o
    // que decide o resultado aqui só pode ser a posição do termo na query.
    //
    // A query tem dois termos que casam, em posições escolhidas para prender o corte dos dois
    // lados: "workorx" (distância 2 de "workers") é o 5º termo, DENTRO do corte, e "consultaxy"
    // (distância 2 de "consulta") é o 9º, logo FORA dele. A única resposta compatível com um corte
    // em exatamente 8 é ['workers']:
    //   - corte >= 9, ou removido: "consultaxy" também é escaneado -> ['consulta', 'workers'];
    //   - corte <= 4: nem "workorx" é escaneado -> [].
    const index = new InvertedIndex();
    for (const term of ['nestjs', 'bullmq', 'workers', 'consulta']) {
      index.addChunk(vocabChunk(`c#${term}`, term));
    }
    expect(index.postings.size).toBe(4);

    const queryTerms = [
      'zzz001',
      'zzz002',
      'zzz003',
      'zzz004',
      'workorx',
      'zzz006',
      'zzz007',
      'zzz008',
      'consultaxy',
      'zzz010',
      'zzz011',
      'zzz012',
    ];
    expect(queryTerms[4]).toBe('workorx');
    expect(queryTerms[8]).toBe('consultaxy');
    // A query chega inteira ao corte: nenhum destes termos é stopword nem cai por comprimento.
    expect(tokenize(queryTerms.join(' '))).toEqual(queryTerms);

    expect(suggestTerms(index, queryTerms.join(' '), 10)).toEqual(['workers']);

    // Controle do MECANISMO, não do resultado: os mesmos 12 termos, com "consultaxy" movido para a
    // primeira posição, devolvem as duas sugestões. Se fosse o orçamento de células (ou qualquer
    // custo do vocabulário) a esconder "consulta", mover o termo não mudaria nada — o vocabulário
    // é o mesmo, a query é a mesma, só a ordem muda. Isto é o que prova que o corte por POSIÇÃO é
    // o mecanismo em jogo nas asserções acima.
    const moved = ['consultaxy', ...queryTerms.filter((term) => term !== 'consultaxy')];
    expect(suggestTerms(index, moved.join(' '), 10)).toEqual(['consulta', 'workers']);
  });

  it('vocabulário de termos longos com prefixo comum não roda a matriz inteira do vocabulário todo', () => {
    // O orçamento por CONTAGEM de pares supunha que cada par custa O(1) por causa de
    // MAX_TERM_LENGTH = 64. A suposição é falsa: termos de 64 caracteres, todos do mesmo
    // comprimento e compartilhando prefixo, derrotam os dois early-exits do levenshtein (o de
    // diferença de comprimento não dispara, e o mínimo de linha só passa de 2 perto do fim), então
    // cada par roda quase a matriz 64x64 inteira e o teto de 750.000 pares permitia da ordem de
    // 3e9 células. Medido: 500 termos envenenados 277ms, 2.000 939ms, 8.000 4.948ms, vocabulário
    // inteiro envenenado 31.357ms, contra 94-124ms num vocabulário natural. A precondição é
    // conteúdo de vault, e `01-raw/` é captura da web indexada.
    //
    // Prova determinística, sem relógio: o orçamento é de CÉLULAS, então o scan do vocabulário
    // para antes do fim quando os pares são caros. "consulta" é o ÚLTIMO termo inserido (e
    // `vocabulary()` itera em ordem de inserção), a distância <= 2 de "consultaxy": ele só é
    // devolvido se o scan tiver chegado lá. Com o orçamento, não chega. Sem o orçamento — ou com
    // um orçamento por pares, que este vocabulário não estoura (12.000 x 2 = 24.000 pares, bem
    // abaixo de 750.000) — o scan chega, devolve ['consulta'] e falha esta asserção.
    const index = new InvertedIndex();
    const prefix = 'x'.repeat(MAX_TOKEN_LENGTH - 6);
    for (let i = 0; i < 12000; i++) {
      index.addChunk(vocabChunk(`p#${i}`, `${prefix}${String(i).padStart(6, '0')}`));
    }
    index.addChunk(vocabChunk('p#consulta', 'consulta'));
    expect(index.postings.size).toBe(12001);

    const poisonedQueryTerm = `${prefix}zzzzzz`;
    expect(poisonedQueryTerm).toHaveLength(64);

    expect(suggestTerms(index, `${poisonedQueryTerm} consultaxy`, 10)).toEqual([]);
  }, 15000);

  it('o orçamento de células não corta um vocabulário natural do mesmo tamanho', () => {
    // Bracket inferior do orçamento de células, e a prova de que o teste acima mede o CUSTO dos
    // pares e não apenas o tamanho do vocabulário: mesmo número de termos (12.001), mesma query
    // de dois termos, mas termos de vocabulário curtos e variados — o feitio de um vault de
    // verdade. Aqui os pares são baratos (o early-exit por diferença de comprimento mata quase
    // todos), o orçamento não é atingido, o scan chega ao fim e "consulta" é sugerido.
    const index = new InvertedIndex();
    for (let i = 0; i < 12000; i++) {
      index.addChunk(vocabChunk(`n#${i}`, `noise${String(i).padStart(6, '0')}`));
    }
    index.addChunk(vocabChunk('n#consulta', 'consulta'));
    expect(index.postings.size).toBe(12001);

    expect(suggestTerms(index, 'termonatural consultaxy', 10)).toEqual(['consulta']);
  }, 15000);

  it('orçamento não é baixo demais: vocabulário de 100.000 termos com query de 6 palavras continua achando a sugestão que só bate na última palavra', () => {
    // Bracket inferior do orçamento de pares. O teste acima só prova que o orçamento não é ALTO
    // demais. Este prova que ele não é BAIXO demais: um vocabulário de 100.000 termos com uma
    // query de 6 palavras é o caso de uso legítimo citado como referência (não deve ser afetado
    // pelo corte). Aqui, das 6 palavras da query, só a ÚLTIMA ("consultaxy") está a distância <= 2
    // de um termo do vocabulário ("consult00"). Se o orçamento de pares for baixo demais para as
    // 100.000 entradas do vocabulário, a implementação escaneia só um PREFIXO dos termos da query
    // por termo de vocabulário, e — como o termo que bate está na última posição — a sugestão some
    // mesmo estando dentro da distância de edição permitida. "consulta" -> "consultaxy" é distância
    // 2 (duas inserções); todos os outros termos, entre si e contra o resto do vocabulário-ruído,
    // ficam a distância > 2 (verificado por cálculo). Isso falha para qualquer orçamento menor que
    // 100.000 (vocabulário) × 6 (posição da palavra que bate).
    const index = new InvertedIndex();
    for (let i = 0; i < 100000; i++) {
      const term = i === 42 ? 'consulta' : `noise${String(i).padStart(6, '0')}`;
      index.addChunk(vocabChunk(`v#${i}`, term));
    }
    const query = 'alfa beta gama delta epsilon consultaxy';

    const suggestions = suggestTerms(index, query, 10);

    expect(suggestions).toEqual(['consulta']);
  }, 15000);
});

/**
 * A via de INGESTÃO do trim quadrático de hífens, que é a que nenhum teto de query fecha:
 * `InvertedIndex.addChunk` tokeniza o CORPO das notas a cada varredura, então um clipping em
 * `01-raw/` com uma corrida longa de hífens — uma linha de separador colada, um blob hifenizado —
 * atrasava toda busca sem ninguém mandar query nenhuma (medido: uma busca por 'jwt' custando
 * 1.137ms por causa de uma corrida de 40.000 hífens numa nota). As asserções são determinísticas:
 * o que se afirma é que a nota envenenada produz exatamente o mesmo vocabulário que a nota limpa
 * e continua pesquisável pelos seus termos de verdade.
 */
describe('ingestão — corpo de nota com corrida longa de hífens', () => {
  const CLIPPING_PATH = '01-raw/clipping.md';
  const PROSE = 'guard de autenticacao jwt no nestjs com worker de filas';
  const BLOB = `a${'-'.repeat(200_000)}b`;

  function indexOf(body: string): InvertedIndex {
    const index = new InvertedIndex();
    for (const chunk of chunkNote(CLIPPING_PATH, body, 'wiki', ['jwt'], 1)) {
      index.addChunk(chunk);
    }
    return index;
  }

  const clean = ['## Clipping', '', PROSE, ''].join('\n');
  const poisoned = ['## Clipping', '', PROSE, '', BLOB, ''].join('\n');

  it('produz exatamente o mesmo vocabulário que a mesma nota sem a corrida de hífens', () => {
    const poisonedIndex = indexOf(poisoned);
    const cleanIndex = indexOf(clean);

    expect([...poisonedIndex.vocabulary()].sort()).toEqual([...cleanIndex.vocabulary()].sort());
    expect([...cleanIndex.vocabulary()].length).toBeGreaterThan(0);
    // Ninguém escreve uma chave de posting list de 200.002 caracteres.
    for (const term of poisonedIndex.vocabulary()) {
      expect(term.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    }
  });

  it('mantém a nota pesquisável pelos seus termos reais', () => {
    const poisonedIndex = indexOf(poisoned);

    const hits = search(poisonedIndex, 'jwt worker', 5);

    expect(hits).not.toHaveLength(0);
    expect(hits[0]!.chunk.path).toBe(CLIPPING_PATH);
    // E o blob não vira termo de busca: procurá-lo não acha nada.
    expect(search(poisonedIndex, BLOB, 5)).toEqual([]);
  });
});
