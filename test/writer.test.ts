import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeNote, editNote, EditError } from '../src/write/writer.js';
import { atomicWrite } from '../src/write/atomic.js';
import { unifiedDiff } from '../src/write/diff.js';
import { PathGuardError } from '../src/write/paths.js';
import { TemplateError, formatLocal } from '../src/write/template.js';

const execFileAsync = promisify(execFile);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

/** Runs a git command in `repoRoot`, returning trimmed stdout. */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

async function countCommits(repoRoot: string): Promise<number> {
  const out = await git(repoRoot, ['rev-list', '--count', 'HEAD']);
  return Number(out);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway copy of `test/fixtures/vault` in `os.tmpdir()`. The fixture itself is
 * read-only shared state across parallel test files, so every write test gets its own
 * copy and never touches the original.
 */
async function makeVault(): Promise<{ tmp: string; vaultRoot: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-writer-test-'));
  const vaultRoot = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultRoot, { recursive: true });
  return { tmp, vaultRoot };
}

async function initRepo(vaultRoot: string): Promise<void> {
  await git(vaultRoot, ['init']);
  await git(vaultRoot, ['config', 'user.name', 'Vault MCP Test']);
  await git(vaultRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
  await git(vaultRoot, ['add', '--all']);
  await git(vaultRoot, ['commit', '-m', 'chore: fixture inicial']);
}

describe('unifiedDiff', () => {
  it('returns an empty string when nothing changed', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'nota.md')).toBe('');
  });

  it('renders a new file against /dev/null with every line added', () => {
    const diff = unifiedDiff('', 'uma\nduas\n', '02-wiki/nova.md');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/02-wiki/nova.md');
    expect(diff).toContain('@@ -0,0 +1,2 @@');
    expect(diff).toContain('+uma');
    expect(diff).toContain('+duas');
    expect(diff).not.toContain('-uma');
  });

  it('gives three lines of context around a single changed line', () => {
    const before = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n') + '\n';
    const after = before.replace('l5', 'CINCO');
    const diff = unifiedDiff(before, after, 'nota.md');
    const body = diff.split('\n').slice(2); // drop the two file headers

    expect(body[0]).toBe('@@ -2,7 +2,7 @@');
    expect(body.slice(1)).toEqual([
      ' l2',
      ' l3',
      ' l4',
      '-l5',
      '+CINCO',
      ' l6',
      ' l7',
      ' l8',
      '',
    ]);
    // `l1` and `l9` are four lines away from the change: outside the context window.
    expect(diff).not.toContain(' l1');
    expect(diff).not.toContain(' l9');
  });

  it('renders a deletion and an addition in the same hunk', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nc\nd\n', 'nota.md');
    expect(diff).toContain('-b');
    expect(diff).toContain('+d');
    expect(diff).toContain(' a');
    expect(diff).toContain(' c');
  });

  it('emits separate hunks for changes far apart', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l2\n', 'DOIS\n').replace('l30\n', 'TRINTA\n');
    const diff = unifiedDiff(before, after, 'nota.md');
    const headers = diff.split('\n').filter((l) => l.startsWith('@@'));
    expect(headers).toHaveLength(2);
  });

  it('marks a missing trailing newline', () => {
    const diff = unifiedDiff('a\n', 'a', 'nota.md');
    expect(diff).toContain('\\ No newline at end of file');
  });

  it('handles a file emptied completely', () => {
    const diff = unifiedDiff('a\nb\n', '', 'nota.md');
    expect(diff).toContain('@@ -1,2 +0,0 @@');
    expect(diff).toContain('-a');
    expect(diff).toContain('-b');
  });

  it('stays linear enough to diff two thousand-line files that share nothing', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `antes ${i}`).join('\n') + '\n';
    const after = Array.from({ length: 1000 }, (_, i) => `depois ${i}`).join('\n') + '\n';
    const started = Date.now();
    const diff = unifiedDiff(before, after, 'nota.md');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(diff).toContain('-antes 0');
    expect(diff).toContain('+depois 0');
  });
});

