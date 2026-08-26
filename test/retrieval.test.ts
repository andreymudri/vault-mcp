import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  applyBudget,
  BM25_TOP_K,
  DEFAULT_CHAR_BUDGET,
  DEFAULT_LIMIT,
  GRAPH_DAMPING,
  TRUNCATION_MARKER,
} from '../src/retrieval/budget.js';
import { Retriever, type SearchOptions } from '../src/retrieval/retrieval.js';
import type { Chunk, ScoredChunk } from '../src/types.js';
import { VaultScanner, type DirEntry, type FsOps } from '../src/vault/scanner.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

const AUTH_GUARD = '02-wiki/nestjs/auth-guard.md';
const BULLMQ = '02-wiki/nestjs/bullmq-worker.md';
const NESTJS_MOC = '02-wiki/nestjs/nestjs-moc.md';
const DOCKER_MOC = '02-wiki/docker/docker-moc.md';
const MULTI_STAGE = '02-wiki/docker/multi-stage.md';
const CACHE_WRAPPER = '02-wiki/patterns/cache-wrapper.md';
const POTENTIA = '03-projects/potentia/README.md';
const DAILY = '04-daily/2026-08-20.md';
const INDEX_KNOWLEDGE = '00-index/index-knowledge.md';
const RASCUNHO = '01-raw/inbox/rascunho.md';

interface MemFile {
  text: string;
  mtimeMs: number;
}

/**
 * The whole fixture vault, read once into memory. Nothing in this file writes to
 * `test/fixtures/vault/`: the tests that need a mutating vault (incremental reindex, and the
 * insertion-order test below) mutate this in-memory copy, so parallel test files cannot corrupt
 * each other's reads.
 */
function loadFixture(): Map<string, MemFile> {
  const files = new Map<string, MemFile>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(FIXTURE, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.set(path, { text: readFileSync(join(FIXTURE, path), 'utf8'), mtimeMs: 1 });
      }
    }
  };
  walk('');
  return files;
}

function memEntry(name: string, directory: boolean): DirEntry {
  return { name, isDirectory: () => directory, isFile: () => !directory };
}

const MEM_ROOT = '/vault';

/** In-memory `FsOps` over a copy of the fixture, with mtime control for reindex tests. */
class MemoryFs implements FsOps {
  constructor(readonly files: Map<string, MemFile>) {}

  readdir(dir: string): DirEntry[] {
    const relative = this.relative(dir);
    const prefix = relative === '' ? '' : `${relative}/`;
    const directories = new Set<string>();
    const out: DirEntry[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) out.push(memEntry(rest, false));
      else directories.add(rest.slice(0, slash));
    }
    for (const name of directories) out.push(memEntry(name, true));
    return out;
  }

  stat(path: string) {
    // `nlink: 1` and a real `isFile`: the scanner runs the write guard's `classifyStat` over
    // this same object, so a fake that omits them is a fake of a node the scanner refuses.
    return { mtimeMs: this.file(path).mtimeMs, nlink: 1, isFile: () => true };
  }

  readFile(path: string): string {
    return this.file(path).text;
  }

  /** Vault-relative read, for tests that rewrite a note with its own bytes. */
  read(relative: string): string {
    const file = this.files.get(relative);
    if (file === undefined) throw new Error(`arquivo ausente: ${relative}`);
    return file.text;
  }

  /** Same bytes, newer mtime: forces the scanner to report the note as `changed`. */
  touch(relative: string): void {
    const file = this.files.get(relative);
    if (file === undefined) throw new Error(`arquivo ausente: ${relative}`);
    this.files.set(relative, { text: file.text, mtimeMs: file.mtimeMs + 1 });
  }

  write(relative: string, text: string): void {
    const previous = this.files.get(relative);
    this.files.set(relative, { text, mtimeMs: (previous?.mtimeMs ?? 0) + 1 });
  }

  remove(relative: string): void {
    this.files.delete(relative);
  }

  markdownPaths(): string[] {
    return [...this.files.keys()].filter((path) => path.endsWith('.md')).sort();
  }

  private relative(path: string): string {
    return path === MEM_ROOT ? '' : path.slice(MEM_ROOT.length + 1);
  }

  private file(path: string): MemFile {
    const file = this.files.get(this.relative(path));
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
    return file;
  }
}

function memoryRetriever(): { retriever: Retriever; fs: MemoryFs; scanner: VaultScanner } {
  const fs = new MemoryFs(loadFixture());
  const scanner = new VaultScanner({ vaultRoot: MEM_ROOT, fs });
  return { retriever: new Retriever({ scanner }), fs, scanner };
}

/** Any query is enough to force a `sync()`; this one exists only for its side effect. */
const WARMUP = 'aquecimento-do-indice';

function diskRetriever(): Retriever {
  return new Retriever({ scanner: new VaultScanner({ vaultRoot: FIXTURE }) });
}

function paths(results: ScoredChunk[]): string[] {
  return results.map((result) => result.chunk.path);
}

function totalChars(results: ScoredChunk[]): number {
  return results.reduce((sum, result) => sum + result.chunk.text.length, 0);
}

