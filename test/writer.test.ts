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

/**
 * Codepoints that render as NOTHING, or reorder what is around them, in the clients that
 * show a diff and a commit subject.
 *
 * These are not line breaks, which is why the round-2 widening to the forced-break set
 * missed all of them: `02-wiki/nota\u202edm.hsab\u202c.md` is one line by every reader's
 * definition, and in any bidi-aware renderer — a chat client, a terminal, Obsidian's file
 * list, `git log` — it reads as `nota basit.md` while the write lands on a different file
 * entirely. `WriteResult.diff`, `WriteResult.path` and the commit subject all carried the
 * override raw.
 *
 * The one table is used against BOTH locks on purpose. `writer.ts` refuses these and
 * `diff.ts` escapes them, the two are reached by different callers, and the docblocks on
 * each say the sets must not drift — so a codepoint added to one and not the other fails
 * here rather than quietly reopening the hole on whichever side was forgotten.
 */
// Written as escapes, never as the literal characters: a test file that carries a raw
// RIGHT-TO-LEFT OVERRIDE is a test file whose own source reads backwards in the editor.
const INVISIBLE_CODEPOINTS: ReadonlyArray<readonly [string, string]> = [
  ['U+00AD SOFT HYPHEN', '\u00ad'],
  ['U+061C ARABIC LETTER MARK', '\u061c'],
  ['U+200B ZERO WIDTH SPACE', '\u200b'],
  ['U+200C ZERO WIDTH NON-JOINER', '\u200c'],
  ['U+200D ZERO WIDTH JOINER', '\u200d'],
  ['U+200E LEFT-TO-RIGHT MARK', '\u200e'],
  ['U+200F RIGHT-TO-LEFT MARK', '\u200f'],
  ['U+202A LEFT-TO-RIGHT EMBEDDING', '\u202a'],
  ['U+202B RIGHT-TO-LEFT EMBEDDING', '\u202b'],
  ['U+202C POP DIRECTIONAL FORMATTING', '\u202c'],
  ['U+202D LEFT-TO-RIGHT OVERRIDE', '\u202d'],
  ['U+202E RIGHT-TO-LEFT OVERRIDE', '\u202e'],
  ['U+2060 WORD JOINER', '\u2060'],
  ['U+2061 FUNCTION APPLICATION', '\u2061'],
  ['U+2062 INVISIBLE TIMES', '\u2062'],
  ['U+2063 INVISIBLE SEPARATOR', '\u2063'],
  ['U+2064 INVISIBLE PLUS', '\u2064'],
  ['U+2066 LEFT-TO-RIGHT ISOLATE', '\u2066'],
  ['U+2067 RIGHT-TO-LEFT ISOLATE', '\u2067'],
  ['U+2068 FIRST STRONG ISOLATE', '\u2068'],
  ['U+2069 POP DIRECTIONAL ISOLATE', '\u2069'],
  ['U+FEFF ZERO WIDTH NO-BREAK SPACE', '\ufeff'],
];

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
 * Runs `work` while WATCHING `fifo` for a reader, and unblocks any reader that appears.
 *
 * A read of a FIFO nobody writes to never returns, and a test that hits one does not fail — it
 * HANGS: vitest prints the failure and then never exits ("close timed out", "Failed to terminate
 * worker"), which costs a whole run and reports nothing. So the write end is opened NON-BLOCKING,
 * which answers ENXIO while nobody is reading and succeeds the instant somebody is; closing it
 * immediately hands the reader EOF. The call under test therefore always finishes, and `opened`
 * says whether it opened the FIFO at all — which is the thing being asserted, rather than left to
 * a timeout.
 */
async function withFifoWatch<T>(
  fifo: string,
  work: () => Promise<T>
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
      } catch {
        // ENXIO: nobody has it open for reading, which is the answer these tests want.
      }
      // Keeps watching for the WHOLE call instead of stopping at the first reader. One call can
      // reach the same path more than once — a classification, then a read, then a template —
      // and a watcher that retired after the first unblock left the second read pending with
      // nobody to free it: the test failed, then the worker could not be terminated. Measured
      // on the duplicate-rule target: 90 s and SIGKILL with the one-shot watcher, 5 s and a
      // clean exit with this one.
      await new Promise((resolve) => setTimeout(resolve, 20));
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

/**
 * Runs `work` and returns its OUTCOME — the rejection reason, or the resolved value.
 *
 * The resolved value rather than a marker string, so an assertion about what a successful call
 * would have handed back still has the object to look at: a guard that stops refusing turns a
 * `PathGuardError` into a `WriteResult` whose `diff` is exactly the thing under test.
 */
async function refusal(work: () => Promise<unknown>): Promise<unknown> {
  return work().then(
    (value: unknown) => value,
    (err: unknown) => err
  );
}

/** A throwaway copy of `test/fixtures/vault` in `os.tmpdir()`. The fixture itself is
 * read-only shared state across parallel test files, so every write test gets its own
 * copy and never touches the original.
 */
async function makeVault(): Promise<{ tmp: string; vaultRoot: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-writer-test-'));
  const vaultRoot = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultRoot, { recursive: true });
  return { tmp, vaultRoot };
}

/**
 * A throwaway git repository with no background writer.
 *
 * `git gc --auto` runs in the BACKGROUND after a commit and keeps writing inside `.git`
 * after the awaited command has returned, which races the teardown below: the phase gate —
 * not a teammate's laptop — failed once with `ENOTEMPTY: rmdir '.../vault/.git'`, on a run
 * whose only job is to be evidence. Turning the writer off is the half that removes the
 * cause; `removeTree` is the half that survives anything else still holding the directory.
 */
