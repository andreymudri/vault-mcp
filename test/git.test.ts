import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitFiles, headBlobState, headSha } from '../src/write/git.js';

const execFileAsync = promisify(execFile);

/** Runs a git command in `repoRoot`, returning trimmed stdout. */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

/**
 * `git init` with the background writer turned OFF.
 *
 * `gc --auto` is dispatched by git after ordinary commands and OUTLIVES the command this test
 * awaited, so a throwaway repository can still be growing objects while the teardown removes it.
 * Nothing here needs packing — the repositories live for one test.
 */
async function initScratchRepo(repoRoot: string): Promise<void> {
  await git(repoRoot, ['init']);
  await git(repoRoot, ['config', 'gc.auto', '0']);
}

/**
 * Teardown that tolerates a transient writer inside a throwaway repository.
 *
 * A plain `fs.rm` raced git and failed once in the gate with `ENOTEMPTY: rmdir '.../vault/.git'`.
 * The retries are `fs.rm`'s own answer to exactly that, and `gc.auto 0` above removes the writer.
 * The same pair `test/writer.test.ts` and `test/learn.test.ts` already carry — a test that fails by
 * accident is worse than a slow one.
 */
async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe('commitFiles', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-git-test-'));
    await initScratchRepo(repoRoot);
    await git(repoRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(repoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
  });

  afterEach(async () => {
    await removeTree(repoRoot);
  });

  it('commits a single new file with the given message', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

    expect(result).toEqual({ committed: true });
    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toContain('feat: adicionar nota');
  });

  it('commits three files in a single commit', async () => {
    const files = ['nota.md', 'moc.md', 'index.md'];
    const absPaths = files.map((f) => path.join(repoRoot, f));
    for (const absPath of absPaths) {
      await fs.writeFile(absPath, `conteudo de ${path.basename(absPath)}\n`, 'utf8');
    }

    const result = await commitFiles(repoRoot, absPaths, 'feat: aprender novo conceito');

    expect(result).toEqual({ committed: true });

    const logBefore = await git(repoRoot, ['log', '--oneline']);
    expect(logBefore.split('\n')).toHaveLength(1);

    const nameOnly = await git(repoRoot, ['show', '--name-only', '--pretty=format:']);
    const committedFiles = nameOnly
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    expect(committedFiles).toEqual([...files].sort());
  });

  it('returns { committed: false, warning } without throwing when not a git repository', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-not-a-repo-'));
    try {
      const absPath = path.join(notARepo, 'nota.md');
      await fs.writeFile(absPath, '# Nota\n', 'utf8');

      const result = await commitFiles(notARepo, [absPath], 'feat: adicionar nota');

      expect(result.committed).toBe(false);
      expect(result.warning).toBeTruthy();
    } finally {
      await removeTree(notARepo);
    }
  });

  it('returns { committed: false } with a warning when there is nothing to commit', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    const first = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');
    expect(first.committed).toBe(true);

    // Same content, no changes staged the second time around.
    const second = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota de novo');

    expect(second.committed).toBe(false);
    expect(second.warning).toBeTruthy();
    // Benign, not a failure: an otherwise pristine repo whose target file is
    // simply unchanged.
    expect(second.warning).not.toContain('falha ao commitar');

    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
  });

  it('treats "no changes added to commit" from an unrelated modified tracked file as a benign no-op, not a git failure', async () => {
    // The target file itself is unchanged, but a different tracked file has
    // an unstaged modification. Under `--literal-pathspecs commit -- <target>`
    // this makes git exit 1 printing "no changes added to commit" -- a
    // different message than "nothing to commit" -- verified with git
    // 2.55.0. This is the normal case, not an edge case: the user's vault is
    // a git repo they actively work in, so it routinely has unrelated
    // pending edits, and re-learning an unchanged note has exactly this
    // shape. It must be classified as a benign no-op, not surfaced as
    // `falha ao commitar`, and must not leak the unrelated filename back.
    const targetPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(targetPath, '# Nota\n', 'utf8');
    const unrelatedPath = path.join(repoRoot, 'outra-nota.md');
    await fs.writeFile(unrelatedPath, 'conteudo original\n', 'utf8');
    await git(repoRoot, ['add', targetPath, unrelatedPath]);
    await git(repoRoot, ['commit', '-m', 'chore: seed']);

    // Modify the unrelated tracked file without ever passing it to commitFiles.
    await fs.writeFile(unrelatedPath, 'conteudo modificado\n', 'utf8');

    const result = await commitFiles(repoRoot, [targetPath], 'feat: reaprender nota inalterada');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toContain('falha ao commitar');
    expect(result.warning).not.toContain('outra-nota.md');

    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toContain('outra-nota.md');
  });

  it('uses the passed message literally', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    const message = 'fix: corrigir link quebrado em nestjs-moc';

    await commitFiles(repoRoot, [absPath], message);

    const subject = await git(repoRoot, ['log', '-1', '--pretty=%s']);
    expect(subject).toBe(message);
  });

  it('never invokes a shell, even when the path is a shell injection attempt', async () => {
    // A path containing `; touch <repo>/PWNED` is only dangerous if the paths
    // are ever interpolated into a shell command string (e.g. via
    // `exec` + a template literal). Passed as a single execFile argv entry,
    // git will simply fail to find a file with this literal, absurd name.
    const maliciousPath = path.join(repoRoot, `nota.md; touch ${repoRoot}/PWNED`);

    const result = await commitFiles(repoRoot, [maliciousPath], 'feat: tentativa de injecao');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    await expect(fs.access(path.join(repoRoot, 'PWNED'))).rejects.toThrow();
  });

  it('is a no-op returning { committed: false, warning } for an empty path list, without touching the index', async () => {
    const unrelated = path.join(repoRoot, 'trabalho-do-usuario.md');
    await fs.writeFile(unrelated, 'algo nao relacionado\n', 'utf8');
    await git(repoRoot, ['add', unrelated]);

    const result = await commitFiles(repoRoot, [], 'feat: commit vazio');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();

    await expect(git(repoRoot, ['log', '--oneline'])).rejects.toThrow();
    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toContain('trabalho-do-usuario.md');
  });

  it('treats a path containing a glob character literally, never as a wildcard', async () => {
    // The file to commit is literally named with a `*` in it (a legal
    // filename on this filesystem). A sibling file whose name a glob
    // expansion of `target*.md` would incorrectly match, but which the tool
    // was never told about.
    const globLikePath = path.join(repoRoot, 'target*.md');
    await fs.writeFile(globLikePath, '# Target\n', 'utf8');
    const untouchedPath = path.join(repoRoot, 'targetX.md');
    await fs.writeFile(untouchedPath, '# Nao deveria ser tocado\n', 'utf8');

    const result = await commitFiles(repoRoot, [globLikePath], 'feat: commit com glob literal');

    // Without --literal-pathspecs (on either the `add` or the `commit`
    // step), git's default pathspec magic treats `*` as a wildcard even
    // though it arrived as a single execFile argv entry with no shell
    // involved — so `target*.md` would also match `targetX.md`.
    expect(result).toEqual({ committed: true });

    const nameOnly = await git(repoRoot, ['show', '--name-only', '--pretty=format:']);
    const committedFiles = nameOnly
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(committedFiles).toEqual(['target*.md']);

    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toBe('?? targetX.md');
  });

  it('does not let a glob-like pathspec at the commit step sweep in an already-staged unrelated file', async () => {
    // This isolates --literal-pathspecs on the `commit` invocation
    // specifically: targetX.md is staged by something other than
    // commitFiles (simulating unrelated in-flight work), before
    // commitFiles ever runs its own `add`. If `commit`'s pathspec matching
    // is not literal, `target*.md` would match the already-staged
    // targetX.md too and pull it into the commit, even though commitFiles's
    // own `add` step never touched it.
    const globLikePath = path.join(repoRoot, 'target*.md');
    await fs.writeFile(globLikePath, '# Target\n', 'utf8');
    const unrelatedPath = path.join(repoRoot, 'targetX.md');
    await fs.writeFile(unrelatedPath, '# Nao deveria ser tocado\n', 'utf8');
    await git(repoRoot, ['add', unrelatedPath]);

    const result = await commitFiles(repoRoot, [globLikePath], 'feat: commit com glob literal');

    expect(result).toEqual({ committed: true });

    const nameOnly = await git(repoRoot, ['show', '--name-only', '--pretty=format:']);
    const committedFiles = nameOnly
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(committedFiles).toEqual(['target*.md']);

    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toBe('A  targetX.md');
  });

  it('commits only the given files, leaving an unrelated modified file untouched', async () => {
    const trackedPath = path.join(repoRoot, 'ja-existente.md');
    await fs.writeFile(trackedPath, 'conteudo original\n', 'utf8');
    await git(repoRoot, ['add', trackedPath]);
    await git(repoRoot, ['commit', '-m', 'chore: seed']);

    // Modify the already-tracked file without including it in the call.
    await fs.writeFile(trackedPath, 'conteudo modificado sem passar por commitFiles\n', 'utf8');

    const newPath = path.join(repoRoot, 'nova.md');
    await fs.writeFile(newPath, '# Nova\n', 'utf8');

    const result = await commitFiles(repoRoot, [newPath], 'feat: adicionar apenas nova');

    expect(result).toEqual({ committed: true });

    const nameOnly = await git(repoRoot, ['show', '--name-only', '--pretty=format:']);
    const committedFiles = nameOnly
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(committedFiles).toEqual(['nova.md']);

    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toContain('ja-existente.md');
  });

  it('does not mistake a real commit failure for "nothing to commit" just because the repo path contains "nada"', async () => {
    // Node's execFile rejection `.message` is built from the reconstructed
    // command line, e.g. `Command failed: git -C <repoRoot> commit ...`. If
    // the repo path happens to contain "nada", that reconstructed line alone
    // satisfies a naive `nada.*commit` check — hiding a genuine failure
    // (here: no git identity configured) behind a false "nothing to commit".
    const nadaRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-nada-repo-'));
    try {
      await initScratchRepo(nadaRepoRoot);
      await git(nadaRepoRoot, ['config', 'user.name', 'Vault MCP Test']);
      await git(nadaRepoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);

      // A failing pre-commit hook forces a real, deterministic commit
      // failure that has nothing to do with "nothing staged".
      const hookPath = path.join(nadaRepoRoot, '.git', 'hooks', 'pre-commit');
      await fs.writeFile(
        hookPath,
        '#!/bin/sh\necho "recusado pelo hook de pre-commit" >&2\nexit 1\n',
        'utf8'
      );
      await fs.chmod(hookPath, 0o755);

      const absPath = path.join(nadaRepoRoot, 'nota.md');
      await fs.writeFile(absPath, '# Nota\n', 'utf8');

      const result = await commitFiles(nadaRepoRoot, [absPath], 'feat: adicionar nota');

      expect(result.committed).toBe(false);
      expect(result.warning).toBeTruthy();
      // Assert on an observable, not on a copy of the source's literal
      // fallback string: the real pre-commit hook failure must actually be
      // surfaced (its own stderr text present in the warning), rather than
      // silently swallowed behind the fixed "nothing to commit" message.
      expect(result.warning).toContain('recusado pelo hook de pre-commit');
    } finally {
      await removeTree(nadaRepoRoot);
    }
  });

  it('does not mistake a real commit failure for "nothing to commit" just because the target file is named "nada-para-commit.md"', async () => {
    // Many real-world pre-commit hooks echo which file(s) they rejected as
    // their very first line of diagnostics (e.g. a linter listing the
    // failing paths). If the target file itself is named e.g.
    // `nada-para-commit.md` -- plausible here, since the filename comes from
    // `slug(titulo)` and the title is LLM-chosen from untrusted note content
    // -- a loose `nada.*commit` check matches that filename directly (`nada`
    // ... `commit` inside `nada-para-commit.md`), even though it leads the
    // line -- so anchoring to line-start alone cannot save it. Only dropping
    // the loose alternative does. This must be reported as a genuine
    // failure.
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(
      hookPath,
      '#!/bin/sh\ngit diff --cached --name-only >&2\necho "rejeitado pela politica do vault" >&2\nexit 1\n',
      'utf8'
    );
    await fs.chmod(hookPath, 0o755);

    const absPath = path.join(repoRoot, 'nada-para-commit.md');
    await fs.writeFile(absPath, '# Nada para commit\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toBe('nada a commitar: arquivos sem alteração');
    expect(result.warning).toContain('falha ao commitar');
    expect(result.warning).toContain('nada-para-commit.md');
    expect(result.warning).toContain('rejeitado pela politica do vault');

    await expect(git(repoRoot, ['log', '--oneline'])).rejects.toThrow();
  });

  it('does not mistake a real commit failure for "nothing to commit" when a hook\'s stderr contains that phrase mid-sentence', async () => {
    // Git always prints "no changes added to commit" as its own line. A
    // hook can print the same words buried inside an unrelated sentence
    // (e.g. as part of its own policy message) while genuinely rejecting
    // the commit. Unanchored matching lets that masquerade as the benign
    // no-op; anchored-to-line-start matching must not.
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(
      hookPath,
      '#!/bin/sh\necho "politica do vault: no changes added to commit sem revisao" >&2\nexit 1\n',
      'utf8'
    );
    await fs.chmod(hookPath, 0o755);

    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toBe('nada a commitar: arquivos sem alteração');
    expect(result.warning).toContain('falha ao commitar');
    expect(result.warning).toContain('politica do vault: no changes added to commit sem revisao');

    await expect(git(repoRoot, ['log', '--oneline'])).rejects.toThrow();
  });

  it('does not mistake a real hook rejection for a no-op when the note body a pre-commit hook echoes puts "nothing to commit" at line start', async () => {
    // Reproduced against real git: a pre-commit hook that echoes the staged
    // note body (a linter, a policy check quoting the offending content)
    // merges that body into the streams commitFiles sees. The note body is
    // clipped web content, so it can contain a line that is exactly
    // `nothing to commit` at column 0. Anchoring the prose match to line
    // start does not help -- the injected text carries its own newlines.
    // Only asking git structurally what is staged is immune.
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(
      hookPath,
      '#!/bin/sh\nfor f in $(git diff --cached --name-only); do cat "$f" >&2; done\nexit 1\n',
      'utf8'
    );
    await fs.chmod(hookPath, 0o755);

    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(
      absPath,
      '# Nota\n\nTrecho clipado da web:\nnothing to commit\n\nfim.\n',
      'utf8'
    );

    const result = await commitFiles(repoRoot, [absPath], 'docs(vault): Nota clipada');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toBe('nada a commitar: arquivos sem alteração');
    expect(result.warning).toContain('falha ao commitar');

    // The rejection was real: nothing was committed.
    await expect(git(repoRoot, ['log', '--oneline'])).rejects.toThrow();
  });

  it('does not mistake a real hook rejection for a no-op when a commit-msg hook echoes a message whose title carries a newline', async () => {
    // The commit message is `docs(vault): {titulo}` with an LLM-chosen
    // title over untrusted note content, so the title can embed a newline.
    // A commit-msg hook that cats the message file (the common shape for
    // conventional-commit linters) then emits `nothing to commit` at column
    // 0 while genuinely rejecting the commit.
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'commit-msg');
    await fs.writeFile(hookPath, '#!/bin/sh\ncat "$1" >&2\nexit 1\n', 'utf8');
    await fs.chmod(hookPath, 0o755);

    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const message = 'docs(vault): Guia\nnothing to commit\n';
    const result = await commitFiles(repoRoot, [absPath], message);

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toBe('nada a commitar: arquivos sem alteração');
    expect(result.warning).toContain('falha ao commitar');

    await expect(git(repoRoot, ['log', '--oneline'])).rejects.toThrow();
  });

  it('treats "nothing added to commit but untracked files present" as a benign no-op', async () => {
    // A vault holding any untracked file -- a draft, `.obsidian/workspace.json`
    // -- makes git print this fifth wording instead of "nothing to commit"
    // when the declared paths are unchanged. That is the normal state of a
    // real vault, and it is a benign no-op, not `falha ao commitar`.
    const targetPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(targetPath, '# Nota\n', 'utf8');
    const first = await commitFiles(repoRoot, [targetPath], 'docs(vault): Nota');
    expect(first.committed).toBe(true);

    await fs.mkdir(path.join(repoRoot, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '.obsidian', 'workspace.json'), '{}\n', 'utf8');

    const result = await commitFiles(repoRoot, [targetPath], 'docs(vault): Nota de novo');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toContain('falha ao commitar');

    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
    // The untracked file stayed untracked: the no-op check never staged it.
    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toContain('?? .obsidian/');
  });

  it('asks whether anything is staged with literal pathspecs, so a glob-like target is not answered for by a sibling', async () => {
    // The staged-check must ask exactly the question the commit will ask.
    // Target `target*.md` is committed and unchanged; the sibling
    // `targetX.md`, which a glob expansion would match, has a staged
    // change the tool was never told about. Without --literal-pathspecs on
    // the check, the sibling answers "yes, something is staged", the commit
    // is attempted, and its own literal pathspec finds nothing -- turning a
    // benign no-op into `falha ao commitar`.
    const globLikePath = path.join(repoRoot, 'target*.md');
    await fs.writeFile(globLikePath, '# Target\n', 'utf8');
    const siblingPath = path.join(repoRoot, 'targetX.md');
    await fs.writeFile(siblingPath, '# Irmao\n', 'utf8');
    await git(repoRoot, ['--literal-pathspecs', 'add', '--', globLikePath, siblingPath]);
    await git(repoRoot, ['commit', '-m', 'chore: seed']);

    await fs.writeFile(siblingPath, '# Irmao modificado\n', 'utf8');
    await git(repoRoot, ['--literal-pathspecs', 'add', '--', siblingPath]);

    const result = await commitFiles(repoRoot, [globLikePath], 'docs(vault): Target');

    expect(result.committed).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).not.toContain('falha ao commitar');

    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
    const status = await git(repoRoot, ['status', '--porcelain']);
    expect(status).toBe('M  targetX.md');
  });
});