describe('Retriever.search — expansão pelo grafo', () => {
  it('alcança vocabulário que o BM25 não alcança, com score amortecido pela origem', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'jwt', limit: 12 });

    expect(paths(results)).toContain(AUTH_GUARD);

    const viaGraph = results.filter((result) => result.chunk.path === CACHE_WRAPPER);
    expect(viaGraph.length).toBeGreaterThan(0);
    for (const result of viaGraph) expect(result.viaGraph).toBe(true);

    const direct = results.filter((r) => r.chunk.path === AUTH_GUARD && !r.viaGraph);
    expect(direct.length).toBeGreaterThan(0);
    const sourceScore = Math.max(...direct.map((result) => result.score));
    for (const result of viaGraph) {
      expect(result.score).toBeCloseTo(GRAPH_DAMPING * sourceScore, 12);
    }
    // O amortecimento tem de MUDAR o score, senão a asserção acima passaria com damping 1.0.
    expect(sourceScore).toBeGreaterThan(0);
    expect(viaGraph[0]!.score).toBeLessThan(sourceScore);
  });

  it('`cache-wrapper.md` não tem nenhum acerto direto de `jwt` — só chega pelo grafo', () => {
    const retriever = diskRetriever();
    // Sem nota de origem dentro da pasta filtrada não há do que expandir, então um chunk de
    // `cache-wrapper.md` aqui significaria acerto direto de BM25, e o teste acima seria vácuo.
    const restricted = retriever.search({ query: 'jwt', folder: '02-wiki/patterns' });
    expect(restricted.results).toEqual([]);
  });

  it('expande um salto só: nota a dois saltos do acerto direto nunca aparece', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'camadas', limit: 40 });

    // Acertos diretos: `multi-stage.md` e `docker-moc.md`. Um salto a partir deles alcança
    // `04-daily/2026-08-20.md` e `CLAUDE.md` (backlinks) e `00-index/index-knowledge.md`.
    // Dois saltos alcançariam `nestjs-moc.md` (por `index-knowledge.md` e por `CLAUDE.md`) e,
    // dele, `auth-guard.md` e `bullmq-worker.md` — nenhum deles pode aparecer.
    expect(new Set(paths(results))).toEqual(
      new Set([MULTI_STAGE, DOCKER_MOC, DAILY, INDEX_KNOWLEDGE, 'CLAUDE.md']),
    );
    expect(paths(results)).not.toContain(NESTJS_MOC);
    expect(paths(results)).not.toContain(AUTH_GUARD);

    // Prova que o corte acima veio do fim da expansão, e não do orçamento: se o orçamento
    // tivesse cortado, a ausência das notas a dois saltos não diria nada sobre o número de saltos.
    expect(results.length).toBeLessThan(40);
    expect(totalChars(results)).toBeLessThan(DEFAULT_CHAR_BUDGET);
  });

  it('dedupe por chunk.id mantém o maior score e a etiqueta de como o chunk foi encontrado', () => {
    const retriever = diskRetriever();

    // Cada pasta abaixo tem uma nota só, e todos os vizinhos dela estão fora: filtrada assim, a
    // busca não tem de onde expandir, então o que sobra é o score DIRETO puro daquele chunk.
    // Essa é a referência que este teste precisa — um máximo sobre os resultados da nota não
    // serve, porque já vem contaminado pelo score herdado que se quer medir.
    const isolated: Array<{ folder: string; path: string }> = [
      { folder: '02-wiki/patterns', path: CACHE_WRAPPER },
      { folder: '03-projects/potentia', path: POTENTIA },
    ];

    const { results } = retriever.search({ query: 'autenticacao jwt', limit: 20 });
    const ids = results.map((result) => result.chunk.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sourceScore = Math.max(
      ...results.filter((r) => r.chunk.path === AUTH_GUARD && !r.viaGraph).map((r) => r.score),
    );

    for (const { folder, path } of isolated) {
      const alone = retriever.search({ query: 'autenticacao jwt', folder, limit: 20 });
      expect(alone.results).toHaveLength(1);
      const directHit = alone.results[0]!;
      expect(directHit.chunk.path).toBe(path);
      expect(directHit.viaGraph).toBe(false);

      const merged = results.find((result) => result.chunk.id === directHit.chunk.id);
      expect(merged).toBeDefined();
      // Chegou pelas duas vias: fica com o maior dos dois scores, que aqui é o herdado — ele é
      // uma fatia do score NÃO amortecido do vizinho, enquanto o direto já pagou o peso por tipo
      // de nota. Por isso este caso é a regra e não a exceção.
      expect(merged!.score).toBeCloseTo(GRAPH_DAMPING * sourceScore, 12);
      expect(merged!.score).toBeGreaterThan(directHit.score);
      // E continua marcado como DIRETO: casou a query sozinho e estaria aqui com a expansão
      // desligada. Reetiquetá-lo de vizinho mente para quem lê o resultado.
      expect(merged!.viaGraph).toBe(false);
    }
  });

  it('o vizinho herda o MAIOR score entre as origens diretas que o alcançam', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'potentia', limit: 20 });

    // `nestjs-moc.md` não casa `potentia` em termo nenhum — só chega pelo grafo — e chega por
    // duas origens diretas de scores diferentes: `auth-guard.md` e `bullmq-worker.md`, que a
    // linkam. O que ela herda tem de ser fatia da maior das duas.
    const authMax = Math.max(
      ...results.filter((r) => r.chunk.path === AUTH_GUARD && !r.viaGraph).map((r) => r.score),
    );
    const bullmqMax = Math.max(
      ...results.filter((r) => r.chunk.path === BULLMQ && !r.viaGraph).map((r) => r.score),
    );
    // Sem esta diferença as duas origens dariam o mesmo valor e o teste não distinguiria nada.
    expect(authMax).toBeGreaterThan(bullmqMax);

    const inherited = results.filter((result) => result.chunk.path === NESTJS_MOC);
    expect(inherited.length).toBeGreaterThan(0);
    for (const result of inherited) {
      expect(result.viaGraph).toBe(true);
      expect(result.score).toBeCloseTo(GRAPH_DAMPING * authMax, 12);
      expect(result.score).toBeGreaterThan(GRAPH_DAMPING * bullmqMax);
    }
  });
});