async function initScratchRepo(repo: string): Promise<void> {
  await git(repo, ['init']);
  await git(repo, ['config', 'gc.auto', '0']);
}

/**
 * Teardown that tolerates a transient writer inside a throwaway repository.
 *
 * A plain `fs.rm` raced git and failed with ENOTEMPTY on `.git/` under a loaded machine. The
 * retries are `fs.rm`'s own answer to exactly that, and `gc.auto 0` above removes the writer.
 * The same hardening `test/learn.test.ts` already carries.
 */
async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function initRepo(vaultRoot: string): Promise<void> {
  await initScratchRepo(vaultRoot);
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

  /**
   * Two changed lines with exactly `gap` unchanged lines between them, in a note long
   * enough that neither change is near an edge.
   */
  function withGap(gap: number): { before: string; after: string } {
    const lines = Array.from({ length: gap + 14 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[5] = 'CINCO';
    changed[6 + gap] = 'DEPOIS';
    return { before: `${lines.join('\n')}\n`, after: `${changed.join('\n')}\n` };
  }

  it('joins two changes into one hunk when their context windows meet', () => {
    // Six unchanged lines is 3 of trailing context plus 3 of leading context with nothing
    // left over, so splitting would print the same lines twice under two headers.
    const { before, after } = withGap(2 * 3);
    const headers = unifiedDiff(before, after, 'nota.md')
      .split('\n')
      .filter((l) => l.startsWith('@@'));
    expect(headers).toHaveLength(1);
  });

  it('splits at the first gap wider than the two context windows', () => {
    // Seven: one line more than both windows can cover, so the seventh would be printed as
    // context belonging to neither change. The threshold has to sit exactly between these
    // two tests — moving it either way flips one of them, which is what pins `2 * CONTEXT`
    // rather than any of the values in [7, 27] that leave the far-apart test below green.
    const { before, after } = withGap(2 * 3 + 1);
    const headers = unifiedDiff(before, after, 'nota.md')
      .split('\n')
      .filter((l) => l.startsWith('@@'));
    expect(headers).toHaveLength(2);
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

  it('marks the side that lost the newline, not the line that kept it', () => {
    // `toContain` cannot tell these apart, and that is the whole reason this file grew a
    // round-trip suite below: the marker was emitted after the CONTEXT line ` a`, where it
    // asserts that both sides end there without a terminator — false for `after`, which
    // goes on for another line. Pinned as the exact text git itself produces.
    expect(unifiedDiff('a', 'a\nb\n', 'nota.md')).toBe(
      [
        '--- a/nota.md',
        '+++ b/nota.md',
        '@@ -1 +1,2 @@',
        '-a',
        '\\ No newline at end of file',
        '+a',
        '+b',
        '',
      ].join('\n')
    );
  });

  it('keeps the marker on a context line only when BOTH sides end there unterminated', () => {
    const diff = unifiedDiff('x\ny', 'z\ny', 'nota.md');
    expect(diff).toBe(
      ['--- a/nota.md', '+++ b/nota.md', '@@ -1,2 +1,2 @@', '-x', '+z', ' y', '\\ No newline at end of file', ''].join(
        '\n'
      )
    );
  });

  it.each([
    [
      'the trailing lines replaced by an unterminated one',
      'a\nb\nc\n',
      'a\nb',
      ['@@ -1,3 +1,2 @@', ' a', '-b', '-c', '+b', '\\ No newline at end of file'],
    ],
    [
      'an unterminated tail rewritten and terminated',
      'a\nb\nc',
      'a\nX\nc\n',
      ['@@ -1,3 +1,3 @@', ' a', '-b', '-c', '\\ No newline at end of file', '+X', '+c'],
    ],
  ])('renders deletions before additions, as git does: %s', (_label, before, after, body) => {
    // The backtrack can hand back a run interleaved as `-b +b -c`, which puts the marker in
    // the MIDDLE of the hunk with a deletion still to come — and the marker's whole meaning
    // is "the file ends here". `git apply` happens to tolerate it; the reference renderers
    // do not produce it. Both expectations below are the byte-exact body of the
    // corresponding real `git diff`, so a drift away from git's shape shows up here.
    expect(unifiedDiff(before, after, 'nota.md').split('\n').slice(2)).toEqual([...body, '']);
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

/**
 * `unifiedDiff`'s output is only worth anything if a real patch tool can put it back, so
 * this suite asserts the PROPERTY rather than the string: apply the diff to `before` with
 * `git apply` and the bytes that come out must equal `after` exactly.
 *
 * That is deliberate, and it is the lesson of the bug this suite was written for. The
 * `\ No newline at end of file` marker was emitted on the wrong side for months behind a
 * single `expect(diff).toContain('\\ No newline at end of file')` — a test three separate
 * mutations of the emitting condition all satisfy, because the marker being PRESENT says
 * nothing about which side it describes. `git apply` refuses the wrong side, and byte
 * comparison catches the cases it accepts and misapplies.
 *
 * `git apply` rather than `patch`: git is already a hard dependency of this suite (the
 * writer commits), and it is the stricter of the two about the marker.
 */
describe('unifiedDiff round-trip', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-roundtrip-'));
    await initScratchRepo(repo);
  });

  afterEach(async () => {
    await removeTree(repo);
  });

  /** Applies `unifiedDiff(before, after)` to `before` with git, returning the result. */
  async function roundTrip(before: string, after: string): Promise<string> {
    const diff = unifiedDiff(before, after, 'f.md');
    expect(diff).not.toBe('');
    await fs.writeFile(path.join(repo, 'f.md'), before, 'utf8');
    await fs.writeFile(path.join(repo, 'p.diff'), diff, 'utf8');
    try {
      await execFileAsync('git', ['-C', repo, 'apply', '--whitespace=nowarn', 'p.diff']);
    } catch (err) {
      throw new Error(
        `git apply recusou o diff de ${JSON.stringify(before)} -> ${JSON.stringify(after)}:\n` +
          `${diff}\n${(err as Error).message}`
      );
    }
    return fs.readFile(path.join(repo, 'f.md'), 'utf8');
  }

  // Every combination of "does this side end in a newline" against every shape of edit
  // that can touch the last line. The terminator cases are the ones that were broken: a
  // marker on the wrong side is invisible to a string assertion and fatal to a patch.
  it.each([
    ['both sides terminated', 'a\nb\nc\n', 'a\nX\nc\n'],
    ['before unterminated, after terminated', 'a\nb\nc', 'a\nX\nc\n'],
    ['before terminated, after unterminated', 'a\nb\nc\n', 'a\nX\nc'],
    ['both sides unterminated', 'a\nb\nc', 'a\nX\nc'],
    ['only the terminator removed', 'a\nb\n', 'a\nb'],
    ['only the terminator added', 'a\nb', 'a\nb\n'],
    ['unterminated last line kept as context', 'x\ny', 'z\ny'],
    ['lines appended after an unterminated last line', 'a', 'a\nb\n'],
    ['lines appended, still unterminated', 'a', 'a\nb'],
    ['the unterminated last line deleted', 'a\nb\nc', 'a\nb\n'],
    ['a line removed before an unterminated tail', 'a\nb\nc', 'a\nc'],
    ['a line inserted before an unterminated tail', 'a\nc', 'a\nb\nc'],
    ['the whole file rewritten, unterminated', 'a\nb\nc', 'x\ny\nz'],
    ['a single unterminated line changed', 'a', 'b'],
    ['an unterminated file given a second line and a terminator', 'solo', 'solo\nmais\n'],
    ['far apart edits with an unterminated tail', `${'l\n'.repeat(30)}fim`, `${'L\n'.repeat(30)}fim`],
  ])('applies cleanly and byte-exactly: %s', async (_label, before, after) => {
    expect(await roundTrip(before, after)).toBe(after);
  });

  it('round-trips two hundred generated pairs byte-exactly', async () => {
    // Seeded, so a failure is reproducible. Short texts over a tiny alphabet is what makes
    // the terminator the interesting variable rather than the diff algorithm.
    let state = 20260824;
    const rand = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const text = (): string => {
      const n = 1 + Math.floor(rand() * 5);
      const lines = Array.from({ length: n }, () => pick(['a', 'b', 'c', 'dd', '']));
      return lines.join('\n') + (rand() < 0.5 ? '\n' : '');
    };

    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const before = text();
      const after = text();
      // An empty side is a creation or a deletion — `git apply` then adds or removes the
      // file rather than rewriting it, which is a different assertion. The `/dev/null`
      // headers have their own tests above.
      if (before === after || before === '' || after === '') continue;
      expect(await roundTrip(before, after)).toBe(after);
      checked += 1;
    }
    // Guards the loop itself: a generator that produced only identical pairs would make
    // every assertion above vacuous and the test would still pass.
    expect(checked).toBeGreaterThan(150);
  }, 60_000);
});

/**
 * O H1 e as seções vazias do esqueleto, nas duas pontas onde o template encontra o conteúdo do
 * chamador.
 */
describe('writeNote — título e seções do esqueleto', () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-titulo-test-'));
    vaultRoot = path.join(tmp, 'vault');
    await fs.mkdir(path.join(vaultRoot, '_templates'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, '02-wiki', 'patterns'), { recursive: true });
    await fs.writeFile(
      path.join(vaultRoot, '_templates', 'wiki.md'),
      '---\ntipo: wiki\ntags: \n---\n\n# <% tp.file.title %>\n\n## Contexto\n\n## Solução\n\n## Referências\n-\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await removeTree(tmp);
  });

  async function body(rel: string): Promise<string> {
    return fs.readFile(path.join(vaultRoot, rel), 'utf8');
  }

  it('usa o título que o chamador informou, com acento e pontuação', async () => {
    const rel = '02-wiki/patterns/check-then-act-nao-e-garantia.md';
    await writeNote({
      vaultRoot,
      path: rel,
      content: 'Corpo do insight.\n',
      tipo: 'wiki',
      title: 'Check-then-act não é garantia: publique com escrita exclusiva',
      deferCommit: true,
    });

    // O NOME DO ARQUIVO continua slug — ele é a identidade da nota no vault e não muda. O que muda
    // é o H1, que era uma reconstrução title-case do slug e perdia acento e pontuação.
    expect(await body(rel)).toContain('# Check-then-act não é garantia: publique com escrita exclusiva');
    expect(await body(rel)).not.toContain('Check Then Act Nao E Garantia');
  });

  it('sem título informado, continua derivando do nome do arquivo', async () => {
    const rel = '02-wiki/patterns/nota-sem-titulo.md';
    await writeNote({ vaultRoot, path: rel, content: 'Corpo.\n', tipo: 'wiki', deferCommit: true });

    expect(await body(rel)).toContain('# Nota Sem Titulo');
  });

  it('não repete como prompt vazio a seção que o corpo já respondeu', async () => {
    const rel = '02-wiki/patterns/com-contexto.md';
    await writeNote({
      vaultRoot,
      path: rel,
      content: 'Corpo do insight.\n\n**Contexto:** investigando a corrida de escrita\n',
      tipo: 'wiki',
      answeredSections: ['Contexto'],
      deferCommit: true,
    });

    const text = await body(rel);
    // O contexto aparece UMA vez, e não como um `## Contexto` vazio logo abaixo dele.
    expect(text).toContain('**Contexto:** investigando a corrida de escrita');
    expect(text).not.toContain('## Contexto');
    // As outras seções continuam de pé: são o convite para preencher a nota depois, no Obsidian.
    expect(text).toContain('## Solução');
    expect(text).toContain('## Referências');
  });

  it('nunca remove uma seção que o template já traz preenchida', async () => {
    await fs.writeFile(
      path.join(vaultRoot, '_templates', 'wiki.md'),
      '---\ntipo: wiki\ntags: \n---\n\n# <% tp.file.title %>\n\n## Contexto\n\nTexto que o template traz.\n\n## Solução\n',
      'utf8',
    );
    const rel = '02-wiki/patterns/contexto-cheio.md';
    await writeNote({
      vaultRoot,
      path: rel,
      content: 'Corpo.\n',
      tipo: 'wiki',
      answeredSections: ['Contexto'],
      deferCommit: true,
    });

    // Descartar isso seria apagar conteúdo do usuário: a regra é sobre PROMPT VAZIO, não sobre nome.
    expect(await body(rel)).toContain('Texto que o template traz.');
    expect(await body(rel)).toContain('## Contexto');
  });

  it('a nota criada termina com quebra de linha', async () => {
    const rel = '02-wiki/patterns/fim-de-linha.md';
    await writeNote({ vaultRoot, path: rel, content: 'Corpo.\n', tipo: 'wiki', deferCommit: true });

    expect(await body(rel)).toMatch(/\n$/);
  });
});

describe('atomicWrite', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-atomic-test-'));
  });

  afterEach(async () => {
    await removeTree(tmp);
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

  /**
   * `{ exclusive: true }` é para o caminho de CRIAÇÃO, onde o chamador já concluiu que o alvo não
   * existe. Sem isso a garantia vinha de um teste seguido de um rename, e não da escrita: entre os
   * dois cabe o Obsidian salvando, um cliente de sync, ou uma segunda instância do servidor.
   */
  describe('exclusive', () => {
    it('recusa publicar sobre um alvo que passou a existir, sem tocar nos bytes dele', async () => {
      const target = path.join(tmp, 'nota.md');
      await fs.writeFile(target, 'do outro processo\n', 'utf8');

      await expect(atomicWrite(target, 'meu\n', { exclusive: true })).rejects.toMatchObject({
        code: 'EEXIST',
      });

      expect(await fs.readFile(target, 'utf8')).toBe('do outro processo\n');
      // E sem lixo: o temporário recusado não pode ficar para o próximo `git add` estagiar.
      expect(await fs.readdir(tmp)).toEqual(['nota.md']);
    });

    it('publica normalmente quando o alvo de fato não existe', async () => {
      const target = path.join(tmp, 'a', 'nova.md');
      await atomicWrite(target, 'conteudo\n', { exclusive: true });

      expect(await fs.readFile(target, 'utf8')).toBe('conteudo\n');
      // Um hard link é publicação atômica; o nome temporário tem de sair, senão a nota nasce com
      // `nlink > 1` e o scanner — que aplica `classifyStat` na leitura — se recusa a indexá-la.
      expect(await fs.readdir(path.join(tmp, 'a'))).toEqual(['nova.md']);
      expect((await fs.stat(target)).nlink).toBe(1);
    });

    it('apenas uma de duas criações concorrentes do mesmo nome vence', async () => {
      const target = path.join(tmp, 'nota.md');
      const results = await Promise.allSettled([
        atomicWrite(target, 'A\n', { exclusive: true }),
        atomicWrite(target, 'B\n', { exclusive: true }),
      ]);

      // Exatamente uma vence. A outra REJEITA — que é a diferença entre perder o insight em
      // silêncio e o chamador poder procurar outro nome.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const perdida = results.find((r) => r.status === 'rejected');
      expect((perdida as PromiseRejectedResult).reason).toMatchObject({ code: 'EEXIST' });
      expect(await fs.readdir(tmp)).toEqual(['nota.md']);
    });
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
    await removeTree(tmp);
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
      await removeTree(bare);
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
    await removeTree(tmp);
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

  it('reports a diff that reproduces the edit it made, on a note with no final newline', async () => {
    // The end-to-end shape of the marker bug, reachable with no crafted input at all:
    // `writeNote` with content that does not end in a newline writes an unterminated note,
    // and the next edit near its end had the marker attached to a context line that was
    // not unterminated. Applying what the caller was SHOWN and comparing it to what was
    // actually written is the assertion that cannot be satisfied by the wrong side.
    const rel = '01-raw/inbox/sem-fim.md';
    const created = await writeNote({
      vaultRoot,
      path: rel,
      content: 'linha um\nlinha dois\nlinha tres SEM FIM',
      deferCommit: true,
    });
    const beforeBytes = await fs.readFile(created.absPath, 'utf8');
    expect(beforeBytes.endsWith('\n')).toBe(false);

    const result = await editNote({
      vaultRoot,
      path: rel,
      oldText: 'SEM FIM',
      newText: 'AINDA SEM FIM',
      deferCommit: true,
    });
    const afterBytes = await fs.readFile(created.absPath, 'utf8');

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-diff-apply-'));
    try {
      await initScratchRepo(repo);
      await fs.mkdir(path.join(repo, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), beforeBytes, 'utf8');
      await fs.writeFile(path.join(repo, 'p.diff'), result.diff, 'utf8');
      await execFileAsync('git', ['-C', repo, 'apply', '--whitespace=nowarn', 'p.diff']);
      expect(await fs.readFile(path.join(repo, rel), 'utf8')).toBe(afterBytes);
    } finally {
      await removeTree(repo);
    }
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
      await removeTree(bare);
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

  /**
   * Every character that ENDS A LINE somewhere a diff gets rendered, not just the two a
   * terminal breaks on. CSS Text 3 makes U+2028, U+2029 and U+0085 forced line breaks, so
   * an HTML client shows them as breaks while `split('\n')` over the same string sees one
   * line — which is precisely how a forged hunk shipped past the header test above.
   */
  const LINE_BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;

  it.each([
    ['U+2028 LINE SEPARATOR', '\u2028'],
    ['U+2029 PARAGRAPH SEPARATOR', '\u2029'],
    ['U+0085 NEXT LINE', '\u0085'],
  ])('escapes %s rather than letting it forge a hunk in an HTML client', (_label, ch) => {
    const forged = `02-wiki/a${ch}+++ b/CLAUDE.md${ch}@@ -1 +1 @@${ch}-real${ch}+forjado.md`;
    const diff = unifiedDiff('antes\n', 'depois\n', forged);

    // Shipped raw, this character was the break. It must not survive into the output at
    // all — escaping is what makes the header one line by every reader's definition.
    expect(diff).not.toContain(ch);

    const lines = diff.split(LINE_BREAKS);
    expect(lines.filter((l) => l.startsWith('--- '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('+++ '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('@@'))).toHaveLength(1);
    expect(lines).not.toContain('+++ b/CLAUDE.md');
    expect(lines).not.toContain('+forjado.md');
  });

  it.each(INVISIBLE_CODEPOINTS)(
    'escapes %s rather than shipping it raw into a header',
    (_label, ch) => {
      const diff = unifiedDiff('antes\n', 'depois\n', `02-wiki/nota${ch}dm.hsab${ch}.md`);

      // Shipped raw, this character is invisible to the reader while it is part of the
      // name of the file that was actually written.
      expect(diff).not.toContain(ch);
      // Same escape convention the C1 controls already use: one byte gets `\xNN`,
      // anything wider gets the four-digit `\uNNNN` that can only mean what it names.
      const code = ch.charCodeAt(0);
      const escaped =
        code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
      expect(diff.split('\n')[0]).toContain(escaped);
    }
  );

  it('escapes a C1 control in the path unambiguously', () => {
    // `\x2028` would read back as `\x20` then a literal `28`, so a codepoint wider than one
    // byte gets the four-digit form. U+0085 is one byte and keeps the short one.
    expect(unifiedDiff('a\n', 'b\n', 'nota\u2028.md').split('\n')[0]).toBe('--- a/nota\\u2028.md');
    expect(unifiedDiff('a\n', 'b\n', 'nota\u0085.md').split('\n')[0]).toBe('--- a/nota\\x85.md');
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

  it('diffs a full rewrite far past the argument limit instead of overflowing the stack', () => {
    // `groupChanges` used to reorder each run of changed ops with
    // `ops.splice(i, j - i, ...dels, ...adds)`. The spread passes every op in the run as a
    // separate function argument and V8 caps that at the stack, so a full rewrite — two
    // texts with nothing in common, which `fallbackOps` returns as ONE run carrying every
    // deletion and every addition — threw `RangeError: Maximum call stack size exceeded`
    // from 248,671 lines per side, ~995 kB combined. That is under half
    // `MAX_DIFF_INPUT_CHARS`, so `unifiedDiff` was refusing inputs it had already decided
    // were small enough to diff, and `safeDiff` turned the throw into
    // `@@ diff indisponível @@` — the note still written and committed, but the diff that
    // is the only visible record of the write silently gone, at any size a caller chose.
    const N = 300_000;
    const before = 'a\n'.repeat(N);
    const after = 'b\n'.repeat(N);
    // Still inside the input bound, so the coarse summary must NOT be what comes back.
    expect(before.length + after.length).toBeLessThan(2 * 1024 * 1024);

    const diff = unifiedDiff(before, after, 'nota.md');

    expect(diff).toContain('--- a/nota.md');
    expect(diff).not.toContain('diff resumido');
    // The whole edit is one run, so the grouping has to hold across all 600,000 ops:
    // every deletion first, then every addition, and no `+` before the last `-`.
    const lines = diff.split('\n');
    const firstAdd = lines.findIndex((l) => l.startsWith('+') && !l.startsWith('+++'));
    let lastDel = -1;
    for (let k = 0; k < lines.length; k += 1) {
      if (lines[k]!.startsWith('-') && !lines[k]!.startsWith('---')) lastDel = k;
    }
    expect(firstAdd).toBeGreaterThan(lastDel);
    expect(lines.filter((l) => l === '-a')).toHaveLength(N);
    expect(lines.filter((l) => l === '+b')).toHaveLength(N);
  });
});

describe('atomicWrite guarantees', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-atomic-guarantee-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTree(tmp);
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
  ): Promise<{
    openedPath: string;
    openedFlags: number | undefined;
    openedMode: number | undefined;
    events: string[];
  }> {
    const events: string[] = [];
    let openedPath = '';
    let openedFlags: number | undefined;
    let openedMode: number | undefined;

    const realOpen = fs.open.bind(fs);
    const realRename = fs.rename.bind(fs);

    vi.spyOn(fs, 'open').mockImplementation((async (p: never, flags: never, mode: never) => {
      openedPath = String(p);
      openedFlags = typeof flags === 'number' ? flags : undefined;
      openedMode = typeof mode === 'number' ? mode : undefined;
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

    return { openedPath, openedFlags, openedMode, events };
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

  it('leaves a new note at the ordinary default mode', async () => {
    const target = path.join(tmp, 'nova.md');
    await atomicWrite(target, 'v1\n');

    expect((await fs.stat(target)).mode & 0o200).toBe(0o200);
    // Exactly what `fs.writeFile` would have produced. The temporary file is created 0600,
    // so a note that never gets widened again would come back owner-only and every other
    // tool the user points at their vault would suddenly see a private file.
    expect((await fs.stat(target)).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('never lets the plaintext sit on disk world-readable before the mode is set', async () => {
    // The bytes were written into a 0644 temporary file and chmod'd to 0600 only
    // afterwards, so the full plaintext of a note deliberately kept owner-only was
    // readable by every process on the machine for the length of the write. The mode has
    // to be right at CREATE time; nothing observable in the finished file says whether it
    // was, which is why this reads the `open` call itself.
    const target = path.join(tmp, 'segredo.md');
    await atomicWrite(target, 'v1\n');
    await fs.chmod(target, 0o600);

    const { openedMode } = await recordAtomicWrite(target, 'conteudo secreto\n');

    expect(openedMode).toBe(0o600);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('conteudo secreto\n');
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
    await removeTree(tmp);
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
    // Not controls in the C0 sense, and that is exactly why they got through: CSS Text 3
    // makes all three forced line breaks, so this path rendered as a fabricated diff hunk
    // in the user's client and `git log --format=%B` showed the injected lines in the
    // commit message. `split('\n')` sees one line in every one of them.
    ['line separator', '02-wiki/a\u2028+++ b/CLAUDE.md\u2028@@ -1 +1 @@\u2028-real\u2028+forjado.md'],
    ['paragraph separator', '02-wiki/a\u2029+++ b/CLAUDE.md\u2029+forjado.md'],
    ['next line', '02-wiki/a\u0085+++ b/CLAUDE.md\u0085+forjado.md'],
    ['C1 control', '02-wiki/no\u0090ta.md'],
  ])('refuses a path containing a %s', async (_label, relPath) => {
    await expect(writeNote({ vaultRoot, path: relPath, content: 'x' })).rejects.toBeInstanceOf(
      PathGuardError
    );
  });

  it.each(INVISIBLE_CODEPOINTS)('refuses a path containing %s', async (_label, ch) => {
    // Not a line break, so the round-2 widening to the forced-break set let every one of
    // these through: the path is one line by every reader's definition and the name still
    // renders as something other than the file that gets written. Reproduced end to end —
    // `writeNote` accepted it and the raw override reached `WriteResult.diff`,
    // `WriteResult.path` and the commit subject, so a user reading any of the three saw a
    // filename that was not the one on disk.
    await expect(
      writeNote({ vaultRoot, path: `02-wiki/nota${ch}dm.hsab${ch}.md`, content: 'x' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('refuses the bidi-override filename before it can reach a result or a commit', async () => {
    const forged = '02-wiki/nota\u202edm.hsab\u202c.md';
    await expect(
      writeNote({ vaultRoot, path: forged, content: 'x' })
    ).rejects.toBeInstanceOf(PathGuardError);

    // Nothing was written and nothing was committed under either reading of the name.
    const log = await git(vaultRoot, ['log', '--format=%s']);
    expect(log).not.toContain('\u202e');
    expect(await exists(path.join(vaultRoot, forged))).toBe(false);
  });

  it('refuses a write that reaches a denied directory through an in-vault symlink', async () => {
    // The guard used to read the LEXICAL path, and this path has no `.git` segment in it.
    // The link does not escape the vault either, so `assertNoSymlinkEscape` is satisfied
    // too — and the write landed in `<vault>/.git/refs/heads/pwn.md`, a malformed loose ref
    // that breaks `git gc`, `git log --all` and every commit this module makes afterwards.
    // Reproduced on Linux with an ordinary relative link a sync client could have created.
    await fs.symlink(
      path.join('..', '.git', 'refs', 'heads'),
      path.join(vaultRoot, '02-wiki', 'compartilhado'),
      'dir'
    );

    await expect(
      writeNote({ vaultRoot, path: '02-wiki/compartilhado/pwn.md', content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(vaultRoot, '.git', 'refs', 'heads', 'pwn.md'))).toBe(false);
  });

  it('refuses a denied directory that is itself a link to somewhere ordinary', async () => {
    // The other direction of the same guard, and the half nothing covered: `pathSegments`
    // checks the LEXICAL segments as well as the resolved ones, and dropping the lexical
    // half — `return relative(realRoot, resolved).split(sep)` — survived every other test
    // in this file. It is not redundant. A link the repository never had is not a reason
    // to honour a path the user plainly meant as the repository: with `node_modules` made
    // a symlink to an ordinary folder of notes, the resolved path carries no denied
    // segment at all, so the resolved half alone accepts the write and it lands silently
    // in the link's target under a name that says it went somewhere else.
    await fs.symlink(path.join('02-wiki'), path.join(vaultRoot, 'node_modules'), 'dir');

    await expect(
      writeNote({ vaultRoot, path: 'node_modules/notas.md', content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(await exists(path.join(vaultRoot, '02-wiki', 'notas.md'))).toBe(false);
  });

  it('refuses an edit that reaches a denied directory through an in-vault symlink', async () => {
    await fs.symlink(
      path.join('..', '.git'),
      path.join(vaultRoot, '02-wiki', 'interno'),
      'dir'
    );
    await expect(
      editNote({ vaultRoot, path: '02-wiki/interno/config.md', oldText: 'a', newText: 'b' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('still allows a symlinked directory that leads somewhere ordinary', async () => {
    // The resolved check must refuse a link INTO a denied directory without refusing links
    // as such: a vault where `02-wiki/externo` points at another folder of notes is a
    // perfectly ordinary vault, and the guard has no business breaking it.
    await fs.mkdir(path.join(vaultRoot, '01-raw', 'compartilhado'), { recursive: true });
    await fs.symlink(
      path.join('..', '01-raw', 'compartilhado'),
      path.join(vaultRoot, '02-wiki', 'externo'),
      'dir'
    );

    const result = await writeNote({ vaultRoot, path: '02-wiki/externo/nota.md', content: 'ok' });
    expect(result.created).toBe(true);
    expect(await exists(path.join(vaultRoot, '01-raw', 'compartilhado', 'nota.md'))).toBe(true);
  });

  it.each([
    ['uppercase', '.GIT/refs/heads/pwn.md'],
    ['mixed case', '.Git/refs/heads/pwn.md'],
    ['a trailing dot', '.git./refs/heads/pwn.md'],
    ['a trailing space', '.git /refs/heads/pwn.md'],
    ['uppercase .obsidian', '.OBSIDIAN/plugins/p/main.md'],
    ['uppercase node_modules', '02-wiki/NODE_MODULES/x.md'],
  ])('refuses a denied directory spelled with %s', async (_label, relPath) => {
    // All four spellings of `.git` open the REAL `.git` on a case-insensitive volume, which
    // is every macOS and Windows vault, and Windows strips trailing dots and spaces from a
    // component before the filesystem ever sees it. All were confirmed creatable. Comparing
    // the segment as typed answers `false` for each one.
    await expect(
      writeNote({ vaultRoot, path: relPath, content: 'lixo' })
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it('does not mistake a note whose name merely starts with a denied one', async () => {
    // The normalisation must not become a prefix match: `.gitignore-notas.md` is a note.
    const result = await writeNote({
      vaultRoot,
      path: '02-wiki/.gitignore-notas.md',
      content: 'Sobre .gitignore.',
    });
    expect(result.created).toBe(true);
    expect(await exists(result.absPath)).toBe(true);
  });

  it('não abre um FIFO no caminho da nota ao escrever', async () => {
    // `guardedPath` answers a question about the PATH: containment, suffix, denied segments,
    // symlink escape. A FIFO inside the vault passes every one of them — it is `.md`, it is
    // contained, it is in no denied directory — and the read that follows blocks on `open()` of
    // a pipe with no writer and never returns. The server serialises writes through a queue
    // that chains onto the previous promise, so ONE of these wedges every later write for the
    // life of the process while unqueued reads keep answering: a server that looks alive with
    // its whole write surface dead.
    const fifo = path.join(vaultRoot, '02-wiki', 'cano.md');
    await execFileAsync('mkfifo', [fifo]);
    const antes = await countCommits(vaultRoot);

    const { result, opened } = await withFifoWatch(fifo, () =>
      refusal(() => writeNote({ vaultRoot, path: '02-wiki/cano.md', content: 'texto' }))
    );

    expect(opened).toBe(false);
    expect(result).toBeInstanceOf(PathGuardError);
    // Nothing was written over it and nothing was committed.
    expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
    expect(await countCommits(vaultRoot)).toBe(antes);
  }, 30_000);

  it('não abre um FIFO no caminho da nota ao editar', async () => {
    // The same hole on the other exported write path, and the same classification closes it.
    const fifo = path.join(vaultRoot, '02-wiki', 'cano.md');
    await execFileAsync('mkfifo', [fifo]);

    const { result, opened } = await withFifoWatch(fifo, () =>
      refusal(() =>
        editNote({ vaultRoot, path: '02-wiki/cano.md', oldText: 'a', newText: 'b' })
      )
    );

    expect(opened).toBe(false);
    expect(result).toBeInstanceOf(PathGuardError);
    expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
  }, 30_000);

  it('recusa um HARD link para fora do vault em vez de vazar os bytes no diff', async () => {
    // `guardedPath` cannot see this one and neither can `realpath`: a hard link has no
    // "original" to resolve to, it IS the file under a second name, and that name happens to be
    // inside the vault and to end in `.md`. Containment, suffix, denied segments and the symlink
    // walk all pass, and the read that follows hands the out-of-vault bytes to `unifiedDiff` —
    // which returns them in `WriteResult.diff`, straight into the caller's context.
    // `vault_write_note` takes the path from the caller, so this is a live route.
    const segredo = path.join(tmp, 'segredo.txt');
    const conteudoSegredo = 'chave-secreta-nao-deve-vazar\nlinha dois do segredo\n';
    await fs.writeFile(segredo, conteudoSegredo, 'utf8');
    const link = path.join(vaultRoot, '02-wiki', 'vazamento.md');
    await fs.link(segredo, link);
    const antes = await countCommits(vaultRoot);

    const resultado = await refusal(() =>
      writeNote({ vaultRoot, path: '02-wiki/vazamento.md', content: 'texto novo' })
    );

    // The payload assertion goes FIRST so the failure names the leak rather than the type:
    // without the guard this is a `WriteResult` whose `diff` carries the linked file's lines,
    // while a `PathGuardError` serialises to `{}`.
    expect(JSON.stringify(resultado)).not.toContain('chave-secreta');
    expect(resultado).toBeInstanceOf(PathGuardError);
    // Nothing was written through the link, and the file outside is byte-identical.
    expect(await fs.readFile(segredo, 'utf8')).toBe(conteudoSegredo);
    expect(await fs.readFile(link, 'utf8')).toBe(conteudoSegredo);
    expect((await fs.lstat(link)).nlink).toBe(2);
    expect(await countCommits(vaultRoot)).toBe(antes);
  });

  it('recusa um HARD link também na edição', async () => {
    const segredo = path.join(tmp, 'segredo-edit.txt');
    const conteudoSegredo = 'chave-secreta-da-edicao\n';
    await fs.writeFile(segredo, conteudoSegredo, 'utf8');
    await fs.link(segredo, path.join(vaultRoot, '02-wiki', 'vazamento-edit.md'));

    const resultado = await refusal(() =>
      editNote({
        vaultRoot,
        path: '02-wiki/vazamento-edit.md',
        oldText: 'chave-secreta-da-edicao',
        newText: 'trocado',
      })
    );

    expect(JSON.stringify(resultado)).not.toContain('chave-secreta');
    expect(resultado).toBeInstanceOf(PathGuardError);
    expect(await fs.readFile(segredo, 'utf8')).toBe(conteudoSegredo);
  });

  it('não confunde uma nota comum com um hard link', async () => {
    // The check is on the LINK COUNT, and an ordinary note has exactly one name. A guard that
    // refused every regular file would pass the two tests above and break the vault.
    const criada = await writeNote({
      vaultRoot,
      path: '02-wiki/nota-sem-link.md',
      content: 'conteudo comum',
    });
    expect(criada.created).toBe(true);
    expect((await fs.lstat(criada.absPath)).nlink).toBe(1);

    const substituida = await writeNote({
      vaultRoot,
      path: '02-wiki/nota-sem-link.md',
      content: 'conteudo trocado',
    });
    expect(substituida.created).toBe(false);
    expect(await fs.readFile(substituida.absPath, 'utf8')).toContain('conteudo trocado');
  });

  it('recusa um diretório e um symlink no caminho da nota', async () => {
    // `foreign` is not only a FIFO: a directory makes the read fail with EISDIR deep inside the
    // write instead of a guard rejection the tool layer can report, and a symlink is a name for
    // a note that lives somewhere else — the atomic rename lands ON the link, so the alias
    // becomes a regular file holding a divergent copy while the note it named never changes.
    await fs.mkdir(path.join(vaultRoot, '02-wiki', 'pasta.md'));
    await fs.writeFile(path.join(vaultRoot, '02-wiki', 'alvo-real.md'), '# Real\n', 'utf8');
    await fs.symlink('alvo-real.md', path.join(vaultRoot, '02-wiki', 'alias.md'));

    await expect(
      writeNote({ vaultRoot, path: '02-wiki/pasta.md', content: 'texto' })
    ).rejects.toBeInstanceOf(PathGuardError);
    await expect(
      writeNote({ vaultRoot, path: '02-wiki/alias.md', content: 'texto' })
    ).rejects.toBeInstanceOf(PathGuardError);
    await expect(
      editNote({ vaultRoot, path: '02-wiki/alias.md', oldText: 'Real', newText: 'Falso' })
    ).rejects.toBeInstanceOf(PathGuardError);

    // The link is still a link and the note it names is untouched.
    expect((await fs.lstat(path.join(vaultRoot, '02-wiki', 'alias.md'))).isSymbolicLink()).toBe(
      true
    );
    expect(await fs.readFile(path.join(vaultRoot, '02-wiki', 'alvo-real.md'), 'utf8')).toBe(
      '# Real\n'
    );
  });

  it('ainda cria uma nota num caminho livre e ainda substitui uma nota comum', async () => {
    // The classification must not turn into "refuse everything that is not already a file":
    // creating is the ordinary case, and replacing an ordinary note is what `writeNote` is for.
    const criada = await writeNote({ vaultRoot, path: '02-wiki/nova-comum.md', content: 'um' });
    expect(criada.created).toBe(true);
    const substituida = await writeNote({
      vaultRoot,
      path: '02-wiki/nova-comum.md',
      content: 'dois',
    });
    expect(substituida.created).toBe(false);
    expect(await fs.readFile(substituida.absPath, 'utf8')).toContain('dois');
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
    await removeTree(tmp);
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

  /**
   * `safeDiff` builds its own summary rather than calling back into `diff.js`, because
   * this is the path taken when `diff.js` has just failed. That is a defensible reason to
   * duplicate the shape — and duplication that nothing pins is duplication that drifts:
   * stubbing this copy's `countLines` to `return 0`, collapsing its header to a constant
   * `--- /dev/null`, replacing its counts with a constant and deleting its `/dev/null`
   * branch for the empty side ALL passed the suite. The three tests below read every field
   * of it, so a drift in either copy has to be a deliberate edit to a test.
   */
  it('names the file and both line counts in the recovery summary', async () => {
    const rel = '02-wiki/patterns/resumo-recuperado.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'um\nDOIS\ntres\n', 'utf8');

    const editNoteFresh = await withFailingDiff();
    const result = await editNoteFresh({
      vaultRoot,
      path: rel,
      oldText: 'DOIS',
      newText: 'dois\nextra',
    });

    expect(result.diff).toContain(`--- a/${rel}`);
    expect(result.diff).toContain(`+++ b/${rel}`);
    expect(result.diff).toContain('@@ diff indisponível @@');
    // Whole-file counts, unlike `coarseSummary`'s changed-region counts: three lines went
    // in and four came out. A constant, or a `countLines` that always answers 0, dies here.
    expect(result.diff).toContain('3 linhas antes, 4 linhas depois');
    expect(result.diff).toContain('Array buffer allocation failed');
  });

  it('renders the recovery summary against /dev/null when the edit empties the note', async () => {
    const rel = '02-wiki/patterns/esvaziada.md';
    await fs.writeFile(path.join(vaultRoot, rel), 'unica\n', 'utf8');

    const editNoteFresh = await withFailingDiff();
    const result = await editNoteFresh({ vaultRoot, path: rel, oldText: 'unica\n', newText: '' });

    expect(result.diff).toContain(`--- a/${rel}`);
    expect(result.diff).toContain('+++ /dev/null');
    expect(result.diff).toContain('1 linhas antes, 0 linhas depois');
    expect(await fs.readFile(path.join(vaultRoot, rel), 'utf8')).toBe('');
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
    await removeTree(tmp);
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
