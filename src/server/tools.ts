import { realpathSync } from 'node:fs';
import { messagesFor, type Messages } from '../i18n/messages.js';
import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';

import { z } from 'zod';

import { LinkGraph } from '../graph/graph.js';
import { sliceAtCodePointBoundary } from '../retrieval/budget.js';
import type { Retriever } from '../retrieval/retrieval.js';
import type { Frontmatter, Note, ScoredChunk } from '../types.js';
import type { VaultScanner } from '../vault/scanner.js';
import { LearnError, learn } from '../write/learn.js';
import { INVISIBLE_CHARS } from '../write/paths.js';
import { deleteNote, moveNote, type DeleteResult, type MoveResult } from '../write/relocate.js';
import { EditError, editNote, writeNote, type WriteResult } from '../write/writer.js';

/**
 * The nine tools the MCP server exposes, as plain objects: a name, a description written for an
 * agent to route on, a zod schema and a handler that answers with TEXT.
 *
 * Nothing here talks to a transport. `createTools` is handed the same `VaultScanner` the
 * `Retriever` owns and returns definitions whose handlers can be called directly, which is what
 * the tests do — the protocol layer in `index.ts` is a thin adapter over this array.
 */

/** A tool answer, in the shape the MCP `tools/call` result expects. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** True for a refusal the agent should read and react to, never for a crash. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** A zod object schema. `index.ts` converts it to JSON Schema for `tools/list`. */
  inputSchema: z.AnyZodObject;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolDeps {
  retriever: Retriever;
  /** MUST be the very scanner the retriever was built with — see `refreshVault`. */
  scanner: VaultScanner;
  vaultRoot: string;
  /**
   * O catálogo do idioma em que este servidor FALA. Ausente significa inglês, o padrão de
   * `resolveLang` — ver `src/i18n/lang.ts` para a fronteira entre o que é traduzível e o que é
   * vocabulário do vault e portanto não é.
   */
  messages?: Messages;
}

/**
 * Characters that are invisible, that break a line, or that reorder what follows them — the one
 * definition, from `src/write/paths.ts`.
 *
 * This module carried a byte-identical copy of the literal, written when that export did not yet
 * exist. It does now, so the copy is gone: a character one surface escapes and another does not is
 * a character that forges a line on exactly one of the surfaces the user reads, and this project
 * has already paid for that shape once — the escape into `.git/` fixed in phase 4 existed because
 * `propagate.ts` carried its own copy of a guard.
 *
 * `paths.ts` exports it WITHOUT the `g` flag deliberately, so no two call sites share a
 * `lastIndex`; the global form is derived here from `.source`, as `propagate.ts` and `learn.ts`
 * already do.
 */
const INVISIBLE_CHARS_GLOBAL = new RegExp(INVISIBLE_CHARS.source, 'g');

/**
 * Renders a path, a heading trail, a query or a `reason` inside a STRUCTURED line without letting
 * it forge one.
 *
 * This is the layer that owes the escape, and deliberately so. `Retriever.search` returns
 * `chunk.path` and `chunk.headingPath` RAW — correctly, since escaping in retrieval would corrupt
 * the field for every consumer that is not a renderer — and the scanner applies no name filter, so
 * `nota\nWARNING: tudo certo.md` is a file Linux accepts and the index holds. Printed verbatim into
 * `caminho:linha — trilha (score X.XX)` it becomes a second rendered line that reads as a report
 * this server never made. The bidi controls are the half that breaks no line at all: they reorder
 * what follows, so a citation can read as one path and name another.
 *
 * The escapes mirror `headerPath` in `src/write/diff.ts` and `forMessage` in
 * `src/write/propagate.ts`: `\n`, `\r`, `\t` by name, everything else in a numeric form that can
 * only mean what it names.
 */
export function forMessage(text: string): string {
  return text.replace(INVISIBLE_CHARS_GLOBAL, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.charCodeAt(0);
    // `\x2028` would read back as `\x20` followed by a literal `28`, so anything wider than one
    // byte is escaped in the four-digit form.
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Replaces the vault's absolute root with `<vault>` in anything rendered back to the caller.
 *
 * Every field this server returns is vault-relative by design, and two are the exception because
 * they are built elsewhere: `PathGuardError` (src/write/paths.ts) names the resolved path it
 * refused, and a failed `git` command (src/write/git.ts) echoes its own `-C <root>` argument. Both
 * carry the absolute root — which on a personal machine spells out the OS username — into text an
 * LLM reads and may quote back. Neither file is this task's to change, so the boundary that renders
 * them is where it gets stripped.
 *
 * Both the configured root and its `realpath` are stripped: the guard resolves symlinks before
 * composing its message, so a vault reached through a symlinked home directory names a root string
 * the caller never configured.
 */
export function makeRedactor(vaultRoot: string): (text: string) => string {
  const configured = resolve(vaultRoot);
  let real = configured;
  try {
    real = realpathSync(configured);
  } catch {
    // An unreadable root is the entrypoint's problem, not this function's: strip what we know.
  }
  // Longest first, so a root that is a prefix of the other cannot leave a tail behind.
  const roots = [...new Set([configured, real])]
    .filter((root) => root !== '' && root !== '/')
    .sort((a, b) => b.length - a.length);
  return (text) => roots.reduce((acc, root) => acc.split(root).join('<vault>'), text);
}

/** How much of a note's body `vault_get_note` returns before cutting it. */
export const MAX_NOTE_CHARS = 20_000;

/**
 * Brings the vault up to date THROUGH the retriever, which is the only component allowed to
 * consume the scanner's delta.
 *
 * `VaultScanner.refresh()` reports what changed SINCE THE LAST CALL and `Retriever.sync()` (called
 * at the top of every `search`) is what turns that delta into index and graph updates. So a read
 * tool that called `scanner.refresh()` on its own would swallow the delta: the retriever's next
 * `search` would be told nothing changed and would answer from an index missing the note the user
 * just wrote. Searching for the empty string is a no-op query — `tokenize('')` yields no terms, so
 * no posting list is walked and no suggestion pair is scored — whose only effect is the sync every
 * read tool needs anyway.
 */
function refreshVault(deps: ToolDeps): void {
  deps.retriever.search({ query: '' });
}

/**
 * How long the queue waits for one write before it lets the NEXT one start.
 *
 * Far above any real write — a `vault_learn` touching four files and committing measures in tens of
 * milliseconds — because the bound is not a performance knob: it is the line between "slow" and
 * "never going to finish".
 */
export const WRITE_SLOT_TIMEOUT_MS = 60_000;

const EXCLUSIVITY_WARNING =
  `uma escrita anterior passou de ${WRITE_SLOT_TIMEOUT_MS} ms e pode ainda estar em andamento; ` +
  'esta chamada não teve exclusão garantida contra ela';

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

  constructor(private readonly slotTimeoutMs: number = WRITE_SLOT_TIMEOUT_MS) {}

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

/**
 * A refusal the AGENT is meant to read and act on — a path that names no note, an argument the
 * vault cannot accept — as opposed to a failure of this server.
 *
 * It exists so the two are distinguishable in the answer: `isError` is set either way (an agent
 * that cannot tell a refusal from an answer will happily quote "nota não encontrada" as content),
 * but a `ToolError`'s message is shown as written, while anything else is prefixed with the tool
 * name and the word "falhou".
 */
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `query: campo obrigatório; limit: esperado number, recebido string`.
 *
 * zod's own messages are English, and everything this server says to its caller is Portuguese, so
 * the two shapes that make up virtually every rejection — a missing field and a wrong type — are
 * translated here rather than by hanging a custom message off each of the twenty-odd fields, where
 * the next field added would silently be the one in English.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      const message =
        issue.code === 'invalid_type'
          ? issue.received === 'undefined'
            ? 'campo obrigatório'
            : `esperado ${issue.expected}, recebido ${issue.received}`
          : issue.message;
      return where === '' ? message : `${where}: ${message}`;
    })
    .join('; ');
}