describe('Retriever.search — desempate determinístico', () => {
  it('dois índices com ordens de inserção diferentes devolvem exatamente a mesma saída', () => {
    const a = memoryRetriever();
    const b = memoryRetriever();

    // A: ordem do scanner (alfabética). B: mesmo conteúdo, byte por byte, mas cada nota removida
    // e recriada da última para a primeira, o que é o que uma sessão de escrita faz ao vault. O
    // scanner passa a enumerar as notas na ordem inversa, e com elas mudam a ordem de inserção
    // dos chunks no índice e a ordem das arestas no grafo — as duas coisas que decidem quem vem
    // antes num empate de score, que na expansão é o caso comum e não a exceção.
    a.retriever.search({ query: WARMUP });
    b.retriever.search({ query: WARMUP });
    for (const path of b.fs.markdownPaths().reverse()) {
      const text = b.fs.read(path);
      b.fs.remove(path);
      b.retriever.search({ query: WARMUP });
      b.fs.write(path, text);
      b.retriever.search({ query: WARMUP });
    }

    // Sem esta asserção o teste seria vácuo: ela é a prova de que os dois vaults estão mesmo em
    // ordens diferentes, e não de que a montagem acima virou no-op.
    const orderA = a.scanner.allNotes().map((note) => note.path);
    const orderB = b.scanner.allNotes().map((note) => note.path);
    expect(orderB).not.toEqual(orderA);
    expect([...orderB].sort()).toEqual([...orderA].sort());

    const resultA = a.retriever.search({ query: 'jwt', limit: 12 });
    const resultB = b.retriever.search({ query: 'jwt', limit: 12 });

    expect(resultA.results.length).toBeGreaterThan(1);
    expect(resultB).toEqual(resultA);
  });

  it('empate de score sai em ordem crescente de chunk.id', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'jwt', limit: 12 });

    for (let i = 1; i < results.length; i++) {
      const previous = results[i - 1]!;
      const current = results[i]!;
      expect(previous.score).toBeGreaterThanOrEqual(current.score);
      if (previous.score === current.score) {
        expect(previous.chunk.id < current.chunk.id).toBe(true);
      }
    }
    // O desempate só significa algo se houver empates de fato nesta saída.
    const tied = results.filter((r, i) => i > 0 && results[i - 1]!.score === r.score);
    expect(tied.length).toBeGreaterThan(0);
  });
});