/**
 * O vault do usuário é um repositório com remote: um commit local que nunca sai da máquina não é o
 * vault "atualizado", é uma cópia divergindo em silêncio. O push é opt-in (`VAULT_AUTO_PUSH`) porque
 * é a única coisa que este servidor faz que sai da máquina, e falha SEMPRE como aviso — a nota já
 * está em disco e commitada, e desfazer isso porque a rede caiu seria o pior negócio possível.
 */
describe('commitFiles — push', () => {
  let origin: string;
  let repoRoot: string;

  beforeEach(async () => {
    origin = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-origin-'));
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', origin]);

    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-push-'));
    await initScratchRepo(repoRoot);
    // Nome do branch fixado nos dois lados: `init.defaultBranch` é config do usuário, e um teste
    // que empurra `master` para um bare chamado `main` falha por causa da máquina, não do código.
    await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(repoRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(repoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
    await git(repoRoot, ['remote', 'add', 'origin', origin]);
    await fs.writeFile(path.join(repoRoot, 'semente.md'), '# Semente\n', 'utf8');
    await git(repoRoot, ['add', '--all']);
    await git(repoRoot, ['commit', '-m', 'chore: semente']);
    await git(repoRoot, ['push', '--set-upstream', 'origin', 'HEAD']);
  });

  afterEach(async () => {
    await removeTree(repoRoot);
    await removeTree(origin);
  });

  /** A mensagem do commit no topo do remote — a única prova de que o push aconteceu. */
  async function remoteHead(): Promise<string> {
    return git(origin, ['log', '--format=%s', '-1', 'main']);
  }

  it('leva o commit para o remote quando o push está ligado', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota', { push: true });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(await remoteHead()).toBe('feat: adicionar nota');
  });

  it('não empurra nada quando o push não é pedido', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

    expect(result.committed).toBe(true);
    expect(result.pushed).toBeUndefined();
    // O commit é local, e o remote continua onde estava.
    expect(await remoteHead()).toBe('chore: semente');
  });

  it('um push que falha vira AVISO, com o commit intacto', async () => {
    await git(repoRoot, ['remote', 'set-url', 'origin', path.join(origin, 'nao-existe')]);
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota', { push: true });

    // O que importa: o commit CONTINUA valendo. Um push que falhou não desfaz nada.
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.warning).toContain('push');
    expect(await git(repoRoot, ['log', '--format=%s', '-1'])).toBe('feat: adicionar nota');
  });

  it('um remote que andou na frente falha como aviso, sem rebase automático', async () => {
    // Outra máquina (o plugin do Obsidian, outro clone) commitou e empurrou primeiro.
    const outro = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-outro-'));
    try {
      await execFileAsync('git', ['clone', origin, outro]);
      await git(outro, ['config', 'user.name', 'Outra Maquina']);
      await git(outro, ['config', 'user.email', 'outra@example.com']);
      await fs.writeFile(path.join(outro, 'de-fora.md'), '# De fora\n', 'utf8');
      await git(outro, ['add', '--all']);
      await git(outro, ['commit', '-m', 'docs(vault): de outra maquina']);
      await git(outro, ['push', 'origin', 'HEAD:main']);

      const absPath = path.join(repoRoot, 'nota.md');
      await fs.writeFile(absPath, '# Nota\n', 'utf8');
      const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota', { push: true });

      expect(result.committed).toBe(true);
      expect(result.pushed).toBe(false);
      expect(result.warning).toContain('push');
      // NADA de rebase automático: o trabalho da outra máquina continua sendo o topo do remote.
      expect(await remoteHead()).toBe('docs(vault): de outra maquina');
    } finally {
      await removeTree(outro);
    }
  });

  it('não tenta empurrar quando não houve commit', async () => {
    const absPath = path.join(repoRoot, 'semente.md');

    const result = await commitFiles(repoRoot, [absPath], 'feat: nada mudou', { push: true });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBeUndefined();
    expect(await remoteHead()).toBe('chore: semente');
  });

  it('VAULT_AUTO_PUSH=1 liga o push sem o chamador pedir', async () => {
    const antes = process.env.VAULT_AUTO_PUSH;
    process.env.VAULT_AUTO_PUSH = '1';
    try {
      const absPath = path.join(repoRoot, 'nota.md');
      await fs.writeFile(absPath, '# Nota\n', 'utf8');

      const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

      expect(result.pushed).toBe(true);
      expect(await remoteHead()).toBe('feat: adicionar nota');
    } finally {
      if (antes === undefined) delete process.env.VAULT_AUTO_PUSH;
      else process.env.VAULT_AUTO_PUSH = antes;
    }
  });
});

