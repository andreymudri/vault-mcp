/**
 * Wiki-link extraction and resolution. Pure functions: no I/O, no filesystem access. The caller
 * owns the vault index (`allPaths`, `byBasename`) and passes it in.
 */

/**
 * `[[target]]`, `[[target#anchor]]`, `[[target|alias]]`, `[[target#anchor|alias]]`.
 *
 * Every class excludes `\n` and `[` deliberately, and both exclusions are load-bearing against
 * quadratic backtracking on hostile input — note bodies include web pages clipped into
 * `01-raw/clippings/`, so this parses untrusted text.
 *
 * A class that admits `[` lets `[^\]|#]+` run to end-of-file from *every* `[[` in a body that
 * happens to contain no `]`, `|` or `#`, then backtrack the whole way looking for `]]`: O(n)
 * work at O(n) start positions. Measured on `"[[a".repeat(n)`: 60KB 1.2s, 120KB 4.7s, 240KB
 * 18.7s — a clean 4x per doubling, repeated on every cold start. Excluding `\n` alone does NOT
 * fix that payload (it holds no newlines; measured 23.4s); excluding `[` is what collapses it
 * to O(n), and 240KB then parses in ~2ms. Excluding `\n` bounds the same blow-up to a single
 * line for the multi-line documents real clippings produce.
 *
 * Both are honest restrictions on the syntax: a wiki-link never spans lines, and neither a
 * target, an anchor, nor an alias can contain `[`.
 *
 * Unlike `FENCE`, this pattern needs no CRLF fix. None of its classes exclude `\r`, but `\r`
 * can still never end up inside a captured group: `source` (the string this matches against) is
 * built by `body.split('\n')` and rejoined with `'\n'`, so every `\r` in it is immediately
 * followed by `\n` (the one exception — a truncated file ending mid line-break, `\r` with no `\n`
 * after it — puts the `\r` at the very end of `source`, past any possible `]]`). Either way, the
 * character right after a `\r` is never `]`, `|` or `#`, so a class that tentatively consumed the
 * `\r` always fails to complete a match and backtracks it back out. A target therefore can only
 * ever end in `\r` if the match itself failed — i.e. never. (`match[1]?.trim()` in
 * `extractLinkTargets` would strip a stray `\r` anyway, belt-and-braces.)
 */
const WIKI_LINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;

/** A ``` or ~~~ fence line, with its optional info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/**
 * `FENCE` anchors with `$` and uses `.`, and `.` does not match `\r` in JavaScript. A
 * CRLF-terminated line (common in notes authored on Windows, or content clipped into
 * `01-raw/clippings/`) therefore fails to match `FENCE` even though it is, semantically, an
 * ordinary fence line followed by a line ending: `body.split('\n')` leaves the `\r` attached to
 * the end of each line, `(.*)` can't consume it, and `$` then can't reach the end of the line.
 * Strip a trailing `\r` before matching so CRLF and LF lines are treated identically — mirrors
 * `src/index/chunker.ts`'s `stripTrailingCR`, which fixes the same blindness on the same pattern.
 */
function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Code samples routinely contain `[[...]]` that is not a link — a fenced snippet in the vault
 * literally documents one — so fences are removed before matching rather than filtered after.
 */
function stripFencedCode(body: string): string {
  const kept: string[] = [];
  let openFence: string | undefined;
  for (const line of body.split('\n')) {
    const marker = FENCE.exec(stripTrailingCR(line));
    if (openFence === undefined) {
      if (marker?.[1] !== undefined) {
        openFence = marker[1];
        continue;
      }
      kept.push(line);
      continue;
    }
    // A closing fence uses the same character, is at least as long, and carries no info string.
    const closing = marker?.[1];
    if (
      closing !== undefined &&
      closing[0] === openFence[0] &&
      closing.length >= openFence.length &&
      (marker?.[2] ?? '') === ''
    ) {
      openFence = undefined;
    }
  }
  return kept.join('\n');
}

/**
 * Every wiki-link target in `body`, in order of first appearance, deduplicated. Anchors and
 * aliases are dropped: only the part that names a note survives.
 */
export function extractLinkTargets(body: string): string[] {
  const source = stripFencedCode(body);
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const match of source.matchAll(WIKI_LINK)) {
    const target = match[1]?.trim();
    if (target === undefined || target === '') continue;
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

/**
 * Resolves raw link targets against the vault index. Both returned arrays preserve the order of
 * `targets` and are deduplicated.
 *
 * @param fromPath vault-relative path of the note the links were found in.
 * @param byBasename basename without `.md` to the vault-relative paths carrying it.
 * @param allPaths every vault-relative note path.
 */
export function resolveLinks(
  targets: string[],
  fromPath: string,
  byBasename: Map<string, string[]>,
  allPaths: Set<string>,
): { links: string[]; brokenLinks: string[] } {
  const links: string[] = [];
  const brokenLinks: string[] = [];
  for (const target of targets) {
    const resolved = resolveOne(target, fromPath, byBasename, allPaths);
    if (resolved === undefined) {
      if (!brokenLinks.includes(target)) brokenLinks.push(target);
    } else if (!links.includes(resolved)) {
      links.push(resolved);
    }
  }
  return { links, brokenLinks };
}

function resolveOne(
  target: string,
  fromPath: string,
  byBasename: Map<string, string[]>,
  allPaths: Set<string>,
): string | undefined {
  const withExtension = target.endsWith('.md') ? target : `${target}.md`;

  const fromDir = dirname(fromPath);
  const relative = normalize(fromDir === '' ? withExtension : `${fromDir}/${withExtension}`);
  if (relative !== undefined && allPaths.has(relative)) return relative;

  const vaultRelative = normalize(withExtension);
  if (vaultRelative !== undefined && allPaths.has(vaultRelative)) return vaultRelative;

  const candidates = byBasename.get(basenameWithoutExtension(withExtension));
  if (candidates === undefined || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // A basename shared by several notes resolves to the shallowest one — the vault convention is
  // that the canonical note sits closest to the root. A tie carries no signal, so it is broken.
  const sorted = [...candidates].sort((a, b) => depth(a) - depth(b));
  const best = sorted[0];
  const runnerUp = sorted[1];
  if (best === undefined) return undefined;
  if (runnerUp !== undefined && depth(runnerUp) === depth(best)) return undefined;
  return best;
}

/** Collapses `.` and `..`; returns undefined when the path escapes the vault root. */
function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? undefined : out.join('/');
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base;
}

function depth(path: string): number {
  let count = 0;
  for (const char of path) if (char === '/') count += 1;
  return count;
}