describe('atomicWrite', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-atomic-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates the parent directory when it is missing', async () => {
    const target = path.join(tmp, 'a', 'b', 'c.md');
    await atomicWrite(target, 'conteudo\n');
    expect(await fs.readFile(target, 'utf8')).toBe('conteudo\n');
  });

  it('leaves no temporary file behind', async () => {
    const target = path.join(tmp, 'nota.md');
    await atomicWrite(target, 'x\n');
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual(['nota.md']);
  });

  it('replaces existing content rather than appending to it', async () => {
    const target = path.join(tmp, 'nota.md');
    await atomicWrite(target, 'primeiro\n');
    await atomicWrite(target, 'segundo\n');
    expect(await fs.readFile(target, 'utf8')).toBe('segundo\n');
  });
});

describe('writeNote', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    ({ tmp, vaultRoot } = await makeVault());
    await initRepo(vaultRoot);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates the note, resolves every template token, and makes one commit', async () => {
    const before = await countCommits(vaultRoot);

    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/patterns/cache-wrapper-novo.md',
      content: 'Um wrapper de cache com TTL.',
      tipo: 'wiki',
    });

    expect(result.created).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.path).toBe('02-wiki/patterns/cache-wrapper-novo.md');
    expect(result.absPath).toBe(path.join(vaultRoot, '02-wiki/patterns/cache-wrapper-novo.md'));

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).not.toContain('<%');
    expect(onDisk).toContain('# Cache Wrapper Novo');
    expect(onDisk).toContain('## Contexto');
    expect(onDisk).toContain('Um wrapper de cache com TTL.');
    expect(onDisk).toContain(`criado: ${formatLocal(new Date(), 'YYYY-MM-DD')}`);

    expect(await countCommits(vaultRoot)).toBe(before + 1);
    const names = await git(vaultRoot, ['show', '--name-only', '--pretty=format:']);
    expect(names).toContain('02-wiki/patterns/cache-wrapper-novo.md');

    expect(result.diff).toContain('--- /dev/null');
    expect(result.diff).toContain('+# Cache Wrapper Novo');
  });

  it("applies _templates/projeto.md when tipo is 'projeto'", async () => {
    const result = await writeNote({
      vaultRoot,
      path: '03-projects/novo-projeto.md',
      content: 'Descrição do projeto.',
      tipo: 'projeto',
    });

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).not.toContain('<%');
    expect(onDisk).toContain('tipo: projeto');
    expect(onDisk).toContain('status: ativo');
    expect(onDisk).toContain('# Novo Projeto');
    expect(onDisk).toContain('## Objetivo');
    expect(onDisk).toContain('## Stack');
    expect(onDisk).toContain('## Links');
    expect(onDisk).toContain('Descrição do projeto.');
    // The body goes above the first section heading, matching how the vault's own
    // notes are shaped, not appended under `## Links`.
    expect(onDisk.indexOf('Descrição do projeto.')).toBeLessThan(onDisk.indexOf('## Objetivo'));
  });

  it('does not apply a template to a note that already exists', async () => {
    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/nestjs/auth-guard.md',
      content: 'Texto totalmente novo.',
      tipo: 'wiki',
    });

    expect(result.created).toBe(false);
    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('Texto totalmente novo.');
    expect(onDisk).not.toContain('## Contexto');
    expect(onDisk).toContain('tipo: wiki');
  });

  it('does not apply a template when tipo is neither wiki nor projeto', async () => {
    const result = await writeNote({
      vaultRoot,
      path: '01-raw/inbox/captura.md',
      content: 'Só um recorte.',
      tipo: 'clipping',
    });

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('tipo: clipping');
    expect(onDisk).toContain('Só um recorte.');
    expect(onDisk).not.toContain('## Contexto');
  });

  it('inserts model content AFTER applyTemplate has run over the skeleton', async () => {
    // A Templater-looking token arriving through `content` must never reach the token
    // scanner: it is not part of the template. Order is the whole point.
    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/patterns/sintaxe.md',
      content: 'A sintaxe <% tp.desconhecido %> do Templater é assim.',
      tipo: 'wiki',
    });

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('<% tp.desconhecido %>');
    expect(onDisk).not.toContain('<% tp.file.title %>');
    expect(onDisk).toContain('# Sintaxe');
  });

  it('propagates TemplateError when the TEMPLATE itself carries an unresolved token', async () => {
    await fs.writeFile(
      path.join(vaultRoot, '_templates', 'wiki.md'),
      '---\ntipo: wiki\n---\n\n<%*\nconst t = tp.file.title\n%>\n',
      'utf8'
    );

    const abs = path.join(vaultRoot, '02-wiki/patterns/quebra.md');
    await expect(
      writeNote({ vaultRoot, path: '02-wiki/patterns/quebra.md', content: 'x', tipo: 'wiki' })
    ).rejects.toBeInstanceOf(TemplateError);
    expect(await exists(abs)).toBe(false);
  });

  it('rejects a denied prefix with PathGuardError and writes nothing', async () => {
    const abs = path.join(vaultRoot, '99-archive', 'x.md');
    await expect(
      writeNote({ vaultRoot, path: '99-archive/x.md', content: 'nao', tipo: 'wiki' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(abs)).toBe(false);
  });

  it('rejects _templates/ with PathGuardError', async () => {
    const before = await fs.readFile(path.join(vaultRoot, '_templates', 'wiki.md'), 'utf8');
    await expect(
      writeNote({ vaultRoot, path: '_templates/wiki.md', content: 'nao', tipo: 'wiki' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await fs.readFile(path.join(vaultRoot, '_templates', 'wiki.md'), 'utf8')).toBe(before);
  });

  it('rejects path traversal with PathGuardError and writes nothing', async () => {
    const escaped = path.join(tmp, 'fora.md');
    await expect(
      writeNote({ vaultRoot, path: '../fora.md', content: 'nao', tipo: 'wiki' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(escaped)).toBe(false);
  });

  it('rejects a glob metacharacter with PathGuardError', async () => {
    await expect(
      writeNote({ vaultRoot, path: '02-wiki/*.md', content: 'nao' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('rejects a non-markdown path with PathGuardError', async () => {
    await expect(
      writeNote({ vaultRoot, path: '02-wiki/nota.txt', content: 'nao' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(vaultRoot, '02-wiki', 'nota.txt'))).toBe(false);
  });

  it('rejects a path that escapes the vault through a symlink', async () => {
    const outside = path.join(tmp, 'fora');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(vaultRoot, '02-wiki', 'atalho'), 'dir');

    await expect(
      writeNote({ vaultRoot, path: '02-wiki/atalho/vazado.md', content: 'nao' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(outside, 'vazado.md'))).toBe(false);
  });

  it('keeps the file on disk with a warning when git fails', async () => {
    const { tmp: bare, vaultRoot: noRepo } = await makeVault();
    try {
      const result = await writeNote({
        vaultRoot: noRepo,
        path: '02-wiki/patterns/sem-git.md',
        content: 'Escrito mesmo sem git.',
        tipo: 'wiki',
      });

      expect(result.committed).toBe(false);
      expect(result.warning).toBeTruthy();
      expect(await fs.readFile(result.absPath, 'utf8')).toContain('Escrito mesmo sem git.');
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('writes without committing when deferCommit is set', async () => {
    const before = await countCommits(vaultRoot);

    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/patterns/adiado.md',
      content: 'Adiado.',
      tipo: 'wiki',
      deferCommit: true,
    });

    expect(result.committed).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(await fs.readFile(result.absPath, 'utf8')).toContain('Adiado.');
    expect(await countCommits(vaultRoot)).toBe(before);
  });

  it('lets a caller batch several deferred writes into ONE commit via absPath', async () => {
    const before = await countCommits(vaultRoot);
    const { commitFiles } = await import('../src/write/git.js');

    const a = await writeNote({
      vaultRoot,
      path: '02-wiki/patterns/lote-a.md',
      content: 'A',
      deferCommit: true,
    });
    const b = await writeNote({
      vaultRoot,
      path: '02-wiki/patterns/lote-b.md',
      content: 'B',
      deferCommit: true,
    });

    const commit = await commitFiles(vaultRoot, [a.absPath, b.absPath], 'docs(vault): lote');
    expect(commit.committed).toBe(true);
    expect(await countCommits(vaultRoot)).toBe(before + 1);

    const names = await git(vaultRoot, ['show', '--name-only', '--pretty=format:']);
    expect(names.split('\n').filter(Boolean).sort()).toEqual([
      '02-wiki/patterns/lote-a.md',
      '02-wiki/patterns/lote-b.md',
    ]);
  });

  it('merges caller frontmatter without discarding what the note already had', async () => {
    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/nestjs/auth-guard.md',
      content: await fs.readFile(path.join(vaultRoot, '02-wiki/nestjs/auth-guard.md'), 'utf8'),
      frontmatter: { status: 'revisado' },
    });

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('tags: [nestjs, auth, jwt]');
    expect(onDisk).toContain('criado: 2026-01-10');
    expect(onDisk).toContain('status: revisado');
  });

  it('warns — rather than writing silently — when ensureFrontmatter REFUSES a key', async () => {
    // An explicit-key block (`? tipo` / `: `) is a shape `ensureFrontmatter` declines to
    // edit: it returns the content with `tipo` still unfilled. The caller cannot see that
    // from the return value alone, so `writeNote` re-reads its own output and says so.
    const result = await writeNote({
      vaultRoot,
      path: '01-raw/inbox/dificil.md',
      content: '---\n? tipo\n: \n---\n\ncorpo preservado\n',
      tipo: 'nota',
    });

    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain('tipo');

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('corpo preservado');
    expect(onDisk).not.toContain('tipo: nota');
  });

  it('reports no frontmatter warning on an ordinary note', async () => {
    const result = await writeNote({
      vaultRoot,
      path: '01-raw/inbox/normal.md',
      content: 'texto simples\n',
      tipo: 'nota',
    });
    expect(result.warning).toBeUndefined();
    expect(await fs.readFile(result.absPath, 'utf8')).toContain('tipo: nota');
  });
});

describe('editNote', () => {
  let tmp: string;
  let vaultRoot: string;
  const target = '02-wiki/nestjs/auth-guard.md';

  beforeEach(async () => {
    ({ tmp, vaultRoot } = await makeVault());
    await initRepo(vaultRoot);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('replaces the single occurrence, commits, and reports the diff', async () => {
    const before = await countCommits(vaultRoot);

    const result = await editNote({
      vaultRoot,
      path: target,
      oldText: 'um mecanismo central de autenticação',
      newText: 'um mecanismo central de autenticação e auditoria',
    });

    expect(result.created).toBe(false);
    expect(result.committed).toBe(true);
    expect(result.warning).toBeUndefined();

    const onDisk = await fs.readFile(result.absPath, 'utf8');
    expect(onDisk).toContain('autenticação e auditoria');
    expect(await countCommits(vaultRoot)).toBe(before + 1);

    expect(result.diff).toContain(`--- a/${target}`);
    expect(result.diff).toContain('+++ b/' + target);
    expect(result.diff).toContain('+A API precisava de um mecanismo central de autenticação e auditoria');
  });

  it('writes without committing when deferCommit is set', async () => {
    const before = await countCommits(vaultRoot);

    const result = await editNote({
      vaultRoot,
      path: target,
      oldText: 'AuthGuard',
      newText: 'GuardaDeAutenticacao',
      deferCommit: true,
    });

    expect(result.committed).toBe(false);
    expect(await fs.readFile(result.absPath, 'utf8')).toContain('GuardaDeAutenticacao');
    expect(await countCommits(vaultRoot)).toBe(before);
  });

  it('throws EditError naming the file when the text is absent, and writes NOTHING', async () => {
    const abs = path.join(vaultRoot, target);
    const before = await fs.readFile(abs, 'utf8');
    const beforeStat = await fs.stat(abs);

    await expect(
      editNote({ vaultRoot, path: target, oldText: 'nao existe aqui', newText: 'x' })
    ).rejects.toThrow(new RegExp(`trecho não encontrado em ${target.replace(/[/.]/g, '\\$&')}`));

    expect(await fs.readFile(abs, 'utf8')).toBe(before);
    expect((await fs.stat(abs)).mtimeMs).toBe(beforeStat.mtimeMs);
    const dirEntries = await fs.readdir(path.dirname(abs));
    expect(dirEntries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('throws EditError of type EditError when the text is absent', async () => {
    await expect(
      editNote({ vaultRoot, path: target, oldText: 'nao existe aqui', newText: 'x' })
    ).rejects.toBeInstanceOf(EditError);
  });

  it('throws EditError citing the count when the text is ambiguous, and writes NOTHING', async () => {
    const rel = '01-raw/inbox/ambiguo.md';
    const abs = path.join(vaultRoot, rel);
    await fs.writeFile(abs, 'alfa\nrepetido\nbeta\nrepetido\ngama\n', 'utf8');
    const before = await fs.readFile(abs, 'utf8');

    await expect(
      editNote({ vaultRoot, path: rel, oldText: 'repetido', newText: 'x' })
    ).rejects.toThrow(/trecho ambíguo em 01-raw\/inbox\/ambiguo\.md: 2 ocorrências/);

    expect(await fs.readFile(abs, 'utf8')).toBe(before);
  });

  it('counts three occurrences as three', async () => {
    const rel = '01-raw/inbox/tres.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'x\nx\nx\n', 'utf8');
    await expect(
      editNote({ vaultRoot, path: rel, oldText: 'x', newText: 'y' })
    ).rejects.toThrow(/3 ocorrências/);
  });

  it('refuses an empty oldText rather than matching everywhere', async () => {
    const abs = path.join(vaultRoot, target);
    const before = await fs.readFile(abs, 'utf8');
    await expect(
      editNote({ vaultRoot, path: target, oldText: '', newText: 'x' })
    ).rejects.toBeInstanceOf(EditError);
    expect(await fs.readFile(abs, 'utf8')).toBe(before);
  });

  it('counts overlapping occurrences without looping forever', async () => {
    const rel = '01-raw/inbox/aaa.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'aaaa\n', 'utf8');
    await expect(
      editNote({ vaultRoot, path: rel, oldText: 'aa', newText: 'b' })
    ).rejects.toThrow(/ocorrências/);
  });

  it('rejects a denied prefix before reading anything', async () => {
    await expect(
      editNote({ vaultRoot, path: '99-archive/antigo.md', oldText: 'a', newText: 'b' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('rejects path traversal', async () => {
    await expect(
      editNote({ vaultRoot, path: '../fora.md', oldText: 'a', newText: 'b' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('keeps the edit on disk with a warning when git fails', async () => {
    const { tmp: bare, vaultRoot: noRepo } = await makeVault();
    try {
      const result = await editNote({
        vaultRoot: noRepo,
        path: target,
        oldText: 'AuthGuard',
        newText: 'GuardaSemGit',
      });
      expect(result.committed).toBe(false);
      expect(result.warning).toBeTruthy();
      expect(await fs.readFile(result.absPath, 'utf8')).toContain('GuardaSemGit');
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
