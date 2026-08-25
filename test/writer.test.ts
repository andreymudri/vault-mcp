import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { constants as fsConstants, promises as fs } from 'node:fs';
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
    // The text alone cannot tell "no template was looked for" from "a template was looked
    // for and the read failed": `_templates/clipping.md` does not exist, so both leave the
    // content untouched. The warning is the only observable that separates them, and
    // without this assertion adding `clipping` to TEMPLATED_TIPOS passes the test.
    expect(result.warning).toBeUndefined();
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

describe('unifiedDiff hardening', () => {
  it('keeps each diff header on exactly one line whatever the path contains', () => {
    // `resolveWritePath` never let a control character through, but `unifiedDiff` is
    // exported and the header must be structurally safe on its own terms: a path that
    // embeds newlines must not be able to add header or hunk lines.
    const forged = 'nota.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-real\n+forjado';
    const diff = unifiedDiff('antes\n', 'depois\n', forged);
    const lines = diff.split('\n');

    expect(lines.filter((l) => l.startsWith('--- '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('+++ '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('@@'))).toHaveLength(1);
    expect(lines).not.toContain('+++ b/CLAUDE.md');
    expect(lines).not.toContain('+forjado');
  });

  it('escapes a carriage return in the path instead of splitting the header', () => {
    const diff = unifiedDiff('antes\n', 'depois\n', 'nota\r\n.md');
    const lines = diff.split('\n');
    expect(lines.filter((l) => l.startsWith('--- '))).toHaveLength(1);
    expect(lines[0]).toBe('--- a/nota\\r\\n.md');
  });

  it('falls back to a coarse summary instead of diffing a huge input', () => {
    // The reviewer's probe: a 6.5 MB note replaced by a few bytes drove the Myers trace
    // to ~5 GB of external typed-array memory and 4.4 s of blocked event loop.
    const before = `${'x'.repeat(7 * 1024 * 1024)}\n`;
    const after = 'y\n';
    const started = Date.now();
    const diff = unifiedDiff(before, after, 'nota.md');

    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff).toContain('--- a/nota.md');
    expect(diff).toContain('diff omitido');
    expect(diff).toContain('1 linha removida');
    expect(diff).toContain('1 linha adicionada');
  });

  it('reports only the region that changed when the input is too large to diff', () => {
    // Counting whole files here made the summary useless: a one-word fix in a multi-MB
    // note reported every line of it as removed and re-added. The counts have to describe
    // the edit, not the file, or the fallback tells the user nothing they did not know.
    const filler = 'x'.repeat(3 * 1024 * 1024);
    const before = `cabecalho\n${filler}\nMARCADOR\nrodape\n`;
    const after = `cabecalho\n${filler}\nTROCADO\nrodape\n`;

    const diff = unifiedDiff(before, after, 'nota.md');

    expect(diff).toContain('diff omitido');
    expect(diff).toContain('1 linha removida');
    expect(diff).toContain('1 linha adicionada');
  });

  it('counts a truncated last line as a line on both sides', () => {
    // The character trim leaves `DEF\n` against NOTHING: the shared prefix runs to `abc`,
    // mid-line, and the shared suffix is empty. Taken raw that is "1 linha removida, 0
    // linhas adicionadas" — but `abc` is still there, on a line that was rewritten rather
    // than deleted. Snapping the start back to the line boundary is what says so.
    const filler = 'x'.repeat(3 * 1024 * 1024);
    const before = `${filler}\nabcDEF\n`;
    const after = `${filler}\nabc`;

    const diff = unifiedDiff(before, after, 'nota.md');

    expect(diff).toContain('1 linha removida');
    expect(diff).toContain('1 linha adicionada');
  });

  it('counts text prepended to the first line as a line on both sides', () => {
    // The mirror image, pinning the other snap. The shared prefix is empty (the texts
    // differ at character 0) and the shared suffix runs back to `DEF`, mid-line, so the
    // raw span is nothing against `abc`: "0 linhas removidas, 1 linha adicionada" for an
    // edit that rewrote one line into one line.
    const filler = 'x'.repeat(3 * 1024 * 1024);
    const before = `DEF\n${filler}\n`;
    const after = `abcDEF\n${filler}\n`;

    const diff = unifiedDiff(before, after, 'nota.md');

    expect(diff).toContain('1 linha removida');
    expect(diff).toContain('1 linha adicionada');
  });

  /**
   * `alternating(n)` changes every even-numbered line of an `n`-line note, so the edit
   * distance is exactly `n` and the odd-numbered lines are shared. A MINIMAL diff keeps
   * those as context lines (` linha 1`); the coarse fallback deletes and re-adds every
   * line (`-linha 1`). That difference is what the two tests below read, and it is
   * asserted on whole lines rather than with `toContain`, because `-linha 1` is a
   * substring of `-linha 10` — which is how the draft version of this test passed on a
   * fallback it believed was minimal.
   */
  function alternating(n: number): { before: string; after: string } {
    return {
      before: `${Array.from({ length: n }, (_, i) => `linha ${i}`).join('\n')}\n`,
      after: `${Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? `alterada ${i}` : `linha ${i}`
      ).join('\n')}\n`,
    };
  }

  it('produces a minimal diff just below the search budget', () => {
    // D = 1200. MAX_TRACE_BYTES of 8 MB is reached at D ≈ 1445, so this must complete the
    // Myers search; shrinking the budget makes it fall back and fails here.
    const { before, after } = alternating(1200);
    const lines = unifiedDiff(before, after, 'nota.md').split('\n');

    expect(lines).toContain(' linha 1');
    expect(lines).not.toContain('-linha 1');
  });

  it('falls back past the search budget instead of stalling', () => {
    // D = 1800, past the same budget. Raising or removing it lets this search run to
    // completion, the shared lines come back as context, and this fails.
    const { before, after } = alternating(1800);
    const started = Date.now();
    const lines = unifiedDiff(before, after, 'nota.md').split('\n');

    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines).toContain('-linha 1');
    expect(lines).toContain('+linha 1');
    expect(lines).not.toContain(' linha 1');
  });
});

