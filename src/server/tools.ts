import { DEFAULT_LAYOUT } from '../config/layout.js';
import { lockPathFor, pushIfEnabled } from '../write/git.js';
import { VaultLock } from '../write/vault-lock.js';
import { readTools } from './tools/read-tools.js';
import { makeRedactor } from './tools/sanitize.js';
import type { ToolContext, ToolDefinition, ToolDeps } from './tools/types.js';
import { type Committed, type DeferredPush, LOCK_LOST_WARNING, WriteQueue } from './tools/write-queue.js';
import { writeTools } from './tools/write-tools.js';

/**
 * The eleven tools the MCP server exposes, as plain objects: a name, a description written for an
 * agent to route on, a zod schema and a handler that answers with TEXT. Some also answer
 * `structuredContent` under an `outputSchema`, where the reader can be a program: `vault_graph`
 * (the fleetmates deck draws it), `vault_learn` (the preview is approved by revision) and
 * `vault_status`.
 *
 * The pieces live in `./tools/`: what a tool is (`types`), how one is built (`define`), the read
 * and the write families (`read-tools`, `write-tools`), and the helpers they share. This file
 * builds the write machinery once, hands it to both families, and re-exports what was public here.
 *
 * Nothing here talks to a transport. `createTools` is handed the same `VaultScanner` the
 * `Retriever` owns and returns definitions whose handlers can be called directly, which is what
 * the tests do — the protocol layer in `index.ts` is a thin adapter over this array.
 */

export { LEGACY_ARGUMENTS, applyLegacyArguments, refuse, type LegacyConflict } from './tools/define.js';
export {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAX_CONTEXT_CHARS,
  MAX_DIFF_CHARS,
  MAX_INSIGHT_CHARS,
  MAX_NOTE_CHARS,
  MAX_WRITE_CHARS,
} from './tools/limits.js';
export { forMessage, makeRedactor } from './tools/sanitize.js';
export { ERROR_META_KEY } from './tools/types.js';
export type { RefusalCode, ToolAnnotations, ToolDefinition, ToolDeps, ToolResult } from './tools/types.js';
export { WRITE_SLOT_TIMEOUT_MS, WriteQueue } from './tools/write-queue.js';

/** The tools, plus what a process that is shutting down needs to know about the writes behind them. */
export interface Toolset {
  tools: ToolDefinition[];
  /** Resolves when no write is in flight — its commit and its push included. */
  idle(): Promise<void>;
  /** Removes, synchronously, any vault lock this process still holds. For the way out. */
  releaseLocks(): void;
}

/** The tools alone. Everything that only needs to call them — every test, mostly — uses this. */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  return createToolset(deps).tools;
}

export function createToolset(deps: ToolDeps): Toolset {
  const m = deps.messages;
  const writes = new WriteQueue();
  const redact = makeRedactor(deps.vaultRoot);
  const layout = deps.layout ?? DEFAULT_LAYOUT;

  /**
   * The cross-process lock for this vault, asked for on every write rather than once.
   *
   * Its path comes from where the repository's directory is on disk (`lockPathFor`), and a vault
   * that becomes a repository while the server runs must not keep locking a file that no other
   * server looks at. The instances are kept per path so the one holding a lock is the one that
   * releases it.
   */
  const locks = new Map<string, VaultLock>();
  const vaultLock = async (): Promise<VaultLock> => {
    if (deps.lock !== undefined) return deps.lock;
    const lockPath = await lockPathFor(deps.vaultRoot);
    let lock = locks.get(lockPath);
    if (lock === undefined) {
      lock = new VaultLock({
        lockPath,
        ...(deps.lockTimeoutMs === undefined ? {} : { timeoutMs: deps.lockTimeoutMs }),
      });
      locks.set(lockPath, lock);
    }
    return lock;
  };

  /** Pushes take turns among themselves, and never make a write wait. */
  let pushTail: Promise<unknown> = Promise.resolve();
  const pushInTurn = (): Promise<{ pushed?: boolean; warning?: string }> => {
    const turn = pushTail.then(() => pushIfEnabled(deps.vaultRoot));
    pushTail = turn.catch(() => undefined);
    return turn;
  };

  /**
   * A write with exclusion against every OTHER PROCESS as well as against this one.
   *
   * `WriteQueue` alone closes the window inside one server, and an MCP stdio server is started per
   * client: two sessions are two processes, each with a queue the other cannot see. So the task
   * runs inside the queue's slot AND holding the vault lock, and everything it reads, it reads
   * after both were granted.
   *
   * The push is the one step left outside. `git push` sends the whole branch, so it needs no
   * exclusion, and a push stuck on the network would otherwise hold every other writer of the
   * vault for as long as it takes to time out. The task is therefore told `push: false`, and the
   * push happens here, after the lock is released.
   */
  /** Every write that has started and has not answered yet, for `idle`. */
  const inFlight = new Set<Promise<void>>();
  const lockedWrite = <T extends Committed>(
    tool: string,
    run: (git: DeferredPush) => Promise<T>,
  ): Promise<{ value: T; warning?: string }> => {
    const work = lockedWriteNow(tool, run);
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
    return work;
  };

  const lockedWriteNow = async <T extends Committed>(
    tool: string,
    run: (git: DeferredPush) => Promise<T>,
  ): Promise<{ value: T; warning?: string }> => {
    const { value: held, warning: queueWarning } = await writes.runExclusive(async () =>
      (await vaultLock()).with(async () => {
        // A write decides from what is on disk NOW, and what it leaves must be seen by the next
        // read: the scan is invalidated on the way in and on the way out, whatever its validity.
        deps.scanner.invalidate();
        try {
          return await run({ push: false });
        } finally {
          deps.scanner.invalidate();
        }
      }),
    );

    let value = held.value;
    const warnings = [queueWarning, held.lost ? LOCK_LOST_WARNING : undefined];
    // A recovered commit is as unpushed as a new one, so either is a reason to push.
    if (value.committed || (value.recovered ?? 0) > 0) {
      const push = await pushInTurn();
      if (push.pushed !== undefined) value = { ...value, pushed: push.pushed } as T;
      warnings.push(push.warning);
    }

    // The caller is told all of this in the answer, once. The log is for whoever was not the
    // caller: a note that is on disk and in no commit is the state an operator most needs to see.
    const log = deps.logger;
    if (log !== undefined) {
      if (value.pending === true) log.warn('write.commitPending', { tool });
      if (held.lost) log.warn('lock.lost', { tool });
      if (value.pushed === false) log.warn('push.failed', { tool });
      if (value.dropped !== undefined) log.warn('commit.dropped', { tool, count: value.dropped });
      if (value.recovered !== undefined) log.info('commit.recovered', { tool, count: value.recovered });
    }

    const warning = warnings.filter((w): w is string => w !== undefined).join('; ');
    return warning === '' ? { value } : { value, warning };
  };

  const ctx: ToolContext = { deps, m, redact, layout, writes, vaultLock, lockedWrite };
  const tools = [...readTools(ctx), ...writeTools(ctx)];

  return {
    tools,
    idle: async () => {
      // A loop, because a write can start while the ones before it are being waited for.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    releaseLocks: () => {
      deps.lock?.releaseSync();
      for (const lock of locks.values()) lock.releaseSync();
    },
  };
}