describe('Retriever.search — filtros', () => {
  it('`01-raw/` fica fora por padrão e entra com includeRaw', () => {
    const retriever = diskRetriever();

    expect(retriever.search({ query: 'rascunhoexclusivo' }).results).toEqual([]);

    const included = retriever.search({ query: 'rascunhoexclusivo', includeRaw: true });
    expect(paths(included.results)).toContain(RASCUNHO);
  });

  it('a exclusão de `01-raw/` é por segmento de caminho, não por prefixo de texto', () => {
    const { retriever, fs } = memoryRetriever();
    fs.write(
      '01-raw-publico/nota.md',
      ['---', 'tipo: wiki', '---', '', '# Publico', '', 'Termo: rawpublicoexclusivo.', ''].join('\n'),
    );

    // Mesma classe de bug do filtro `folder`: `startsWith('01-raw')` engoliria uma pasta cujo
    // nome apenas começa igual.
    expect(paths(retriever.search({ query: 'rawpublicoexclusivo' }).results)).toContain(
      '01-raw-publico/nota.md',
    );
    // E a pasta de verdade continua de fora.
    expect(retriever.search({ query: 'rascunhoexclusivo' }).results).toEqual([]);
  });

  it('`tipo: projeto` devolve só o README do projeto, inclusive contra a expansão', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'potentia', tipo: 'projeto', limit: 20 });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.chunk.path).toBe(POTENTIA);
    // O README linka as duas: sem refiltrar depois do merge, a expansão as traria de volta.
    expect(paths(results)).not.toContain(AUTH_GUARD);
    expect(paths(results)).not.toContain(CACHE_WRAPPER);

    // Sem o filtro, a mesma query traz sim os vizinhos — senão a asserção acima passaria mesmo
    // com a expansão inteira desligada.
    const unfiltered = retriever.search({ query: 'potentia', limit: 20 });
    expect(paths(unfiltered.results)).toContain(CACHE_WRAPPER);
  });

  it('`folder` restringe o conjunto devolvido, inclusive contra vizinhos de fora', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({
      query: 'multi-stage',
      folder: '02-wiki/docker',
      limit: 20,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.chunk.path.startsWith('02-wiki/docker/')).toBe(true);
    }
    expect(paths(results)).not.toContain(DAILY);

    // Sem o filtro, `04-daily/2026-08-20.md` entra pela expansão (linka `[[multi-stage]]`).
    const unfiltered = retriever.search({ query: 'multi-stage', limit: 20 });
    expect(paths(unfiltered.results)).toContain(DAILY);
  });

  it('`folder` não casa por prefixo de nome de pasta', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'multi-stage', folder: '02-wiki/dock', limit: 20 });
    expect(results).toEqual([]);
  });

  it('`folder` normaliza barra final e trata vazio como ausência de filtro', () => {
    const retriever = diskRetriever();
    const canonical = retriever.search({ query: 'multi-stage', folder: '02-wiki/docker', limit: 20 });
    const unfiltered = retriever.search({ query: 'multi-stage', limit: 20 });

    expect(retriever.search({ query: 'multi-stage', folder: '02-wiki/docker/', limit: 20 })).toEqual(
      canonical,
    );
    expect(retriever.search({ query: 'multi-stage', folder: '', limit: 20 })).toEqual(unfiltered);
    // As duas asserções acima só valem alguma coisa porque filtrar de fato muda o resultado.
    expect(canonical.results.length).toBeGreaterThan(0);
    expect(unfiltered.results.length).toBeGreaterThan(canonical.results.length);
  });

  it('`tipo` não-string no frontmatter não vaza para o chunk', () => {
    const { retriever, fs } = memoryRetriever();
    fs.write(
      '02-wiki/nestjs/tipo-numerico.md',
      ['---', 'tipo: 123', 'tags: [nestjs]', '---', '', '# Tipo numerico', '', 'Termo: tiponumericoexclusivo.', ''].join('\n'),
    );

    const { results } = retriever.search({ query: 'tiponumericoexclusivo', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    // `Chunk.tipo` é declarado `string | undefined`; um número vindo do YAML tem de virar
    // `undefined`, não atravessar o tipo até o filtro e o peso por tipo de nota.
    for (const result of results) expect(result.chunk.tipo).toBeUndefined();
  });

  it('filtro restritivo não é engolido pelo corte em BM25_TOP_K', () => {
    const { retriever, fs } = memoryRetriever();

    // A fixture é pequena demais para que um alvo filtrável caia abaixo do oitavo lugar, então
    // este teste adiciona ruído — só na cópia em memória, nunca na fixture em disco. Cada nota
    // extra é um chunk de wiki denso em `nestjs`, que ranqueia acima do parágrafo do README onde
    // "NestJS" aparece uma vez. Com mais de oito, o README só sobrevive se `keep` rodar ANTES do
    // corte em BM25_TOP_K; aplicado depois, os oito primeiros são todos wiki e a busca por
    // `tipo: 'projeto'` devolve vazio.
    for (let i = 0; i < 12; i++) {
      fs.write(
        `02-wiki/nestjs/ruido-${i}.md`,
        ['---', 'tipo: wiki', 'tags: [nestjs]', '---', '', `# Ruido ${i}`, '', 'nestjs nestjs nestjs.', ''].join('\n'),
      );
    }

    const { results } = retriever.search({ query: 'nestjs', tipo: 'projeto', limit: 20 });
    expect(paths(results)).toContain(POTENTIA);

    // O ruído tem de estar mesmo lotando os oito primeiros, senão o teste não prova nada.
    const unfiltered = retriever.search({ query: 'nestjs', limit: 20 });
    const topDirect = unfiltered.results.filter((result) => !result.viaGraph).slice(0, 8);
    expect(topDirect).toHaveLength(8);
    for (const result of topDirect) {
      expect(result.chunk.path.startsWith('02-wiki/nestjs/ruido-')).toBe(true);
    }
  });

  it('as tags do frontmatter são buscáveis mesmo sem aparecer no corpo', () => {
    const retriever = diskRetriever();
    // `patterns` é tag de `cache-wrapper.md` e não aparece em nenhum corpo do vault (o nome da
    // pasta não é indexado): sem as tags do frontmatter no índice, esta busca não acha nada.
    const { results } = retriever.search({ query: 'patterns', limit: 20 });
    expect(paths(results)).toContain(CACHE_WRAPPER);
  });
});

describe('Retriever.search — sem resultado', () => {
  it('devolve results vazio e sugestões com o termo mais próximo', () => {
    const retriever = diskRetriever();
    const { results, suggestions } = retriever.search({ query: 'bulmq' });

    expect(results).toEqual([]);
    expect(suggestions ?? []).not.toHaveLength(0);
    expect(suggestions).toContain('bullmq');
  });

  it('não sugere correção quando foi o filtro, e não a query, que esvaziou o resultado', () => {
    const retriever = diskRetriever();
    // A query casa de sobra sem filtro: o vazio abaixo é escolha de quem chamou, não erro de
    // digitação. Sugerir `jwt` para quem escreveu `jwt` lê como defeito.
    expect(retriever.search({ query: 'jwt', limit: 20 }).results.length).toBeGreaterThan(0);

    const narrowed: SearchOptions[] = [
      { query: 'jwt', tipo: 'inexistente' },
      { query: 'multi-stage', folder: '02-wiki/dock' },
      { query: 'jwt', limit: 0 },
    ];
    for (const options of narrowed) {
      const result = retriever.search(options);
      expect(result.results).toEqual([]);
      expect(result.suggestions).toBeUndefined();
    }
  });

  it('omite a chave `suggestions` quando não há o que sugerir', () => {
    const retriever = diskRetriever();
    // `SearchResult.suggestions` é documentado como "populated only when results is empty", o
    // que se lê como `if (result.suggestions)`. Um array vazio é truthy e mandaria o consumidor
    // para o ramo de "você quis dizer" sem nada para mostrar.
    for (const query of ['', '   ', 'de a o para', 'proc']) {
      const result = retriever.search({ query });
      expect(result.results).toEqual([]);
      expect(result.suggestions).toBeUndefined();
      expect('suggestions' in result).toBe(false);
    }
  });

  it('devolve no máximo cinco sugestões, por distância e depois alfabeticamente', () => {
    const retriever = diskRetriever();
    expect(retriever.search({ query: 'cach' }).suggestions).toEqual(['cache', 'cada']);
    // Esta query tem mais candidatos do que cabe: prende o teto em cinco pelos dois lados.
    expect(retriever.search({ query: 'corea' }).suggestions).toEqual([
      'carga',
      'cerca',
      'certa',
      'copia',
      'corpo',
    ]);
  });

  it('não devolve sugestões quando há resultado', () => {
    const retriever = diskRetriever();
    const found = retriever.search({ query: 'bullmq' });
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.suggestions ?? []).toHaveLength(0);
  });
});

