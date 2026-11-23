import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTemplate } from '../../i18n/errors.js';
import type { Messages } from '../../i18n/messages.js';
import { sliceAtCodePointBoundary } from '../../retrieval/budget.js';
import { INVISIBLE_CHARS } from '../../write/paths.js';
import { MAX_DIFF_CHARS } from './limits.js';

/**
 * Everything that stands between text read off the vault and a line of this server's output:
 * escaping, quoting, redaction and the bounded relay of a diff.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

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
export const INVISIBLE_CHARS_GLOBAL = new RegExp(INVISIBLE_CHARS.source, 'g');

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

/**
 * Every string inside `value` passed through `redact`, at any depth.
 *
 * `structuredContent` is JSON, so a newline in it forges nothing and `forMessage` would only corrupt
 * a path a client uses as a key. The absolute root is a different matter: it leaks the same way in
 * a JSON string as in a line of text, so redaction applies to both channels.
 */
export function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  }
  return value;
}

/** `[…cortado]`, in the same shape as the body's own cut marker. */
export const CUT = '[…cortado]';

export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${sliceAtCodePointBoundary(text, max)}${CUT}`;
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
export const QUOTE_PREFIX = '> ';

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
export const LINE_BREAKS_GLOBAL = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

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
export const QUOTED_CONTROLS_GLOBAL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function escapeControl(ch: string): string {
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
export function sanitizeQuoted(text: string, collapseCrlf: boolean): string {
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
export function quoteSnippet(text: string): string {
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
export function relayDiff(diff: string, m: Messages): string {
  const safe = sanitizeQuoted(diff, false);
  if (safe.length <= MAX_DIFF_CHARS) return safe;
  // Cut at the last whole line that fits, so the tail of the relayed diff is never half a line
  // with a `+` in front of it — and never half a surrogate pair.
  const head = sliceAtCodePointBoundary(safe, MAX_DIFF_CHARS);
  const lastBreak = head.lastIndexOf('\n');
  const kept = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  return `${kept}\n[…${renderTemplate(m.results.diffTruncated, { max: MAX_DIFF_CHARS, total: safe.length })}]`;
}