describe('atomicWrite guarantees', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-atomic-guarantee-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * Runs `atomicWrite` while recording how it reached the filesystem: which path it
   * opened, with which flags, and the order of `sync`/`rename`. Those are exactly the
   * properties that make the write atomic and durable, and none of them shows up in the
   * resulting file, so nothing but a spy can pin them.
   */
  async function recordAtomicWrite(
    target: string,
    text: string
  ): Promise<{ openedPath: string; openedFlags: number | undefined; events: string[] }> {
    const events: string[] = [];
    let openedPath = '';
    let openedFlags: number | undefined;

    const realOpen = fs.open.bind(fs);
    const realRename = fs.rename.bind(fs);

    vi.spyOn(fs, 'open').mockImplementation((async (p: never, flags: never, mode: never) => {
      openedPath = String(p);
      openedFlags = typeof flags === 'number' ? flags : undefined;
      const handle = await realOpen(p, flags, mode);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push('sync');
        return realSync();
      };
      return handle;
    }) as never);

    vi.spyOn(fs, 'rename').mockImplementation((async (from: never, to: never) => {
      events.push('rename');
      return realRename(from, to);
    }) as never);

    try {
      await atomicWrite(target, text);
    } finally {
      vi.restoreAllMocks();
    }

    return { openedPath, openedFlags, events };
  }

  it('writes its temporary file in the target directory, not the system temp dir', async () => {
    const target = path.join(tmp, 'sub', 'nota.md');
    const { openedPath } = await recordAtomicWrite(target, 'conteudo\n');

    // A temp file in os.tmpdir() also makes the rename cross-device (EXDEV) for anyone
    // whose vault is not on the same filesystem as /tmp.
    expect(path.dirname(openedPath)).toBe(path.dirname(target));
    expect(await fs.readFile(target, 'utf8')).toBe('conteudo\n');
  });

  it('creates the temporary file exclusively, so it cannot adopt a planted symlink', async () => {
    const target = path.join(tmp, 'nota.md');
    const { openedFlags } = await recordAtomicWrite(target, 'conteudo\n');

    expect(typeof openedFlags).toBe('number');
    expect(openedFlags! & fsConstants.O_EXCL).toBe(fsConstants.O_EXCL);
    expect(openedFlags! & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
  });

  it('flushes the data to disk before the rename publishes it', async () => {
    const target = path.join(tmp, 'nota.md');
    const { events } = await recordAtomicWrite(target, 'conteudo\n');

    expect(events).toEqual(['sync', 'rename']);
  });

  it('publishes exactly one of two concurrent writes, never a hybrid', async () => {
    // MCP dispatches tool calls concurrently and `deferCommit` exists for a batch that
    // writes several files, so one process racing itself needs no attacker.
    const target = path.join(tmp, 'nota.md');
    const a = 'A'.repeat(200_000);
    const b = 'B'.repeat(200_000);

    await Promise.all([atomicWrite(target, a), atomicWrite(target, b)]);

    const onDisk = await fs.readFile(target, 'utf8');
    expect([a, b]).toContain(onDisk);
    expect(await fs.readdir(tmp)).toEqual(['nota.md']);
  });

  it('keeps the mode of the note it replaces', async () => {
    const target = path.join(tmp, 'segredo.md');
    await atomicWrite(target, 'v1\n');
    await fs.chmod(target, 0o600);

    await atomicWrite(target, 'v2\n');

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('v2\n');
  });

  it('leaves a new note writable at the ordinary default mode', async () => {
    const target = path.join(tmp, 'nova.md');
    await atomicWrite(target, 'v1\n');

    expect((await fs.stat(target)).mode & 0o200).toBe(0o200);
  });
});

