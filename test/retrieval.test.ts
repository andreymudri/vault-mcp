import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { applyBudget, DEFAULT_CHAR_BUDGET, GRAPH_DAMPING } from '../src/retrieval/budget.js';
import { Retriever } from '../src/retrieval/retrieval.js';
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

  stat(path: string): { mtimeMs: number } {
    return { mtimeMs: this.file(path).mtimeMs };
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

  it('dedupe por chunk.id mantém o maior score quando o chunk chega pelas duas vias', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'jwt', limit: 12 });

    const ids = results.map((result) => result.chunk.id);
    expect(new Set(ids).size).toBe(ids.length);

    // `nestjs-moc.md` é acerto direto de `jwt` e linka `auth-guard.md`, então todo chunk de
    // `auth-guard.md` também chega pela expansão com `0.4 ×` o score do MOC. O chunk de topo de
    // `auth-guard.md` tem de manter o score direto, maior, e continuar marcado como direto.
    const mocScore = Math.max(
      ...results.filter((r) => r.chunk.path === NESTJS_MOC).map((r) => r.score),
    );
    expect(Number.isFinite(mocScore)).toBe(true);
    const top = results.find((result) => result.chunk.path === AUTH_GUARD);
    expect(top).toBeDefined();
    expect(top!.viaGraph).toBe(false);
    expect(top!.score).toBeGreaterThan(GRAPH_DAMPING * mocScore);
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

  it('usa DEFAULT_LIMIT quando `limit` não é passado', () => {
    const retriever = diskRetriever();
    const { results } = retriever.search({ query: 'jwt' });
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThan(0);
    expect(totalChars(results)).toBeLessThanOrEqual(
      DEFAULT_CHAR_BUDGET + results[results.length - 1]!.chunk.text.length,
    );
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

function stubChunk(id: string, length: number): ScoredChunk {
  const chunk: Chunk = {
    id,
    path: `${id}.md`,
    headingPath: [],
    lineStart: 1,
    lineEnd: 1,
    text: 'x'.repeat(length),
    tags: [],
  };
  return { chunk, score: 1, viaGraph: false };
}

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

  it('devolve um único chunk maior que o orçamento inteiro em vez de devolver vazio', () => {
    const scored = [stubChunk('gigante', 500)];
    expect(applyBudget(scored, 10, 100)).toHaveLength(1);
  });

  it('devolve vazio para entrada vazia', () => {
    expect(applyBudget([], 10, 100)).toEqual([]);
  });
});
