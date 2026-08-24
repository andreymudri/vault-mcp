import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommitResult {
  committed: boolean;
  warning?: string;
}

/**
 * Stages and commits `absPaths` in `repoRoot` as a single commit with `message`.
 *
 * Uses `execFile`, never `exec` with an assembled string: the paths originate
 * from an MCP tool call made by a language model, and a shell would interpret
 * them. All paths are passed as separate argv entries after `--`.
 *
 * By the time this function runs, the files are already written to disk. It
 * never throws — a git failure (no repository, git absent from PATH, nothing
 * staged) is caught and reported as `{ committed: false, warning }` so the
 * caller never mistakes a commit failure for the note itself failing to be
 * written.
 */
export async function commitFiles(
  repoRoot: string,
  absPaths: string[],
  message: string
): Promise<CommitResult> {
  // With no paths, `git commit -m <msg> --` has no pathspec at all and commits
  // the entire index — including unrelated work already staged by the user.
  // Refuse to run git in that case rather than risk sweeping in a stranger's
  // changes under this tool's commit message.
  if (absPaths.length === 0) {
    return { committed: false, warning: 'nada a commitar: nenhum arquivo informado' };
  }

  try {
    await execFileAsync('git', ['-C', repoRoot, '--literal-pathspecs', 'add', '--', ...absPaths]);
  } catch (err) {
    return { committed: false, warning: `falha ao adicionar arquivos ao git: ${errorMessage(err)}` };
  }

  // Ask git's own bookkeeping whether anything is actually staged for these
  // exact paths, rather than reading the prose `git commit` prints on
  // failure. That prose is not ours: it interleaves a pre-commit hook's
  // stderr, a commit-msg hook echoing the message, and filenames git echoes
  // back -- and here the filename is `slug(titulo)` and the message is
  // `docs(vault): {titulo}`, with the title chosen by a language model over
  // web content clipped into the vault. Any phrase the classifier looks for,
  // including one at column 0, can be injected through that path (an
  // injected string carries its own newlines, so anchoring does not help).
  // An exit status cannot be. This also covers every wording, present and
  // future, localized or not -- including `nothing added to commit but
  // untracked files present`, which a vault holding any untracked draft or
  // `.obsidian/workspace.json` produces as its normal state.
  //
  // Ordering: this must run *after* `add`, so it sees exactly what `add`
  // staged, and immediately *before* `commit` with the identical
  // `--literal-pathspecs` and pathspecs, so it answers precisely the
  // question the commit is about to ask. Nothing runs in between that could
  // invalidate it. A concurrent writer could still change the index in that
  // window, but then the commit fails and is reported as a real failure --
  // the safe direction, since the benign classification is only ever granted
  // by a check that positively observed an empty staged diff.
  try {
    await execFileAsync('git', [
      '-C',
      repoRoot,
      '--literal-pathspecs',
      'diff',
      '--cached',
      '--quiet',
      '--',
      ...absPaths,
    ]);
    // Exit 0: no staged difference for these paths. The benign no-op.
    return { committed: false, warning: 'nada a commitar: arquivos sem alteração' };
  } catch (err) {
    // Exit 1 is `--quiet`'s "there are differences" signal: proceed to commit.
    // Anything else (128, a spawn failure) is a genuine error.
    if (exitCode(err) !== 1) {
      return {
        committed: false,
        warning: `falha ao verificar alterações no git: ${errorMessage(err)}`,
      };
    }
  }

  try {
    await execFileAsync('git', [
      '-C',
      repoRoot,
      '--literal-pathspecs',
      'commit',
      '-m',
      message,
      '--',
      ...absPaths,
    ]);
  } catch (err) {
    // There *was* something staged, so a failure here is real: a rejecting
    // hook, an unset identity, a locked index. Surface the diagnostic.
    return { committed: false, warning: `falha ao commitar: ${errorMessage(err)}` };
  }

  return { committed: true };
}

/**
 * The process exit status of an execFile rejection, or `undefined` when the
 * child never ran (`err.code` is then a string like `ENOENT`).
 */
function exitCode(err: unknown): number | undefined {
  if (err instanceof Error) {
    const { code } = err as Error & { code?: number | string };
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/**
 * Combines an execFile rejection's stdout and stderr. Used only to build the
 * diagnostic text of a warning: no control-flow decision is taken on git's
 * prose, because that prose carries hook output and LLM-chosen filenames and
 * commit messages derived from untrusted note content. Whether a failure was
 * a benign no-op is decided by `git diff --cached --quiet`'s exit status
 * above, before the commit is ever attempted.
 */
function errorStreams(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stdout?: string; stderr?: string };
    return [withStreams.stdout, withStreams.stderr]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Combines an execFile rejection's message, stdout and stderr for diagnostics. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const streams = errorStreams(err);
    return streams.length > 0 ? `${err.message}: ${streams}` : err.message;
  }
  return String(err);
}
