import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
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
    await git(vaultRoot, ['add', '-A']);
    await git(vaultRoot, ['commit', '-m', 'chore: vault inicial']);
  }
  return vaultRoot;
}

function makeRetriever(vaultRoot: string): Retriever {
  return new Retriever({ scanner: new VaultScanner({ vaultRoot }) });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
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
      await fs.rm(path.dirname(noRepo), { recursive: true, force: true });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
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
    await fs.rm(path.dirname(vaultRoot), { recursive: true, force: true });
  });

  it('cria nota nova quando a anexação é impossível, em vez de derrubar a chamada', async () => {
    // An empty stub note - Obsidian makes these - is a target `editNote` cannot anchor to: it
    // refuses an empty `oldText`. Before the fallback this threw and the insight was lost.
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

    expect(result.action).toBe('created');
    // NOT over the stub: `writeNote` is create-OR-REPLACE, so an occupied path is never handed to
    // it. A free name keeps both files.
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md');
    expect(await read(vaultRoot, stub)).toBe('');
    expect(result.warning).toContain(stub);
    expect(result.committed).toBe(true);

    const nota = await read(vaultRoot, result.path);
    expect(nota).toContain('TTL configuravel');
    // A genuinely new file, so the `_templates/wiki.md` skeleton applies - which `writeNote`
    // skips for any path that already exists, a zero-byte stub included.
    expect(nota).toContain('## Contexto');
    expect(nota).toContain('## Solução');
    expect(nota).toContain('## Exemplo');
    expect(nota.split('\n').some((l) => l.startsWith('# '))).toBe(true);

    // The MOC and the daily point at the file that exists, not at the name the call started from.
    expect(await read(vaultRoot, '02-wiki/patterns/patterns-moc.md')).toContain(
      '- [[cache-wrapper-ttl-2026-08-20]] —',
    );
    expect(await read(vaultRoot, DAILY_REL)).toContain('[[cache-wrapper-ttl-2026-08-20]]');
  });

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

  it('deixa vazar uma falha de anexação que não é "este alvo não aceita o texto"', async () => {
    // The fallback must not swallow real faults: only the write guard refusing the path, an edit
    // with nothing to anchor to, and a file that vanished are recoverable. A directory where the
    // note should be is none of those - `readFile` fails with EISDIR - and silently writing a new
    // note there would hide a broken vault.
    //
    // The retriever is a stub because the real one CANNOT produce this state: the scanner never
    // indexes a directory as a note, so nothing else can route an append onto one.
    const pasta = '02-wiki/nestjs/pasta.md';
    await fs.mkdir(path.join(vaultRoot, pasta));
    const retriever = {
      search: () => ({ results: [scored(pasta, 10, ['bullmq'])] }),
    } as unknown as Retriever;

    await expect(
      learn({
        vaultRoot,
        retriever,
        titulo: 'Retry de worker BullMQ',
        insight: 'O worker BullMQ aplica retry com backoff exponencial na fila',
        contexto: 'Investigando a fila',
        dominio: 'nestjs',
        tags: ['bullmq'],
        now: NOW,
      }),
    ).rejects.toThrow(/EISDIR/);

    // Nothing was written and nothing was committed.
    expect(await exists(path.join(vaultRoot, '02-wiki/nestjs/retry-de-worker-bullmq.md'))).toBe(
      false,
    );
    expect(await logLines(vaultRoot)).toBe(1);
  });

  it('procura o próximo nome livre quando o nome com data também está ocupado', async () => {
    const stub = '02-wiki/patterns/cache-wrapper-ttl.md';
    const datado = '02-wiki/patterns/cache-wrapper-ttl-2026-08-20.md';
    await fs.writeFile(path.join(vaultRoot, stub), '', 'utf8');
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
    // Neither occupied file was written over.
    expect(await read(vaultRoot, stub)).toBe('');
    expect(await read(vaultRoot, datado)).toBe('conteudo anterior sem relacao\n');
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
