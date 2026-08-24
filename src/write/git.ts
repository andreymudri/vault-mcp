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
    const streams = errorStreams(err);
    if (/nothing to commit|nada a submeter|nada.*commit/i.test(streams)) {
      return { committed: false, warning: 'nada a commitar: arquivos sem alteração' };
    }
    return { committed: false, warning: `falha ao commitar: ${errorMessage(err)}` };
  }

  return { committed: true };
}

/**
 * Combines only an execFile rejection's stdout and stderr — never its
 * `.message`, which node builds from the reconstructed command line (e.g.
 * `Command failed: git -C <repoRoot> commit ...`). Matching "nothing to
 * commit" detection against that message would let a repo path containing
 * the word "nada" or "commit" masquerade every real git failure (unset
 * identity, a pre-commit hook, index.lock) as "nothing to commit".
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