describe('Retriever.search — orçamento', () => {
  it('respeita o limite de chunks pedido', () => {
    const retriever = diskRetriever();
    expect(retriever.search({ query: 'jwt', limit: 3 }).results).toHaveLength(3);
  });

  it('as constantes do orçamento são as do spec', () => {
    // Escritas como literais de propósito: uma asserção em termos da própria constante anda
    // junto com ela e não prende valor nenhum.
    expect(BM25_TOP_K).toBe(8);
    expect(GRAPH_DAMPING).toBe(0.4);
    expect(DEFAULT_LIMIT).toBe(6);
    expect(DEFAULT_CHAR_BUDGET).toBe(8000);
  });

  it('usa DEFAULT_LIMIT quando `limit` não é passado', () => {
    const retriever = diskRetriever();
    // `jwt` tem mais de seis candidatos e todos cabem no orçamento de caracteres, então o corte
    // aqui é o do número de chunks e mais nada.
    expect(retriever.search({ query: 'jwt' }).results).toHaveLength(6);
    expect(retriever.search({ query: 'jwt', limit: 20 }).results.length).toBeGreaterThan(6);
  });

  it('`limit: 0` devolve vazio em vez de cair no padrão', () => {
    const retriever = diskRetriever();
    expect(retriever.search({ query: 'jwt', limit: 0 }).results).toEqual([]);
  });

  it('o orçamento de caracteres corta antes do limite de chunks', () => {
    const { retriever, fs } = memoryRetriever();
    // A fixture inteira cabe folgada em 8.000 caracteres, então o orçamento só se manifesta com
    // notas grandes — escritas aqui na cópia em memória. Cada uma vira um chunk de ~2.870
    // caracteres: dois cabem, o terceiro estoura.
    const filler = 'orcamentoexclusivo '.repeat(150).trim();
    for (let i = 0; i < 5; i++) {
      fs.write(
        `02-wiki/patterns/grande-${i}.md`,
        ['---', 'tipo: wiki', '---', '', `# Grande ${i}`, '', filler, ''].join('\n'),
      );
    }

    const { results } = retriever.search({ query: 'orcamentoexclusivo', limit: 50 });

    expect(paths(results)).toEqual([
      '02-wiki/patterns/grande-0.md',
      '02-wiki/patterns/grande-1.md',
    ]);
    expect(totalChars(results)).toBeLessThanOrEqual(8000);
    // O terceiro candidato existe e ficou de fora só por não caber.
    expect(totalChars(results) + results[0]!.chunk.text.length).toBeGreaterThan(8000);
  });
});

