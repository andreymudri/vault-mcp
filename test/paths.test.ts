import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  DENIED_SEGMENTS,
  assertNoSymlinkEscape,
  guardedPath,
  normalizeSegment,
  resolveWritePath,
  PathGuardError,
} from '../src/write/paths.js';
import { symlink } from 'node:fs/promises';

describe('resolveWritePath', () => {
  it('accepts a valid vault-relative path and returns absolute normalized path', () => {
    const vaultRoot = '/vault';
    const result = resolveWritePath(vaultRoot, '02-wiki/nestjs/nova.md');
    expect(result).toBe(resolve(vaultRoot, '02-wiki/nestjs/nova.md'));
  });

  it('rejects paths escaping via ../', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '../fora.md')).toThrow(PathGuardError);
  });

  it('rejects absolute paths', () => {
    const vaultRoot = '/vault';
    // Must end in .md, otherwise this dies on the suffix check before the absolute-path
    // handling is ever reached, and the rejection this test claims to verify is never
    // exercised.
    expect(() => resolveWritePath(vaultRoot, '/etc/passwd.md')).toThrow(PathGuardError);
    // An absolute path that happens to resolve inside the vault must still be rejected:
    // the contract is "vault-relative path in", not "any path that lands inside the vault".
    expect(() => resolveWritePath(vaultRoot, '/vault/02-wiki/nova.md')).toThrow(PathGuardError);
  });

  it('rejects paths containing glob metacharacters', () => {
    const vaultRoot = '/vault';
    // git interprets a pathspec as a glob; `*.md` stays inside the vault and ends in .md so
    // every other check passes, but it reaches `git add` as a wildcard and can sweep up files
    // the tool never touched.
    expect(() => resolveWritePath(vaultRoot, '02-wiki/*.md')).toThrow(PathGuardError);
    expect(() => resolveWritePath(vaultRoot, '02-wiki/nota[1].md')).toThrow(PathGuardError);
  });

  it('rejects paths that escape via traversal', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '02-wiki/../../fora.md')).toThrow(
      PathGuardError,
    );
  });

  it('rejects paths in 99-archive/ with message naming the folder', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '99-archive/x.md')).toThrow(PathGuardError);
    try {
      resolveWritePath(vaultRoot, '99-archive/x.md');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
      expect((err as Error).message).toMatch(/99-archive/);
    }
  });

  it('rejects paths in _templates/ with message naming the folder', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '_templates/x.md')).toThrow(PathGuardError);
    try {
      resolveWritePath(vaultRoot, '_templates/x.md');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
      expect((err as Error).message).toMatch(/_templates/);
    }
  });

  it('rejects paths not ending in .md', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '02-wiki/nestjs/nova.txt')).toThrow(
      PathGuardError,
    );
  });

  it('throws PathGuardError, not generic Error', () => {
    const vaultRoot = '/vault';
    try {
      resolveWritePath(vaultRoot, '../fora.md');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
    }
  });
});