/**
 * A pergunta que `vault_delete` faz ao git ANTES de destruir qualquer coisa.
 *
 * Apagar uma nota é a única operação deste servidor que não tem volta pelo próprio servidor,
 * e o que a torna reversível não é nada que este código faça: é existir um blob no `HEAD`. Se
 * não existe — o vault não é repositório, ou a nota foi criada e nunca commitada — a exclusão
 * é irreversível de verdade, e a tool para e diz isso em vez de apagar e avisar depois.
 *
 * "Rastreada mas suja" é uma terceira resposta, e não uma recusa: a restauração existe, só que
 * ela traz de volta a versão COMMITADA e não o que está no disco agora. O usuário decide com
 * essa frase na mão.
 */
describe('headBlobState', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-head-test-'));
    await initScratchRepo(repoRoot);
    await git(repoRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(repoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
  });

  afterEach(async () => {
    await removeTree(repoRoot);
  });

  it('reconhece uma nota commitada e limpa', async () => {
    await fs.writeFile(path.join(repoRoot, 'nota.md'), '# Nota\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);

    expect(await headBlobState(repoRoot, 'nota.md')).toEqual({ inHead: true, modified: false });
  });

  it('reconhece uma nota commitada com edição não commitada', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);
    await fs.writeFile(absPath, '# Nota editada\n', 'utf8');

    expect(await headBlobState(repoRoot, 'nota.md')).toEqual({ inHead: true, modified: true });
  });

  it('conta como modificada a edição que está apenas no índice', async () => {
    // `git add` sem commit não põe blob nenhum no HEAD. Comparar contra o índice em vez de
    // contra o HEAD diria "limpa" aqui, e a restauração perderia a edição já staged sem avisar.
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);
    await fs.writeFile(absPath, '# Nota editada\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);

    expect(await headBlobState(repoRoot, 'nota.md')).toEqual({ inHead: true, modified: true });
  });

  it('recusa uma nota nunca commitada', async () => {
    await fs.writeFile(path.join(repoRoot, 'nota.md'), '# Nota\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);
    await fs.writeFile(path.join(repoRoot, 'nova.md'), '# Nova\n', 'utf8');

    const state = await headBlobState(repoRoot, 'nova.md');
    expect(state.inHead).toBe(false);
    expect(state.reason).toBeDefined();
  });

  it('recusa quando o repositório não tem commit nenhum', async () => {
    await fs.writeFile(path.join(repoRoot, 'nota.md'), '# Nota\n', 'utf8');

    const state = await headBlobState(repoRoot, 'nota.md');
    expect(state.inHead).toBe(false);
  });

  it('recusa quando o diretório não é um repositório git', async () => {
    // O vault do usuário pode simplesmente não ser um repositório. Nesse caso NADA aqui é
    // reversível, e essa é justamente a informação que a recusa carrega.
    const semGit = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-sem-git-'));
    try {
      await fs.writeFile(path.join(semGit, 'nota.md'), '# Nota\n', 'utf8');
      const state = await headBlobState(semGit, 'nota.md');
      expect(state.inHead).toBe(false);
      expect(state.reason).toBeDefined();
    } finally {
      await removeTree(semGit);
    }
  });

  it('não confunde uma nota com outra de nome parecido', async () => {
    await fs.mkdir(path.join(repoRoot, '02-wiki'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, '02-wiki', 'nota.md'), '# Nota\n', 'utf8');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);

    expect((await headBlobState(repoRoot, '02-wiki/nota.md')).inHead).toBe(true);
    expect((await headBlobState(repoRoot, 'nota.md')).inHead).toBe(false);
  });
});

describe('headSha', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-sha-test-'));
    await initScratchRepo(repoRoot);
    await git(repoRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(repoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
  });

  afterEach(async () => {
    await removeTree(repoRoot);
  });

  it('devolve o sha do commit no topo', async () => {
    await fs.writeFile(path.join(repoRoot, 'nota.md'), '# Nota\n', 'utf8');
    await git(repoRoot, ['add', 'nota.md']);
    await git(repoRoot, ['commit', '-m', 'docs: nota']);

    const sha = await headSha(repoRoot);
    expect(sha).toBe(await git(repoRoot, ['rev-parse', 'HEAD']));
  });

  it('devolve undefined onde não há HEAD', async () => {
    // Sem isso, a frase de desfazer que a tool devolve sairia com um `undefined` no meio, o
    // que é pior do que não oferecer desfazer nenhum: é um comando que o usuário vai colar.
    expect(await headSha(repoRoot)).toBeUndefined();
  });
});