describe('Retriever.sync — reindexação incremental', () => {
  it('reflete o novo conteúdo de uma nota alterada e esquece o antigo', () => {
    const { retriever, fs } = memoryRetriever();
    expect(paths(retriever.search({ query: 'bullmq' }).results)).toContain(BULLMQ);

    fs.write(
      BULLMQ,
      ['---', 'tipo: wiki', 'tags: [nestjs]', '---', '', '# Worker', '', 'termodepoisdaedicao.', ''].join(
        '\n',
      ),
    );

    const after = retriever.search({ query: 'termodepoisdaedicao' });
    expect(paths(after.results)).toContain(BULLMQ);
    expect(retriever.search({ query: 'backoff' }).results).toEqual([]);
  });

  it('a expansão pelo grafo enxerga o conteúdo novo de uma nota alterada', () => {
    const { retriever, fs } = memoryRetriever();
    const before = retriever
      .search({ query: 'jwt', limit: 12 })
      .results.filter((result) => result.chunk.path === CACHE_WRAPPER);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((result) => result.chunk.text.includes('Redis'))).toBe(true);

    fs.write(
      CACHE_WRAPPER,
      [
        '---',
        'tipo: wiki',
        'tags: [patterns]',
        '---',
        '',
        '# Cache Wrapper',
        '',
        'Conteudo novo, que ainda cita [[auth-guard]] e mais nada.',
        '',
      ].join('\n'),
    );

    // Os chunks que a expansão devolve vêm da mesma reindexação que a busca direta, e não de uma
    // cópia por nota que só o caminho direto mantém em dia.
    const after = retriever
      .search({ query: 'jwt', limit: 12 })
      .results.filter((result) => result.chunk.path === CACHE_WRAPPER);
    expect(after.length).toBeGreaterThan(0);
    for (const result of after) {
      expect(result.chunk.text).toContain('Conteudo novo');
      expect(result.chunk.text).not.toContain('Redis');
    }
  });

  it('uma nota esvaziada deixa de aparecer, inclusive pela expansão', () => {
    const { retriever, fs } = memoryRetriever();
    // `03-projects/potentia/README.md` linka `cache-wrapper.md`, então a expansão alcança a nota
    // mesmo depois de ela ficar sem nenhum texto indexável — se a reindexação não esquecer os
    // chunks antigos, a busca devolve conteúdo que não existe mais em disco.
    expect(paths(retriever.search({ query: 'potentia', limit: 20 }).results)).toContain(
      CACHE_WRAPPER,
    );

    fs.write(CACHE_WRAPPER, ['---', 'tipo: wiki', 'tags: [patterns]', '---', ''].join('\n'));

    const after = retriever.search({ query: 'potentia', limit: 20 });
    expect(paths(after.results)).toContain(POTENTIA);
    expect(paths(after.results)).not.toContain(CACHE_WRAPPER);
  });

  it('reconstrói o grafo quando uma nota muda: a expansão enxerga o link novo', () => {
    const { retriever, fs } = memoryRetriever();
    const before = retriever.search({ query: 'jwt', limit: 20 });
    expect(paths(before.results)).toContain(AUTH_GUARD);
    expect(paths(before.results)).not.toContain(MULTI_STAGE);

    fs.write(AUTH_GUARD, `${fs.read(AUTH_GUARD)}\nVer tambem [[multi-stage]].\n`);

    // `multi-stage.md` não casa `jwt` em termo nenhum: só pode aparecer se a aresta nova entrou
    // no grafo. Congelar o grafo depois da primeira montagem passa despercebido em qualquer
    // teste que só remova notas, porque a nota removida some do índice de qualquer jeito.
    const after = retriever.search({ query: 'jwt', limit: 20 });
    expect(paths(after.results)).toContain(MULTI_STAGE);
  });

  it('reconstrói o grafo quando uma nota some, mesmo sem nenhuma nota alterada', () => {
    const { retriever, fs } = memoryRetriever();
    // Nenhuma das duas na pasta de `auth-guard.md`: um alvo ao lado do arquivo que linka resolve
    // pelo caminho relativo antes de chegar na busca por basename, e não seria ambíguo.
    const AMBIGUA_DOCKER = '02-wiki/docker/ambigua.md';
    const AMBIGUA_PATTERNS = '02-wiki/patterns/ambigua.md';
    const body = (marker: string): string =>
      ['---', 'tipo: wiki', '---', '', '# Ambigua', '', `Nota de destino ${marker}.`, ''].join('\n');

    fs.write(AMBIGUA_DOCKER, body('docker'));
    fs.write(AMBIGUA_PATTERNS, body('patterns'));
    fs.write(AUTH_GUARD, `${fs.read(AUTH_GUARD)}\nVer tambem [[ambigua]].\n`);

    // Dois basenames iguais na mesma profundidade: `[[ambigua]]` fica ambíguo e não vira aresta.
    const before = retriever.search({ query: 'jwt', limit: 20 });
    expect(paths(before.results)).not.toContain(AMBIGUA_DOCKER);
    expect(paths(before.results)).not.toContain(AMBIGUA_PATTERNS);

    fs.remove(AMBIGUA_PATTERNS);

    // Nenhuma nota foi reescrita neste passo — só uma sumiu —, e mesmo assim o link de OUTRA
    // nota passou a resolver. Reconstruir o grafo só quando `changed` não está vazio deixa a
    // aresta nova de fora.
    const after = retriever.search({ query: 'jwt', limit: 20 });
    expect(paths(after.results)).toContain(AMBIGUA_DOCKER);
  });

  it('esquece uma nota removida e reconstrói o grafo sem as arestas dela', () => {
    const { retriever, fs } = memoryRetriever();
    expect(paths(retriever.search({ query: 'multi-stage', limit: 20 }).results)).toContain(DAILY);

    fs.remove(DAILY);

    const after = retriever.search({ query: 'multi-stage', limit: 20 });
    expect(paths(after.results)).not.toContain(DAILY);
    expect(paths(after.results)).toContain(MULTI_STAGE);
    // O MOC do docker continua chegando pelo grafo: só a aresta da nota removida sumiu.
    expect(paths(after.results)).toContain(DOCKER_MOC);
  });
});

function stubChunk(id: string, length: number, overrides: Partial<Chunk> = {}): ScoredChunk {
  const chunk: Chunk = {
    id,
    path: `${id}.md`,
    headingPath: [],
    lineStart: 1,
    lineEnd: 1,
    text: 'x'.repeat(length),
    tags: [],
    ...overrides,
  };
  return { chunk, score: 1, viaGraph: false };
}

/** True when every surrogate in `text` is half of a complete pair. */
function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

describe('Retriever.search — teto de termos da query', () => {
  const repeated = (times: number): string => new Array(times).fill('jwt').join(' ');

  it('ignora os termos além do 64º, e o 64º ainda conta', () => {
    const retriever = diskRetriever();
    const atCap = retriever.search({ query: repeated(64), limit: 12 });

    // `autenticacao` na posição 65 é descartado: a saída é idêntica à da query sem ele. O termo
    // é escolhido por casar chunks que ESTÃO no resultado (auth-guard, cache-wrapper, README),
    // senão contá-lo ou não daria na mesma e o teste não distinguiria teto nenhum.
    expect(retriever.search({ query: `${repeated(64)} autenticacao`, limit: 12 })).toEqual(atCap);
    // E é descartado por ser o 65º, não por ser irrelevante: dentro do teto ele muda o score.
    expect(retriever.search({ query: `${repeated(63)} autenticacao`, limit: 12 })).not.toEqual(atCap);
  });

  it('uma query enorme é cortada no teto, e não repassada inteira ao índice', () => {
    const retriever = diskRetriever();

    // O `search` de `src/index/bm25.ts` percorre a LISTA de tokens, não o conjunto, e varre a
    // posting list inteira por ocorrência; a query é argumento de tool call num processo de
    // event loop único, então o custo é atacável de fora (medido no vault real: 11,9s para uma
    // palavra repetida 80.000 vezes, síncrono, travando toda outra chamada).
    //
    // A prova aqui é determinística, não cronometrada: 200.000 termos devolvem exatamente o que
    // devolvem os 64 primeiros — mesmos chunks, mesmos scores —, o que só acontece se o índice
    // tiver visto 64 termos. Um relógio não serviria: a fixture é pequena demais para que a
    // diferença de trabalho apareça em milissegundos, e o teste passaria sem o teto.
    expect(retriever.search({ query: repeated(200_000), limit: 12 })).toEqual(
      retriever.search({ query: repeated(64), limit: 12 }),
    );
  });

  it('corta a query bruta em 1024 caracteres, antes de qualquer tokenização', () => {
    const retriever = diskRetriever();

    // Um teto por CONTAGEM de termos não fecha isto: `a` seguido de milhares de hifens e `b` é
    // um termo só, e é o comprimento do termo que faz o trim de hifens do tokenizador
    // backtrackear quadraticamente. O que precisa ser cortado é a string crua.
    const atClamp = `jwt ${'a'.repeat(1020)}`;
    expect(atClamp).toHaveLength(1024);

    // `autenticacao` começa exatamente no caractere 1025 e casa chunks de verdade: se
    // sobreviver ao corte, muda o resultado.
    const beyond = `${atClamp} autenticacao ${'b'.repeat(50_000)}`;
    expect(retriever.search({ query: beyond, limit: 12 })).toEqual(
      retriever.search({ query: atClamp, limit: 12 }),
    );

    // E o corte é em 1024, não num número qualquer maior: o mesmo termo, movido para dentro do
    // limite, muda o resultado.
    const within = `jwt ${'a'.repeat(1020 - ' autenticacao'.length)} autenticacao`;
    expect(within).toHaveLength(1024);
    expect(retriever.search({ query: within, limit: 12 })).not.toEqual(
      retriever.search({ query: atClamp, limit: 12 }),
    );
  });

  it('o teto não muda o ranking de uma query normal', () => {
    const retriever = diskRetriever();
    const natural = 'guard de autenticação jwt no nestjs';
    expect(retriever.search({ query: natural, limit: 12 }).results[0]!.chunk.path).toBe(AUTH_GUARD);
  });
});