/**
 * Wraps a tool body so that NOTHING escapes as an exception: bad input and a thrown error both
 * come back as `isError` content.
 *
 * That is the contract the plan asks for — a malformed note must never take the process down — and
 * it holds for direct callers too, not only for the ones coming through the protocol adapter.
 */
function define<Shape extends z.ZodRawShape>(
  redact: (text: string) => string,
  name: string,
  description: string,
  shape: Shape,
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<string>,
): ToolDefinition {
  const inputSchema = z.object(shape);
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) {
        return fail(`entrada inválida para ${name}: ${forMessage(describeIssues(parsed.error))}`);
      }
      try {
        return ok(await run(parsed.data));
      } catch (err) {
        // Redacted BEFORE escaping: the errors that carry an absolute root come from `paths.ts` and
        // `git.ts`, which build it from the real filesystem, so the root reaches here unescaped.
        if (err instanceof ToolError) return fail(forMessage(redact(err.message)));
        return fail(`${name} falhou: ${forMessage(redact(messageOf(err)))}`);
      }
    },
  };
}

/** Folder match on whole path segments, so `02-wiki/nest` never selects `02-wiki/nestjs/`. */
function inFolder(path: string, folder: string): boolean {
  const normalized = folder.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '' ? true : path.startsWith(`${normalized}/`);
}

/** Frontmatter comes from files nobody validated, so every field may be any YAML scalar. */
function stringField(note: Note, key: string): string | undefined {
  const value = note.frontmatter[key];
  return typeof value === 'string' ? value : undefined;
}

function noteTags(note: Note): string[] {
  const tags = note.frontmatter.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

/**
 * Bounds on the frontmatter block `vault_get_note` renders. All three exist because the SOURCE
 * bytes say nothing about the rendered size.
 *
 * YAML aliases share nodes, so a mapping of 300 bytes can describe a structure whose TEXT is
 * megabytes: nine levels of nine references each is 9^5 leaves. `frontmatter.ts` bounds `tags` for
 * exactly this reason and carries every other key through by reference, with an explicit note that
 * "a consumer that serializes arbitrary frontmatter keys must impose its own bound". This is that
 * consumer, and it did not: `JSON.stringify` over such a value produced a 1,2 MB answer from a
 * 330-byte note in this project's own test, and larger shapes reach tens of megabytes and then a
 * `RangeError` — on a single-threaded stdio server, a wedge followed by a crash, from a note a
 * poisoned `01-raw/` clipping delivers with no caller cooperation at all.
 *
 * The per-VALUE bound matters as much as the total: without it one enormous value spends the whole
 * budget and hides every other key, which is the same note losing its `tipo` and its links.
 */
const MAX_FRONTMATTER_KEYS = 32;
const MAX_FRONTMATTER_VALUE_CHARS = 512;
const MAX_FRONTMATTER_CHARS = 4_000;

/** `[…cortado]`, in the same shape as the body's own cut marker. */
const CUT = '[…cortado]';

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${sliceAtCodePointBoundary(text, max)}${CUT}`;
}

/**
 * One frontmatter value as text, in work PROPORTIONAL TO WHAT IS EMITTED rather than to what the
 * value expands to.
 *
 * That is the whole design, and it is why the budget is threaded THROUGH the walk instead of being
 * applied to its result: a container is never handed to `String` or `JSON.stringify`, both of which
 * expand everything before anything can be truncated, so a check on the output is a check that runs
 * after the damage.
 *
 * `depth` is 1 at the top, which buys back the thing the first version of this bound took away. A
 * `fonte:` mapping of a URL and an author is 40 bytes and rendered `{objeto com 2 chave(s)}` it was
 * UNREACHABLE — `vault_get_note` is the only tool that returns note content, so summarising a value
 * that fits is simply losing it. One level down, `{url: https://…, autor: fulano}` costs the same
 * worst case, because the character budget is what bounds the work, not the depth.
 *
 * The cap is on TEXT, never on element count: `frontmatter.ts` lets a note carry 64 tags, and a
 * 40-item list is about 190 characters — well inside the budget — so counting items made
 * `vault_get_note` summarise a list `vault_list` printed in full, two tools disagreeing about the
 * same note.
 */
function renderFrontmatterValue(value: unknown, depth = 1, memo: RenderMemo = new WeakMap()): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (depth <= 0) return `[lista com ${value.length} item(ns)]`;
    return remember(memo, value, depth, () =>
      clamp(
        joinBudgeted(value, (item) => renderFrontmatterValue(item, depth - 1, memo), value.length),
        MAX_FRONTMATTER_VALUE_CHARS,
      ),
    );
  }

  if (typeof value === 'object') {
    // The depth test comes FIRST, before any enumeration. `Object.entries` on the way to a
    // summary that only needs the count builds one two-element array per key, and an alias makes
    // that happen once per reference to the same object.
    if (depth <= 0) {
      return remember(memo, value, depth, () => `{objeto com ${Object.keys(value).length} chave(s)}`);
    }
    return remember(memo, value, depth, () => {
      const entries = Object.entries(value);
      const inner = joinBudgeted(
        entries,
        ([key, item]) => `${clamp(key, MAX_FRONTMATTER_VALUE_CHARS)}: ${renderFrontmatterValue(item, depth - 1, memo)}`,
        entries.length,
      );
      return clamp(`{${inner}}`, MAX_FRONTMATTER_VALUE_CHARS);
    });
  }

  return clamp(String(value), MAX_FRONTMATTER_VALUE_CHARS);
}

/**
 * One rendering per (container, depth), for the whole block.
 *
 * A YAML alias makes the SAME object reachable by many paths, and the rendering of a container is
 * a pure function of the container and the depth it is reached at — so the second path can only
 * ever recompute an answer that is already known. Without this, a 60.000-key map under 40 keys of
 * 25 aliases each was summarised ~640 times and cost 5,2 s of synchronous work on a server that
 * answers nothing else meanwhile; with it, once.
 *
 * The map is created per `renderFrontmatterBlock` call and thrown away with it, deliberately: a
 * module-level cache would key on objects the scanner holds across refreshes, and would answer
 * from a stale rendering if any of them were ever mutated in place.
 */
type RenderMemo = WeakMap<object, Map<number, string>>;

function remember(memo: RenderMemo, value: object, depth: number, compute: () => string): string {
  let byDepth = memo.get(value);
  if (byDepth === undefined) {
    byDepth = new Map();
    memo.set(value, byDepth);
  }
  const hit = byDepth.get(depth);
  if (hit !== undefined) return hit;
  const rendered = compute();
  byDepth.set(depth, rendered);
  return rendered;
}

/**
 * `render` applied to as many items as fit in `MAX_FRONTMATTER_VALUE_CHARS`, with the rest counted
 * rather than rendered.
 *
 * The loop STOPS at the budget instead of rendering everything and cutting afterwards, which is
 * what keeps a billion-element alias list from costing a billion renders. Every item contributes at
 * least the two characters of its separator, so the iteration count is bounded by the budget even
 * when every item renders empty.
 */
