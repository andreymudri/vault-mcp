import { PHRASES } from '../../i18n/phrases.js';

/**
 * Serialization of the write tools inside ONE server process. The exclusion against other
 * processes is `write/vault-lock.ts`.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/**
 * How long the queue waits for one write before it lets the NEXT one start.
 *
 * Far above any real write — a `vault_learn` touching four files and committing measures in tens of
 * milliseconds — because the bound is not a performance knob: it is the line between "slow" and
 * "never going to finish".
 */
export const WRITE_SLOT_TIMEOUT_MS = 60_000;

export const EXCLUSIVITY_WARNING = `${PHRASES.writeOverranHead}${WRITE_SLOT_TIMEOUT_MS}${PHRASES.writeOverranTail}`;

/**
 * The cross-process twin of `EXCLUSIVITY_WARNING`: the vault lock this write held was taken over
 * before the write let go of it, which only happens to a holder older than `LOCK_STALE_MS`.
 */
export const LOCK_LOST_WARNING = PHRASES.lockLost;

/** What a write function is told about pushing when the tool layer pushes on its behalf. */
export interface DeferredPush {
  push: false;
}

/** The part of every write result the tool layer reads to decide whether there is something to push. */
export interface Committed {
  committed: boolean;
  pushed?: boolean;
  pending?: boolean;
  recovered?: number;
  dropped?: number;
}