describe('applyBudget', () => {
  it('corta na contagem de chunks quando ela vem primeiro', () => {
    const scored = [stubChunk('a', 10), stubChunk('b', 10), stubChunk('c', 10)];
    expect(applyBudget(scored, 2, 1000).map((item) => item.chunk.id)).toEqual(['a', 'b']);
  });

  it('corta no orçamento de caracteres quando ele vem primeiro', () => {
    const scored = [stubChunk('a', 60), stubChunk('b', 60), stubChunk('c', 10)];
    // O terceiro caberia sozinho, mas o corte é no primeiro que estoura: o resultado tem de ser
    // um prefixo do ranking, não uma seleção que pula chunk melhor colocado para caber outro.
    expect(applyBudget(scored, 10, 100).map((item) => item.chunk.id)).toEqual(['a']);
  });

  it('não corta quando a soma bate exatamente no orçamento', () => {
    const scored = [stubChunk('a', 60), stubChunk('b', 40)];
    expect(applyBudget(scored, 10, 100).map((item) => item.chunk.id)).toEqual(['a', 'b']);
  });

  it('devolve um único chunk maior que o orçamento inteiro em vez de devolver vazio', () => {
    const scored = [stubChunk('gigante', 500)];
    expect(applyBudget(scored, 10, 100)).toHaveLength(1);
  });

  it('trunca esse chunk único, com marcador, e não mexe no chunk indexado', () => {
    const scored = [stubChunk('gigante', 500), stubChunk('depois', 10)];
    const out = applyBudget(scored, 10, 100);

    expect(out).toHaveLength(1);
    expect(out[0]!.chunk.text.length).toBeLessThanOrEqual(100);
    expect(out[0]!.chunk.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out[0]!.chunk.text.startsWith('xxx')).toBe(true);
    // O chunk original é o que o índice guarda: alterá-lo corromperia toda busca posterior.
    expect(scored[0]!.chunk.text).toHaveLength(500);
    expect(scored[0]!.chunk.text).not.toContain(TRUNCATION_MARKER);
  });

  it('nunca corta no meio de um par surrogate', () => {
    // Uma das duas paridades cai obrigatoriamente no meio do par, seja qual for o tamanho do
    // marcador, então o teste não depende de contar caracteres do marcador.
    for (const charBudget of [100, 101]) {
      const out = applyBudget([stubChunk('emoji', 0, { text: '😀'.repeat(200) })], 10, charBudget);
      const text = out[0]!.chunk.text;
      expect(isWellFormed(text)).toBe(true);
      expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(charBudget);
    }
  });

  it('orçamento menor que o próprio marcador devolve só o marcador, não a nota quase inteira', () => {
    const out = applyBudget([stubChunk('gigante', 500)], 10, 10);
    // Sem a trava em zero o corte vira negativo, que em `slice` conta do FIM da string.
    expect(out[0]!.chunk.text).toBe(TRUNCATION_MARKER);
  });

  it('o intervalo de linhas anunciado encolhe junto com o texto truncado', () => {
    const original = stubChunk('longo', 0, {
      text: 'linha de dez\n'.repeat(100),
      lineStart: 10,
      lineEnd: 109,
    });
    const chunk = applyBudget([original], 10, 100)[0]!.chunk;
    const carried = chunk.text.slice(0, chunk.text.length - TRUNCATION_MARKER.length);

    expect(chunk.lineStart).toBe(10);
    // O intervalo anunciado tem de descrever o texto que veio junto: quem reler
    // `path:lineStart-lineEnd` no disco não pode receber de volta o chunk inteiro.
    expect(chunk.lineEnd).toBe(10 + (carried.match(/\n/g) ?? []).length);
    expect(chunk.lineEnd).toBeLessThan(109);
    expect(original.chunk.lineEnd).toBe(109);
  });

  it('devolve vazio para entrada vazia', () => {
    expect(applyBudget([], 10, 100)).toEqual([]);
  });
});

