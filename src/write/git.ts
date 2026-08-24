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
  try {
    await execFileAsync('git', ['-C', repoRoot, 'add', '--', ...absPaths]);
  } catch (err) {
    return { committed: false, warning: `falha ao adicionar arquivos ao git: ${errorMessage(err)}` };
  }

  try {
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', message, '--', ...absPaths]);
  } catch (err) {
    const msg = errorMessage(err);
    if (/nothing to commit|nada a submeter|nada.*commit/i.test(msg)) {
      return { committed: false, warning: 'nada a commitar: arquivos sem alteração' };
    }
    return { committed: false, warning: `falha ao commitar: ${msg}` };
  }

  return { committed: true };
}

/** Combines an execFile rejection's message, stdout and stderr for diagnostics. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stdout?: string; stderr?: string };
    const parts = [withStreams.stdout, withStreams.stderr]
      .map((s) => (s ?? '').trim())
      .filter(Boolean);
    return parts.length > 0 ? `${err.message}: ${parts.join(' ')}` : err.message;
  }
  return String(err);
}
