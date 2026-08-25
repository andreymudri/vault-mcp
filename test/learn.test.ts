import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { tokenize } from '../src/index/tokenizer.js';
import { extractLinkTargets } from '../src/vault/links.js';
import { Retriever } from '../src/retrieval/retrieval.js';
import { VaultScanner } from '../src/vault/scanner.js';
import type { Chunk, ScoredChunk } from '../src/types.js';
import {
  DUPLICATE_SCORE_RATIO,
  LearnError,
  MAX_QUERY_CHARS,
  MAX_QUERY_SOURCE_CHARS,
  MAX_QUERY_TERMS,
  decideDuplicate,
  duplicateQuery,
  learn,
  slug,
} from '../src/write/learn.js';

const execFileAsync = promisify(execFile);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

/** The wall-clock instant every I/O test learns at: the day of the fixture's daily note. */
const NOW = new Date(2026, 7, 20, 14, 5, 0);
const TODAY = '2026-08-20';
const DAILY_REL = `04-daily/${TODAY}.md`;
const MOC_NESTJS = '02-wiki/nestjs/nestjs-moc.md';
const BULLMQ = '02-wiki/nestjs/bullmq-worker.md';
const CACHE_WRAPPER = '02-wiki/patterns/cache-wrapper.md';
const INDEX_REL = '00-index/index-knowledge.md';
const MOC_DOCKER = '02-wiki/docker/docker-moc.md';

/**
 * A base64-ish blob pasted into an insight — a JWT, a log line, a clipped payload. It is ONE
 * token of 1136 characters, which is what makes it interesting: it alone pushes the raw
 * `${titulo} ${insight}` concatenation past retrieval's silent 1024-character clamp.
 */
const BLOB = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + 'Qk1RVEVTVEVEQVRBQkxPQg'.repeat(50);

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

/**
 * A throwaway copy of `test/fixtures/vault` under `os.tmpdir()`, optionally a git repository
 * with one commit of the whole fixture.
 *
 * The fixture is read-only shared state across test files that vitest runs in PARALLEL, so
 * every test that writes works on its own copy. Mutating it in place makes one file corrupt
 * another file's reads intermittently and unreproducibly.
 */
