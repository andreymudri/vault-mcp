import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
  /**
   * Set where the warning is a condition the caller may want to tell apart rather than a git
   * diagnostic to relay: `git.notARepo`, `git.gitMissing`.
   */
  warningCode?: string;
  /** True when this commit failed and was written to the pending journal, to be retried. */
  pending?: boolean;
  /** How many earlier pending commits this call managed to make. Absent when none. */
  recovered?: number;
  /** How many pending commits were given up on after `MAX_PENDING_ATTEMPTS`. Absent when none. */
  dropped?: number;
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
  /**
   * Quanto tempo cada `git` desta chamada pode levar. Existe como opção, e não só como constante,
   * pela mesma razão que `WriteQueue` recebe o seu: um limite que não dá para encurtar é um
   * limite que nenhum teste consegue ver disparar, e a prova de que ele existe passaria a ser a
   * leitura do código.
   */
  timeoutMs?: number;
  /**
   * The waits between retries of a git that found `index.lock` taken. An option for the same reason
   * `timeoutMs` is one: a test has to be able to watch the retry give up without spending the three
   * seconds the real schedule takes.
   */
  indexLockWaitsMs?: readonly number[];
}

/**
 * How long ANY git of this module may take before it is killed.
 *
 * It started as the push's own bound, and the reason written for it was already general: a git
 * that talks to the network from inside a single-threaded stdio server is a server that stops
 * answering — the same wedge class as a blocking read. What was missing is that the push is not
 * the only git here that can hang, nor the most exposed one.
 *
 * `git commit` runs USER CODE: a `pre-commit` or `commit-msg` hook, whatever the owner of the
 * vault put there, and a hook that waits for something never returns. It also signs, and
 * `commit.gpgsign = true` with a passphrase-protected key and no live agent opens a pinentry —
 * a prompt on a server that has no terminal to answer it on. Either one pinned the call forever:
 * the `WriteQueue` slot expires after 60 s and warns the writes behind it, but the caller of THIS
 * one keeps waiting, which is precisely what the bound exists to prevent.
 *
 * One constant for every invocation, and not one per site: two numbers that must agree drift, and
 * a site added later inherits the bound instead of forgetting it.
 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Every `git` this module runs: bounded by the clock, and unable to ask anything.
 *
 * `GIT_TERMINAL_PROMPT=0` was on the push alone, with the right reason attached to it — a server
 * started by an MCP client has no terminal to answer a prompt on, so a prompt IS a hang. The
 * reason never had anything to do with the network: it is about where this process runs, so it
 * holds for every git here.
 */