describe('assertNoSymlinkEscape', () => {
  let tmpVault: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpVault = resolve(tmpdir(), `vault-${Date.now()}-${Math.random()}`);
    await mkdir(tmpVault, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directories
    try {
      if (tmpVault) await rm(tmpVault, { recursive: true, force: true });
      if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('allows paths inside the vault', async () => {
    const notePath = resolve(tmpVault, '02-wiki/test.md');
    await mkdir(resolve(tmpVault, '02-wiki'), { recursive: true });
    // Should not throw
    await assertNoSymlinkEscape(tmpVault, notePath);
  });

  it('rejects symlinks pointing outside the vault', async () => {
    outsideDir = resolve(tmpdir(), `outside-${Date.now()}-${Math.random()}`);
    await mkdir(outsideDir, { recursive: true });

    const symlinkDir = resolve(tmpVault, 'linked');
    await symlink(outsideDir, symlinkDir, 'dir');

    const notePathThroughSymlink = resolve(symlinkDir, 'test.md');

    await expect(assertNoSymlinkEscape(tmpVault, notePathThroughSymlink)).rejects.toThrow(PathGuardError);
  });

  it('surfaces a missing vault root as PathGuardError, not a raw ENOENT', async () => {
    const missingRoot = resolve(tmpVault, 'nope');
    const target = resolve(missingRoot, 'a.md');

    // writer.ts branches on `e instanceof PathGuardError`; a raw fs ENOENT would escape
    // that check as an unclassified tool failure instead of a recognized guard rejection.
    await expect(assertNoSymlinkEscape(missingRoot, target)).rejects.toThrow(PathGuardError);
  });
});

/**
 * The one guard every writer in `src/write/` passes through, tested HERE because it lives
 * here now.
 *
 * It used to live twice — once in `writer.ts`, once in `propagate.ts` — and the coverage
 * followed the callers rather than the boundary: `.git` in lower case was pinned from both
 * sides while `.obsidian`, `node_modules` and `_templates` could be deleted from the set,
 * and `normalizeSegment`'s `toLowerCase` could be deleted outright, with the whole suite
 * still green. Every case below is a mutation that survived. The set is enumerated from
 * the export rather than retyped, so an entry ADDED to it without a test fails here too.
 */
describe('guardedPath', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'vault-mcp-guard-'));
    vaultRoot = join(tmp, 'vault');
    await mkdir(join(vaultRoot, '02-wiki'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Each denied directory, with a link name that carries none of its letters as a segment. */
  const DENIED: ReadonlyArray<readonly [string, string]> = [
    ['.git', 'atalho-a'],
    ['.obsidian', 'atalho-b'],
    ['node_modules', 'atalho-c'],
    ['_templates', 'atalho-d'],
  ];

  it('covers every entry of DENIED_SEGMENTS in the table below', () => {
    // The table is the coverage. An entry added to the set without a row here would
    // otherwise be a denied directory nothing exercises.
    expect([...DENIED_SEGMENTS].sort()).toEqual(DENIED.map(([name]) => name).sort());
  });

  it.each(DENIED.map(([name]) => name))('refuses a write directly inside %s', async (name) => {
    await expect(guardedPath(vaultRoot, `${name}/pwn.md`)).rejects.toBeInstanceOf(PathGuardError);
  });

  it.each(DENIED.map(([name]) => name))(
    'refuses a write nested under %s at any depth',
    async (name) => {
      // The nested form is the one that isolates `DENIED_SEGMENTS` from `DENIED_PREFIXES`:
      // `_templates/` at the top is refused by the prefix list, and `02-wiki/_templates/`
      // is refused by nothing else at all.
      await expect(guardedPath(vaultRoot, `02-wiki/${name}/pwn.md`)).rejects.toBeInstanceOf(
        PathGuardError,
      );
    },
  );

  it.each(DENIED)(
    'refuses a write that reaches %s through an in-vault symlink',
    async (name, link) => {
      // The link does not escape the vault, so `assertNoSymlinkEscape` is satisfied, and
      // the lexical path carries no denied segment for a string check to find. Only the
      // scan of the RESOLVED path catches it — and a user or a sync client can create the
      // link.
      await mkdir(join(vaultRoot, name, 'dentro'), { recursive: true });
      await symlink(join('..', name, 'dentro'), join(vaultRoot, '02-wiki', link), 'dir');

      await expect(guardedPath(vaultRoot, `02-wiki/${link}/pwn.md`)).rejects.toBeInstanceOf(
        PathGuardError,
      );
    },
  );

  it.each([
    ['uppercase', '.GIT'],
    ['mixed case', '.Git'],
    ['a trailing dot', '.git.'],
    ['a trailing space', '.git '],
    ['uppercase .obsidian', '.OBSIDIAN'],
    ['mixed case .obsidian', '.Obsidian'],
    ['uppercase node_modules', 'NODE_MODULES'],
    ['mixed case node_modules', 'Node_Modules'],
    ['uppercase _templates', '_TEMPLATES'],
    ['a trailing dot on node_modules', 'node_modules.'],
  ])('refuses a denied directory spelled with %s', async (_label, spelling) => {
    // Every one of these OPENS the real directory: the comparison is case-insensitive on
    // APFS and on every Windows volume, and Windows strips trailing dots and spaces from a
    // component before the filesystem sees it. `Set.has` on the string as typed answers
    // false for all of them.
    await expect(guardedPath(vaultRoot, `02-wiki/${spelling}/pwn.md`)).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });

  it('refuses a denied directory spelled in upper case reached through a symlink', async () => {
    // The case folding has to hold on the RESOLVED half too: the link name is ordinary and
    // only the directory it lands in is spelled `.GIT`.
    await mkdir(join(vaultRoot, '.GIT', 'refs'), { recursive: true });
    await symlink(join('..', '.GIT', 'refs'), join(vaultRoot, '02-wiki', 'atalho-e'), 'dir');

    await expect(guardedPath(vaultRoot, '02-wiki/atalho-e/pwn.md')).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });

  it.each([
    ['.git', 'ordinaria-a'],
    ['.obsidian', 'ordinaria-b'],
    ['node_modules', 'ordinaria-c'],
    ['_templates', 'ordinaria-d'],
  ])('refuses %s even when it is ITSELF a link to somewhere ordinary', async (name, alvo) => {
    // The other direction of the same guard: dropping the LEXICAL half of `pathSegments`
    // survives every symlink test above, because with the denied directory made a link to
    // an ordinary folder of notes the RESOLVED path carries no denied segment at all. The
    // write then lands in the link's target under a name that says it went somewhere else.
    // A link the repository never had is not a reason to honour a path the user plainly
    // meant as the repository.
    await mkdir(join(vaultRoot, alvo), { recursive: true });
    await symlink(alvo, join(vaultRoot, name), 'dir');

    await expect(guardedPath(vaultRoot, `${name}/notas.md`)).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });

  it('names the refused segment in the message', async () => {
    await expect(guardedPath(vaultRoot, '02-wiki/.git/pwn.md')).rejects.toThrow(/\.git/);
  });

  it('matches whole segments, never prefixes', async () => {
    // `02-wiki/git/` is an ordinary part of a vault about software, exactly as
    // `99-archive-notes/` stays legal beside the denied `99-archive/`.
    await mkdir(join(vaultRoot, '02-wiki', 'git'), { recursive: true });
    const abs = await guardedPath(vaultRoot, '02-wiki/git/rebase-interativo.md');
    expect(abs).toBe(join(vaultRoot, '02-wiki', 'git', 'rebase-interativo.md'));

    expect(await guardedPath(vaultRoot, '02-wiki/.gitignore-notas.md')).toBe(
      join(vaultRoot, '02-wiki', '.gitignore-notas.md'),
    );
    expect(await guardedPath(vaultRoot, '99-archive-notes/nota.md')).toBe(
      join(vaultRoot, '99-archive-notes', 'nota.md'),
    );
  });

  it('allows a symlinked directory that leads somewhere ordinary', async () => {
    // Refusing a link INTO a denied directory must not become refusing links as such: a
    // vault where `02-wiki/externo` points at another folder of notes is an ordinary vault.
    await mkdir(join(vaultRoot, '01-raw', 'compartilhado'), { recursive: true });
    await symlink(
      join('..', '01-raw', 'compartilhado'),
      join(vaultRoot, '02-wiki', 'externo'),
      'dir',
    );

    await expect(guardedPath(vaultRoot, '02-wiki/externo/nota.md')).resolves.toBe(
      join(vaultRoot, '02-wiki', 'externo', 'nota.md'),
    );
  });

  /**
   * One code point from EVERY range of `INVISIBLE_CHARS`, including both ends of the ones
   * that are ranges.
   *
   * Each row is a range that could be deleted from the class on its own: nothing else in
   * the guard refuses these, so a missing range is a path accepted with a character in it
   * that forges a diff hunk, forges a commit subject, or renders as a name that is not the
   * file on disk. Written as escapes, never as the literal characters — a test file
   * carrying a raw RIGHT-TO-LEFT OVERRIDE is a file whose own source reads backwards.
   */
  const INVISIBLE: ReadonlyArray<readonly [string, string]> = [
    ['U+0000 NUL', '\u0000'],
    ['U+000A LINE FEED', '\n'],
    ['U+001F UNIT SEPARATOR', '\u001f'],
    ['U+007F DELETE', '\u007f'],
    ['U+0085 NEXT LINE', '\u0085'],
    ['U+009F APPLICATION PROGRAM COMMAND', '\u009f'],
    ['U+00AD SOFT HYPHEN', '\u00ad'],
    ['U+061C ARABIC LETTER MARK', '\u061c'],
    ['U+200B ZERO WIDTH SPACE', '\u200b'],
    ['U+200F RIGHT-TO-LEFT MARK', '\u200f'],
    ['U+2028 LINE SEPARATOR', '\u2028'],
    ['U+2029 PARAGRAPH SEPARATOR', '\u2029'],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', '\u202a'],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', '\u202e'],
    ['U+2060 WORD JOINER', '\u2060'],
    ['U+2064 INVISIBLE PLUS', '\u2064'],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', '\u2066'],
    ['U+2069 POP DIRECTIONAL ISOLATE', '\u2069'],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', '\ufeff'],
  ];

  it.each(INVISIBLE)('refuses a path carrying %s', async (_label, ch) => {
    await expect(guardedPath(vaultRoot, `02-wiki/nota${ch}dm.hsab.md`)).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });

  it('escapes the refused path in the message rather than rendering it', async () => {
    // U+2028 is a forced line break in every HTML-rendering client, so a raw one in the
    // message renders a standalone line the guard never wrote, attached to a refusal.
    const forjado = '02-wiki/a\u2028+++ b/CLAUDE.md.md';
    await expect(guardedPath(vaultRoot, forjado)).rejects.toThrow(/\\u2028/);
    try {
      await guardedPath(vaultRoot, forjado);
      expect.fail('deveria ter recusado');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('\u2028');
      expect(message).not.toContain('\n');
    }
  });

  it.each([
    ['a path that escapes with ..', '../fora.md'],
    ['an absolute path', '/etc/passwd.md'],
    ['a glob metacharacter', '02-wiki/*.md'],
    ['a suffix that is not .md', '02-wiki/nota.txt'],
  ])('still applies the syntactic half: refuses %s', async (_label, relPath) => {
    await expect(guardedPath(vaultRoot, relPath)).rejects.toBeInstanceOf(PathGuardError);
  });

  it('still applies the symlink-escape half', async () => {
    const fora = join(tmp, 'fora');
    await mkdir(fora, { recursive: true });
    await writeFile(join(fora, 'segredo.md'), 'segredo\n', 'utf8');
    await symlink(fora, join(vaultRoot, '02-wiki', 'saida'), 'dir');

    await expect(guardedPath(vaultRoot, '02-wiki/saida/segredo.md')).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });
});

describe('normalizeSegment', () => {
  it('folds case and strips the trailing dots and spaces Windows drops', () => {
    // The three spellings the filesystem treats as one, and the reason `Set.has` alone is
    // not the comparison the guard needs.
    expect(normalizeSegment('.GIT')).toBe('.git');
    expect(normalizeSegment('.Git')).toBe('.git');
    expect(normalizeSegment('.git.')).toBe('.git');
    expect(normalizeSegment('.git ')).toBe('.git');
    expect(normalizeSegment('.git. . ')).toBe('.git');
    expect(normalizeSegment('NODE_MODULES')).toBe('node_modules');
  });

  it('does not touch a leading dot or an inner one', () => {
    // Stripping more than the trailing run would turn `.gitignore-notas` into something
    // the set matches, and an ordinary note would stop being writable.
    expect(normalizeSegment('.gitignore-notas.md')).toBe('.gitignore-notas.md');
    expect(normalizeSegment('nota.md')).toBe('nota.md');
  });
});