async function makeVault(withGit = true): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-learn-test-'));
  const vaultRoot = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultRoot, { recursive: true });
  if (withGit) {
    await git(vaultRoot, ['init']);
    await git(vaultRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(vaultRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
    await git(vaultRoot, ['config', 'commit.gpgsign', 'false']);
    // `git gc --auto` runs in the BACKGROUND after a commit and keeps writing into `.git`
    // after this process has moved on, which races the teardown below.
    await git(vaultRoot, ['config', 'gc.auto', '0']);
    await git(vaultRoot, ['add', '-A']);
    await git(vaultRoot, ['commit', '-m', 'chore: vault inicial']);
  }
  return vaultRoot;
}

function makeRetriever(vaultRoot: string): Retriever {
  return new Retriever({ scanner: new VaultScanner({ vaultRoot }) });
}

/**
 * Teardown that tolerates a transient writer inside the throwaway repo.
 *
 * A plain `fs.rm` raced git and failed with ENOTEMPTY on `.git/` under a loaded machine. The
 * retries are `fs.rm`'s own answer to exactly that, and `gc.auto 0` above removes the writer.
 */
async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function read(vaultRoot: string, rel: string): Promise<string> {
  return fs.readFile(path.join(vaultRoot, rel), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Files touched by HEAD, sorted. */
async function commitFilesOf(vaultRoot: string, rev = 'HEAD'): Promise<string[]> {
  const out = await git(vaultRoot, ['show', '--name-only', '--pretty=format:', rev]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

async function logLines(vaultRoot: string): Promise<number> {
  const out = await git(vaultRoot, ['log', '--oneline']);
  return out === '' ? 0 : out.split('\n').length;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

const CONTEUDO_FORA = 'conteudo real, fora do vault\n';

/**
 * A note that EXISTS and holds content, and that the write guard will not write to: a symlink
 * pointing out of the vault, which `assertNoSymlinkEscape` refuses.
 *
 * It is the deterministic way to reach the "occupied and unappendable" branch. A blank stub no
 * longer reaches it (blank is not occupied), and the other routes - a file vanishing, an edit
 * losing its anchor - are races.
 */
async function notaBlindada(vaultRoot: string, rel: string): Promise<string> {
  const fora = path.join(path.dirname(vaultRoot), `fora-${path.basename(rel)}`);
  await fs.writeFile(fora, CONTEUDO_FORA, 'utf8');
  await fs.symlink(fora, path.join(vaultRoot, rel));
  return fora;
}

/**
 * Runs `work` while WATCHING `fifo` for a reader, and unblocks any reader that appears.
 *
 * A read of a FIFO nobody writes to never returns, and a test that hits one does not fail —
 * it HANGS: vitest prints the failure and then never exits ("close timed out", "Failed to
 * terminate worker"), which costs a whole run and reports nothing. So the write end is opened
 * NON-BLOCKING, which answers ENXIO while nobody is reading and succeeds the instant somebody
 * is; closing it immediately hands the reader EOF. The call under test therefore always
 * finishes, and `opened` says whether it opened the FIFO at all — which is what gets asserted,
 * instead of leaving the answer to a timeout.
 */
async function withFifoWatch<T>(
  fifo: string,
  work: () => Promise<T>,
): Promise<{ result: T; opened: boolean }> {
  let finished = false;
  let opened = false;
  const watch = (async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!finished && Date.now() < deadline) {
      try {
        const handle = await fs.open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        await handle.close();
        opened = true;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  })();

  try {
    const result = await work();
    return { result, opened };
  } finally {
    finished = true;
    await watch;
  }
}

/** A retriever that finds nothing, so the route under test is the only thing deciding. */
function semResultados(): Retriever {
  return { search: () => ({ results: [] }) } as unknown as Retriever;
}

/** The local calendar day of `at`, in the vault's `YYYY-MM-DD` convention. */
function dataLocal(at: Date): string {
  const mes = String(at.getMonth() + 1).padStart(2, '0');
  const dia = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${mes}-${dia}`;
}

/** A synthetic scored chunk, for the pure duplicate rule. */
function scored(
  notePath: string,
  score: number,
  tags: string[] = [],
  viaGraph = false,
): ScoredChunk {
  const chunk: Chunk = {
    id: `${notePath}#1`,
    path: notePath,
    headingPath: [],
    lineStart: 1,
    lineEnd: 2,
    text: 'texto',
    tags,
  };
  return { chunk, score, viaGraph };
}

/** `noteTags` lookup built from a plain table, as `learn` builds one from the result set. */
function tagsFrom(table: Record<string, string[]>): (p: string) => string[] {
  return (p) => table[p] ?? [];
}

describe('slug', () => {
  it('matches the vault filename convention', () => {
    expect(slug('Auth Service Singleton')).toBe('auth-service-singleton');
    expect(slug('BullMQ Worker')).toBe('bullmq-worker');
  });

  it('folds accents and lowercases', () => {
    expect(slug('Configuração de Índice')).toBe('configuracao-de-indice');
    expect(slug('Ação Rápida')).toBe('acao-rapida');
  });

  it('collapses runs of non-alphanumerics into one hyphen and trims the edges', () => {
    expect(slug('  --Cache / Wrapper (TTL)!!  ')).toBe('cache-wrapper-ttl');
    expect(slug('a  ---  b')).toBe('a-b');
  });

  it('keeps digits', () => {
    expect(slug('HTTP 429 e backoff')).toBe('http-429-e-backoff');
  });

  it('bounds the filename and never ends in a hyphen', () => {
    const long = slug(`${'palavra '.repeat(60)}fim`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
    expect(long.startsWith('palavra-palavra')).toBe(true);
  });

  it('is empty for a title with nothing sluggable in it', () => {
    expect(slug('  ///  ')).toBe('');
  });
});

describe('duplicateQuery', () => {
  it('is the folded term list of title and insight, which the index reads identically', () => {
    const titulo = 'Retry de worker BullMQ';
    const insight = 'O worker BullMQ aplica retry com backoff exponencial na fila';
    expect(duplicateQuery(titulo, insight).query).toBe(tokenize(`${titulo} ${insight}`).join(' '));
    expect(duplicateQuery(titulo, insight).truncated).toBe(false);
  });

  it('never hands retrieval a query long enough for its silent clamp to bite', () => {
    const insight = `${'wrapper de cache redis com ttl configuravel '.repeat(200)}`;
    const { query } = duplicateQuery('Cache', insight);
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(tokenize(query).length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
  });

  it('drops an oversized token instead of letting it swallow the whole budget', () => {
    // The blob alone is longer than the clamp, so a raw concatenation would be cut INSIDE it and
    // every discriminating term after it would be lost. Skipping it keeps the prose.
    const { query } = duplicateQuery('Anotacao rapida da sessao', `${BLOB} worker bullmq da fila`);
    expect(query).not.toContain(BLOB.toLowerCase());
    expect(query.split(' ')).toContain('bullmq');
    expect(query.split(' ')).toContain('worker');
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it('pula um termo longo que não cabe e mantém os termos curtos depois dele', () => {
    // This is the LIVE case for skipping instead of stopping. A multi-kilobyte blob is discarded
    // by the tokenizer's own term-length cap before it ever reaches the budget loop; what does
    // reach it is an ordinary 60-character identifier arriving with less budget left than it
    // needs. Ending the scan there would throw away every plain word behind it — measured here:
    // 16 fillers fit, the 17th does not, and `bullmq`/`worker` still do.
    const gordo = 'g'.repeat(60);
    const { query } = duplicateQuery('Assunto', `${`${gordo} `.repeat(20)} bullmq worker`);
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(query.split(' ')).toContain('bullmq');
    expect(query.split(' ')).toContain('worker');
  });

  it('reports truncation instead of silently dropping the tail of a huge insight', () => {
    expect(duplicateQuery('Titulo', 'a'.repeat(MAX_QUERY_SOURCE_CHARS + 1)).truncated).toBe(true);
    expect(duplicateQuery('Titulo', 'palavra '.repeat(20)).truncated).toBe(false);
  });
});

describe('decideDuplicate', () => {
  const TAGS = { [BULLMQ]: ['nestjs', 'bullmq', 'filas'] };

  it('is not a duplicate when nothing matched', () => {
    const decision = decideDuplicate([], ['bullmq'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(false);
    expect(decision.reason).toContain('nenhum match');
    expect(decision.targetPath).toBeUndefined();
  });

  it('takes the runner-up from ANOTHER note, never the next chunk of the same note', () => {
    // Same-note chunks are the common case: a strong hit fills the window. Reading `results[1]`
    // would compare a note against itself and refuse every real duplicate.
    const results = [
      scored(BULLMQ, 10, TAGS[BULLMQ]),
      scored(BULLMQ, 9.5, TAGS[BULLMQ]),
      scored(CACHE_WRAPPER, 1),
    ];
    const decision = decideDuplicate(results, ['bullmq'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(true);
    expect(decision.targetPath).toBe(BULLMQ);
  });

  it('treats a top hit with no runner-up at all as standing out', () => {
    const decision = decideDuplicate([scored(BULLMQ, 3)], ['bullmq'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(true);
  });

  it('pins the ratio threshold from below: exactly 1.8x is enough', () => {
    expect(DUPLICATE_SCORE_RATIO).toBe(1.8);
    const results = [scored(BULLMQ, DUPLICATE_SCORE_RATIO), scored(CACHE_WRAPPER, 1)];
    expect(decideDuplicate(results, ['bullmq'], 'nestjs', tagsFrom(TAGS)).isDuplicate).toBe(true);
  });

  it('pins the ratio threshold from above: the double just below 1.8 is not', () => {
    const justBelow = 1.7999999999999998;
    expect(justBelow).toBeLessThan(DUPLICATE_SCORE_RATIO);
    const results = [scored(BULLMQ, justBelow), scored(CACHE_WRAPPER, 1)];
    const decision = decideDuplicate(results, ['bullmq'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(false);
    expect(decision.reason).toContain('razão');
  });

  it('needs the overlap too: a dominant hit with neither tag nor domain in common is new', () => {
    const decision = decideDuplicate([scored(BULLMQ, 10), scored(CACHE_WRAPPER, 1)], ['docker'], 'docker', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(false);
    expect(decision.reason).toContain('overlap');
  });

  it('accepts a shared tag alone', () => {
    const decision = decideDuplicate([scored(BULLMQ, 10), scored(CACHE_WRAPPER, 1)], ['bullmq'], 'docker', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(true);
  });

  it('accepts the same domain alone', () => {
    const decision = decideDuplicate([scored(BULLMQ, 10), scored(CACHE_WRAPPER, 1)], ['nada'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(true);
  });

  it('matches the domain on a whole path segment, not a string prefix', () => {
    const sibling = '02-wiki/patternsX/nota.md';
    const decision = decideDuplicate(
      [scored(sibling, 10), scored(CACHE_WRAPPER, 1)],
      ['nada'],
      'patterns',
      tagsFrom({}),
    );
    expect(decision.isDuplicate).toBe(false);
  });

  it('refuses a top hit that is not a wiki note', () => {
    // A project README, a daily, the knowledge index and an archived note can all top the list
    // for a learning. None of them is a place to file one, and `99-archive/` and `_templates/`
    // are read-only areas the write guard refuses outright.
    for (const forapath of [
      '03-projects/potentia/README.md',
      '99-archive/antigo.md',
      '04-daily/2026-08-20.md',
      '00-index/index-knowledge.md',
      'quebrada.md',
    ]) {
      const decision = decideDuplicate(
        [scored(forapath, 10, ['bullmq']), scored(CACHE_WRAPPER, 1)],
        ['bullmq'],
        'nestjs',
        tagsFrom({ [forapath]: ['bullmq'] }),
      );
      expect(decision.isDuplicate).toBe(false);
      expect(decision.reason).toContain('02-wiki/');
    }
  });

  it('refuses a top hit that only entered through graph expansion', () => {
    // This state is SYNTHETIC and cannot be produced by the real `Retriever`: an inherited score
    // is 0.4x the best DIRECT score and every idf is positive, so a graph-only chunk never reaches
    // rank 1 (measured: 1546 of 4497 fixture searches carry one, none of them first). The guard
    // is an assertion for the day `GRAPH_DAMPING` reaches 1, and this test is the only way to
    // reach it - it pins what the guard must do, not something a user can hit today.
    const results = [scored(BULLMQ, 10, TAGS[BULLMQ], true), scored(CACHE_WRAPPER, 1)];
    const decision = decideDuplicate(results, ['bullmq'], 'nestjs', tagsFrom(TAGS));
    expect(decision.isDuplicate).toBe(false);
    expect(decision.reason).toContain('grafo');
  });
});

describe('learn — roteamento', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  it('anexa a nota existente quando o insight se sobrepõe fortemente a ela', async () => {
    const titulo = 'Retry de worker BullMQ';
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo,
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes',
      contexto: 'Investigando jobs que falhavam sem nova tentativa',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    expect(result.path).toBe(BULLMQ);
    expect(result.diff).not.toBe('');
    expect(result.reason).toContain(BULLMQ);

    const note = await read(vaultRoot, BULLMQ);
    expect(note).toContain(`## ${TODAY} — ${titulo}`);
    expect(note).toContain('backoff exponencial na fila de notificacoes');
    expect(note).toContain('Investigando jobs que falhavam sem nova tentativa');
    // The note it appended to is intact: the original body is still there, once.
    expect(note).toContain('# BullMQ Worker');
    expect(occurrences(note, '## Contexto')).toBe(1);
  });

  it('cria nota nova quando o assunto não existe no vault', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs', 'observabilidade'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/health-check-com-terminus.md');
    expect(result.diff).not.toBe('');

    const note = await read(vaultRoot, result.path);
    const parsed = matter(note, {});
    expect(parsed.data.tipo).toBe('wiki');
    expect(parsed.data.tags).toEqual(['nestjs', 'observabilidade']);
    expect(note).toContain('terminus expoe um indicador de saude');
    expect(note).toContain('Subindo o healthcheck do cluster');
  });

  it('cria nota nova quando há bom match mas nem tag nem domínio se sobrepõem', async () => {
    const before = await read(vaultRoot, BULLMQ);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Retry de worker BullMQ no build',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes',
      contexto: 'Lendo o Dockerfile do worker',
      dominio: 'docker',
      tags: ['docker'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/docker/retry-de-worker-bullmq-no-build.md');
    expect(result.reason).toContain('overlap');
    // The strongly matching note was NOT touched.
    expect(await read(vaultRoot, BULLMQ)).toBe(before);
  });

  it('cria nota nova quando a razão fica abaixo de 1.8 mesmo com overlap de tag e domínio', async () => {
    const before = await read(vaultRoot, CACHE_WRAPPER);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    // Measured on this fixture: top `cache-wrapper.md` at 20.4618 against
    // `03-projects/potentia/README.md` at 12.7129 — a direct hit, not a damped graph neighbour —
    // for a ratio of 1.6095. The overlap conjunct is satisfied (tags AND domain), so only the
    // ratio can be deciding this. Together with the bullmq case at 2.5000 the pair brackets the
    // constant in (1.6095, 2.5000).
    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl.md');
    expect(result.reason).toContain('razão');
    expect(await read(vaultRoot, CACHE_WRAPPER)).toBe(before);
  });

  it('não deixa a truncagem silenciosa de 1024 caracteres virar a decisão', async () => {
    const titulo = 'Anotacao rapida da sessao';
    const insight =
      `${BLOB} depois de investigar, o worker do bullmq reprocessa cada job da fila ` +
      'com retry e backoff exponencial configurado em queueOptions, e o processo do worker ' +
      'roda separado da api';

    // The hazard, stated as an assertion: the raw concatenation is over the clamp, and what
    // survives the clamp carries none of the terms that identify the note.
    const raw = `${titulo} ${insight}`;
    expect(raw.length).toBeGreaterThan(MAX_QUERY_CHARS);
    expect(tokenize(raw.slice(0, MAX_QUERY_CHARS))).not.toContain('bullmq');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo,
      insight,
      contexto: 'Colei o payload antes de escrever o aprendizado',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    expect(result.path).toBe(BULLMQ);
  });

  it('anexa em vez de sobrescrever quando a nota do título já existe', async () => {
    const before = await read(vaultRoot, CACHE_WRAPPER);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    // The ratio rule says "not a duplicate", but the file name is the vault's identity for a
    // note: writing it would have replaced `cache-wrapper.md` with three paragraphs.
    expect(result.action).toBe('appended');
    expect(result.path).toBe(CACHE_WRAPPER);
    // This route appends on the FILE NAME alone, after the duplicate rule looked at that same
    // note and said no. Both halves have to reach the caller, and the warning has to say the
    // append rests on a title coincidence - otherwise the one outcome this module calls its worst
    // is the only one it reports as an ordinary success.
    expect(result.reason).toContain('razão');
    expect(result.reason).toContain(`nota já existe em ${CACHE_WRAPPER}`);
    expect(result.warning).toContain('coincidência de título');

    const after = await read(vaultRoot, CACHE_WRAPPER);
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain('## Solução');
  });

  it('rejeita título sem nada aproveitável para nome de arquivo', async () => {
    await expect(
      learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        titulo: '  ///  ',
        insight: 'algo',
        contexto: 'algo',
        dominio: 'nestjs',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(LearnError);
  });
});

describe('learn — domínio', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  const rustOpts = {
    titulo: 'Ownership no Rust',
    insight: 'O borrow checker do Rust move a posse do valor quando ele e passado para outra funcao',
    contexto: 'Portando o worker para Rust',
    dominio: 'rust',
    tags: ['rust'],
  };

  it('recusa um domínio inexistente listando os válidos', async () => {
    const promise = learn({ vaultRoot, retriever: makeRetriever(vaultRoot), ...rustOpts, now: NOW });
    await expect(promise).rejects.toBeInstanceOf(LearnError);
    await expect(promise).rejects.toThrow(/nestjs/);
    await expect(promise).rejects.toThrow(/docker/);
    await expect(promise).rejects.toThrow(/patterns/);

    expect(await exists(path.join(vaultRoot, '02-wiki', 'rust'))).toBe(false);
    expect(await logLines(vaultRoot)).toBe(1);
  });

  it('cria o domínio quando confirmado, com diff não-vazio', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      ...rustOpts,
      confirmNovoDominio: true,
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/rust/ownership-no-rust.md');
    expect(result.diff).not.toBe('');
    expect(await exists(path.join(vaultRoot, '02-wiki', 'rust', 'rust-moc.md'))).toBe(true);
    expect(await read(vaultRoot, INDEX_REL)).toContain('[[../02-wiki/rust/rust-moc|rust]]');
  });

  it('recusa um domínio que é caminho, mesmo com a confirmação', async () => {
    await expect(
      learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        ...rustOpts,
        dominio: '../.git/refs/heads',
        confirmNovoDominio: true,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(LearnError);
    expect(await logLines(vaultRoot)).toBe(1);
  });
});

describe('learn — propagação e commit', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  it('uma criação em nestjs entra num único commit com a nota, o MOC e o daily', async () => {
    const before = await logLines(vaultRoot);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs', 'observabilidade'],
      projeto: 'potentia',
      now: NOW,
    });

    expect(result.committed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(await logLines(vaultRoot)).toBe(before + 1);
    expect(await commitFilesOf(vaultRoot)).toEqual(
      [result.path, MOC_NESTJS, DAILY_REL].sort(),
    );
    expect(await git(vaultRoot, ['log', '-1', '--pretty=format:%s'])).toBe(
      'docs(vault): Health check com Terminus',
    );

    expect(result.propagated.sort()).toEqual([MOC_NESTJS, DAILY_REL].sort());
    expect(await read(vaultRoot, MOC_NESTJS)).toContain('- [[health-check-com-terminus]] —');
    expect(await read(vaultRoot, DAILY_REL)).toContain(
      '- 14:05 [[health-check-com-terminus]] (aprendizado, potentia)',
    );
  });

  it('uma criação em domínio novo entra num commit com quatro arquivos', async () => {
    const before = await logLines(vaultRoot);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Ownership no Rust',
      insight: 'O borrow checker do Rust move a posse do valor quando ele e passado para outra funcao',
      contexto: 'Portando o worker para Rust',
      dominio: 'rust',
      tags: ['rust'],
      confirmNovoDominio: true,
      now: NOW,
    });

    expect(result.committed).toBe(true);
    expect(await logLines(vaultRoot)).toBe(before + 1);
    expect(await commitFilesOf(vaultRoot)).toEqual(
      [result.path, '02-wiki/rust/rust-moc.md', INDEX_REL, DAILY_REL].sort(),
    );
  });

  it('uma anexação commita a nota, o MOC (só atualizado) e o daily', async () => {
    const mocBefore = await read(vaultRoot, MOC_NESTJS);
    const before = await logLines(vaultRoot);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes',
      contexto: 'Investigando jobs que falhavam sem nova tentativa',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    expect(result.committed).toBe(true);
    expect(await logLines(vaultRoot)).toBe(before + 1);
    expect(await commitFilesOf(vaultRoot)).toEqual([BULLMQ, MOC_NESTJS, DAILY_REL].sort());

    const mocAfter = await read(vaultRoot, MOC_NESTJS);
    expect(mocAfter).toContain(`atualizado: ${TODAY}`);
    // An append adds no MOC entry: the note is already listed there.
    expect(mocAfter.split('\n').filter((l) => l.startsWith('- [[')).length).toBe(
      mocBefore.split('\n').filter((l) => l.startsWith('- [[')).length,
    );
    expect(await read(vaultRoot, DAILY_REL)).toContain('- 14:05 [[bullmq-worker]] (aprendizado)');
  });

  it('a mesma chamada repetida não duplica a linha no MOC nem no daily', async () => {
    const opts = {
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs', 'observabilidade'],
      now: NOW,
    };

    const first = await learn(opts);
    const second = await learn(opts);

    const moc = await read(vaultRoot, MOC_NESTJS);
    const daily = await read(vaultRoot, DAILY_REL);
    expect(occurrences(moc, '- [[health-check-com-terminus]]')).toBe(1);
    expect(occurrences(daily, '[[health-check-com-terminus]]')).toBe(1);
    expect(first.action).toBe('created');
    expect(second.propagated).not.toContain(DAILY_REL);
  });

  it('grava tudo em disco e avisa quando o git falha', async () => {
    const noRepo = await makeVault(false);
    try {
      const result = await learn({
        vaultRoot: noRepo,
        retriever: makeRetriever(noRepo),
        titulo: 'Health check com Terminus',
        insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
        contexto: 'Subindo o healthcheck do cluster',
        dominio: 'nestjs',
        tags: ['nestjs'],
        now: NOW,
      });

      expect(result.committed).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('git');
      expect(await exists(path.join(noRepo, result.path))).toBe(true);
      expect(await read(noRepo, MOC_NESTJS)).toContain('- [[health-check-com-terminus]] —');
      expect(await read(noRepo, DAILY_REL)).toContain('[[health-check-com-terminus]]');
    } finally {
      await removeTree(path.dirname(noRepo));
    }
  });

  it('commita a nota e o MOC e nomeia o daily quando a propagação do daily falha', async () => {
    // A directory where the daily note should be: `readFile` fails with EISDIR, which is not the
    // ordinary "create it" ENOENT.
    await fs.rm(path.join(vaultRoot, DAILY_REL));
    await fs.mkdir(path.join(vaultRoot, DAILY_REL));

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    expect(result.committed).toBe(true);
    expect(result.warning).toContain(DAILY_REL);
    expect(result.propagated).not.toContain(DAILY_REL);
    expect(await commitFilesOf(vaultRoot)).toEqual([result.path, MOC_NESTJS].sort());
  });

  it('trunca o resumo por ponto de código, sem partir um par surrogate', async () => {
    const frase = `${'x'.repeat(119)}🎉 e mais texto que passa de cento e vinte pontos de codigo`;
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: frase,
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    const moc = await read(vaultRoot, MOC_NESTJS);
    const entry = moc.split('\n').find((l) => l.includes('[[health-check-com-terminus]]')) ?? '';
    // The 120th code point is the emoji: a UTF-16 slice would keep its high surrogate alone.
    expect(entry).toContain('🎉');
    expect(entry).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(Array.from(entry.slice(entry.indexOf('— ') + 2)).length).toBe(120);
  });

  it('usa só a primeira frase do insight como resumo', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O terminus agrega indicadores. Esta segunda frase nao entra no resumo do MOC.',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    const moc = await read(vaultRoot, MOC_NESTJS);
    expect(moc).toContain('- [[health-check-com-terminus]] — O terminus agrega indicadores.');
    expect(moc).not.toContain('Esta segunda frase');
  });
});

describe('learn — links', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  it('renderiza os links numa seção ## Links da nota criada', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      links: ['auth-guard', '[[bullmq-worker]]', 'multi-stage.md'],
      now: NOW,
    });

    const note = await read(vaultRoot, result.path);
    expect(note).toContain('## Links');
    expect(note).toContain('- [[auth-guard]]');
    // Already-bracketed and `.md`-suffixed forms normalise to the same wiki-link.
    expect(note).toContain('- [[bullmq-worker]]');
    expect(note).toContain('- [[multi-stage]]');
    expect(note).not.toContain('[[[[');
  });

  it('descarta o alias de um link, que renderiza um nome e aponta para outro', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      links: ['auth-guard|cache-wrapper'],
      now: NOW,
    });

    const note = await read(vaultRoot, result.path);
    expect(note).toContain('- [[auth-guard]]');
    expect(note).not.toContain('cache-wrapper');
    // What the reader sees and what the graph records are the same note again.
    expect(extractLinkTargets(note)).toEqual(['auth-guard']);
  });

  it('não deixa um nome de link fechar o próprio wiki-link e forjar texto', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Health check com Terminus',
      insight: 'O modulo terminus expoe um indicador de saude que agrega disco e memoria heap',
      contexto: 'Subindo o healthcheck do cluster',
      dominio: 'nestjs',
      tags: ['nestjs'],
      links: ['auth-guard]] revisado por seguranca [[outra-nota'],
      now: NOW,
    });

    const note = await read(vaultRoot, result.path);
    const item = note.split('\n').find((l) => l.startsWith('- [[')) ?? '';
    expect(item).toBe('- [[auth-guard revisado por seguranca outra-nota]]');
    expect(occurrences(note, '[[')).toBe(1);
    expect(occurrences(note, ']]')).toBe(1);
  });

  it('renderiza os links também no caminho de anexação', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes',
      contexto: 'Investigando jobs que falhavam sem nova tentativa',
      dominio: 'nestjs',
      tags: ['bullmq'],
      links: ['auth-guard'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    const note = await read(vaultRoot, BULLMQ);
    const section = note.slice(note.indexOf(`## ${TODAY} —`));
    expect(section).toContain('## Links');
    expect(section).toContain('- [[auth-guard]]');
  });

  it('preserva CRLF ao anexar numa nota com fim de linha do Windows', async () => {
    const abs = path.join(vaultRoot, BULLMQ);
    const original = await fs.readFile(abs, 'utf8');
    await fs.writeFile(abs, original.replace(/\n/g, '\r\n'), 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Retry de worker BullMQ',
      // MULTI-LINE on purpose: with a single-line insight `withEol` has nothing to rewrite and
      // the test passes against an implementation that always emits LF.
      insight:
        'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes.\n\n' +
        'Segunda linha do insight, que precisa terminar em CRLF como o resto do arquivo.',
      contexto: 'Investigando jobs que falhavam sem nova tentativa',
      dominio: 'nestjs',
      tags: ['bullmq'],
      links: ['auth-guard'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    const note = await read(vaultRoot, BULLMQ);
    const appended = note.slice(note.indexOf(`## ${TODAY} —`));
    expect(appended).toContain('Segunda linha do insight');
    expect(appended.split('\r\n').length).toBeGreaterThan(6);
    expect(appended.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('learn - texto livre nao vira estrutura', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  const terminus = {
    titulo: 'Health check com Terminus',
    contexto: 'Subindo o healthcheck do cluster',
  };

  it('não cria arestas de grafo a partir do resumo nem do projeto', async () => {
    const mocBefore = extractLinkTargets(await read(vaultRoot, MOC_DOCKER));
    const dailyBefore = extractLinkTargets(await read(vaultRoot, DAILY_REL));

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      ...terminus,
      // The shape of an insight clipped off a page: its first sentence becomes the `resumo`, and
      // the `resumo` is written into a MOC list item.
      insight:
        'a]] - [[cache-wrapper]] e [[auth-guard]] fim. O modulo terminus expoe um indicador de saude.',
      dominio: 'docker',
      tags: ['docker'],
      projeto: 'x]] (nada) [[auth-guard]] (',
      now: NOW,
    });

    expect(result.action).toBe('created');

    // Assert on PARSED EDGES with this project's own parser, not on the raw string: what matters
    // is what `graph.ts` and the one-hop expansion will see.
    const mocAfter = extractLinkTargets(await read(vaultRoot, MOC_DOCKER));
    const dailyAfter = extractLinkTargets(await read(vaultRoot, DAILY_REL));
    expect(mocAfter.filter((t) => !mocBefore.includes(t))).toEqual(['health-check-com-terminus']);
    expect(dailyAfter.filter((t) => !dailyBefore.includes(t))).toEqual([
      'health-check-com-terminus',
    ]);

    // The text itself is kept - only the brackets are dropped, so the entry still reads.
    expect(await read(vaultRoot, MOC_DOCKER)).toContain('cache-wrapper e auth-guard fim.');
    expect(await read(vaultRoot, DAILY_REL)).toContain('(aprendizado, x (nada) auth-guard (');

    // The BODY is the other side of the boundary: a wiki-link the user wrote inside their own
    // insight is authored content and stays a link.
    expect(extractLinkTargets(await read(vaultRoot, result.path))).toEqual([
      'cache-wrapper',
      'auth-guard',
    ]);
  });

  it('não cria arestas a partir do resumo na entrada do índice de conhecimento', async () => {
    const indexBefore = extractLinkTargets(await read(vaultRoot, INDEX_REL));

    await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Ownership no Rust',
      insight: 'a]] - [[cache-wrapper]] e [[auth-guard]] fim. O borrow checker move a posse.',
      contexto: 'Portando o worker para Rust',
      dominio: 'rust',
      tags: ['rust'],
      confirmNovoDominio: true,
      now: NOW,
    });

    const indexAfter = extractLinkTargets(await read(vaultRoot, INDEX_REL));
    expect(indexAfter.filter((t) => !indexBefore.includes(t))).toEqual([
      '../02-wiki/rust/rust-moc',
    ]);
  });

  it('não deixa título nem contexto forjarem um heading dentro da nota', async () => {
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Retry de worker BullMQ\n## Forjado pelo titulo',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila de notificacoes',
      contexto: 'Investigando jobs\n## Forjado pelo contexto',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    const note = await read(vaultRoot, BULLMQ);
    const appended = note.slice(note.indexOf(`## ${TODAY} `));
    expect(appended.split('\n').filter((l) => l.startsWith('## '))).toHaveLength(1);
    expect(appended).toContain('Forjado pelo titulo');
    expect(appended).toContain('Forjado pelo contexto');

    // The same title is the commit subject, where a newline forges a message body.
    const message = await git(vaultRoot, ['log', '-1', '--pretty=format:%B']);
    expect(message.trim().split('\n')).toHaveLength(1);
  });

  it('remove caracteres invisíveis do insight, da nota e do diff', async () => {
    const ESC = String.fromCharCode(0x1b);
    const NUL = String.fromCharCode(0x00);
    const RLO = String.fromCharCode(0x202e);
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      ...terminus,
      insight:
        `O modulo terminus expoe ${ESC}[31mvermelho${ESC}[0m um indicador${NUL} de ` +
        `saude${RLO} edaus ed.`,
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    const note = await read(vaultRoot, result.path);
    expect(note).toContain('vermelho');
    // The plan says the diff is shown to the user: a terminal printing it executes SGR sequences.
    for (const invisivel of [ESC, NUL, RLO]) {
      expect(note).not.toContain(invisivel);
      expect(result.diff).not.toContain(invisivel);
    }
  });

  it('recusa um insight que abre com o delimitador de frontmatter', async () => {
    const promise = learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      ...terminus,
      insight: '---\ntipo: moc\ntags: [urgentissimo]\n---\nO modulo terminus expoe indicadores.',
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    await expect(promise).rejects.toBeInstanceOf(LearnError);
    await expect(promise).rejects.toThrow(/frontmatter/);
    expect(await logLines(vaultRoot)).toBe(1);
  });

  it('aceita um bloco de --- depois da primeira linha e mantém o frontmatter da nota', async () => {
    // The guard is about offset 0, so an insight that merely CONTAINS a rule or a YAML sample is
    // written as it is - refusing those would be refusing ordinary technical prose.
    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      ...terminus,
      insight: 'O frontmatter do indicador terminus fica assim:\n\n---\ntipo: moc\n---\n',
      dominio: 'nestjs',
      tags: ['nestjs'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    const parsed = matter(await read(vaultRoot, result.path), {});
    expect(parsed.data.tipo).toBe('wiki');
    expect(parsed.data.tags).toEqual(['nestjs']);
    expect(parsed.content).toContain('tipo: moc');
  });
});

describe('learn - o insight nunca se perde', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  // Obsidian leaves exactly these behind: click an unresolved link, or press Enter in a new note.
  // A placeholder is not a note, and the outcome must not turn on which whitespace byte is in it.
  for (const [rotulo, conteudo] of [
    ['zero bytes', ''],
    ['uma quebra de linha', '\n'],
    ['só espaços', '   '],
  ] as const) {
    it(`escreve a nota no lugar do stub em branco (${rotulo}), com o esqueleto do template`, async () => {
      const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
      await fs.writeFile(path.join(vaultRoot, stub), conteudo, 'utf8');

      const result = await learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        titulo: 'Cache Wrapper TTL',
        insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
        contexto: 'Revisando o wrapper de cache',
        dominio: 'patterns',
        tags: ['redis', 'cache'],
        now: NOW,
      });

      // The path the user's own link points at, not a dated sibling that would leave the
      // placeholder blank forever.
      expect(result.action).toBe('created');
      expect(result.path).toBe(stub);
      expect(await exists(path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md')))
        .toBe(false);

      // `editNote` would have appended into the placeholder and run neither `ensureFrontmatter`
      // nor `applyTemplate`, leaving a note with no tipo, no tags and no skeleton - invisible to
      // `vault_list({tipo:'wiki'})` and unreachable by the tag arm of the duplicate rule.
      const nota = await read(vaultRoot, stub);
      const parsed = matter(nota, {});
      expect(parsed.data.tipo).toBe('wiki');
      expect(parsed.data.tags).toEqual(['redis', 'cache']);
      // Built from the template with THIS call's `now`, not with wall-clock time.
      expect(nota).toContain(`criado: ${TODAY}`);
      expect(nota).toContain('TTL configuravel');
      expect(nota).toContain('## Contexto');
      expect(nota).toContain('## Solução');
      expect(nota).toContain('## Exemplo');
      // Spliced ABOVE the first section, where the vault's own notes put their lead paragraph -
      // appending instead would file the learning under whatever section happens to come last.
      expect(nota.indexOf('TTL configuravel')).toBeLessThan(nota.indexOf('## Contexto'));
      expect(nota.indexOf('# Cache Wrapper Ttl')).toBeLessThan(nota.indexOf('TTL configuravel'));
      expect(nota.split('\n')).toContain('# Cache Wrapper Ttl');

      // Created, so it is listed: a note nobody links to is a note nobody finds.
      expect(await read(vaultRoot, '02-wiki/patterns/patterns-moc.md')).toContain(
        '- [[cache-wrapper-ttl]] —',
      );
      expect(await read(vaultRoot, DAILY_REL)).toContain('[[cache-wrapper-ttl]]');
    });
  }

  it('grava o aprendizado quando a nota alvo sumiu entre o índice e a escrita', async () => {
    // The index can name a note that is no longer on disk - the user deleted it in Obsidian
    // between the scan and the write. Through the real retriever that is a race; the stub makes
    // it deterministic. ENOENT is recoverable: the learning becomes a new note.
    const fantasma = '02-wiki/nestjs/fantasma.md';
    const retriever = {
      search: () => ({ results: [scored(fantasma, 10, ['bullmq'])] }),
    } as unknown as Retriever;

    const result = await learn({
      vaultRoot,
      retriever,
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
      contexto: 'Investigando a fila',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/retry-de-worker-bullmq.md');
    expect(result.warning).toContain(fantasma);
    expect(await read(vaultRoot, result.path)).toContain('backoff exponencial');
  });

  it('não abre o alvo da regra de duplicata antes de classificá-lo', async () => {
    // The classification runs BEFORE anything is opened. Without it the first thing to touch the
    // target is `readFile`, which follows the link onto a FIFO and never returns — the collision
    // guard further down cannot help here, because this target comes from the duplicate rule.
    const cano = path.join(path.dirname(vaultRoot), 'cano-alvo');
    await execFileAsync('mkfifo', [cano]);
    const alias = '02-wiki/nestjs/alias-cano.md';
    await fs.symlink(cano, path.join(vaultRoot, alias));
    const retriever = {
      search: () => ({ results: [scored(alias, 10, ['bullmq'])] }),
    } as unknown as Retriever;

    const result = await learn({
      vaultRoot,
      retriever,
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
      contexto: 'Investigando a fila',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/retry-de-worker-bullmq.md');
    expect(await read(vaultRoot, result.path)).toContain('backoff exponencial');
    expect(result.warning).toContain(alias);
  }, 15_000);

  it('grava o aprendizado quando a guarda de escrita recusa o alvo da regra', async () => {
    // A target that classifies as an ordinary note and is then refused by `writeNote`'s own guards
    // — `DENIED_SEGMENTS` here — is still "this target cannot take the text", not a fault to throw.
    // The insight goes to the note's own name instead of being lost with the exception.
    const alvo = '02-wiki/node_modules/nota.md';
    await fs.mkdir(path.join(vaultRoot, '02-wiki/node_modules'));
    await fs.writeFile(path.join(vaultRoot, alvo), '# Nota\n\nconteudo real\n', 'utf8');
    const retriever = {
      search: () => ({ results: [scored(alvo, 10, ['bullmq'])] }),
    } as unknown as Retriever;

    const result = await learn({
      vaultRoot,
      retriever,
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
      contexto: 'Investigando a fila',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/retry-de-worker-bullmq.md');
    expect(await read(vaultRoot, result.path)).toContain('backoff exponencial');
    expect(result.warning).toContain(alvo);
    expect(await read(vaultRoot, alvo)).toBe('# Nota\n\nconteudo real\n');
  });

  it('grava o aprendizado quando o alvo da regra de duplicata não é uma nota', async () => {
    // A directory standing where a note should be cannot take the text, so the append is refused
    // and the learning takes the note's own free name. Nothing opens the directory: the classifier
    // answers from `lstat` alone, which is what keeps a FIFO in the same position from wedging the
    // whole server.
    //
    // The retriever is a stub because the real one CANNOT produce this state: the scanner never
    // indexes a directory as a note, so nothing else can route an append onto one.
    const pasta = '02-wiki/nestjs/pasta.md';
    await fs.mkdir(path.join(vaultRoot, pasta));
    const retriever = {
      search: () => ({ results: [scored(pasta, 10, ['bullmq'])] }),
    } as unknown as Retriever;

    const result = await learn({
      vaultRoot,
      retriever,
      titulo: 'Retry de worker BullMQ',
      insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
      contexto: 'Investigando a fila',
      dominio: 'nestjs',
      tags: ['bullmq'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/retry-de-worker-bullmq.md');
    expect(await read(vaultRoot, result.path)).toContain('backoff exponencial');
    expect(result.warning).toContain(pasta);
    expect((await fs.lstat(path.join(vaultRoot, pasta))).isDirectory()).toBe(true);
  });

  it('avisa e grava só o corpo quando o template do vault não existe', async () => {
    // `_templates/wiki.md` is the USER's file and can simply not be there. `writeNote` raises this
    // warning itself when it creates a note; on this route it never looks, so the warning has to
    // come from here — otherwise a note without its skeleton is reported as an ordinary success.
    await fs.rm(path.join(vaultRoot, '_templates/wiki.md'));
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), '', 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe(stub);
    expect(result.warning).toContain('_templates/wiki.md');
    const nota = await read(vaultRoot, stub);
    expect(nota).toContain('TTL configuravel');
    expect(matter(nota, {}).data.tipo).toBe('wiki');
  });

  it('usa um template sem seção sem perder o insight', async () => {
    // A template of frontmatter and a title and nothing else is a perfectly ordinary user
    // template, and it is the one shape with no `## ` to splice above. The body goes after the
    // skeleton instead of being dropped.
    await fs.writeFile(
      path.join(vaultRoot, '_templates/wiki.md'),
      '---\ntipo: wiki\ntags: \ncriado: <% tp.date.now("YYYY-MM-DD") %>\n---\n\n# <% tp.file.title %>\n',
      'utf8',
    );
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), '\n', 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe(stub);
    const nota = await read(vaultRoot, stub);
    expect(nota.split('\n')).toContain('# Cache Wrapper Ttl');
    expect(nota).toContain('TTL configuravel');
    expect(nota.indexOf('# Cache Wrapper Ttl')).toBeLessThan(nota.indexOf('TTL configuravel'));
  });

  it('difere do caminho livre apenas em criado, que segue o now da chamada', async () => {
    // The two routes have to produce the same note, and they do — except for `criado`, which
    // `writeNote` stamps with wall-clock time on the free path while this route passes `opts.now`.
    // `opts.now` is the value the MOC entry, the daily capture and the append heading of the SAME
    // call already use; `writeNote` is the outlier and is outside this task's file set. The
    // divergence is asserted rather than described, so nobody has to trust a comment.
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), '   ', 'utf8');
    const outroVault = await makeVault();
    // Sampled BEFORE the calls, so a run that crosses local midnight has both days in hand.
    const antes = new Date();

    try {
      const opts = {
        titulo: 'Cache Wrapper TTL',
        insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
        contexto: 'Revisando o wrapper de cache',
        dominio: 'patterns',
        tags: ['redis', 'cache'],
        now: NOW,
      } as const;

      const sobreStub = await learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        ...opts,
      });
      const emCaminhoLivre = await learn({
        vaultRoot: outroVault,
        retriever: makeRetriever(outroVault),
        ...opts,
      });

      expect(sobreStub.path).toBe(stub);
      expect(emCaminhoLivre.path).toBe(stub);

      const semCriado = (texto: string): string =>
        texto
          .split('\n')
          .filter((linha) => !linha.startsWith('criado:'))
          .join('\n');
      const a = await read(vaultRoot, sobreStub.path);
      const b = await read(outroVault, emCaminhoLivre.path);
      expect(semCriado(a)).toBe(semCriado(b));
      expect(a).toContain(`criado: ${TODAY}`);
      // Wall clock, sampled on BOTH sides of the two calls rather than only after them:
      // `writeNote` stamps `criado` from its own `new Date()`, and a sample taken afterwards
      // names a different day whenever the run crosses local midnight — a correct note failing
      // the test once a day. Either day is right, and naming both is what makes the assertion
      // honest rather than merely quiet.
      const criado = b.match(/^criado: (.+)$/m)?.[1]?.trim();
      expect(criado).toBeDefined();
      expect([dataLocal(antes), dataLocal(new Date())]).toContain(criado);
    } finally {
      await removeTree(path.dirname(outroVault));
    }
  });

  it('usa um nome livre quando a nota do título existe e não aceita anexação', async () => {
    const alvo = '02-wiki/patterns/cache-wrapper-ttl.md';
    const fora = await notaBlindada(vaultRoot, alvo);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
    // The warning has to say BOTH which target failed and where the learning ended up: a user
    // told only the first half has to go looking for their own insight.
    expect(result.warning).toContain(alvo);
    expect(result.warning).toContain(`aprendizado gravado em ${result.path}`);
    expect(await fs.readFile(fora, 'utf8')).toBe(CONTEUDO_FORA);
  });

  it('procura o próximo nome livre quando o nome com data também está ocupado', async () => {
    const datado = '02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md';
    await notaBlindada(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await fs.writeFile(path.join(vaultRoot, datado), 'conteudo anterior sem relacao\n', 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20-2.md');
    expect(await read(vaultRoot, datado)).toBe('conteudo anterior sem relacao\n');
  });

  it('mantém o nome livre dentro do limite de tamanho do slug', async () => {
    // 'ab ab ab ...' is chosen for arithmetic, not for looks: it makes the slug exactly 80
    // characters AND puts a hyphen exactly where the date suffix has to cut it, so both halves of
    // the bounding - the truncation and the trailing-hyphen trim - are exercised at once.
    const titulo = 'ab '.repeat(40);
    const base = slug(titulo);
    expect(base).toHaveLength(80);
    await notaBlindada(vaultRoot, `02-wiki/patterns/${base}.md`);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo,
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    const nome = path.basename(result.path, '.md');
    expect(nome.length).toBeLessThanOrEqual(80);
    expect(nome.endsWith(`-${TODAY}`)).toBe(true);
    expect(nome).not.toContain('--');
    expect(nome.startsWith('ab-ab-ab')).toBe(true);
  });

  it('recusa em vez de escrever por cima quando não há nome livre', async () => {
    // The last-resort guard protecting the fix: without the throw, `writeNote` is handed an
    // OCCUPIED path and is create-OR-REPLACE. It takes 101 files to reach, which is why it is a
    // coverage gap and not a live bug - and why it still has to be pinned.
    await notaBlindada(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    const nomes = [`cache-wrapper-ttl-${TODAY}`];
    for (let i = 2; i <= 100; i += 1) nomes.push(`cache-wrapper-ttl-${TODAY}-${i}`);
    await Promise.all(
      nomes.map((nome) =>
        fs.writeFile(path.join(vaultRoot, '02-wiki/patterns', `${nome}.md`), 'ocupado\n', 'utf8'),
      ),
    );

    // A stub with NO results, because the 100 extra files are enough to move BM25's corpus
    // statistics: with the real retriever the duplicate rule starts pointing at
    // `cache-wrapper.md`, the append succeeds there, and the name search under test never runs.
    const retriever = { search: () => ({ results: [] }) } as unknown as Retriever;

    await expect(
      learn({
        vaultRoot,
        retriever,
        titulo: 'Cache Wrapper TTL',
        insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
        contexto: 'Revisando o wrapper de cache',
        dominio: 'patterns',
        tags: ['redis', 'cache'],
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(LearnError);

    // Nothing written, nothing committed, nothing overwritten.
    for (const nome of nomes) {
      expect(await read(vaultRoot, `02-wiki/patterns/${nome}.md`)).toBe('ocupado\n');
    }
    // Nothing propagated either: the MOC this domain does not have yet was never created.
    expect(await exists(path.join(vaultRoot, '02-wiki/patterns/patterns-moc.md'))).toBe(false);
    expect(await logLines(vaultRoot)).toBe(1);
  });

  it('nunca substitui uma nota existente quando a anexação no alvo falha', async () => {
    // A completely ordinary Obsidian filename that `resolveWritePath` refuses (glob
    // metacharacters) while the scanner indexes it happily. The duplicate rule therefore routes
    // the append to a path the write guard will not take, and the fallback used to hand the
    // colliding `cache-wrapper.md` to create-OR-REPLACE: 722 bytes of note replaced by a 6-line
    // stub, in a vault where only this tool commits.
    const rascunho = '02-wiki/nestjs/bullmq-worker [rascunho].md';
    await fs.rename(path.join(vaultRoot, BULLMQ), path.join(vaultRoot, rascunho));
    const before = await read(vaultRoot, CACHE_WRAPPER);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper',
      insight: 'bullmq retry backoff exponencial notificacoes worker',
      contexto: 'Investigando a fila de notificacoes',
      dominio: 'patterns',
      tags: ['bullmq'],
      now: NOW,
    });

    const after = await read(vaultRoot, CACHE_WRAPPER);
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain('## Solução');
    expect(after).toContain('[[auth-guard]]');
    expect(after).toContain('backoff exponencial');
    expect(after.length).toBeGreaterThan(before.length);

    expect(result.action).toBe('appended');
    expect(result.path).toBe(CACHE_WRAPPER);
    expect(result.warning).toContain(rascunho);
  });
});

describe('learn - nada e removido do disco', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await makeVault();
  });

  afterEach(async () => {
    await removeTree(path.dirname(vaultRoot));
  });

  const insightRust = {
    insight: 'O borrow checker do Rust move a posse do valor quando ele e passado para outra funcao',
    contexto: 'Portando o worker para Rust',
  };

  it('não apaga um arquivo fora do vault alcançado por diretório de domínio symlinkado', async () => {
    // `02-wiki/externo` is a link to a directory OUTSIDE the vault. The path
    // `02-wiki/externo/alvo.md` passes `resolveWritePath` — right suffix, no glob, inside the
    // vault as a string — and only `assertNoSymlinkEscape`, INSIDE `writeNote`, can see the
    // escape. Anything destructive done before that call is done to a file the guard was about
    // to refuse.
    const fora = path.join(path.dirname(vaultRoot), 'compartilhado');
    await fs.mkdir(fora);
    const vitima = path.join(fora, 'alvo.md');
    await fs.writeFile(vitima, '\n', 'utf8');
    await fs.symlink(fora, path.join(vaultRoot, '02-wiki/externo'));

    await expect(
      learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        titulo: 'Alvo',
        ...insightRust,
        dominio: 'externo',
        tags: ['rust'],
        confirmNovoDominio: true,
        now: NOW,
      }),
    ).rejects.toThrow(/symlink/);

    expect(await exists(vitima)).toBe(true);
    expect(await fs.readFile(vitima, 'utf8')).toBe('\n');
  });

  it('não apaga um arquivo em node_modules antes de a escrita ser negada', async () => {
    // `DENIED_SEGMENTS` lives inside `writeNote` too. Same shape as the symlink case: the refusal
    // is correct and arrives after anything done first.
    const rel = '02-wiki/node_modules/alvo.md';
    await fs.mkdir(path.join(vaultRoot, '02-wiki/node_modules'));
    await fs.writeFile(path.join(vaultRoot, rel), '   ', 'utf8');

    await expect(
      learn({
        vaultRoot,
        retriever: makeRetriever(vaultRoot),
        titulo: 'Alvo',
        ...insightRust,
        dominio: 'node_modules',
        tags: ['rust'],
        confirmNovoDominio: true,
        now: NOW,
      }),
    ).rejects.toThrow(/node_modules/);

    expect(await fs.readFile(path.join(vaultRoot, rel), 'utf8')).toBe('   ');
  });

  it('não destrói um symlink em branco no caminho da nota', async () => {
    // The blankness of a symlink is the TARGET's, and acting on it acts on the LINK: a user's
    // alias into a shared store is not a placeholder this module may stand on. It is classified
    // as a note, the append is refused by the escape guard, and the learning takes a free name.
    const fora = path.join(path.dirname(vaultRoot), 'alias-alvo.md');
    await fs.writeFile(fora, '\n', 'utf8');
    const link = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await fs.symlink(fora, link);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(fora, 'utf8')).toBe('\n');
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
  });

  it('não deixa o nome de um arquivo do vault forjar uma linha no aviso', async () => {
    // The scanner applies no filter to note names, so a file called `cache\nWARNING: ....md` is a
    // name the index can hand back - and `decision.reason` quotes it into the title-collision
    // warning, which `joinWarnings` does not fold.
    const nome = '02-wiki/patterns/cache\nWARNING: nada de anormal aconteceu.md';
    const retriever = {
      search: () => ({ results: [scored(nome, 10, ['cache'])] }),
    } as unknown as Retriever;

    const result = await learn({
      vaultRoot,
      retriever,
      titulo: 'Cache Wrapper',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    expect(result.path).toBe(CACHE_WRAPPER);
    expect(result.warning).toBeDefined();
    expect(result.warning).not.toContain('\n');
    expect(result.reason).not.toContain('\n');
  });

  it('preserva uma nota acima do teto de leitura no caminho do título', async () => {
    // Past the total ceiling the classifier answers `note` WITHOUT reading, so the answer must be
    // the safe one: a 1.2 MiB note is never a placeholder, and writing over it would be a
    // create-or-replace onto real content the probe deliberately did not look at.
    const alvo = '02-wiki/patterns/cache-wrapper-ttl.md';
    const original = `---\ntipo: wiki\ntags: [cache]\n---\n\n# Cache Wrapper TTL\n\n${'palavra '.repeat(160_000)}\n`;
    expect(original.length).toBeGreaterThan(1024 * 1024);
    await fs.writeFile(path.join(vaultRoot, alvo), original, 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe(alvo);
    expect((await read(vaultRoot, alvo)).startsWith(original.trimEnd())).toBe(true);
  });

  it('trata como placeholder um arquivo em branco com caractere multibyte na fronteira', async () => {
    // U+2028 is three bytes and whitespace, and here it straddles the 4096-byte chunk boundary.
    // Decoding each chunk on its own splits it into replacement characters, which are not
    // whitespace, and the file flips from placeholder to note on byte alignment alone.
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), `${' '.repeat(4095)}\u2028${' '.repeat(10)}`, 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe(stub);
    const nota = await read(vaultRoot, stub);
    expect(nota.split('\n')).toContain('# Cache Wrapper Ttl');
    expect(nota).toContain('## Contexto');
    expect(nota).toContain('TTL configuravel');
  });

  it('preserva uma nota maior que o limite de sondagem no caminho do título', async () => {
    // The probe reads a bounded prefix and answers `note` on the first non-blank byte. This pins
    // the DIRECTION that bound exists for: err towards occupied. Answering `blank` here would hand
    // an existing 5 KB note to a create-or-replace write.
    const alvo = '02-wiki/patterns/cache-wrapper-ttl.md';
    const original = `---\ntipo: wiki\ntags: [cache]\n---\n\n# Cache Wrapper TTL\n\n${'palavra '.repeat(700)}\n`;
    expect(original.length).toBeGreaterThan(4096);
    await fs.writeFile(path.join(vaultRoot, alvo), original, 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('appended');
    expect(result.path).toBe(alvo);
    const depois = await read(vaultRoot, alvo);
    expect(depois.startsWith(original.trimEnd())).toBe(true);
    expect(depois).toContain('TTL configuravel');
  });

  it('não escreve num diretório com nome de nota, e o deixa intacto', async () => {
    // A directory named `<slug>.md` is the reachable `foreign` state. Nothing may read it (the
    // read fails) and nothing may write over it (the rename fails), so the learning takes a free
    // name and the directory is left exactly as it was.
    const dir = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'dentro.txt'), 'conteudo do diretorio\n', 'utf8');

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(dir, 'dentro.txt'), 'utf8')).toBe('conteudo do diretorio\n');
  });

  // A symlink to a FIFO at THIS path is deliberately not a separate test: the classification it
  // would pin is the one the test below already pins, and it would pin it by HANGING the runner
  // instead of failing. The two FIFO cases that remain - a FIFO at the note's name, and a symlink
  // to a FIFO as the duplicate rule's target - each cover a route nothing else reaches.
  it('não renomeia por cima de um symlink para uma nota do vault', async () => {
    // `editNote`'s atomic rename lands ON the link, not through it: the alias becomes a regular
    // file holding a divergent copy, and the note it pointed at never receives the learning. A
    // link is not a note this module may edit - it names one that lives elsewhere.
    const real = '02-wiki/patterns/nota-real.md';
    const conteudoReal =
      '---\ntipo: wiki\ntags: [cache]\n---\n\n# Nota Real\n\nwrapper de cache redis com ttl\n';
    await fs.writeFile(path.join(vaultRoot, real), conteudoReal, 'utf8');
    const alias = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await fs.symlink(path.join(vaultRoot, real), alias);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await read(vaultRoot, real)).toBe(conteudoReal);
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
  });

  it('grava o aprendizado quando o caminho da nota é um laço de symlink', async () => {
    // Unreadable is not a reason to lose the insight. A loop, a link to a directory, a file the
    // process cannot open: none of them can take the text, and the free name below can.
    const a = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    const b = path.join(vaultRoot, '02-wiki/patterns/laco.md');
    await fs.symlink(b, a);
    await fs.symlink(a, b);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
    expect((await fs.lstat(a)).isSymbolicLink()).toBe(true);
  });

  it('não abre um FIFO no lugar do template quando um placeholder ocupa o caminho', async () => {
    // `_templates/wiki.md` is read with no classification at all on this route, and a FIFO
    // there left the promise pending for as long as the process lived — on the single thread
    // that serves every tool call, so every LATER call hung too and only SIGKILL recovered it.
    // The vault is a directory the user syncs; a named pipe in it is not exotic.
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), '   ', 'utf8');
    const template = path.join(vaultRoot, '_templates', 'wiki.md');
    await fs.rm(template);
    await execFileAsync('mkfifo', [template]);

    const { result, opened } = await withFifoWatch(template, () =>
      learn({
        vaultRoot,
        retriever: semResultados(),
        titulo: 'Cache Wrapper TTL',
        insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
        contexto: 'Revisando o wrapper de cache',
        dominio: 'patterns',
        tags: ['redis', 'cache'],
        now: NOW,
      }),
    );

    expect(opened).toBe(false);
    expect(result.path).toBe(stub);
    expect(result.warning).toContain('template ignorado: _templates/wiki.md');
    // The learning is never lost to a template problem: the body is what the user asked for.
    expect(await read(vaultRoot, stub)).toContain('TTL configuravel');
    expect((await fs.lstat(template)).isFIFO()).toBe(true);
  }, 30_000);

  it('não abre um FIFO no lugar do template quando o caminho da nota está livre', async () => {
    // The OTHER route to the same file: with the note's path free, `writeNote` is the one that
    // reads the skeleton. Both routes have to answer the same way, or the hang simply moves.
    const template = path.join(vaultRoot, '_templates', 'wiki.md');
    await fs.rm(template);
    await execFileAsync('mkfifo', [template]);

    const { result, opened } = await withFifoWatch(template, () =>
      learn({
        vaultRoot,
        retriever: semResultados(),
        titulo: 'Retry de worker BullMQ',
        insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
        contexto: 'Investigando a fila',
        dominio: 'nestjs',
        tags: ['bullmq'],
        now: NOW,
      }),
    );

    expect(opened).toBe(false);
    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/nestjs/retry-de-worker-bullmq.md');
    expect(result.warning).toContain('template ignorado: _templates/wiki.md');
    expect(await read(vaultRoot, result.path)).toContain('backoff exponencial');
    expect((await fs.lstat(template)).isFIFO()).toBe(true);
  }, 30_000);

  it('trata como placeholder um arquivo de espaços no limite do teto de leitura', async () => {
    // The blank direction of `MAX_BLANK_BYTES`. The `note` direction — a file ABOVE the ceiling
    // is never a placeholder — has a test; this is the other side of the same comparison, and
    // without it the ceiling can be moved down onto ordinary placeholders with the suite green.
    // A file EXACTLY at the ceiling is still probed, and a probe that finds only whitespace
    // says `blank`: the note is created with its skeleton, over the placeholder.
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), ' '.repeat(1024 * 1024), 'utf8');
    expect((await fs.stat(path.join(vaultRoot, stub))).size).toBe(1024 * 1024);

    const result = await learn({
      vaultRoot,
      retriever: semResultados(),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe(stub);

    const nota = await read(vaultRoot, stub);
    // Born with its skeleton, not appended to: an append runs neither `ensureFrontmatter` nor
    // `applyTemplate`, so the note would carry `{}` for frontmatter and no `# H1` at all.
    expect(nota).toContain('# Cache Wrapper Ttl');
    expect(nota).toContain('## Contexto');
    expect(nota).toContain('TTL configuravel');
    expect(nota).not.toContain(' '.repeat(64));
  }, 30_000);

  it('não perde o aprendizado quando o close do probe rejeita', async () => {
    // `pathState` closes its descriptor in a `finally` that shares the `try` with the `catch`
    // answering `note`, so a `close` that rejects escapes the classifier entirely. Neither call
    // site guards against a throw, and a raw EIO from a descriptor the probe had ALREADY
    // finished reading left `learn` with nothing written and the insight lost. Injected,
    // because no test can produce an EIO on demand.
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    await fs.writeFile(path.join(vaultRoot, stub), '   ', 'utf8');

    const realOpen = fs.open.bind(fs);
    let rejeitados = 0;
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (
      alvo: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode: Parameters<typeof fs.open>[2],
    ) => {
      const handle = await realOpen(alvo, flags, mode);
      // Only the read-only probe: `atomicWrite` opens with numeric flags and its own `close`
      // is the one that publishes the bytes.
      if (flags !== 'r') return handle;
      return {
        read: handle.read.bind(handle),
        close: async (): Promise<void> => {
          await handle.close();
          rejeitados += 1;
          throw Object.assign(new Error('EIO: erro de I/O no close'), { code: 'EIO' });
        },
      };
    }) as never);

    try {
      const result = await learn({
        vaultRoot,
        retriever: semResultados(),
        titulo: 'Cache Wrapper TTL',
        insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
        contexto: 'Revisando o wrapper de cache',
        dominio: 'patterns',
        tags: ['redis', 'cache'],
        now: NOW,
      });

      expect(result.path).toBe(stub);
      expect(await read(vaultRoot, stub)).toContain('TTL configuravel');
    } finally {
      spy.mockRestore();
    }

    // The fault was actually injected: without this the test passes on a probe that never ran.
    expect(rejeitados).toBeGreaterThan(0);
  }, 30_000);

  it('não anexa numa nota que é um HARD link para um arquivo fora do vault', async () => {
    // `lstat` cannot see a hard link — there is no "original" — so the target classified as an
    // ordinary note, the append READ it, and the secret went into the note, into the commit and
    // into the `diff` handed back to the caller. The file outside survives (`atomicWrite`'s
    // rename breaks the link), so it is a copy and a leak rather than corruption.
    const segredo = path.join(path.dirname(vaultRoot), 'segredo.txt');
    const conteudoSegredo = 'chave-secreta-nao-deve-vazar\n';
    await fs.writeFile(segredo, conteudoSegredo, 'utf8');
    const alvo = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await fs.link(segredo, alvo);

    const result = await learn({
      vaultRoot,
      retriever: semResultados(),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.action).toBe('created');
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(result.diff).not.toContain('chave-secreta');
    expect(result.warning).toContain('não é uma nota');
    // Neither name was touched, and the note went somewhere else.
    expect(await fs.readFile(segredo, 'utf8')).toBe(conteudoSegredo);
    expect(await fs.readFile(alvo, 'utf8')).toBe(conteudoSegredo);
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
    const commit = await git(vaultRoot, ['show', '--format=%B', '-s']);
    expect(commit).not.toContain('chave-secreta');
  }, 30_000);

  it('não abre um FIFO no caminho da nota', async () => {
    // Reading a FIFO never returns. On a single-threaded stdio server that is the whole process,
    // and the path merely LOOKS like a note - so nothing may open it, neither to judge whether it
    // is blank nor to append to it.
    const fifo = path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-ttl.md');
    await execFileAsync('mkfifo', [fifo]);

    const result = await learn({
      vaultRoot,
      retriever: makeRetriever(vaultRoot),
      titulo: 'Cache Wrapper TTL',
      insight: 'Wrapper de cache redis wrapper de cache com TTL configuravel',
      contexto: 'Revisando o wrapper de cache',
      dominio: 'patterns',
      tags: ['redis', 'cache'],
      now: NOW,
    });

    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, result.path)).toContain('TTL configuravel');
    expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
  }, 15_000);
});
