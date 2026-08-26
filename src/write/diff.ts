/**
 * A line-level unified diff, with no external dependency.
 *
 * This is the value of `WriteResult.diff`, and it is the only thing that makes a write
 * VISIBLE. Everything else in the write path reports that something happened; this
 * reports what. A user reading a `vault_write_note` response has no other way to tell a
 * two-word fix from a note rewritten end to end.
 */

/** Lines of context kept on each side of a change, matching `diff -u`'s default. */
const CONTEXT = 3;

/**
 * The largest combined input, in characters, that will be diffed line by line at all.
 *
 * `MAX_EDIT_DISTANCE` caps the SEARCH DEPTH, which is not the same thing as capping
 * memory: every round pushes an `Int32Array` of `2*(n+m)+3` onto the trace, so the trace
 * costs roughly `D * 8 * (n+m)` bytes and grows without bound in `n+m` however small D
 * stays. A 6.5 MB note replaced by a 12-byte string measured 4.4 s of blocked event loop
 * and 5,035 MB of RSS. `--max-old-space-size` does not help, because a typed array's
 * backing store is EXTERNAL to the V8 heap: the process walks past the flag straight into
 * the OS OOM killer, which is not an error anything can catch.
 *
 * So the first bound is on the input itself, checked before the text is even split into
 * lines. Past it the answer is a coarse "N lines changed" summary. That is a real loss of
 * detail, and it is the right loss: this is a single-event-loop MCP server, and a diff
 * that takes the whole process down with it reports nothing at all.
 */
const MAX_DIFF_INPUT_CHARS = 2 * 1024 * 1024;

/**
 * The largest trace the Myers search may allocate, in bytes — the ONE bound on the search.
 *
 * The greedy algorithm keeps one V array per round, so the trace is what makes a diff of
 * two texts with nothing in common expensive. Storing only the WINDOW each round can reach
 * (see `myersOps`) removes the `n+m` factor from each entry, leaving an honest O(D²) in
 * BYTES — which is the point: with the width gone, a byte budget is simultaneously a depth
 * budget (8 MB is reached at D ≈ 1445) and a time budget, because the work per round is
 * proportional to the window that round writes. One number bounds both, and it bounds them
 * whatever the input looks like.
 *
 * An earlier version also carried a separate `MAX_EDIT_DISTANCE` of 3000 rounds. Windowing
 * made it DEAD: 3000 rounds cost about 36 MB, so the byte budget always tripped first and
 * the depth cap could never be observed — a bound no test could reach is a bound that is
 * not there. It is gone, and this is the only thing `myersOps` gives up on.
 *
 * Past it the answer is still CORRECT, just less minimal: `fallbackOps` reports the whole
 * remaining region as deleted-then-added, which is what a diff of two unrelated texts looks
 * like anyway. The common-affix trim in `diffOps` runs first, so an ordinary note edit has
 * a D in the single digits and never approaches this.
 */
const MAX_TRACE_BYTES = 8 * 1024 * 1024;

type OpKind = '=' | '-' | '+';

interface Op {
  kind: OpKind;
  /** Index into the `before` lines, or -1 for an addition. */
  a: number;
  /** Index into the `after` lines, or -1 for a deletion. */
  b: number;
}

interface Sides {
  lines: string[];
  /** True when the text is non-empty and does not end in a newline. */
  noTrailingNewline: boolean;
}

/**
 * Splits a text into diffable lines.
 *
 * A trailing newline is a TERMINATOR, not a separator, so `'a\n'` is one line and not
 * two — `split('\n')` disagrees, and taking its word for it makes every file that ends
 * properly look like it has a phantom empty last line. Whether that terminator is
 * present is kept separately so the diff can say `\ No newline at end of file`, which
 * is the only way the output can distinguish `'a'` from `'a\n'` at all.
 */
function toSides(text: string): Sides {
  if (text === '') return { lines: [], noTrailingNewline: false };
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
    return { lines, noTrailingNewline: false };
  }
  return { lines, noTrailingNewline: true };
}

