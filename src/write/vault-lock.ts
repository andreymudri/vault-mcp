import { constants, promises as fs, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { coded } from '../i18n/errors.js';

/**
 * Mutual exclusion between PROCESSES writing to the same vault.
 *
 * `WriteQueue` (src/server/tools.ts) serializes the writes of one server, and an MCP stdio server
 * is started PER CLIENT: two Claude Code sessions, or Claude and Codex, are two processes over one
 * vault, each with a queue the other cannot see. Measured on 0.5.0 with eight processes editing
 * different passages of one note: eight answers of success, six or seven edits in the file. The
 * atomic `rename` in `atomic.ts` guarantees nobody reads a partial file; it says nothing about
 * whether the bytes a writer READ were still the current ones when it published.
 *
 * So exclusion has to live where every writer passes, and the only such place is the filesystem.
 * The lock is a file created with `O_CREAT|O_EXCL`, which is atomic and fails with `EEXIST` for
 * everyone but the first.
 *
 * WHERE THE FILE LIVES is not this class's decision (see `lockPathFor` in `git.ts`), but the rule
 * is: a path derived from the vault alone. `os.tmpdir()` is the tempting home and the wrong one —
 * two clients started with different `TMPDIR`s would each hold "the" lock and never meet.
 *
 * LIVENESS. A lock nobody can ever take back is the same wedge `WriteQueue`'s slot exists to
 * prevent, now across processes: one crashed server would end writing for every other one. A lock
 * is therefore taken over when its holder is provably gone (same host, pid no longer exists) or
 * when it is older than `staleMs` — far above any real write, which is bounded by the queue slot
 * and by the git timeouts. A waiter that runs out of patience first is REFUSED (`lock.timeout`):
 * writing without exclusion is the defect, so not writing is the safe direction.
 *
 * WHAT IS NOT CLOSED. POSIX has no compare-and-swap on a file name, so the takeover is "move the
 * file aside, then check it was the one judged stale, and put it back if it was not". Between the
 * move and the putting back, a third process can create a fresh lock, and the holder whose file
 * was moved then shares the vault with it. That needs three writers arriving in the same
 * microseconds as a stale lock, and it does not go unreported: `release` answers whether the lock
 * was still its caller's, and the tool says so in its answer.
 */
export interface LockInfo {
  pid: number;
  host: string;
  /** Random per acquisition: what tells an owner apart from a later holder with the same pid. */
  token: string;
  /** ISO timestamp of the acquisition. */
  at: string;
}

export class VaultLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultLockError';
  }
}

/** How long a writer waits for the lock before the write is refused. */
export const LOCK_TIMEOUT_MS = 30_000;

/**
 * Age past which a lock is taken over even when its pid is alive.
 *
 * Above the longest hold a healthy writer can have — the queue slot is 60 s and the three git
 * invocations of a commit are bounded at 30 s each — so a takeover on age alone means the holder
 * is hung, not slow.
 */
export const LOCK_STALE_MS = 120_000;

/**
 * How long a lock file that does not parse is given before it counts as abandoned.
 *
 * The file is created empty and written a moment later, so "does not parse" is the normal state of
 * a lock being taken right now. Writing a hundred bytes never takes five seconds.
 */
const UNREADABLE_GRACE_MS = 5_000;

const FIRST_WAIT_MS = 10;
const MAX_WAIT_MS = 250;

export interface VaultLockOptions {
  lockPath: string;
  timeoutMs?: number;
  staleMs?: number;
  /** Injectable so the stale rule can be tested without a real dead process. */
  isAlive?: (pid: number) => boolean;
}

type Observed =
  | { kind: 'gone' }
  | { kind: 'held'; info: LockInfo; raw: string }
  | { kind: 'unreadable'; raw: string; mtimeMs: number };

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `kill(pid, 0)` delivers nothing: it only asks whether the pid exists. EPERM means it does. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

function parseInfo(raw: string): LockInfo | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value.pid === 'number' &&
      typeof value.host === 'string' &&
      typeof value.token === 'string' &&
      typeof value.at === 'string' &&
      !Number.isNaN(Date.parse(value.at))
    ) {
      return { pid: value.pid, host: value.host, token: value.token, at: value.at };
    }
  } catch {
    // Not JSON (yet): the caller decides by age.
  }
  return undefined;
}

export class VaultLock {
  readonly lockPath: string;
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly host = hostname();
  /** The exact bytes of the lock this instance holds, for the exit-time release. */
  private heldRaw: string | undefined;

  constructor(options: VaultLockOptions) {
    this.lockPath = options.lockPath;
    this.timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    this.staleMs = options.staleMs ?? LOCK_STALE_MS;
    this.isAlive = options.isAlive ?? processExists;
  }

