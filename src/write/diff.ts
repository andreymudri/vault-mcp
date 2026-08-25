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
 * The largest edit distance the Myers search will explore before giving up.
 *
 * The greedy algorithm keeps one V array per D, so the trace costs O(D²) memory: on two
 * files that share nothing, D is the sum of their lengths and a pair of 50k-line inputs
 * would allocate on the order of 10¹⁰ integers. That is not a slow diff, it is a dead
 * MCP server — `unifiedDiff` is synchronous and never awaits, so nothing at the tool
 * layer can interrupt it.
 *
 * Beyond the cap the answer is still CORRECT, just less minimal: `fallbackOps` reports
 * the whole remaining region as deleted-then-added, which is what a diff of two texts
 * with nothing in common looks like anyway. The common-affix trim below runs first, so
 * an ordinary note edit has a D in the single digits and never approaches this.
 */
const MAX_EDIT_DISTANCE = 3000;

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
 * Returns `undefined` when the edit distance exceeds `MAX_EDIT_DISTANCE`; the caller
 * falls back rather than allocating without bound. `aFrom`/`bFrom` shift the emitted
 * indices back into the caller's un-trimmed coordinates.
 */
function myersOps(
  a: string[],
  b: string[],
  aFrom: number,
  bFrom: number
): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
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

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
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
      if (x >= n && y >= m) return backtrack(trace, a, b, off, aFrom, bFrom);
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
 */
function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  off: number,
  aFrom: number,
  bFrom: number
): Op[] {
  const reversed: Op[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!) ? k + 1 : k - 1;
    const prevX = v[prevK + off]!;
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
 * A unified diff of `before` → `after`, labelled with `path`.
 *
 * Returns `''` when the texts are identical — an empty diff is how a caller reports
 * "the write changed nothing", and a header with no hunks would read as a change.
 * A new file (`before` is `''`) is rendered against `/dev/null`, the way git does it.
 */
export function unifiedDiff(before: string, after: string, path: string): string {
  if (before === after) return '';

  const a = toSides(before);
  const b = toSides(after);
  const ops = diffOps(a.lines, b.lines);

  // Adding or removing the file's final newline changes no LINE, so the line diff above
  // finds nothing and the whole edit would be reported as an empty diff — the one output
  // that means "the write changed nothing". It did change something, and a note whose
  // last line lost its terminator is exactly the kind of edit a user wants to see. Git
  // renders it by rewriting the last line as a delete/add pair; the `\ No newline` marker
  // below then attaches to whichever side lacks the terminator.
  if (a.noTrailingNewline !== b.noTrailingNewline && ops.length > 0) {
    const last = ops[ops.length - 1]!;
    if (last.kind === '=' && last.a === a.lines.length - 1 && last.b === b.lines.length - 1) {
      ops.splice(
        ops.length - 1,
        1,
        { kind: '-', a: last.a, b: -1 },
        { kind: '+', a: -1, b: last.b }
      );
    }
  }

  const ranges = hunkRanges(ops);
  if (ranges.length === 0) return '';

  const out: string[] = [
    before === '' ? '--- /dev/null' : `--- a/${path}`,
    after === '' ? '+++ /dev/null' : `+++ b/${path}`,
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

      const lastOfA = op.kind !== '+' && op.a === a.lines.length - 1 && a.noTrailingNewline;
      const lastOfB = op.kind !== '-' && op.b === b.lines.length - 1 && b.noTrailingNewline;
      if (lastOfA || lastOfB) out.push(NO_NEWLINE);
    }
  }

  return `${out.join('\n')}\n`;
}

/** `start,count`, with `diff -u`'s elision of the count when it is exactly 1. */
function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