/** Every `a` line deleted, then every `b` line added. Correct, merely not minimal. */
function fallbackOps(a: string[], b: string[], aFrom: number, bFrom: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < a.length; i += 1) ops.push({ kind: '-', a: aFrom + i, b: -1 });
  for (let j = 0; j < b.length; j += 1) ops.push({ kind: '+', a: -1, b: bFrom + j });
  return ops;
}

/**
 * Myers' greedy O(ND) line diff, recording the search trace so the edit script can be
 * recovered by walking it backwards.
 *
 * Returns `undefined` when the trace would exceed `MAX_TRACE_BYTES`; the caller falls back
 * rather than allocating without bound. `aFrom`/`bFrom` shift the emitted indices back
 * into the caller's un-trimmed coordinates.
 */
function myersOps(
  a: string[],
  b: string[],
  aFrom: number,
  bFrom: number
): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  // `n + m` is the true worst-case edit distance, so the loop is unbounded only in the
  // sense that `MAX_TRACE_BYTES` is what stops it early.
  const max = n + m;
  // `off` shifts the diagonal index `k` (which runs from `-d` to `d`) into a non-negative
  // array index. The `+1` of `off` and the `+3` of `size` are one slot of headroom each:
  // `k + 1 + off` is read at `k === d === n + m`, and with the tight `2(n+m)+1` sizing that
  // read walks off the end of the array — silently, since a typed array returns
  // `undefined` rather than throwing. On two empty inputs that is the FIRST read taken,
  // so the diff of `'a\n'` against `'a'` came back with no ops at all.
  const off = n + m + 1;
  const size = 2 * (n + m) + 3;

  const v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let traceBytes = 0;

  for (let d = 0; d <= max; d += 1) {
    // Only the diagonals in `[-d, d]` are written this round, and the reads reach one
    // further on each side, so `[-(d+1), d+1]` is everything round `d` can touch. Keeping
    // a copy of the WHOLE `v` instead — `v.slice()` — is what made the trace cost
    // `D * (n+m)` and let a 6.5 MB note allocate gigabytes: the width of the array has
    // nothing to do with how much of it the search has actually reached. `d <= max <= n+m`
    // keeps this window inside the array without clamping, so the index of diagonal `k`
    // within it is exactly `k + d + 1`.
    const window = v.slice(off - d - 1, off + d + 2);
    traceBytes += window.byteLength;
    if (traceBytes > MAX_TRACE_BYTES) return undefined;
    trace.push(window);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!)) {
        x = v[k + 1 + off]!;
      } else {
        x = v[k - 1 + off]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + off] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, aFrom, bFrom);
    }
  }
  return undefined;
}

/**
 * Recovers the edit script from the trace, walking from the end back to the origin.
 *
 * `trace[d]` is the V array as it stood BEFORE round `d` ran, which is what makes the
 * "which neighbour did we come from" test below identical to the one the forward pass
 * made — the two must agree or the reconstruction wanders off the path that was
 * actually taken.
 *
 * Each entry holds only the window `[-(d+1), d+1]` that round `d` could reach, so
 * diagonal `k` lives at `k + d + 1` rather than at `k + off`. The window is exactly the
 * set of diagonals this walk reads, since `k` here is confined to `[-d, d]`.
 */
function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  aFrom: number,
  bFrom: number
): Op[] {
  const reversed: Op[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const w = d + 1;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + w]! < v[k + 1 + w]!) ? k + 1 : k - 1;
    const prevX = v[prevK + w]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      reversed.push({ kind: '=', a: aFrom + x - 1, b: bFrom + y - 1 });
      x -= 1;
      y -= 1;
    }

    if (d > 0) {
      if (x === prevX) reversed.push({ kind: '+', a: -1, b: bFrom + prevY });
      else reversed.push({ kind: '-', a: aFrom + prevX, b: -1 });
      x = prevX;
      y = prevY;
    }
  }

  reversed.reverse();
  return reversed;
}