/**
 * Serializes the write tools against each other.
 *
 * `learn()` checks whether a path exists and then publishes with `rename` (src/write/atomic.ts),
 * and the window between the two is a TOCTOU: two overlapping `vault_learn` calls both reported
 * `{action:'created', committed:true}` while the FIRST insight survived in no file and in no blob —
 * the second `rename` simply replaced it. That was rated low only because nothing could issue
 * concurrent calls; this server is exactly the thing that can, so the precondition expires here.
 *
 * The queue closes it AT THIS PROCESS: no two write tool calls of one server overlap, so no write
 * can land inside another's window. It does NOT close the race against a writer outside this
 * process (Obsidian, a second server, a checkout of the vault repository) — only an
 * `O_CREAT|O_EXCL` publish in `atomic.ts` can, and that file belongs to another task. Reads are
 * deliberately NOT queued: `Retriever.search` is synchronous and the writers publish atomically, so
 * a reader sees either the old file or the new one and never waits for a commit.
 *
 * LIVENESS. The queue does not chain on the task's own promise, and that is the whole point of
 * `slot`. A task that NEVER settles — a `readFile` on a FIFO nobody writes to, a lock another
 * process holds — would otherwise leave `tail` pending forever and wedge every later write for the
 * lifetime of the process, while unqueued reads keep answering: a server that looks alive with a
 * dead write surface, reporting nothing. So each task gets a SLOT, and the slot ends when the task
 * settles OR when `slotTimeoutMs` elapses, whichever comes first.
 *
 * Losing exclusion is the deliberate trade, taken only where the alternative is losing the tool
 * entirely, and it is never taken SILENTLY: the abandoned task stays tracked, and every call that
 * could have overlapped it is answered with `EXCLUSIVITY_WARNING`. The caller whose own write hung
 * still waits for it — the bound frees the QUEUE, not the caller, because resolving a caller's
 * promise before its write finished would report an outcome nobody observed.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Tasks whose slot expired and that have not settled since. */
  private outstanding = 0;
  /** Monotonic count of expired slots, so a call can tell whether one expired while it waited. */
  private expired = 0;
  /**
   * Monotonic count of tasks that actually STARTED — the only thing that can cost a caller its
   * exclusion, and the counter `runExclusive` reads.
   */
  private started = 0;
  // A plain field, not a constructor parameter property: this tree is kept to syntax Node can
  // strip without transforming (`erasableSyntaxOnly`), which is what lets a test start the real
  // sources in a second PROCESS — see `test/cross-process.test.ts`.
  private readonly slotTimeoutMs: number;

  constructor(slotTimeoutMs: number = WRITE_SLOT_TIMEOUT_MS) {
    this.slotTimeoutMs = slotTimeoutMs;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    // The slot has to EXIST synchronously — it becomes the new tail before this returns — but its
    // timer must not start until the task does. Armed at enqueue instead, a task that waits behind
    // others burns its slot WAITING: five 200 ms writes behind a 300 ms slot ran four at a time,
    // which is the serialization guarantee failing under exactly the backlog it exists for, and
    // failing silently. So the tail is a promise this queue resolves by hand, and the timer starts
    // inside `begin`.
    let release: () => void = () => undefined;
    const slotClosed = new Promise<void>((resolve) => {
      release = resolve;
    });

    const begin = (): Promise<T> => {
      this.started += 1;
      let result: Promise<T>;
      try {
        result = task();
      } catch (err) {
        // A task that throws SYNCHRONOUSLY never produces a promise to hang the slot on, and an
        // unreleased slot is the wedge this class exists to prevent.
        release();
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.arm(result, release);
      return result;
    };

    // Both arms are `begin`: a rejected predecessor must not stall the queue, and a write tool that
    // failed says nothing about whether the next one may run.
    const started = this.tail.then(begin, begin);
    this.tail = slotClosed;
    return started;
  }

  /**
   * `run`, plus whether the call actually had the queue to itself.
   *
   * Sampled when the task STARTS rather than when it was queued, which is what makes the answer
   * exact. Two windows put another task alongside this one, and each is one term: a slot abandoned
   * BEFORE this task started and still outstanding (first), and any task that STARTED while this
   * one ran (second) — which is what an expired slot lets happen, and the only way it costs
   * anything. Nothing else can execute concurrently, because every other path holds the tail.
   *
   * An earlier version asked instead whether a slot had expired and whether anything was
   * outstanding at the end, and both misfire for a call that was ALONE: its own slot expiring
   * increments `expired` and `outstanding`, so a single write of more than 60 s reported a lost
   * exclusion against nobody. Counting STARTS answers the question directly — a warning that
   * appears where nothing overlapped teaches the reader to ignore it where something did.
   *
   * The version before that sampled `expired` at ENQUEUE and left a real overlap silent: a caller
   * that started after the expiry and finished after the abandoned task settled saw an unchanged
   * counter at both ends and reported success with no warning. That window stays closed: a task
   * that starts after this one is counted whether or not it has finished.
   */
  async runExclusive<T>(task: () => Promise<T>): Promise<{ value: T; warning?: string }> {
    let outstandingAtStart = 0;
    let startedAtStart = 0;
    const value = await this.run(async () => {
      outstandingAtStart = this.outstanding;
      // Includes this task's own increment, which `begin` has already applied.
      startedAtStart = this.started;
      return task();
    });

    const overlapped = outstandingAtStart > 0 || this.started > startedAtStart;
    return overlapped ? { value, warning: EXCLUSIVITY_WARNING } : { value };
  }

  /** True while a write that overran its slot may still be running. */
  get hasOutstanding(): boolean {
    return this.outstanding > 0;
  }

  /**
   * Starts this task's slot: `release` is called when the task settles or when the slot expires,
   * whichever comes first, and an expired slot leaves the task TRACKED so the loss of exclusion can
   * still be reported for as long as it may be writing.
   */
  private arm(result: Promise<unknown>, release: () => void): void {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      release();
    };
    const timer = setTimeout(() => {
      if (closed) return;
      this.outstanding += 1;
      this.expired += 1;
      const settled = (): void => {
        this.outstanding -= 1;
      };
      result.then(settled, settled);
      close();
    }, this.slotTimeoutMs);
    // A pending write must not be the reason the process stays alive — the transport decides that.
    // `unref` also keeps this timer from holding a test runner open.
    timer.unref();
    result.then(close, close);
  }
}
