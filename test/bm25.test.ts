import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkNote } from '../src/index/chunker.js';
import { FIELD_WEIGHTS, InvertedIndex, NOTE_TYPE_WEIGHTS } from '../src/index/inverted-index.js';
import { B, idf, K1, search, suggestTerms } from '../src/index/bm25.js';
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

  it('termos de vocabulário absurdamente longos (base64/hex sem separadores) não travam o event loop', () => {
    // Reproduz a cena de risco: 200 termos de vocabulário de 5.000 caracteres cada, todos do
    // MESMO comprimento que a query (o early-exit por diferença de comprimento não ajuda) e
    // quase idênticos entre si (o early-exit por mínimo de linha também não ajuda, porque o
    // mínimo permanece baixo por quase toda a matriz). Um clipping cheio de data-URIs base64 ou
    // hex digests produz exatamente esse vocabulário — `tokenizer.ts` não tem cap de tamanho de
    // token. Sem o cap de comprimento em `levenshtein`, isso mede ~37s de event loop bloqueado;
    // com o cap, cada comparação é O(1) (só checagem de tamanho) e o suggestTerms inteiro deve
    // terminar em milissegundos.
    // Todo par (term_i, queryTerm) só difere nos 3 últimos caracteres (dígitos vs. "xxx"), então
    // a distância de edição verdadeira é sempre exatamente 3 (> maxDistance) — o prefixo de 4997
    // "x"s idênticos alinha em diagonal a custo zero, e nenhuma combinação de inserção/deleção
    // supera o custo de 3 substituições. Isso garante que `suggestions` fica vazio independente
    // do cap, e mantém o mínimo de cada linha da matriz baixo (0 ou 1) por quase toda a extensão
    // do cálculo — exatamente a condição em que o early-exit por mínimo de linha NÃO ajuda,
    // forçando a matriz O(len²) inteira a rodar sem o cap de comprimento.
    const index = new InvertedIndex();
    const LONG = 5000;
    const prefix = 'x'.repeat(LONG - 3);
    for (let i = 0; i < 200; i++) {
      const suffix = String(i).padStart(3, '0');
      const term = prefix + suffix;
      index.addChunk(makeChunk({ id: `long#${i}`, headingPath: [term] }));
    }
    const queryTerm = 'x'.repeat(LONG);

    const start = Date.now();
    const suggestions = suggestTerms(index, queryTerm, 10);
    const elapsedMs = Date.now() - start;

    // Nenhum termo de 5.000 caracteres deve ser sugerido — o cap trata termos além dele como
    // fora de alcance, então nada no vocabulário sintético qualifica.
    expect(suggestions).toEqual([]);
    // Bound folgado o bastante para não ser flaky em CI, mas várias ordens de grandeza abaixo dos
    // ~37s medidos sem o cap — qualquer regressão que reintroduza o scan completo estoura isso.
    expect(elapsedMs).toBeLessThan(2000);
  }, 10000);
});