/**
 * The edit script from `a` to `b`.
 *
 * The common prefix and suffix are stripped before the search runs. That is not an
 * optimisation detail — it is what keeps D small for the shape this module actually
 * sees: `editNote` replaces one substring inside a note that is otherwise byte-identical,
 * so trimming turns a 400-line diff into a two-line one and the O(D²) trace never grows.
 */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head: Op[] = [];
  for (let i = 0; i < start; i += 1) head.push({ kind: '=', a: i, b: i });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myersOps(midA, midB, start, start) ?? fallbackOps(midA, midB, start, start);

  const tail: Op[] = [];
  for (let i = endA; i < a.length; i += 1) tail.push({ kind: '=', a: i, b: b.length - (a.length - i) });

  return [...head, ...middle, ...tail];
}

/** Contiguous op ranges to render, each already padded with up to `CONTEXT` lines. */
function hunkRanges(ops: Op[]): Array<[number, number]> {
  const changed = ops.map((op) => op.kind !== '=');
  const ranges: Array<[number, number]> = [];

  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - CONTEXT);
    let last = i;
    let j = i + 1;
    while (j < ops.length) {
      if (changed[j]) {
        last = j;
        j += 1;
        continue;
      }
      // An unchanged run short enough to be context on BOTH sides keeps the hunks
      // joined; anything longer is cheaper to render as two hunks than as one.
      let k = j;
      while (k < ops.length && !changed[k]) k += 1;
      if (k < ops.length && k - j <= 2 * CONTEXT) {
        j = k;
        continue;
      }
      break;
    }
    ranges.push([start, Math.min(ops.length - 1, last + CONTEXT)]);
    i = Math.min(ops.length - 1, last + CONTEXT) + 1;
  }
  return ranges;
}

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * The path as it may appear inside a header line.
 *
 * A unified diff is a LINE-structured format, and this function's only job is that a
 * header occupies exactly one line whatever it is handed. Interpolating the path raw let
 * a filename containing a newline inject fabricated `+++`/`@@` lines, and a diff carrying
 * a forged hunk that attributes attacker-chosen content to a file that was never touched
 * defeats the entire point of showing the user a diff.
 *
 * `writer.ts` already refuses control characters in a note path, so nothing reaching the
 * write path arrives here dirty. This is the second lock on the same door: `unifiedDiff`
 * is exported and its output is a security boundary in its own right, so its structure
 * must not depend on a caller having validated anything.
 *
 * "One line" is not the same question as "one \n". `\n` and `\r` are what a terminal
 * breaks on, but CSS Text 3 makes U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR and
 * U+0085 NEXT LINE forced breaks in every HTML-rendering client, and a chat UI showing a
 * diff is exactly such a client. A path carrying a raw U+2028 rendered there as a
 * complete, fabricated `+++`/`@@` hunk while `split('\n')` over the same string saw one
 * line and reported nothing wrong.
 *
 * "One line" is not the whole question either. A path can occupy exactly one line and
 * still not READ as itself: U+202E RIGHT-TO-LEFT OVERRIDE and the rest of the bidi
 * controls reorder the characters after them, and the zero-width formats render as
 * nothing at all, so `02-wiki/nota\u202edm.hsab\u202c.md` displays as `nota basit.md` in
 * every bidi-aware client while naming a different file. That cannot forge a hunk the way
 * a break can, but a header the reader cannot read is a header that certifies nothing, and
 * escaping costs the same either way.
 *
 * So the escaped set is every C0 control, DEL, every C1 control (U+0085 among them), the
 * two Unicode separators, and every bidi control and zero-width format — the same set
 * `writer.ts`'s `CONTROL_CHARS` refuses, which is not a coincidence and must not drift.
 * `test/writer.test.ts`'s `INVISIBLE_CODEPOINTS` runs one table against both, so adding a
 * codepoint to one side and not the other fails there rather than silently reopening the
 * hole on whichever side was forgotten.
 */
function headerPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.charCodeAt(0);
    // `\x2028` would read back as `\x20` followed by a literal `28`, so anything wider
    // than one byte is escaped in the four-digit form that can only mean what it names.
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Lines in `text[from, to)`, counting a trailing newline as a terminator rather than a
 * separator. Takes a range rather than a substring so the caller never has to allocate a
 * copy of a region that can be megabytes wide.
 */
function countLines(text: string, from = 0, to = text.length): number {
  if (to <= from) return 0;
  let lines = 0;
  for (let i = from; i < to; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return text.charCodeAt(to - 1) === 10 ? lines : lines + 1;
}

/** `1 linha removida` / `4 linhas removidas`, so the summary reads as Portuguese. */
function lineCount(count: number, participle: string): string {
  return count === 1
    ? `1 linha ${participle}`
    : `${count} linhas ${participle}${participle.endsWith('a') ? 's' : ''}`;
}

/**
 * The half-open span `[start, endBefore)` of `before` and `[start, endAfter)` of `after`
 * that the two texts do NOT share, snapped outwards to whole lines.
 *
 * Character-level, deliberately: this runs on inputs too big to split into lines at all,
 * so it may only walk the strings with `charCodeAt` — O(n) time, O(1) memory, no
 * allocation. The common prefix and suffix are the same in both texts by construction, so
 * one `start` indexes both.
 *
 * The snap outwards to line boundaries is what makes the result honest in LINES. Without
 * it, `hello world` → `hello brave world` trims to `''` against `brave` and counts zero
 * lines removed, when a line was plainly rewritten.
 */
function changedSpan(
  before: string,
  after: string
): { start: number; endBefore: number; endAfter: number } {
  const min = Math.min(before.length, after.length);
  let start = 0;
  while (start < min && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  // Back to the start of the line the change begins on.
  while (start > 0 && before.charCodeAt(start - 1) !== 10) start -= 1;
  // Forward to the end of the line it ends on. Both ends move together: the untouched
  // suffix is the same length on each side, so stepping one steps the other.
  while (endBefore < before.length && before.charCodeAt(endBefore - 1) !== 10) {
    endBefore += 1;
    endAfter += 1;
  }

  return { start, endBefore, endAfter };
}

/**
 * The coarse answer for an input too large to diff line by line.
 *
 * It keeps the header shape a caller can recognise and says plainly that the detail is
 * missing, because silently returning something that LOOKS like a complete diff of a
 * 7 MB rewrite would be worse than admitting the limit.
 *
 * The counts describe the CHANGED REGION, not the whole file. Counting whole files here
 * made the summary technically true and practically useless: a one-word fix in a 2 MB note
 * reported "50000 linhas removidas, 50000 linhas adicionadas", which tells the user
 * nothing except how big their note is. "1 linha removida, 1 linha adicionada" tells them
 * the edit was small even though the detail could not be rendered.
 */
function coarseSummary(before: string, after: string, path: string, toPath: string): string {
  const span = changedSpan(before, after);
  const removed = countLines(before, span.start, span.endBefore);
  const added = countLines(after, span.start, span.endAfter);
  const label = headerPath(path);
  const toLabel = headerPath(toPath);
  return [
    before === '' ? '--- /dev/null' : `--- a/${label}`,
    after === '' ? '+++ /dev/null' : `+++ b/${toLabel}`,
    '@@ diff omitido @@',
    ` entrada de ${before.length + after.length} caracteres excede o limite de ` +
      `${MAX_DIFF_INPUT_CHARS}; ${lineCount(removed, 'removida')}, ${lineCount(added, 'adicionada')}`,
    '',
  ].join('\n');
}

/**
 * True when this op's line is the LAST line of a side that ends without a terminator.
 *
 * `-` never touches side B and `+` never touches side A, so the guard on `kind` is what
 * keeps `op.a`/`op.b` of `-1` from matching `length - 1` of an empty side.
 */
function unterminatedA(op: Op, a: Sides): boolean {
  return op.kind !== '+' && op.a === a.lines.length - 1 && a.noTrailingNewline;
}

function unterminatedB(op: Op, b: Sides): boolean {
  return op.kind !== '-' && op.b === b.lines.length - 1 && b.noTrailingNewline;
}

/**
 * Rewrites every `=` whose two sides disagree about the final newline into a delete/add
 * pair, in place.
 *
 * A line's TERMINATOR is part of the line. `a`'s last line without a trailing newline and
 * `b`'s last line with one are different lines even when their characters match, so the
 * `=` that `diffOps` pairs them into is not an equality at all — `diffOps` compares the
 * strings `toSides` split out, and the terminator is not in them.
 *
 * Rendering such an op as a CONTEXT line is what made the `\ No newline` marker lie:
 * the marker after a context line asserts that BOTH sides end there without a terminator,
 * so on `unifiedDiff('a', 'a\nb\n')` it told `patch` to strip a newline that `b` still
 * has. Splitting the op is what git does, and it is what gives the marker exactly one
 * side to describe.
 *
 * It subsumes the case the line diff cannot see at all: adding or removing only the file's
 * final newline changes no LINE, every op comes back `=`, and without this the whole edit
 * would render as the empty diff that means "the write changed nothing".
 */
function splitUnterminatedContext(ops: Op[], a: Sides, b: Sides): void {
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    if (op.kind !== '=') continue;
    if (unterminatedA(op, a) === unterminatedB(op, b)) continue;
    ops.splice(i, 1, { kind: '-', a: op.a, b: -1 }, { kind: '+', a: -1, b: op.b });
    i += 1;
  }
}

/**
 * Reorders each run of consecutive changed ops into all deletions, then all additions.
 *
 * The backtrack can hand back a run interleaved as `-b +b -c`, which is the same edit but
 * puts a `+` line before a `-` line that follows it. That matters for one reason: a
 * `\ No newline` marker attaches to the line ABOVE it, so a marker on the last added line
 * lands in the middle of the hunk with deletions still to come — a shape `git apply` is
 * entitled to read differently from the one git itself emits.
 *
 * Within one run the `-` ops are already in increasing `a` order and the `+` ops in
 * increasing `b` order, and no `=` separates them, so grouping preserves both the preimage
 * and the postimage exactly. It only makes the rendering canonical.
 */
function groupChanges(ops: Op[]): void {
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === '=') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]!.kind !== '=') j += 1;
    const run = ops.slice(i, j);
    const dels = run.filter((op) => op.kind === '-');
    const adds = run.filter((op) => op.kind === '+');
    if (dels.length > 0 && adds.length > 0) {
      // Written back one element at a time, NOT `splice(i, j - i, ...dels, ...adds)`.
      // A spread passes every op as a separate function argument and V8 caps that at the
      // stack, so the splice threw `RangeError: Maximum call stack size exceeded` from
      // ~249k lines per side — a full rewrite comes back from `fallbackOps` as ONE run
      // holding the entire edit script, so the spread's width is the whole op count. That
      // is under half `MAX_DIFF_INPUT_CHARS`, and `safeDiff` swallowed the throw into
      // `@@ diff indisponível @@`: the note still written, the diff that is the only
      // visible record of it gone, at a size the caller picks. The run is only reordered
      // and `dels.length + adds.length === j - i`, so an in-place write does the same job
      // with no argument list at all.
      for (let k = 0; k < dels.length; k += 1) ops[i + k] = dels[k]!;
      for (let k = 0; k < adds.length; k += 1) ops[i + dels.length + k] = adds[k]!;
    }
    i = j;
  }
}