function runGit(args: string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<{ stdout: string }> {
  return execFileAsync('git', args, {
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * `VAULT_AUTO_PUSH=1` (or `true`, `yes`, `on`) turns the push on for every write. Anything else is
 * off — and a value that is neither a yes nor a no is reported at start-up by `resolveConfig`.
 */
export function autoPushEnabled(): boolean {
  const raw = process.env.VAULT_AUTO_PUSH?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * The waits between retries of an `add` or a `commit` that found `index.lock` taken: about three
 * seconds in all, which outlasts any git a person or an editor plugin runs by hand.
 *
 * The vault lock (`vault-lock.ts`) already keeps two of THESE servers from colliding here. What is
 * left is every other git on the same repository — the user's own, or an auto-commit plugin inside
 * Obsidian — and those hold the index for milliseconds.
 */
const INDEX_LOCK_WAITS_MS: readonly number[] = [100, 200, 400, 800, 1600];

/** How many times a pending commit is attempted in all before it is given up on. */
const MAX_PENDING_ATTEMPTS = 5;

/** Pending commits retried per call, so a long journal cannot turn one write into a hundred gits. */
const MAX_PENDING_PER_CALL = 20;

const PENDING_FILE = 'vault-mcp-pending.json';
const LOCK_FILE = 'vault-mcp.lock';
const PENDING_NOTE = 'o commit ficou pendente e será refeito na próxima escrita';

/** A commit that failed after its files were written, kept so a later write can make it. */
export interface PendingCommit {
  /** Repository-relative, POSIX separators. */
  paths: string[];
  message: string;
  /** Attempts made so far, the failed original included. */
  attempts: number;
  at: string;
}

type GitDirAnswer =
  | { dir: string }
  | { dir: undefined; reason: 'notARepo' | 'gitMissing' | 'failed'; detail: string };

/** A git directory does not move, so a positive answer is asked for once per root. */
const gitDirs = new Map<string, string>();

async function resolveGitDir(repoRoot: string): Promise<GitDirAnswer> {
  const cached = gitDirs.get(repoRoot);
  if (cached !== undefined) return { dir: cached };
  try {
    const { stdout } = await runGit(['-C', repoRoot, 'rev-parse', '--absolute-git-dir']);
    const dir = stdout.trim();
    if (dir === '') return { dir: undefined, reason: 'failed', detail: 'git devolveu um diretório vazio' };
    gitDirs.set(repoRoot, dir);
    return { dir };
  } catch (err) {
    // A string `code` is the spawn failing (`ENOENT`: no git on PATH); a numeric one is git itself
    // answering, and 128 is how `rev-parse` says "this is not a repository". Anything else — a
    // timeout kill — is not an answer about the repository at all.
    const code = err instanceof Error ? (err as Error & { code?: number | string }).code : undefined;
    const reason = code === 'ENOENT' ? 'gitMissing' : typeof code === 'number' ? 'notARepo' : 'failed';
    return { dir: undefined, reason, detail: errorMessage(err) };
  }
}

/** The repository's git directory, absolute, or `undefined` when `repoRoot` is not inside one. */
export async function gitDir(repoRoot: string): Promise<string | undefined> {
  return (await resolveGitDir(repoRoot)).dir;
}

/**
 * Where the cross-process vault lock lives: inside the git directory when there is one, a dotfile
 * in the vault root when there is not.
 *
 * Inside `.git` because nothing there is ever a note, ever staged, or ever shown by `git status`.
 * Asked of git rather than assumed to be `<vault>/.git`: a vault can be a subdirectory of a
 * repository, a linked worktree or a submodule, and in each of those `.git` is elsewhere or is a
 * file. The dotfile fallback is invisible to the scanner, which skips every dot entry.
 */
export async function lockPathFor(vaultRoot: string): Promise<string> {
  const dir = await gitDir(vaultRoot);
  return dir === undefined ? join(vaultRoot, '.vault-mcp.lock') : join(dir, LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed git was stopped by `index.lock`.
 *
 * Two signs, either one enough. The file still being there is the reliable one. The other is git
 * naming it in what it printed, for the lock that was released between the failure and this
 * check — and that IS reading git's prose, which this module otherwise refuses to do. The refusal
 * is about granting a benign classification on text a hook or a filename can forge; here the only
 * thing forged text can buy is a bounded number of retries of a command that had already failed.
 */
function indexLockInvolved(dir: string | undefined, err: unknown): boolean {
  if (dir !== undefined && existsSync(join(dir, 'index.lock'))) return true;
  return errorStreams(err).includes('index.lock');
}

async function retryOnIndexLock<T>(
  dir: string | undefined,
  waits: readonly number[],
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      const wait = waits[attempt];
      if (wait === undefined || !indexLockInvolved(dir, err)) throw err;
      await sleep(wait);
    }
  }
}

type CommitOutcome =
  | { status: 'committed' }
  | { status: 'nothing'; warning: string }
  | { status: 'failed'; warning: string };

/** One add, one staged-diff check, one commit — the unit both a new write and a retry go through. */
async function commitOnce(
  repoRoot: string,
  dir: string | undefined,
  absPaths: string[],
  message: string,
  timeoutMs: number,
  waits: readonly number[],
): Promise<CommitOutcome> {
  try {
    await retryOnIndexLock(dir, waits, () =>
      runGit(['-C', repoRoot, '--literal-pathspecs', 'add', '--', ...absPaths], timeoutMs),
    );
  } catch (err) {
    return { status: 'failed', warning: `falha ao adicionar arquivos ao git: ${errorMessage(err)}` };
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
    await runGit(
      ['-C', repoRoot, '--literal-pathspecs', 'diff', '--cached', '--quiet', '--', ...absPaths],
      timeoutMs,
    );
    // Exit 0: no staged difference for these paths. The benign no-op.
    return { status: 'nothing', warning: 'nada a commitar: arquivos sem alteração' };
  } catch (err) {
    // Exit 1 is `--quiet`'s "there are differences" signal: proceed to commit.
    // Anything else (128, a spawn failure) is a genuine error.
    if (exitCode(err) !== 1) {
      return { status: 'failed', warning: `falha ao verificar alterações no git: ${errorMessage(err)}` };
    }
  }

  try {
    await retryOnIndexLock(dir, waits, () =>
      runGit(
        ['-C', repoRoot, '--literal-pathspecs', 'commit', '-m', message, '--', ...absPaths],
        timeoutMs,
      ),
    );
  } catch (err) {
    // There *was* something staged, so a failure here is real: a rejecting
    // hook, an unset identity, a locked index. Surface the diagnostic.
    return { status: 'failed', warning: `falha ao commitar: ${errorMessage(err)}` };
  }
  return { status: 'committed' };
}

function isPendingCommit(value: unknown): value is PendingCommit {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<PendingCommit>;
  return (
    Array.isArray(entry.paths) &&
    entry.paths.every((p) => typeof p === 'string') &&
    typeof entry.message === 'string' &&
    typeof entry.attempts === 'number' &&
    typeof entry.at === 'string'
  );
}

/** The journal as it is on disk. A missing or unreadable file is an empty journal, never an error. */
async function readPending(dir: string): Promise<PendingCommit[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir, PENDING_FILE), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPendingCommit) : [];
  } catch {
    return [];
  }
}

/** Replaces the journal, through a sibling temporary file so a crash never leaves half of one. */
async function writePending(dir: string, entries: PendingCommit[]): Promise<void> {
  const target = join(dir, PENDING_FILE);
  if (entries.length === 0) {
    await fs.rm(target, { force: true });
    return;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

/**
 * Commits that failed after their files were written and are waiting to be made.
 *
 * Without the journal such a write is an orphan: the note is on disk, the tool said "Commit: no",
 * and nothing ever looks at it again — the next write commits ITS paths and no others, so with
 * auto-push on the note silently never leaves the machine.
 */
export async function pendingCommits(repoRoot: string): Promise<PendingCommit[]> {
  const dir = await gitDir(repoRoot);
  return dir === undefined ? [] : readPending(dir);
}

/**
 * Retries the journal, oldest first. Each entry becomes its own commit under its own message, so
 * the history reads as it would have had nothing failed.
 *
 * "Nothing staged" also clears an entry: somebody already committed those paths — the user, or an
 * auto-commit plugin sweeping the tree — and that is the outcome the entry was waiting for.
 */
async function drainPending(
  repoRoot: string,
  dir: string,
  timeoutMs: number,
  waits: readonly number[],
): Promise<{ recovered: number; dropped: number }> {
  const entries = await readPending(dir);
  if (entries.length === 0) return { recovered: 0, dropped: 0 };

  const keep: PendingCommit[] = entries.slice(MAX_PENDING_PER_CALL);
  let recovered = 0;
  let dropped = 0;
  for (const entry of entries.slice(0, MAX_PENDING_PER_CALL)) {
    const absPaths = entry.paths.map((p) => join(repoRoot, ...p.split('/')));
    const outcome = await commitOnce(repoRoot, dir, absPaths, entry.message, timeoutMs, waits);
    if (outcome.status === 'committed') recovered += 1;
    else if (outcome.status === 'nothing') continue;
    else if (entry.attempts + 1 >= MAX_PENDING_ATTEMPTS) dropped += 1;
    else keep.push({ ...entry, attempts: entry.attempts + 1 });
  }
  await writePending(dir, keep);
  return { recovered, dropped };
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
 *
 * Two things happen around that one commit. BEFORE it, the pending journal is retried, so a write
 * that failed to commit earlier is made now. AFTER it, a failure of this commit is written to the
 * same journal. Both assume the caller holds the vault lock, which every write tool does.
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

  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const waits = options.indexLockWaitsMs ?? INDEX_LOCK_WAITS_MS;

  // Asked first, because a vault that is not a repository gets ONE sentence about it instead of
  // git's stderr on every write, and because nothing below — the retry, the journal — has
  // anywhere to live without a git directory.
  const where = await resolveGitDir(repoRoot);
  if (where.dir === undefined && where.reason === 'notARepo') {
    return {
      committed: false,
      warningCode: 'git.notARepo',
      warning: 'o vault não é um repositório git: a nota foi salva, mas não versionada',
    };
  }
  if (where.dir === undefined && where.reason === 'gitMissing') {
    return {
      committed: false,
      warningCode: 'git.gitMissing',
      warning: 'o git não foi encontrado no PATH: a nota foi salva, mas não versionada',
    };
  }
  const dir = where.dir;

  const drained =
    dir === undefined ? { recovered: 0, dropped: 0 } : await drainPending(repoRoot, dir, timeoutMs, waits);
  const recovery = {
    ...(drained.recovered > 0 ? { recovered: drained.recovered } : {}),
    ...(drained.dropped > 0 ? { dropped: drained.dropped } : {}),
  };

  const outcome = await commitOnce(repoRoot, dir, absPaths, message, timeoutMs, waits);

  let result: CommitResult;
  if (outcome.status === 'committed') {
    result = { committed: true, ...recovery };
  } else if (outcome.status === 'nothing' || dir === undefined) {
    result = { committed: false, warning: outcome.warning, ...recovery };
  } else {
    const entry: PendingCommit = {
      paths: absPaths.map((p) => relative(repoRoot, p).split(sep).join('/')),
      message,
      attempts: 1,
      at: new Date().toISOString(),
    };
    await writePending(dir, [...(await readPending(dir)), entry]);
    result = {
      committed: false,
      pending: true,
      warning: `${outcome.warning}; ${PENDING_NOTE}`,
      ...recovery,
    };
  }

  // A recovered commit is as unpushed as a new one, so either is a reason to push.
  const somethingToPush = result.committed || drained.recovered > 0;
  if (!somethingToPush || !(options.push ?? autoPushEnabled())) return result;

  const push = await pushBranch(repoRoot, timeoutMs);
  return {
    ...result,
    pushed: push.pushed,
    ...(push.warning === undefined
      ? {}
      : { warning: result.warning === undefined ? push.warning : `${result.warning}; ${push.warning}` }),
  };
}

/** What `vault_status` reports about the repository under the vault. */
export interface RepoState {
  /** False when the vault is not inside a git repository, or git is not installed. */
  repository: boolean;
  /** The checked-out branch. Absent on a detached HEAD and when `repository` is false. */
  branch?: string;
  /** True when HEAD names a commit rather than a branch: new commits then belong to no branch. */
  detached: boolean;
  /** Commits here that the upstream lacks. Absent, with `behind`, when no upstream is configured. */
  ahead?: number;
  /** Commits the last-fetched upstream has that are not here. No network is touched to learn it. */
  behind?: number;
  pending: PendingCommit[];
}

/**
 * The repository as a write would find it, read without changing anything.
 *
 * Every question is asked of git by exit status or by a number, never by its prose, and each one
 * failing means "not applicable" rather than an error: no upstream is the ordinary state of a
 * vault that never leaves the machine.
 */
export async function repoState(repoRoot: string): Promise<RepoState> {
  const dir = await gitDir(repoRoot);
  if (dir === undefined) return { repository: false, detached: false, pending: [] };

  let branch: string | undefined;
  let detached = false;
  try {
    const { stdout } = await runGit(['-C', repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    branch = stdout.trim() === '' ? undefined : stdout.trim();
  } catch {
    // Exit 1 is `--quiet`'s "HEAD is not a symbolic ref".
    detached = true;
  }

  let counts: { ahead: number; behind: number } | undefined;
  try {
    const { stdout } = await runGit([
      '-C', repoRoot, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD',
    ]);
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    if (ahead !== undefined && behind !== undefined && Number.isInteger(ahead) && Number.isInteger(behind)) {
      counts = { ahead, behind };
    }
  } catch {
    // No upstream configured, or no commit yet: there is nothing to be ahead of.
  }

  return {
    repository: true,
    ...(branch === undefined ? {} : { branch }),
    detached,
    ...(counts ?? {}),
    pending: await readPending(dir),
  };
}

/** What a commit says about the pending journal, for a result type that relays it. */
export type CommitRecovery = Pick<CommitResult, 'pending' | 'recovered' | 'dropped'>;

/** The recovery fields of `commit` that are set, and no others — never a key holding `undefined`. */
export function commitRecovery(commit: CommitResult): CommitRecovery {
  return {
    ...(commit.pending === undefined ? {} : { pending: commit.pending }),
    ...(commit.recovered === undefined ? {} : { recovered: commit.recovered }),
    ...(commit.dropped === undefined ? {} : { dropped: commit.dropped }),
  };
}

/**
 * The push of `VAULT_AUTO_PUSH`, for a caller that committed with `push: false`.
 *
 * The write tools commit while holding the vault lock and push after letting it go: `git push`
 * sends the whole branch, so nothing about it needs exclusion, and a push stuck on the network must
 * not keep every other writer waiting for as long as it takes to time out.
 */
export async function pushIfEnabled(
  repoRoot: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ pushed?: boolean; warning?: string }> {
  if (!autoPushEnabled()) return {};
  return pushBranch(repoRoot, timeoutMs);
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
    await runGit(['-C', repoRoot, 'rev-parse', '--verify', `HEAD:${relPath}`]);
  } catch (err) {
    return { inHead: false, modified: false, reason: errorMessage(err) };
  }

  try {
    await runGit(['-C', repoRoot, '--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', relPath]);
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
    const { stdout } = await runGit(['-C', repoRoot, 'rev-parse', 'HEAD']);
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
async function pushBranch(
  repoRoot: string,
  timeoutMs: number,
): Promise<{ pushed: boolean; warning?: string }> {
  try {
    await runGit(['-C', repoRoot, 'push'], timeoutMs);
    return { pushed: true };
  } catch (err) {
    const detail = timedOut(err)
      ? `o push passou de ${timeoutMs} ms e foi encerrado`
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