describe('write guard', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    ({ tmp, vaultRoot } = await makeVault());
    await initRepo(vaultRoot);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('refuses to write inside .git', async () => {
    await expect(
      writeNote({ vaultRoot, path: '.git/refs/heads/pwn.md', content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(vaultRoot, '.git', 'refs', 'heads', 'pwn.md'))).toBe(false);
  });

  it('refuses to write inside .obsidian', async () => {
    await expect(
      writeNote({ vaultRoot, path: '.obsidian/plugins/p/main.md', content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(vaultRoot, '.obsidian', 'plugins', 'p', 'main.md'))).toBe(false);
  });

  it('refuses a dot-directory nested deeper in the path', async () => {
    await expect(
      writeNote({ vaultRoot, path: '02-wiki/.git/pwn.md', content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('matches the dot-directory by segment, not by prefix', async () => {
    // A directory merely NAMED `git` is an ordinary part of the vault, exactly as
    // `99-archive-notes/` stays legal beside the denied `99-archive/`.
    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/git/rebase-interativo.md',
      content: 'Notas sobre rebase.',
    });
    expect(result.created).toBe(true);
    expect(await exists(result.absPath)).toBe(true);
  });

  it.each([
    ['newline', '02-wiki/nota\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-a\n+b.md'],
    ['carriage return', '02-wiki/nota\r.md'],
    ['tab', '02-wiki/no\tta.md'],
    ['NUL', '02-wiki/no\u0000ta.md'],
    ['escape', '02-wiki/no\u001bta.md'],
  ])('refuses a path containing a %s', async (_label, relPath) => {
    await expect(writeNote({ vaultRoot, path: relPath, content: 'x' })).rejects.toBeInstanceOf(
      PathGuardError
    );
  });

  it('refuses an edit inside .git just as it refuses a write', async () => {
    await expect(
      editNote({ vaultRoot, path: '.git/config.md', oldText: 'a', newText: 'b' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });
});

describe('write ordering', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    ({ tmp, vaultRoot } = await makeVault());
    await initRepo(vaultRoot);
  });

  afterEach(async () => {
    vi.doUnmock('../src/write/diff.js');
    vi.resetModules();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * Forces `unifiedDiff` to throw, which is the only way to observe the order the write
   * path runs in — the diff is a pure function of two strings, so nothing about the file
   * on disk reveals whether it was computed before or after `atomicWrite`.
   */
  async function withFailingDiff(): Promise<typeof editNote> {
    vi.resetModules();
    vi.doMock('../src/write/diff.js', () => ({
      unifiedDiff: () => {
        throw new RangeError('Array buffer allocation failed');
      },
    }));
    const fresh = await import('../src/write/writer.js');
    return fresh.editNote;
  }

  it('computes the diff before it publishes the write', async () => {
    // The order is the structural half of the fix and it leaves no trace in the result:
    // `safeDiff` recovers either way, so a passing "it still writes and warns" test says
    // nothing about which ran first. Recording both calls is the only way to pin it, and
    // pin it is worth doing — with the diff computed first, "written but unreported" is
    // not a state this code can reach, rather than one it happens to avoid as long as
    // `unifiedDiff`'s own bounds hold.
    const rel = '02-wiki/patterns/ordem-observada.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'linha um\nMARCADOR\nlinha tres\n', 'utf8');

    const events: string[] = [];
    vi.resetModules();
    vi.doMock('../src/write/diff.js', () => ({
      unifiedDiff: () => {
        events.push('diff');
        return '--- a/x\n+++ b/x\n';
      },
    }));
    const { editNote: editNoteFresh } = await import('../src/write/writer.js');

    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation((async (from: never, to: never) => {
      events.push('rename');
      return realRename(from, to);
    }) as never);

    try {
      await editNoteFresh({ vaultRoot, path: rel, oldText: 'MARCADOR', newText: 'TROCADO' });
    } finally {
      vi.restoreAllMocks();
    }

    expect(events).toEqual(['diff', 'rename']);
  });

  it('still writes the note, and says so, when the diff cannot be produced', async () => {
    // The reviewer's probe left a 6.5 MB note replaced and UNREPORTED: the diff threw
    // after `atomicWrite` had published the replacement, so the call rejected while the
    // new content sat on disk. Computing the diff FIRST makes that state unreachable —
    // but a reporting failure must not cost the user their content either, so the throw
    // becomes a warning and the write goes ahead. Both bad outcomes are closed: the write
    // always happens, and the report never claims more than it knows.
    const rel = '02-wiki/patterns/ordem.md';
    const target = path.join(vaultRoot, rel);
    await fs.writeFile(target, 'linha um\nMARCADOR\nlinha tres\n', 'utf8');

    const editNoteFresh = await withFailingDiff();
    const result = await editNoteFresh({
      vaultRoot,
      path: rel,
      oldText: 'MARCADOR',
      newText: 'TROCADO',
    });

    expect(await fs.readFile(target, 'utf8')).toBe('linha um\nTROCADO\nlinha tres\n');
    expect(result.warning).toMatch(/diff/i);
    expect(result.diff).toContain('diff indisponível');
    // Under the old order the note was published and the caller got nothing at all.
    expect(result.diff).not.toBe('');
  });

  it('creates a new note and reports the failure rather than rejecting', async () => {
    // The `before === ''` branch of the same recovery: a note that does not exist yet is
    // rendered against /dev/null, and a diff failure there must not stop the note being
    // created — losing the content the caller asked to write to a reporting problem is
    // the larger of the two wrongs.
    vi.resetModules();
    vi.doMock('../src/write/diff.js', () => ({
      unifiedDiff: () => {
        throw new RangeError('Array buffer allocation failed');
      },
    }));
    const { writeNote: writeNoteFresh } = await import('../src/write/writer.js');

    const rel = '02-wiki/patterns/nova-com-diff-quebrado.md';
    const result = await writeNoteFresh({ vaultRoot, path: rel, content: 'Corpo da nota.' });

    expect(result.created).toBe(true);
    expect(await fs.readFile(path.join(vaultRoot, rel), 'utf8')).toContain('Corpo da nota.');
    expect(result.warning).toMatch(/diff/i);
    expect(result.diff).toContain('--- /dev/null');
  });
});

describe('editNote occurrence counting', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    ({ tmp, vaultRoot } = await makeVault());
    await initRepo(vaultRoot);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('refuses an ambiguous edit whose occurrences overlap', async () => {
    // `aa` sits in `aaa` twice, at offset 0 and offset 1. Counting non-overlapping
    // matches reports one and silently edits the first — the ambiguity the contract
    // promises to refuse.
    const rel = '01-raw/inbox/sobreposto.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'inicio aaa fim\n', 'utf8');

    await expect(editNote({ vaultRoot, path: rel, oldText: 'aa', newText: 'b' })).rejects.toThrow(
      /2 ocorrências/
    );
    expect(await fs.readFile(path.join(vaultRoot, rel), 'utf8')).toBe('inicio aaa fim\n');
  });
});
