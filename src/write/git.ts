import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommitResult {
  committed: boolean;
  /**
   * Whether the commit reached the remote. `undefined` when no push was attempted — either it was
   * not asked for, or there was no commit to push — which is deliberately distinct from `false`,
   * "it was attempted and did not get there".
   */
  pushed?: boolean;
  warning?: string;
}

export interface CommitOptions {
  /**
   * Push the branch after a successful commit. Defaults to the `VAULT_AUTO_PUSH` environment
   * variable, and therefore to OFF.
   *
   * Off by default because this is the only thing the server does that leaves the machine. A vault
   * with a remote is a vault kept on more than one, though, and a commit that never leaves is not
   * "the vault updated" — it is a copy diverging quietly, which is the failure the remote exists to
   * prevent.
   */
  push?: boolean;
}

/**
 * How long a push may take before it is killed.
 *
 * A push talks to the network from inside a single-threaded stdio server, so an unbounded one is a
 * server that stops answering — the same wedge class as a blocking read. Generous enough for a slow
 * link and a large pack, short enough that the caller gets an answer.
 */
const PUSH_TIMEOUT_MS = 30_000;

/** `VAULT_AUTO_PUSH=1` (or `true`) turns the push on for every write. Anything else is off. */
function autoPushEnabled(): boolean {
  const raw = process.env.VAULT_AUTO_PUSH?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
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
  message: string,
  options: CommitOptions = {}
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

  if (!(options.push ?? autoPushEnabled())) return { committed: true };
  return { committed: true, ...(await pushBranch(repoRoot)) };
}

/**
 * What git knows about `relPath`, asked BEFORE anything is destroyed.
 *
 * `vault_delete` is the one operation in this server that this server cannot undo, and what
 * makes it undoable at all is not anything the code does: it is a blob existing in `HEAD`. So
 * the deletion is gated on that fact rather than on a `confirm` flag alone — a flag confirms
 * intent, and intent is not the same question as recoverability.
 *
 * The three answers are genuinely different and each drives a different behaviour:
 *
 * - `inHead: true, modified: false` — delete freely, `git checkout <sha>^ -- <path>` brings it
 *   back exactly.
 * - `inHead: true, modified: true` — deletion is still recoverable, but what comes back is the
 *   COMMITTED version and not what is on disk right now. That is a warning the user reads
 *   before deciding, never a refusal: it is their edit and their call.
 * - `inHead: false` — the vault is not a repository, or the note was written and never
 *   committed. Nothing brings it back, and `vault_delete` stops there.
 *
 * `rev-parse --verify HEAD:<path>` is the whole question in one command: it fails on a
 * repository with no commits, on a directory that is not a repository, and on a path that is
 * not in the tree, and every one of those is `inHead: false` for the same reason.
 *
 * `modified` is measured against `HEAD` and NOT against the index. A note that was edited and
 * `git add`ed has no blob of that edit anywhere in a commit, so comparing against the index
 * would report it clean and the restore would silently drop the staged work.
 */
export interface HeadBlobState {
  /** True when `HEAD:<relPath>` names a blob — i.e. a delete is recoverable from git. */
  inHead: boolean;
  /** True when the working tree differs from that blob. Meaningless when `inHead` is false. */
  modified: boolean;
  /** Git's own diagnostic, when it is what answered `inHead: false`. */
  reason?: string;
}

export async function headBlobState(repoRoot: string, relPath: string): Promise<HeadBlobState> {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', `HEAD:${relPath}`]);
  } catch (err) {
    return { inHead: false, modified: false, reason: errorMessage(err) };
  }

  try {
    await execFileAsync('git', [
      '-C',
      repoRoot,
      '--literal-pathspecs',
      'diff',
      '--quiet',
      'HEAD',
      '--',
      relPath,
    ]);
    return { inHead: true, modified: false };
  } catch (err) {
    // Exit 1 is `--quiet`'s "there are differences". Anything else is git failing to answer,
    // and an unanswered question about the user's own edits is reported as "modified": the
    // warning it produces is the cautious direction, and the blob is in `HEAD` either way.
    return exitCode(err) === 1
      ? { inHead: true, modified: true }
      : { inHead: true, modified: true, reason: errorMessage(err) };
  }
}

/**
 * The sha at `HEAD`, or `undefined` where there is none.
 *
 * `vault_delete` names the exact command that undoes it, and the command has to carry a sha
 * rather than `HEAD^`: the user may commit again before they read the answer, and by then
 * `HEAD^` names something else entirely. `undefined` rather than a placeholder, because a
 * command with `undefined` spliced into it is worse than offering no undo at all — it is a
 * line the user will paste.
 */
export async function headSha(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    return sha === '' ? undefined : sha;
  } catch {
    // No commits, or not a repository. Both mean there is no sha to name.
    return undefined;
  }
}

/**
 * Pushes the current branch, reporting failure as a WARNING and never as a rollback.
 *
 * The commit already happened and the note is already on disk. Undoing either because the network
 * was down, or because someone pushed first from another machine, would be the worst trade
 * available — so every failure here comes back as text the caller shows, with git's own diagnostic
 * inside it.
 *
 * `git push` with no refspec, deliberately: it follows the branch's configured upstream, so a
 * repository that has not been told where to push says so instead of having a remote and a branch
 * guessed for it.
 *
 * **A rejected push is NOT resolved automatically.** A vault whose remote moved ahead needs a pull,
 * a rebase or a merge, and every one of those rewrites the user's knowledge base — a decision that
 * is theirs and not a side effect of writing one note. The warning names the situation and stops.
 */
async function pushBranch(repoRoot: string): Promise<{ pushed: boolean; warning?: string }> {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'push'], {
      timeout: PUSH_TIMEOUT_MS,
      // No credential prompt: a server started by an MCP client has no terminal to answer one on,
      // so a prompt is a hang. Failing immediately turns that into a warning the user can read.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { pushed: true };
  } catch (err) {
    const detail = timedOut(err)
      ? `o push passou de ${PUSH_TIMEOUT_MS} ms e foi encerrado`
      : errorMessage(err);
    return {
      pushed: false,
      warning:
        `commit feito, mas o push falhou: ${detail}. A nota está salva e commitada localmente; ` +
        'nada foi desfeito e nenhum rebase foi tentado. Se o remote andou na frente, ' +
        'resolva com um pull no vault antes do próximo push.',
    };
  }
}

/** True when the rejection is `execFile`'s own timeout kill, rather than git's exit status. */
function timedOut(err: unknown): boolean {
  return err instanceof Error && (err as Error & { killed?: boolean }).killed === true;
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