/**
 * A unified diff of `before` → `after`, labelled with `path` — and with `toPath` on the
 * `+++` side when the file also MOVED.
 *
 * Returns `''` when the texts are identical AND the path did not change: an empty diff is
 * how a caller reports "the write changed nothing", and a header with no hunks would read
 * as a change. A RENAME is a change, though, and a pure one — identical bytes under a new
 * name — is where that rule bites hardest: labelled with one path it renders as the empty
 * string, and `vault_move`'s user is shown nothing at all about the operation that just
 * ran. So a differing `toPath` renders the header alone, which is exactly the claim being
 * made: this file is now that file, and no line of it changed.
 *
 * A new file (`before` is `''`) is rendered against `/dev/null`, the way git does it, and
 * `toPath` still labels the `+++` side there.
 *
 * `toPath` is escaped by the same `headerPath` as `path`. It is a caller-supplied path
 * reaching the same rendered surface, so leaving it raw would reopen — on the new
 * parameter — the forged-hunk hole that escaping the first one closed.
 */
export function unifiedDiff(before: string, after: string, path: string, toPath?: string): string {
  const destination = toPath ?? path;
  if (before === after) {
    if (destination === path) return '';
    return `--- a/${headerPath(path)}\n+++ b/${headerPath(destination)}\n`;
  }

  // Checked BEFORE `toSides` splits anything: on a 6.5 MB note the split alone allocates
  // an array of every line, and the point of this bound is to not touch the input at all
  // once it is too big to handle inside one tick of a single-threaded server.
  if (before.length + after.length > MAX_DIFF_INPUT_CHARS) {
    return coarseSummary(before, after, path, destination);
  }

  const a = toSides(before);
  const b = toSides(after);
  const ops = diffOps(a.lines, b.lines);

  splitUnterminatedContext(ops, a, b);
  groupChanges(ops);

  const ranges = hunkRanges(ops);
  if (ranges.length === 0) return '';

  const label = headerPath(path);
  const toLabel = headerPath(destination);
  const out: string[] = [
    before === '' ? '--- /dev/null' : `--- a/${label}`,
    after === '' ? '+++ /dev/null' : `+++ b/${toLabel}`,
  ];

  // Line numbers are 1-based and count only the lines present on each side.
  const aIndex: number[] = [];
  const bIndex: number[] = [];
  let aPos = 0;
  let bPos = 0;
  for (const op of ops) {
    aIndex.push(aPos);
    bIndex.push(bPos);
    if (op.kind !== '+') aPos += 1;
    if (op.kind !== '-') bPos += 1;
  }

  for (const [from, to] of ranges) {
    let aCount = 0;
    let bCount = 0;
    for (let i = from; i <= to; i += 1) {
      if (ops[i]!.kind !== '+') aCount += 1;
      if (ops[i]!.kind !== '-') bCount += 1;
    }
    const aStart = aCount === 0 ? 0 : aIndex[from]! + 1;
    const bStart = bCount === 0 ? 0 : bIndex[from]! + 1;
    out.push(`@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@`);

    for (let i = from; i <= to; i += 1) {
      const op = ops[i]!;
      const line = op.kind === '+' ? b.lines[op.b]! : a.lines[op.a]!;
      out.push(`${op.kind === '=' ? ' ' : op.kind}${line}`);

      const lastOfA = unterminatedA(op, a);
      const lastOfB = unterminatedB(op, b);
      // A `-` line exists only on side A and a `+` line only on side B, so for those the
      // marker describes the one side the line came from and `||` reads the single flag
      // that can be set. A CONTEXT line is on BOTH sides at once, and the marker after it
      // asserts that both of them end there without a terminator — emitting it because
      // only one does is what told `patch` to strip a newline the other side still had.
      // `splitUnterminatedContext` has already rewritten every `=` whose sides disagree,
      // so the two flags agree on everything reaching here as `=`; the `&&` is the honest
      // spelling of that invariant rather than a second, independent check.
      if (op.kind === '=' ? lastOfA && lastOfB : lastOfA || lastOfB) out.push(NO_NEWLINE);
    }
  }

  return `${out.join('\n')}\n`;
}

/** `start,count`, with `diff -u`'s elision of the count when it is exactly 1. */
function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