  /**
   * Takes the lock, waiting for a live holder up to `timeoutMs`.
   *
   * Resolves to the release function, which answers whether the lock was still the caller's when
   * it let go — `false` means somebody took it over while the caller was writing.
   */
  async acquire(): Promise<() => Promise<boolean>> {
    const info: LockInfo = {
      pid: process.pid,
      host: this.host,
      token: randomBytes(16).toString('hex'),
      at: new Date().toISOString(),
    };
    const raw = JSON.stringify(info);
    const deadline = Date.now() + this.timeoutMs;
    let wait = FIRST_WAIT_MS;

    for (;;) {
      if (await this.create(raw)) {
        this.heldRaw = raw;
        return async () => {
          if (this.heldRaw === raw) this.heldRaw = undefined;
          return this.removeIfStill(raw);
        };
      }

      const observed = await this.observe();
      const now = Date.now();
      // Gone between the failed create and the read, or stale and successfully moved aside: the
      // name is free again, so go straight back to creating — but never past the deadline, or a
      // stream of other writers could keep this loop alive forever.
      const freed =
        observed.kind === 'gone' || (this.isStale(observed, now) && (await this.removeIfStill(observed.raw)));
      if (freed && now < deadline) continue;

      if (now >= deadline) {
        const holder = observed.kind === 'held' ? observed.info.pid : 0;
        throw coded(
          new VaultLockError(
            `outro processo está escrevendo no vault há mais de ${this.timeoutMs} ms (pid ${holder}); nada foi escrito`,
          ),
          'lock.timeout',
          { ms: this.timeoutMs, pid: holder },
        );
      }

      // Jitter, so writers that started waiting together do not retry together.
      const pause = Math.min(wait, deadline - now) * (0.5 + Math.random() / 2);
      await new Promise<void>((resolve) => setTimeout(resolve, pause));
      wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
  }

  /** Runs `task` holding the lock. `lost` is true when the lock was taken over meanwhile. */
  async with<T>(task: () => Promise<T>): Promise<{ value: T; lost: boolean }> {
    const release = await this.acquire();
    let value: T;
    try {
      value = await task();
    } catch (err) {
      await release();
      throw err;
    }
    return { value, lost: !(await release()) };
  }

  /** Who holds the lock right now, for `vault_status`. Undefined when nobody does. */
  async holder(): Promise<LockInfo | undefined> {
    const observed = await this.observe();
    return observed.kind === 'held' ? observed.info : undefined;
  }

  /**
   * Best-effort release for a process that is exiting, where nothing asynchronous runs any more.
   * Removes the file only when it still carries exactly what this instance wrote.
   */
  releaseSync(): void {
    const raw = this.heldRaw;
    if (raw === undefined) return;
    this.heldRaw = undefined;
    try {
      if (readFileSync(this.lockPath, 'utf8') === raw) unlinkSync(this.lockPath);
    } catch {
      // Already gone, or unreadable: there is nothing left for an exiting process to do.
    }
  }

  private async create(raw: string): Promise<boolean> {
    let handle;
    try {
      handle = await fs.open(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') return false;
      throw coded(
        new VaultLockError(`não foi possível criar o lock do vault: ${messageOf(err)}`),
        'lock.failed',
        { detail: messageOf(err) },
      );
    }
    try {
      await handle.writeFile(raw);
    } finally {
      await handle.close();
    }
    return true;
  }

  private async observe(): Promise<Observed> {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = await fs.readFile(this.lockPath, 'utf8');
      mtimeMs = (await fs.stat(this.lockPath)).mtimeMs;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { kind: 'gone' };
      // Unreadable for another reason (permissions): treated as held, never as free.
      return { kind: 'unreadable', raw: '', mtimeMs: Date.now() };
    }
    const info = parseInfo(raw);
    return info === undefined ? { kind: 'unreadable', raw, mtimeMs } : { kind: 'held', info, raw };
  }

  private isStale(observed: Exclude<Observed, { kind: 'gone' }>, now: number): boolean {
    if (observed.kind === 'unreadable') return now - observed.mtimeMs > UNREADABLE_GRACE_MS;
    const { info } = observed;
    // A pid means something only on the machine that issued it: on a shared filesystem the same
    // number names an unrelated process, so another host's lock goes stale by age alone.
    if (info.host === this.host && !this.isAlive(info.pid)) return true;
    return now - Date.parse(info.at) > this.staleMs;
  }

  /**
   * Removes the lock file only if it still holds exactly `expected`.
   *
   * Move aside, THEN compare: comparing first and unlinking after is the check-then-act this
   * module exists to avoid — between the two another process can replace the file, and the unlink
   * would delete a live lock. A file that turns out not to be the expected one is put back with
   * `link`, which refuses to overwrite a lock created in the meantime.
   */
  private async removeIfStill(expected: string): Promise<boolean> {
    const aside = `${this.lockPath}.${randomBytes(6).toString('hex')}.aside`;
    try {
      await fs.rename(this.lockPath, aside);
    } catch (err) {
      // Somebody else removed it first, which frees the name just the same for an acquirer and
      // means "no longer mine" for a releaser.
      if (errnoCode(err) === 'ENOENT') return false;
      throw coded(
        new VaultLockError(`não foi possível criar o lock do vault: ${messageOf(err)}`),
        'lock.failed',
        { detail: messageOf(err) },
      );
    }

    let moved: string | undefined;
    try {
      moved = await fs.readFile(aside, 'utf8');
    } catch {
      moved = undefined;
    }

    if (moved !== expected) {
      try {
        await fs.link(aside, this.lockPath);
      } catch {
        // The name was taken again while this one was aside. See "WHAT IS NOT CLOSED" above.
      }
      await fs.unlink(aside).catch(() => undefined);
      return false;
    }
    await fs.unlink(aside).catch(() => undefined);
    return true;
  }
}