/** O arquivo bruto da fixture, dividido em linhas 1-based por índice `linha - 1`. */
function rawLines(relative: string): string[] {
  return readFileSync(join(FIXTURE, relative), 'utf8').split('\n');
}

describe('Retriever.search — citação de linha real', () => {
  /**
   * A prova do contrato, na mesma forma que `test/chunker.test.ts` usa: fatiar o ARQUIVO BRUTO
   * pelo intervalo que o resultado anuncia e exigir o texto do chunk de volta. Comparar ids entre
   * si não serviria — eles deslocam todos juntos quando o offset está errado, então um vault
   * inteiro citado 5 linhas adiantado passaria intacto.
   */
  it('o intervalo anunciado reslicia exatamente o arquivo bruto da fixture', () => {
    const retriever = diskRetriever();
    const queries = ['jwt', 'docker camadas', 'cache', 'potentia', 'bullmq filas'];

    let comFrontmatter = 0;
    let total = 0;
    for (const query of queries) {
      for (const { chunk } of retriever.search({ query, limit: 20 }).results) {
        const lines = rawLines(chunk.path);
        expect(lines.slice(chunk.lineStart - 1, chunk.lineEnd).join('\n')).toBe(chunk.text);
        // A linha citada — a que a ferramenta de busca imprime como `caminho:lineStart` — tem de
        // conter de fato a abertura do texto do chunk.
        expect(lines[chunk.lineStart - 1]).toBe(chunk.text.split('\n')[0]);
        expect(chunk.id).toBe(`${chunk.path}#${chunk.lineStart}`);
        total++;
        if (lines[0] === '---') comFrontmatter++;
      }
    }

    // Sem notas com frontmatter entre os resultados a asserção acima é vácua: o offset só existe
    // por causa do bloco, e as duas notas da fixture sem ele acertam com qualquer constante.
    expect(total).toBeGreaterThan(20);
    expect(comFrontmatter).toBeGreaterThan(10);
  });

  it('o primeiro chunk de uma nota com frontmatter cita a linha do arquivo, não a do corpo', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'jwt', limit: 20 });

    const lines = rawLines(AUTH_GUARD);
    // `## Contexto` existe uma vez só em `auth-guard.md`; a linha dele no arquivo é o número que
    // o chunk correspondente tem de anunciar.
    const contexto = lines.indexOf('## Contexto') + 1;
    expect(contexto).toBeGreaterThan(1);

    const chunk = results
      .map((result) => result.chunk)
      .find((c) => c.path === AUTH_GUARD && c.headingPath[0] === 'Contexto');
    expect(chunk).toBeDefined();
    expect(chunk!.lineStart).toBe(contexto);
    expect(chunk!.id).toBe(`${AUTH_GUARD}#${contexto}`);
    // O bloco de frontmatter tem cinco linhas: numerar a partir do corpo daria 5 linhas a menos.
    expect(chunk!.lineStart).toBeGreaterThan(5);
  });
});

describe('Retriever.search — sinal estruturado de truncamento', () => {
  const HUGE = '02-wiki/gigante.md';
  const TERM = 'termograndalhao';

  function withHugeNote(): ReturnType<typeof memoryRetriever> {
    const made = memoryRetriever();
    // Uma nota sem `##` é um chunk só, e este passa do orçamento inteiro sozinho.
    made.fs.write(
      HUGE,
      ['---', 'tipo: wiki', '---', '', `# Grandalhao`, '', `${TERM} `.repeat(1200), ''].join('\n'),
    );
    return made;
  }

  it('marca `truncated` no chunk que o orçamento cortou', () => {
    const { retriever } = withHugeNote();
    const { results } = retriever.search({ query: TERM, limit: 6 });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.chunk.path).toBe(HUGE);
    expect(result.truncated).toBe(true);
    // O corte é real, não apenas anunciado.
    expect(result.chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHAR_BUDGET);
    expect(result.chunk.text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('resultado inteiro não vem marcado', () => {
    const { retriever } = withHugeNote();
    const { results } = retriever.search({ query: 'jwt', limit: 12 });

    expect(results.length).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.truncated).toBeUndefined();
      expect(result.chunk.text).not.toContain(TRUNCATION_MARKER);
    }
  });

  /**
   * O ponto do campo. `TRUNCATION_MARKER` é prosa comum e uma nota pode contê-lo literalmente —
   * uma nota SOBRE este servidor, por exemplo. Um consumidor que decida "isto foi cortado" pelo
   * texto erra nas duas direções; o campo tem de sair do lado estrutural.
   */
  it('nota que contém o marcador literalmente não é confundida com um corte', () => {
    const { retriever, fs } = memoryRetriever();
    const relative = '02-wiki/sobre-marcador.md';
    fs.write(
      relative,
      [
        '---',
        'tipo: wiki',
        '---',
        '',
        '# Marcador',
        '',
        `O servidor anexa o texto abaixo quando corta um trecho: ${TRUNCATION_MARKER.trim()}`,
        '',
        'Termo de controle: marcadorliteral.',
        '',
      ].join('\n'),
    );

    const { results } = retriever.search({ query: 'marcadorliteral', limit: 6 });
    const found = results.find((result) => result.chunk.path === relative);
    expect(found).toBeDefined();
    // O texto casa o que um detector textual procuraria...
    expect(found!.chunk.text).toContain(TRUNCATION_MARKER.trim());
    // ...e mesmo assim o chunk está inteiro, então nada foi cortado.
    expect(found!.truncated).toBeUndefined();
    expect(found!.chunk.text).toContain('Termo de controle');
  });
});