function joinBudgeted<T>(items: readonly T[], render: (item: T) => string, total: number): string {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    const part = render(item);
    parts.push(part);
    length += part.length + 2;
    if (length > MAX_FRONTMATTER_VALUE_CHARS) break;
  }
  const rest = total - parts.length;
  return `${parts.join(', ')}${rest > 0 ? `, …+${rest} item(ns)` : ''}`;
}

/**
 * The whole frontmatter block, one line per key, escaped per key and per value, and bounded in key
 * count and in total size. Returns the marker line itself so the caller is told what was left out —
 * a silently shortened block is a note whose metadata the caller believes it has seen.
 */
function renderFrontmatterBlock(frontmatter: Frontmatter): string {
  const entries = Object.entries(frontmatter);
  const memo: RenderMemo = new WeakMap();
  const lines: string[] = [];
  let length = 0;
  let cut = entries.length > MAX_FRONTMATTER_KEYS;

  for (const [key, value] of entries.slice(0, MAX_FRONTMATTER_KEYS)) {
    // Escaped PER KEY AND PER VALUE, then joined. Escaping the assembled block instead turns the
    // separators into the two literal characters `\` and `n`, which is every note with two keys.
    const line = `  ${forMessage(clamp(key, MAX_FRONTMATTER_VALUE_CHARS))}: ${forMessage(renderFrontmatterValue(value, 1, memo))}`;
    if (length + line.length > MAX_FRONTMATTER_CHARS) {
      cut = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  if (cut) lines.push(`  […frontmatter cortado em ${MAX_FRONTMATTER_KEYS} chaves / ${MAX_FRONTMATTER_CHARS} caracteres]`);
  return lines.join('\n');
}

/**
 * The prefix every line of quoted note text carries.
 *
 * It is what keeps a NOTE from forging a RESULT. The citation line is `caminho:linha — trilha
 * (score X.XX)` and results are separated by a blank line, so a note whose body contains a line in
 * that exact shape — trivial to plant in `01-raw/inbox/`, which is where clipped web pages land —
 * used to render as an additional result citing a note that does not exist, with content nobody
 * wrote. Escaping the body is not the answer: it is quoted prose, and a search tool that mangles
 * the text it found is worse than one that quotes it. Marking it is: with every body line prefixed,
 * a line at column zero can only have come from this server.
 */
const QUOTE_PREFIX = '> ';

/**
 * Every character that STARTS A NEW RENDERED LINE — Unicode's mandatory break set (UAX #14): LF,
 * VT, FF, CR, NEL, LS and PS, with CRLF matched as the single break it is.
 *
 * It is a subset of the invisible class above, and it has to be its own thing: escaping the whole
 * invisible class inside note text would break words at soft hyphens and zero-width joiners, which
 * is mangling the content, while splitting on `\n` alone — what this module did first — leaves six
 * other characters that a renderer turns into a line and this module does not. The original
 * forgery simply moved to the next terminator: a planted note put
 * `03-projects/segredos/senhas.md:1 — Credenciais (score 99.99)` at column zero of a search answer,
 * under the very header that tells the agent an unprefixed line came from the server.
 *
 * WHEN `paths.ts` EXPORTS ITS `INVISIBLE_CHARS`, this stays: the two answer different questions
 * ("what is invisible" vs "what begins a line"), and only the first one is imported.
 */
const LINE_BREAKS_GLOBAL = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/**
 * Everything ELSE that quoted note text must not carry through raw.
 *
 * The line terminators above were only half the problem. ESC (U+001B) and CSI (U+009B) are not
 * line terminators and produce no `\n`, so the `> ` on every line survives — and a body carrying
 * `ESC[F` followed by `ESC[2K` still REWRITES the previous rendered line at column zero in any
 * client that honours ANSI, which is the same forgery `\r` was escaped to stop, arriving by another
 * mechanism. The bidi overrides do it visually instead: they reorder a line so the quote marker no
 * longer reads as the start of it.
 *
 * This is `INVISIBLE_CHARS` MINUS THE JOINERS. The soft hyphen, the zero-width (non-)joiner, the
 * word joiner and the BOM are word-forming or word-splitting characters that ordinary prose in a
 * vault does legitimately contain — a German or Portuguese hyphenation point, an emoji sequence —
 * and escaping those would mangle the very content the snippet exists to show. Nothing else in the
 * class is word-forming, and no note legitimately carries a NUL, a backspace or a CSI.
 *
 * Escapes are ASCII by construction, so an escape can never re-form a terminator or a control.
 */
// eslint-disable-next-line no-control-regex
const QUOTED_CONTROLS_GLOBAL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapeControl(ch: string): string {
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  if (ch === '\v') return '\\x0b';
  if (ch === '\f') return '\\x0c';
  const code = ch.charCodeAt(0);
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * Quoted text whose only line break is `\n` and which carries no control that can rewrite what is
 * already on screen.
 *
 * `collapseCrlf` is the one difference between the two callers, and it is not cosmetic. In a
 * SNIPPET a CRLF note must not show `\r` at the end of every line — that is noise on content the
 * user wrote on Windows. In a DIFF the `\r` is the CHANGE: an edit that only rewrites line endings
 * renders as `-linha` / `+linha`, two lines a reader cannot tell apart, so the diff shows a change
 * with no visible difference. Escaping it there is what makes the diff honest.
 */
function sanitizeQuoted(text: string, collapseCrlf: boolean): string {
  // The trailing `\r` is the same noise as the rest, arriving by a different route: `chunker.ts`
  // splits the body on `\n` and JOINS on `\n`, so the final line's own terminator is the
  // separator that gets dropped and its `\r` is left orphaned at the end of the snippet. Every
  // interior pair collapses and that last one did not, which put a visible `\r` on the last
  // quoted line of every note written on Windows. Only at the very END, and only in the
  // collapsing caller: a lone `\r` anywhere else is a break that can still rewrite a rendered
  // line, and it stays escaped.
  const collapsed = collapseCrlf ? text.replace(/\r\n/g, '\n').replace(/\r$/, '') : text;
  // Terminators first, as one pass over ONE set, so a terminator can never be handled by one half
  // and missed by the other: LF stays the break the quoter splits on, the rest becomes text.
  const broken = collapsed.replace(LINE_BREAKS_GLOBAL, (match) => {
    if (match === '\n') return '\n';
    // Only reachable when `collapseCrlf` is false — the replace above has already removed the pair
    // otherwise. The `\r` becomes visible text and the `\n` stays the break, so the line structure
    // is untouched and the carriage return is finally SHOWN instead of quietly disappearing.
    if (match === '\r\n') return `${escapeControl('\r')}\n`;
    return escapeControl(match);
  });
  return broken.replace(QUOTED_CONTROLS_GLOBAL, escapeControl);
}

/** Note text as a block that cannot be read as anything but quoted text. */
function quoteSnippet(text: string): string {
  return sanitizeQuoted(text, true)
    .split('\n')
    .map((line) => `${QUOTE_PREFIX}${line}`)
    .join('\n');
}

/**
 * A diff as text whose every rendered line still carries the diff's own `+`/`-`/` `/`@@` prefix.
 *
 * The diff is relayed rather than quoted — a caller reads it as a diff, and prefixing it with `> `
 * would cost that — so the guarantee has to come from the same place: `unifiedDiff` prefixes what
 * it splits on `\n`, so a body carrying U+2028 (or any other alternate terminator) rides inside one
 * diff line and renders as a second, unprefixed line. A fabricated `+++ b/CLAUDE.md` hunk in the
 * middle of a diff this server vouches for is the same forgery as the snippet one, on the write
 * path.
 */
function relayDiff(diff: string): string {
  return sanitizeQuoted(diff, false);
}

/** One rendered result: the citation line the vault's `CLAUDE.md` requires, then the text. */
function renderResult(item: ScoredChunk): string {
  const { chunk } = item;
  const trail =
    chunk.headingPath.length === 0 ? '' : ` — ${forMessage(chunk.headingPath.join(' > '))}`;
  const flags = [
    `score ${item.score.toFixed(2)}`,
    item.viaGraph ? 'via grafo' : undefined,
    // The BOOLEAN, never the marker text. `TRUNCATION_MARKER` is ordinary prose that a note can
    // quote verbatim (`src/types.ts` says so), so matching on it would label an intact note as cut.
    item.truncated === true ? 'trecho truncado' : undefined,
  ]
    .filter((flag): flag is string => flag !== undefined)
    .join(', ');
  return `${forMessage(chunk.path)}:${chunk.lineStart}${trail} (${flags})\n${quoteSnippet(chunk.text)}`;
}

function renderNoteLine(note: Note): string {
  // Clamped even though `tipo`/`status` are string-typed and `tags` arrives bounded from
  // `frontmatter.ts`: this line is emitted once per note in the vault, so an unbounded field here
  // multiplies by the size of the vault rather than by one note.
  const details = [
    `tipo: ${clamp(stringField(note, 'tipo') ?? '—', MAX_FRONTMATTER_VALUE_CHARS)}`,
    `status: ${clamp(stringField(note, 'status') ?? '—', MAX_FRONTMATTER_VALUE_CHARS)}`,
    `tags: ${clamp(noteTags(note).join(', '), MAX_FRONTMATTER_VALUE_CHARS) || '—'}`,
  ].join(', ');
  return forMessage(`- ${note.path} — ${note.title} (${details})`);
}

/** Shared tail of `vault_write_note` and `vault_edit_note`. */
function renderWrite(
  result: WriteResult,
  verb: string,
  redact: (text: string) => string,
  queueWarning?: string,
): string {
  const lines = [
    `${verb}: ${forMessage(result.path)}`,
    `Commit: ${result.committed ? 'sim' : 'não'}`,
    // Only when a push was ATTEMPTED. With `VAULT_AUTO_PUSH` unset the server touches no network at
    // all, and a `Push: não` line there would report on something nobody asked for.
    ...(result.pushed === undefined ? [] : [`Push: ${result.pushed ? 'sim' : 'não'}`]),
  ];
  for (const warning of [result.warning, queueWarning]) {
    if (warning !== undefined) lines.push(`Aviso: ${forMessage(redact(warning))}`);
  }
  lines.push('', 'Diff:', result.diff === '' ? '(sem alteração de conteúdo)' : relayDiff(result.diff));
  return lines.join('\n');
}

/**
 * Shared tail of `vault_move` and `vault_delete`.
 *
 * Every list is rendered even when empty, spelled `(nada)`. An absent line reads as "this did not
 * apply"; `Reescritos: (nada)` reads as "no other note needed changing", which is a claim the
 * caller wants and is the usual, correct outcome of a move that only changed a directory.
 */
function renderRelocate(
  headline: string,
  result: MoveResult | DeleteResult,
  redact: (text: string) => string,
  queueWarning?: string,
): string {
  const lines = [headline];
  if ('rewritten' in result) {
    lines.push(
      `Links corrigidos em: ${
        result.rewritten.length === 0 ? '(nada)' : forMessage(result.rewritten.join(', '))
      }`,
    );
  }
  lines.push(
    `MOC/índice atualizados: ${
      result.propagated.length === 0 ? '(nada)' : forMessage(result.propagated.join(', '))
    }`,
    `Commit: ${result.committed ? 'sim' : 'não'}`,
    ...(result.pushed === undefined ? [] : [`Push: ${result.pushed ? 'sim' : 'não'}`]),
  );
  if ('undo' in result && result.undo !== undefined) {
    // Vault-relative on purpose (see `relocate.ts`): a command carrying the redactor's `<vault>`
    // is a command the user pastes and watches fail, so the answer says where to run it instead.
    lines.push(`Desfazer, de dentro do vault: ${forMessage(result.undo)}`);
  }
  for (const warning of [...result.warnings, queueWarning]) {
    if (warning !== undefined) lines.push(`Aviso: ${forMessage(redact(warning))}`);
  }
  lines.push('', 'Diff (mostre ao usuário):', result.diff === '' ? '(vazio)' : relayDiff(result.diff));
  return lines.join('\n');
}

/**
 * The caps `toTags` in `src/vault/frontmatter.ts` applies when it READS a note's tags back.
 *
 * Mirrored rather than imported because that function is not exported, and mirrored at all because
 * the two have to agree: a tag this tool writes past those bounds is a tag the scanner will not
 * hand back, so `vault_list` would not find the note the caller just tagged.
 */
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 128;

/**
 * `tags` as the SCANNER would read it back, from what a caller sent.
 *
 * A bare `'jwt'` is coerced, not dropped: `toTags` splits exactly such a string on commas when it
 * parses a note, so coercing here is what keeps "written by the tool" and "read by the scanner"
 * the same set — dropping it answered `Nota criada` while `vault_list {tags:['jwt']}` then failed
 * to return the note, with only the diff's `tags: []` as a signal.
 *
 * What cannot be coerced is REFUSED rather than silently reduced. A number or an object in the
 * `tags` slot has no reading that preserves the caller's intent, and `frontmatter.ts` drops a
 * container deliberately (that drop is its defence against an aliased YAML structure); reporting
 * success over a tag nobody will ever see is the outcome this refusal exists to prevent.
 */
/**
 * Tag shapes YAML reads back as something other than the text that was written.
 *
 * A tag is written by `serializeScalar` (src/write/template.ts) BARE unless its `NEEDS_QUOTES_RE`
 * matches — that expression covers the reserved words and the punctuation shapes, but not the
 * numeric ones. Every rule below was MEASURED by writing the tag through `writeNote` and reading it
 * back through `parseFile`, never inferred from a pattern:
 *
 *   `3.10`→`3.1`  `007`→`7`  `0x10`→`16`  `0b101`→`5`  `1e3`→`1000`  `1_000`→`1000`  `1.`→`1`
 *   `+7`→`7`  `.Inf`/`.INF`/`.inf`→`Infinity`  `.NaN`/`.nan`→`NaN`
 *   `1:30`→`90`  `12:00`→`720`  `1:30:00`→`5400`   (YAML 1.1 sexagesimal integer)
 *   `1:30.5`→`90.5`  `1:30.`→`90`  `0:30.5`→`30.5`  `59:59.999`→`3599.999`   (…and float)
 *   `017`→`15`  `0x1f`→`31`  `0b11`→`3`   (radix, and the reason the message reads the radix too)
 *   `2026-02-30`→`2026-03-02`  `2026-13-01`→`2027-01-01`  `0000-00-00`→`1899-11-30`
 *   `2026-01-10T00:00:00Z`→`2026-01-10`  `2026-01-10 00:00:00`→`2026-01-10`   (full timestamp)
 *
 * And, just as importantly, what MEASURED FINE and is therefore NOT refused: `type:adr`, `lang:pt`,
 * `c++:stl`, `a:b`, `v1:2` — a colon is only special when both sides are digits — plus `1:60` and
 * `0:59` (not sexagesimal), `2026-1-5` (js-yaml's short timestamp needs a two-digit month AND day),
 * `-5`, `-.inf`, `true`/`null`/`yes`/`~` (all quoted by the serializer), `2026`, `0`, `c++`,
 * `v3.10`. An earlier version of this guard refused every colon and every non-canonical date, which
 * blocked ordinary namespaced tags that work — with advice ("use a tag with a letter") that a tag
 * made only of letters cannot follow.
 *
 * Four more shapes belong to that second list and were being refused wrongly, all because this
 * pattern was WIDER than js-yaml's own resolvers: `009`/`018`/`09` (a leading zero means octal, and
 * 8 and 9 are not octal digits — a zero-padded ticket id is the realistic case), `1_`/`007_` (a
 * numeric may not end in an underscore), `0X1F`/`0B11` (the radix prefixes are lowercase-only), and
 * `+.0`/`+.1`/`+.9` (js-yaml's bare-dot float carries no sign).
 *
 * The break is in the serializer, which is outside this task's file set, so the decision here is to
 * REFUSE what will not survive rather than write a tag that never comes back. Refusing beats
 * coercing because a tag is an identifier: `3.10` silently stored as `3.1` is not the tag anyone
 * asked for. Each refusal NAMES THE VALUE THAT WOULD COME BACK, so a retry has something to act on.
 */
const NUMERIC_LIKE_RE = new RegExp(
  '^(?:' +
    // INTEGERS, YAML 1.1. The radix prefixes are LOWERCASE-ONLY: `0X1F` and `0B11` are read by
    // nobody and come back as themselves. A leading zero means OCTAL, which is why `009`, `018`
    // and `09` survive — 8 and 9 are not octal digits, so js-yaml leaves them as text — while
    // `007` and `017` do not. The decimal branch is `0` ALONE or a non-zero lead, never `0[0-9]+`.
    '[+]?0b[01_]+' +
    '|[+]?0x[0-9a-fA-F_]+' +
    '|[+]?0[0-7_]+' +
    '|[+]?(?:0|[1-9][0-9_]*)' +
    // FLOATS, YAML 1.1. Same `0`-alone rule in the integer part. The bare-dot form carries NO
    // sign in js-yaml's own pattern, which is the whole reason `.5` is read as 0.5 while `+.5`,
    // `+.0` and `+.9` are ordinary text. `.nan` takes no sign either; `.inf` does.
    '|[+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?' +
    '|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?' +
    '|[+]?\\.(?:inf|Inf|INF)' +
    '|\\.(?:nan|NaN|NAN)' +
  ')$',
);

/** js-yaml's YAML 1.1 sexagesimal INTEGER: the leading group may not start with a zero. */
const SEXAGESIMAL_INT_RE = /^[+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/;

/**
 * js-yaml's YAML 1.1 sexagesimal FLOAT, which is a SEPARATE resolver and a different shape.
 *
 * Two differences from the integer above, and both are measured: the leading group may start with
 * a zero (`0:30.5` → 30.5, while `0:30` survives), and it ends in a dot whose digits are optional
 * (`1:30.` → 90). Covering only the integer form let every one of `1:30.5`, `12:00.25`,
 * `1:30:00.5` and `59:59.999` through as a tag that comes back a number.
 */
const SEXAGESIMAL_FLOAT_RE = /^[+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/;

/**
 * js-yaml's short timestamp form: a two-digit month AND day, and nothing after it.
 *
 * `2026-1-5` is deliberately NOT this shape — it survives as text, measured — which is why the
 * one-or-two-digit form belongs to the timestamp regex below and not to this one.
 */
const YAML_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * js-yaml's FULL timestamp: the same date with a time part, which the short form above never
 * matched — so `2026-01-10T00:00:00Z` sailed past the guard and came back as `2026-01-10`.
 *
 * The time part is what makes the one-or-two-digit month and day legal here: `2026-1-5` alone is
 * text, `2026-1-5T01:02:03Z` is the fifth of January. The separator is `T`, `t`, or runs of blanks;
 * the fraction and the zone are optional; the zone may be `Z` or an offset.
 */
const YAML_TIMESTAMP_RE =
  /^(\d{4})-(\d\d?)-(\d\d?)(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))?(?:[ \t]*(?:Z|([-+])(\d\d?)(?::(\d\d))?))?$/;

/** What `1:30` becomes: base-60 digits, most significant first. */
function sexagesimalValue(tag: string): string {
  const negative = tag.startsWith('-');
  const digits = tag.replace(/^[-+]/, '').replace(/_/g, '').split(':');
  const value = digits.reduce((acc, part) => acc * 60 + Number(part), 0);
  return String(negative ? -value : value);
}

/**
 * The day a YAML timestamp comes back as, built the way js-yaml builds it (UTC) and rendered the
 * way `frontmatter.ts` renders it. `2026-02-30` is a perfectly good argument to `Date.UTC` — it
 * just is not the thirtieth of February.
 */
function yamlDateDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * The same, for the full timestamp form, assembled exactly as js-yaml assembles it: build the
 * instant in UTC, then SUBTRACT the zone offset. An hour of 25 is not rejected, it rolls the day —
 * measured, `2026-01-10T25:00:00Z` comes back as `2026-01-11`.
 */
function yamlTimestampDay(match: RegExpExecArray): string {
  const [, year, month, day, hour, minute, second, fraction, sign, tzHour, tzMinute] = match;
  // js-yaml pads the fraction to milliseconds: `.5` is 500 ms, not 5.
  const ms = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0').slice(0, 3));
  let time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms,
  );
  if (sign !== undefined) {
    const offset = (Number(tzHour) * 60 + Number(tzMinute ?? 0)) * 60_000;
    time -= sign === '-' ? -offset : offset;
  }
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The number YAML reads a numeric-looking tag back as, BY RADIX.
 *
 * `Number('017')` is 17 and YAML 1.1 reads it as 15, so naming the value with `Number` alone
 * produced a refusal that pointed at a number the parser never produces — which is the one thing
 * these messages exist to get right, since the caller retries against what they are told.
 * Underscores are stripped first: YAML ignores them inside a numeric, `Number` reads `NaN`.
 */
function yamlNumberText(tag: string): string {
  const body = tag.replace(/^[+]/, '').replace(/_/g, '');
  if (/^0x/.test(body)) return String(parseInt(body.slice(2), 16));
  if (/^0b/.test(body)) return String(parseInt(body.slice(2), 2));
  if (/^0[0-7]+$/.test(body)) return String(parseInt(body, 8));
  return String(Number(body));
}

/** `undefined` when the tag survives the write/read round trip, or why it would not. */
function tagRoundTripProblem(tag: string): string | undefined {
  // FIRST, because it makes every other question moot: a leading `-` is in `NEEDS_QUOTES_RE`'s
  // leading-character class (src/write/template.ts), so the serializer quotes the whole tag and YAML
  // hands back the text unchanged — measured on `-5`, `-.inf` and `-1:30`, all of which survive.
  // `+` is not in that class, which is why `+7` still comes back as `7`.
  if (tag.startsWith('-')) return undefined;

  // SECOND, and for the same reason: js-yaml's integer and float resolvers both refuse a numeric
  // that ENDS in an underscore, whatever else it looks like. Measured on `1_`, `007_`, `0_`, `07_`,
  // `1e3_` and `1:30.5_` — every one of them ordinary text, and a ticket id with a trailing
  // separator is not an exotic tag.
  if (tag.endsWith('_')) return undefined;

  const timestamp = YAML_TIMESTAMP_RE.exec(tag);
  if (timestamp !== null) {
    return (
      `seria lida como a data ${yamlTimestampDay(timestamp)}, porque o YAML lê a forma com hora ` +
      `como um timestamp e o vault guarda só o dia`
    );
  }

  const date = YAML_DATE_RE.exec(tag);
  if (date !== null) {
    const day = yamlDateDay(Number(date[1]), Number(date[2]), Number(date[3]));
    return day === tag
      ? undefined
      : `seria lida como a data ${day}, porque o YAML normaliza a data e essa não existe no calendário`;
  }

  if (SEXAGESIMAL_INT_RE.test(tag) || SEXAGESIMAL_FLOAT_RE.test(tag)) {
    return (
      `seria lida como o número ${sexagesimalValue(tag)}, porque o YAML lê dígitos separados por ` +
      `':' como sexagesimal; troque o separador, ex.: '${tag.replace(/:/g, '-')}'`
    );
  }

  // `0o17` is deliberately absent from the pattern: js-yaml's default schema is YAML 1.1, which has
  // no `0o` octal, so it stays a string. Measured.
  if (!NUMERIC_LIKE_RE.test(tag)) return undefined;

  // A number whose text IS its canonical form survives: `2026` comes back as `2026`, `0` as `0`.
  // Underscores are stripped first because YAML ignores them inside a numeric — `1_000` is the
  // number 1000 — while `Number` reads the same string as `NaN`, which would name the wrong value
  // in the message the caller is meant to act on.
  const asNumber = yamlNumberText(tag);
  if (asNumber === tag) return undefined;
  // `.inf`/`.nan` are YAML spellings that `Number` does not know; name what YAML gives back.
  const readBack = /^[-+]?\.inf$/i.test(tag)
    ? `${tag.startsWith('-') ? '-' : ''}Infinity`
    : /^\.nan$/i.test(tag)
      ? 'NaN'
      : asNumber;
  return `seria lida como o número ${readBack}; acrescente uma letra, ex.: 'v${tag}'`;
}

function coerceTags(value: unknown): string[] {
  const items =
    typeof value === 'string'
      ? // Bounded before splitting, like `toTags`: a multi-megabyte scalar must not allocate a
        // million-element array only for the first `MAX_TAGS` of it to survive.
        value.slice(0, MAX_TAGS * (MAX_TAG_LENGTH + 1)).split(',')
      : value;
  if (!Array.isArray(items)) {
    throw new ToolError(
      'frontmatter.tags precisa ser uma lista de textos ou um texto com tags separadas por vírgula',
    );
  }

  const out: string[] = [];
  for (const item of items) {
    if (out.length >= MAX_TAGS) break;
    if (item === null || item === undefined || typeof item === 'object') {
      throw new ToolError('frontmatter.tags só aceita textos ou números; remova listas e objetos');
    }
    const tag = String(item).slice(0, MAX_TAG_LENGTH).trim();
    if (tag === '') continue;
    const problem = tagRoundTripProblem(tag);
    if (problem !== undefined) {
      throw new ToolError(
        `frontmatter.tags: a tag '${forMessage(tag)}' ${forMessage(problem)}, e a nota deixaria ` +
          'de casar com a busca por essa tag',
      );
    }
    out.push(tag);
  }
  return out;
}

function toFrontmatter(input: Record<string, unknown> | undefined): Frontmatter | undefined {
  if (input === undefined) return undefined;
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(input)) {
    // `out['__proto__'] = value` is not a property assignment — it runs the setter and REPLACES
    // this object's prototype, so a caller could hand the writer an object whose inherited members
    // it never expected. The key is dropped rather than escaped: nothing in a vault's frontmatter
    // is legitimately called `__proto__`.
    if (key === '__proto__') continue;
    // An explicit `undefined` reads as "campo ausente" — `String(undefined)` would write the word
    // `undefined` into the note's metadata.
    if (value === undefined) continue;

    // The three declared fields are typed on `Frontmatter`, and a caller can send anything: a
    // `tipo` of `42` would not typecheck as the string the rest of the system compares against.
    // A scalar is coerced; `null` and a container are REFUSED, because both would fall through to
    // the writer's own default (`tipo: nota`) while the answer said the note was created as asked.
    if (key === 'tipo' || key === 'status' || key === 'criado') {
      if (value === null || typeof value === 'object') {
        throw new ToolError(`frontmatter.${key} precisa ser um texto`);
      }
      out[key] = String(value);
      continue;
    }
    if (key === 'tags') {
      out.tags = coerceTags(value);
      continue;
    }
    // Every other key keeps whatever it carries — `serializeEntry` in `src/write/template.ts`
    // quotes and escapes every value it emits, so an odd one becomes a strange string, never a
    // second key.
    out[key] = value;
  }
  return out;
}

/**
 * Why a REFUSED write may have been refused, when the target turns out to be hardlinked.
 *
 * The write layer refuses a hardlinked target — a note whose inode a second name shares, which
 * `cp -al` snapshots and some backup tools create legitimately — and its message names the path
 * without naming the link count, so the user cannot tell a hostile link from their own backup.
 * The refusal is not this module's to change; the ANSWER is, and this is the number that explains
 * it. It is added only to a write that already failed, so an ordinary refusal gains no noise.
 *
 * `stat` is confined to a path that stays inside the vault: this runs on caller-supplied input and
 * must not report on files outside it, not even a link count.
 */
async function hardLinkHint(vaultRoot: string, relPath: string): Promise<string | undefined> {
  try {
    // REAL paths on both sides, never the lexical ones. `resolve(root, relPath)` keeps the string
    // inside the vault while `lstat` follows every symlink on the way: with `02-wiki/fora` linked
    // outside, a lexically-inside path answered "o arquivo tem 3 hard links" about a file the vault
    // does not contain. Containment is a question about the filesystem, so it is asked of the
    // filesystem.
    const root = realpathSync(resolve(vaultRoot));
    const target = realpathSync(resolve(root, relPath));
    if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;

    const stat = await fs.lstat(target);
    if (stat.nlink > 1) {
      return (
        `o arquivo tem ${stat.nlink} hard links apontando para o mesmo inode ` +
        '(uma cópia `cp -al` ou um snapshot de backup faz isso), então escrever nele mudaria ' +
        'todas as cópias de uma vez'
      );
    }
  } catch {
    // Sem alvo legível não há o que explicar; o erro original já é a resposta.
  }
  return undefined;
}

/**
 * Runs a write and, if it is refused for a reason that is about the FILE rather than about the
 * caller's text, adds the link count that explains the refusal.
 *
 * `EditError` and `LearnError` are refusals of the ARGUMENTS — an anchor that matches nothing, a
 * domain that does not exist — and adding a link count to those would be noise.
 *
 * That exemption is DELIBERATELY UNPINNED, and this note exists so the next reader does not spend
 * the afternoon I spent trying to pin it. Reaching it needs an argument refusal ON a hardlinked
 * file, and the write guard in `src/write/paths.ts` classifies `nlink > 1` as `foreign` and refuses
 * it BEFORE any anchor is compared — correctly, since a shared inode must not be read or written
 * through. So that combination cannot occur, and on a file with a single link `hardLinkHint`
 * returns `undefined` anyway. The branch stays because this module should not lean on another
 * module's guard for a property it states itself; what IS reachable — a file-level refusal carrying
 * the count, an argument refusal carrying nothing about the file — is asserted as a pair in
 * `test/tools.test.ts`.
 */
async function withWriteDetail<T>(
  vaultRoot: string,
  relPath: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EditError || err instanceof LearnError || err instanceof ToolError) throw err;
    const hint = await hardLinkHint(vaultRoot, relPath);
    if (hint === undefined) throw err;
    throw new ToolError(`${messageOf(err)}; ${hint}`);
  }
}










export function createTools(deps: ToolDeps): ToolDefinition[] {
  const m = deps.messages ?? messagesFor('en');
  const writes = new WriteQueue();
  const redact = makeRedactor(deps.vaultRoot);

  const vaultSearch = define(
    redact,
    'vault_search',
    m.tools.vault_search.description,
    {
      query: z.string().min(1, m.validation.queryEmpty).describe(m.tools.vault_search.query),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(m.tools.vault_search.limit),
      tipo: z.string().optional().describe(m.tools.vault_search.tipo),
      folder: z.string().optional().describe(m.tools.vault_search.folder),
      include_raw: z
        .boolean()
        .optional()
        .describe(m.tools.vault_search.include_raw),
    },
    async (input) => {
      const { results, suggestions } = deps.retriever.search({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.tipo === undefined ? {} : { tipo: input.tipo }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
        ...(input.include_raw === undefined ? {} : { includeRaw: input.include_raw }),
      });

      // The query is caller-supplied and echoed back, so it is escaped like anything else that
      // lands in a structured line: a query carrying a newline would otherwise print a line
      // shaped exactly like a result this search never found.
      const query = forMessage(input.query);
      if (results.length === 0) {
        const head = `Nenhum resultado para "${query}".`;
        return suggestions === undefined
          ? head
          : `${head}\nSugestões de termos parecidos no vault: ${forMessage(suggestions.join(', '))}`;
      }

      const head =
        `${results.length} resultado(s) para "${query}". ` +
        'Cite `caminho:linha` ao usar qualquer trecho abaixo. ' +
        'Cada trecho da nota vem prefixado com `> `; linhas sem esse prefixo são deste servidor, ' +
        'nunca conteúdo do vault.';
      return [head, ...results.map(renderResult)].join('\n\n');
    },
  );

  const vaultGetNote = define(
    redact,
    'vault_get_note',
    m.tools.vault_get_note.description,
    { path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_get_note.path) },
    async (input) => {
      refreshVault(deps);
      const note = deps.scanner.getNote(input.path);
      if (note === undefined) {
        throw new ToolError(`nota não encontrada: ${forMessage(input.path)}`);
      }

      const frontmatter = renderFrontmatterBlock(note.frontmatter);
      // The body is relayed RAW — no `sanitizeQuoted`, no `> ` — and that is a decision, not an
      // omission. `vault_edit_note` locates `old_text` as an EXACT substring of the file, so an
      // agent that reads a note here and then edits a piece of it must be handed the bytes that are
      // on disk; escaping a control would make every such edit fail to match, silently, on exactly
      // the notes that carry one. This tool also makes no structural claim to undermine: it returns
      // one note, with no per-line prefix contract and no citation lines a body could forge. The
      // surfaces that DO make such a claim — the search snippet and the relayed diff — are
      // sanitised, and this one is bounded instead (`MAX_NOTE_CHARS`).
      const body =
        note.body.length <= MAX_NOTE_CHARS
          ? note.body
          : `${sliceAtCodePointBoundary(note.body, MAX_NOTE_CHARS)}\n[…nota cortada em ${MAX_NOTE_CHARS} caracteres]`;

      return [
        forMessage(`${note.path} — ${note.title}`),
        'Frontmatter:',
        frontmatter === '' ? '  (nenhum)' : frontmatter,
        `Links: ${note.links.length === 0 ? '(nenhum)' : forMessage(note.links.join(', '))}`,
        `Links quebrados: ${
          note.brokenLinks.length === 0 ? '(nenhum)' : forMessage(note.brokenLinks.join(', '))
        }`,
        '',
        body,
      ].join('\n');
    },
  );

  const vaultList = define(
    redact,
    'vault_list',
    m.tools.vault_list.description,
    {
      tipo: z.string().optional().describe(m.tools.vault_list.tipo),
      tags: z.array(z.string()).optional().describe(m.tools.vault_list.tags),
      status: z.string().optional().describe(m.tools.vault_list.status),
      folder: z.string().optional().describe(m.tools.vault_list.folder),
    },
    async (input) => {
      refreshVault(deps);
      // Tags are compared case-insensitively: the vault writes `nestjs` and an agent routinely
      // asks for `NestJS`, and a filter that answers "nenhuma nota" to a tag that exists is read
      // as an empty vault rather than as a case mismatch.
      const wanted = (input.tags ?? []).map((tag) => tag.toLowerCase());
      const notes = deps.scanner
        .allNotes()
        .filter((note) => {
          if (input.tipo !== undefined && stringField(note, 'tipo') !== input.tipo) return false;
          if (input.status !== undefined && stringField(note, 'status') !== input.status) return false;
          if (input.folder !== undefined && !inFolder(note.path, input.folder)) return false;
          if (wanted.length > 0) {
            const tags = noteTags(note).map((tag) => tag.toLowerCase());
            if (!wanted.every((tag) => tags.includes(tag))) return false;
          }
          return true;
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      if (notes.length === 0) return 'Nenhuma nota com os filtros informados.';
      return [`${notes.length} nota(s):`, ...notes.map(renderNoteLine)].join('\n');
    },
  );

  const vaultBacklinks = define(
    redact,
    'vault_backlinks',
    m.tools.vault_backlinks.description,
    { path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_backlinks.path) },
    async (input) => {
      refreshVault(deps);
      const target = deps.scanner.getNote(input.path);
      // Asked rather than answered with an empty list: the graph only holds edges to notes that
      // exist, so a wrong path and a genuinely unlinked note would give the same answer, and the
      // agent would read a typo as "this note is isolated".
      if (target === undefined) {
        throw new ToolError(`nota não encontrada: ${forMessage(input.path)}`);
      }

      // Rebuilt per call rather than cached: the scanner's delta is consumed by the retriever
      // (see `refreshVault`), so this layer cannot tell whether the vault moved, and `build` is a
      // pass over the edges the scanner already resolved.
      const graph = new LinkGraph();
      graph.build(deps.scanner.allNotes());
      // `LinkGraph` stores edges in a `Set`, so a note linking `[[auth-guard]]` twice is ONE
      // backlink here — deduplicated, not dropped.
      const backlinks = graph.backlinks(target.path).sort();

      if (backlinks.length === 0) {
        return `Nenhuma nota aponta para ${forMessage(target.path)}.`;
      }
      const lines = backlinks.map((path) => {
        const note = deps.scanner.getNote(path);
        return forMessage(`- ${path}${note === undefined ? '' : ` — ${note.title}`}`);
      });
      return [`${backlinks.length} nota(s) apontam para ${forMessage(target.path)}:`, ...lines].join('\n');
    },
  );

  const vaultWriteNote = define(
    redact,
    'vault_write_note',
    m.tools.vault_write_note.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_write_note.path),
      content: z.string().describe(m.tools.vault_write_note.content),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe(m.tools.vault_write_note.frontmatter),
    },
    async (input) => {
      const frontmatter = toFrontmatter(input.frontmatter);
      // `writeNote`'s `tipo` argument is deliberately NOT passed, even when the caller sends
      // `tipo: 'wiki'` in the frontmatter — which still lands in the block, since `writeNote`
      // merges `frontmatter` over its defaults. That argument is what selects a `_templates/`
      // skeleton, and splicing one under content the caller already authored gives the note two
      // `# H1`s and a set of empty sections nobody asked for. The skeleton belongs to `vault_learn`,
      // which composes the body itself; here the content is the note.
      const { value: result, warning } = await writes.runExclusive(() =>
        withWriteDetail(deps.vaultRoot, input.path, () =>
          writeNote({
            vaultRoot: deps.vaultRoot,
            path: input.path,
            content: input.content,
            ...(frontmatter === undefined ? {} : { frontmatter }),
          }),
        ),
      );
      return renderWrite(result, result.created ? 'Nota criada' : 'Nota substituída', redact, warning);
    },
  );

  const vaultEditNote = define(
    redact,
    'vault_edit_note',
    m.tools.vault_edit_note.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_edit_note.path),
      old_text: z.string().min(1, m.validation.oldTextEmpty).describe(m.tools.vault_edit_note.old_text),
      new_text: z.string().describe(m.tools.vault_edit_note.new_text),
    },
    async (input) => {
      const { value: result, warning } = await writes.runExclusive(() =>
        withWriteDetail(deps.vaultRoot, input.path, () =>
          editNote({
            vaultRoot: deps.vaultRoot,
            path: input.path,
            oldText: input.old_text,
            newText: input.new_text,
          }),
        ),
      );
      return renderWrite(result, 'Nota editada', redact, warning);
    },
  );

  const vaultLearn = define(
    redact,
    'vault_learn',
    m.tools.vault_learn.description,
    {
      titulo: z.string().min(1, m.validation.tituloEmpty).describe(m.tools.vault_learn.titulo),
      insight: z.string().min(1, m.validation.insightEmpty).describe(m.tools.vault_learn.insight),
      contexto: z.string().min(1, m.validation.contextoEmpty).describe(m.tools.vault_learn.contexto),
      dominio: z
        .string()
        .min(1, m.validation.dominioEmpty)
        .describe(m.tools.vault_learn.dominio),
      projeto: z
        .string()
        .optional()
        .describe(m.tools.vault_learn.projeto),
      tags: z.array(z.string()).optional().describe(m.tools.vault_learn.tags),
      links: z.array(z.string()).optional().describe(m.tools.vault_learn.links),
      confirm_novo_dominio: z
        .boolean()
        .optional()
        .describe(m.tools.vault_learn.confirm_novo_dominio),
    },
    async (input) => {
      const { value: result, warning: queueWarning } = await writes.runExclusive(() =>
        learn({
          vaultRoot: deps.vaultRoot,
          retriever: deps.retriever,
          titulo: input.titulo,
          insight: input.insight,
          contexto: input.contexto,
          dominio: input.dominio,
          ...(input.projeto === undefined ? {} : { projeto: input.projeto }),
          // The same round-trip guard as `vault_write_note`: `learn` writes these into the very
          // same YAML block, so a tag that would not come back must be refused here too.
          ...(input.tags === undefined ? {} : { tags: coerceTags(input.tags) }),
          ...(input.links === undefined ? {} : { links: input.links }),
          ...(input.confirm_novo_dominio === undefined
            ? {}
            : { confirmNovoDominio: input.confirm_novo_dominio }),
          now: new Date(),
        }),
      );

      const lines = [
        result.action === 'created'
          ? `Aprendizado registrado em nota NOVA: ${forMessage(result.path)}`
          : `Aprendizado ANEXADO à nota existente: ${forMessage(result.path)}`,
        // `reason` and `warning` name paths read off the vault index, so they carry whatever a
        // file name carries.
        `Motivo: ${forMessage(redact(result.reason))}`,
        `Propagado para: ${
          result.propagated.length === 0 ? '(nada)' : forMessage(result.propagated.join(', '))
        }`,
        `Commit: ${result.committed ? 'sim' : 'não'}`,
        // Same rule as `renderWrite`: the line exists only when a push was attempted.
        ...(result.pushed === undefined ? [] : [`Push: ${result.pushed ? 'sim' : 'não'}`]),
      ];
      for (const aviso of [result.warning, queueWarning]) {
        if (aviso !== undefined) lines.push(`Aviso: ${forMessage(redact(aviso))}`);
      }
      lines.push('', 'Diff (mostre ao usuário):', result.diff === '' ? '(vazio)' : relayDiff(result.diff));
      return lines.join('\n');
    },
  );

  /**
   * `refreshVault` INSIDE the exclusive slot, and only for these two.
   *
   * Every other write tool answers a question about one path, and `guardedPath` plus
   * `classifyNode` answer it from the filesystem. These two answer questions about the GRAPH —
   * which notes link here, where does `[[slug]]` resolve — and those come out of the scanner. A
   * stale scanner does not fail loudly here: it rewrites the wrong file, or reports a note as
   * unlinked and deletes it. So the refresh runs, and it runs after the queue has granted the
   * slot, so no write of this process can land between the refresh and the operation.
   */
  const refreshedWrite = <T>(run: () => Promise<T>): Promise<{ value: T; warning?: string }> =>
    writes.runExclusive(() => {
      refreshVault(deps);
      return run();
    });

  const vaultMove = define(
    redact,
    'vault_move',
    m.tools.vault_move.description,
    {
      from: z.string().min(1, m.validation.fromEmpty).describe(m.tools.vault_move.from),
      to: z
        .string()
        .min(1, m.validation.toEmpty)
        .describe(m.tools.vault_move.to),
      confirm_novo_dominio: z
        .boolean()
        .optional()
        .describe(m.tools.vault_move.confirm_novo_dominio),
    },
    async (input) => {
      const { value: result, warning } = await refreshedWrite(() =>
        moveNote({
          vaultRoot: deps.vaultRoot,
          scanner: deps.scanner,
          from: input.from,
          to: input.to,
          ...(input.confirm_novo_dominio === undefined
            ? {}
            : { confirmNovoDominio: input.confirm_novo_dominio }),
          now: new Date(),
        }),
      );
      return renderRelocate(
        `Nota movida: ${forMessage(result.from)} → ${forMessage(result.to)}`,
        result,
        redact,
        warning,
      );
    },
  );

  const vaultDelete = define(
    redact,
    'vault_delete',
    m.tools.vault_delete.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_delete.path),
      confirm: z
        .boolean()
        .optional()
        .describe(m.tools.vault_delete.confirm),
    },
    async (input) => {
      const { value: result, warning } = await refreshedWrite(() =>
        deleteNote({
          vaultRoot: deps.vaultRoot,
          scanner: deps.scanner,
          path: input.path,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
          now: new Date(),
        }),
      );
      return renderRelocate(`Nota apagada: ${forMessage(result.path)}`, result, redact, warning);
    },
  );

  return [
    vaultSearch,
    vaultGetNote,
    vaultList,
    vaultBacklinks,
    vaultWriteNote,
    vaultEditNote,
    vaultLearn,
    vaultMove,
    vaultDelete,
  ];
}
