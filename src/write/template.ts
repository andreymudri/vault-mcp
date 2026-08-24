import matter from 'gray-matter';

import type { Frontmatter } from '../types.js';

/** Thrown when a template carries a Templater expression this module cannot resolve. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface TemplateContext {
  title: string;
  now: Date;
}

/**
 * `<% ... %>` on a single line, tolerating any amount of whitespace inside the
 * delimiters (`applyTemplate` trims the capture).
 *
 * Deliberately NOT the obvious `<%\s*(.+?)\s*%>`. That form is ambiguous twice
 * over — `\s*` and `.+?` compete for the same characters, and `.` swallows a
 * nested `<%` — so on text carrying many `<%` and no `%>` the engine rescans to
 * the end of the input from every one of them: quadratic, 65s on 240KB. This
 * form is a deterministic loop instead. Each alternative consumes exactly one
 * character and they are disjoint on that character, so at every position at
 * most one can apply, and the loop stops dead at a nested `<%` (`<(?!%)`) — the
 * bound that keeps each start position O(token length) rather than O(input).
 *
 * It matters because a template body is not always trusted: T13 may splice
 * model-supplied content into the skeleton before calling `applyTemplate`, so
 * the only thing standing between an adversarial note and a wedged event loop
 * is this regex.
 */
const TOKEN_RE = /<%((?:[^%<\n]|<(?!%)|%(?!>))*)%>/g;

/** `tp.date.now("FMT")`, single or double quoted. */
const DATE_NOW_RE = /^tp\.date\.now\(\s*(['"])([\s\S]*?)\1\s*\)$/;

const FORMAT_TOKEN_RE = /YYYY|MM|DD|HH|mm/g;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Formats `d` in the machine's LOCAL timezone, supporting `YYYY`, `MM`, `DD`,
 * `HH` and `mm`.
 *
 * Local, deliberately — and the opposite of what `vault/frontmatter.ts` does.
 * The two date conversions in this system are asymmetric because their inputs
 * are: a YAML frontmatter date is built by js-yaml at UTC midnight and carries
 * no timezone, so it is read back with `toISOString()`; the `Date` reaching this
 * function is a real wall-clock instant. Formatting it in UTC would make a
 * `vault_learn` at 22:00 in São Paulo (UTC−3) write its capture into the NEXT
 * day's daily note, carrying a 22:00 timestamp inside it.
 *
 * `write/propagate.ts` and `write/learn.ts` must reuse this rather than
 * reimplementing date formatting.
 */
export function formatLocal(d: Date, fmt: string): string {
  const values: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  };
  return fmt.replace(FORMAT_TOKEN_RE, (token) => values[token] ?? token);
}

/**
 * Refuses any `<%` of the TEMPLATE that `TOKEN_RE` did not consume.
 *
 * `TOKEN_RE` is linear precisely because it excludes `\n` from every
 * alternative — which means it does not MATCH a multi-line token, and without
 * this check `applyTemplate` would return such a template verbatim: neither
 * substituted nor rejected, the one outcome this module exists to prevent.
 *
 * That is not hypothetical. T13 reads `_templates/*.md` from the user's REAL
 * vault, and a hand-written Obsidian template commonly uses Templater's block
 * form:
 *
 *     <%*
 *     const t = tp.file.title
 *     %>
 *
 * Silently passing it through creates a note whose body opens with a raw `<%*`
 * block. Putting `\n` back into `TOKEN_RE` would match it — and reintroduce the
 * cubic blow-up that regex was rewritten to escape. A residual scan is O(n),
 * keeps the linear guarantee, and restores the fail-loud contract.
 *
 * It scans `templateText`, NOT the substituted output, and the difference is
 * the whole point. An unresolved token can only live in the INPUT; the output
 * additionally carries whatever `ctx` supplied, so scanning it made a perfectly
 * legitimate `<%` arriving through `ctx.title` — a note actually titled
 * "Sintaxe <% %> do Templater" — get blamed on a Templater token that was never
 * there. `ctx.title` is model-chosen from clipped content, so that pinned a
 * PERMANENT write failure on one note: the guard cannot be poisoned by the very
 * text it is guarding. `tokenStarts` holds the offsets `TOKEN_RE` consumed;
 * every alternative in that regex forbids a nested `<%`, so a matched token
 * contains exactly one `<%` — its own, at the range start — and set membership
 * on the starts is enough to tell resolved from residual.
 */
function assertNoResidualToken(templateText: string, tokenStarts: Set<number>): void {
  let at = templateText.indexOf('<%');
  while (at >= 0 && tokenStarts.has(at)) {
    at = templateText.indexOf('<%', at + 2);
  }
  if (at < 0) return;

  // Bounded slice: the fragment must name the offender without pasting a 240KB
  // adversarial input into an error message.
  const fragment = templateText.slice(at, at + 60);
  const ellipsis = templateText.length > at + 60 ? '…' : '';
  throw new TemplateError(
    `token Templater não resolvido (forma não suportada, possivelmente ` +
      `multi-linha): ${fragment.replace(/\n/g, '\\n')}${ellipsis}`,
  );
}

/**
 * Replaces the Templater tokens of `templateText`.
 *
 * Supports `tp.file.title` and `tp.date.now("FMT")`. Any other expression throws
 * `TemplateError` naming it: failing loud is the point, since an unsubstituted
 * `<% %>` token written into the vault is exactly the bug this module exists to
 * prevent. A token shape `TOKEN_RE` cannot match is caught by the residual scan
 * below rather than passed through.
 */
export function applyTemplate(templateText: string, ctx: TemplateContext): string {
  const tokenStarts = new Set<number>();

  const out = templateText.replace(TOKEN_RE, (_match, rawExpr: string, offset: number) => {
    tokenStarts.add(offset);
    const expr = rawExpr.trim();

    if (expr === 'tp.file.title') return ctx.title;

    const dateMatch = DATE_NOW_RE.exec(expr);
    if (dateMatch) return formatLocal(ctx.now, dateMatch[2] ?? '');

    throw new TemplateError(`expressão Templater não suportada: <% ${expr} %>`);
  });

  assertNoResidualToken(templateText, tokenStarts);
  return out;
}

/** True when the parsed YAML value counts as "not filled in". */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * When a plain (unquoted) YAML scalar would NOT round-trip the value.
 *
 * The alternatives, in order:
 *  - `^$` — the empty string is not a plain scalar at all.
 *  - `^\s|\s$` — leading/trailing whitespace is stripped by YAML.
 *  - `[\u0000-\u001f\u007f-\u009f\u2028\u2029]` — every C0 control, DEL, every
 *    C1 control, and the Unicode line separators. `\n` and `\r` are the obvious
 *    members: a value carrying `\n---\n` would CLOSE the frontmatter block
 *    early, dropping every key after it into the note body. But the rest matter
 *    just as much and for a different reason: js-yaml scans the WHOLE raw stream
 *    for non-printable characters before it parses anything, so a single stray
 *    ESC or DEL makes it refuse the ENTIRE document — the note loses all of its
 *    metadata, permanently. ANSI escape sequences are ordinary content in a page
 *    clipped into `01-raw/clippings/`, so this is a routine input, not an
 *    adversarial one. U+0085 and U+2028/U+2029 are line breaks to YAML, which is
 *    the `\n` problem wearing a different codepoint.
 *  - `[\ufffe\uffff]` and the two unpaired-surrogate alternatives — the REST of
 *    that same js-yaml gate, which the control ranges alone did not cover. Its
 *    pattern (`loader.js:26`) is
 *    `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\ufffe\uffff]` plus a high
 *    surrogate with no low after it and a low surrogate with no high before it,
 *    so those three shapes were emitted RAW and cost the note its whole block
 *    exactly like a stray DEL. A lone surrogate is not an exotic attack: the
 *    plan truncates `resumo` at a fixed LENGTH, and cutting text mid-emoji
 *    produces precisely one — this module must not depend on every caller
 *    slicing by code point. A WELL-FORMED pair is printable to js-yaml, so the
 *    lookahead and lookbehind are load-bearing; quoting every emoji would be
 *    pointless churn. And the regex carries no `u` flag, deliberately: it has to
 *    see code UNITS to tell a pair from a half.
 *  - `:\s|:$|\s#` — the mapping and comment indicators.
 *  - `[,[\]{}]` — the flow-context metacharacters, wherever they appear. Every
 *    list here is written in flow style, so a tag `auth]` closes the sequence
 *    early and yields `tags: [auth], x]`, which js-yaml then REFUSES to parse:
 *    the note loses all of its metadata and T3's scanner reports it as broken
 *    frontmatter forever after. A comma is milder but just as wrong — `a, b, c`
 *    as one tag silently becomes three.
 *  - `^[-?:#&*!|>'"%@\`]` — the indicator characters, which are only special in
 *    first position.
 *  - the boolean/null words, which would come back as a non-string.
 *
 * Values reach here from a `vault_write_note` call — that is, from a language
 * model — and land in the user's real vault, so the rule errs toward quoting.
 */
const NEEDS_QUOTES_RE =
  /^$|^\s|\s$|[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|:\s|:$|\s#|[,[\]{}]|^[-?:#&*!|>'"%@`]|^(?:true|false|null|yes|no|on|off|~)$/i;

/**
 * The characters js-yaml refuses to see RAW anywhere in the stream.
 *
 * Mirrors `PATTERN_NON_PRINTABLE` (`js-yaml/lib/js-yaml/loader.js:26`) minus the
 * C0 range, which `JSON.stringify` already escapes. U+FFFE, U+FFFF and the two
 * unpaired-surrogate shapes belong here for the same reason DEL does: QUOTING
 * them is not enough, because that gate runs over the RAW stream and rejects the
 * WHOLE document — the note loses every key it had, permanently. Only escaping
 * fixes it. `JSON.stringify` has been well-formed since ES2019 and escapes lone
 * surrogates itself, so those two alternatives find nothing left to do on a
 * current runtime; they cost one branch and they keep this function from
 * depending silently on that.
 */
const RAW_UNPRINTABLE_RE =
  /[\u007f-\u009f\u2028\u2029\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A double-quoted YAML scalar for `text`, with every non-printable character
 * ESCAPED rather than merely wrapped in quotes.
 *
 * `JSON.stringify` on its own is not enough, and the gap is easy to miss: JSON
 * string syntax is a subset of YAML's double-quoted syntax and it escapes the C0
 * range, but it emits DEL and the C1 range (U+007F–U+009F) LITERALLY. js-yaml
 * checks the entire raw stream for non-printable characters BEFORE parsing, so a
 * single literal DEL — inside quotes or not — makes it reject the whole
 * document and the note loses all of its metadata. Quoting never fixes that;
 * only escaping does. U+FFFE and U+FFFF sit in that same gate and JSON leaves
 * them literal too, which is why `RAW_UNPRINTABLE_RE` reaches past the C1 range.
 */
function doubleQuote(text: string): string {
  return JSON.stringify(text).replace(
    RAW_UNPRINTABLE_RE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return "''";
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (NEEDS_QUOTES_RE.test(text)) return doubleQuote(text);
  return text;
}

/** `tags` and any other list serialise in flow style, matching the vault's style. */
function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeScalar(item)).join(', ')}]`;
  }
  return serializeScalar(value);
}

/**
 * A frontmatter key safe to emit unquoted: a letter or digit, then letters,
 * digits, `_`, `-` or `.`.
 *
 * An allowlist, not a denylist, and deliberately so. `Frontmatter` carries an
 * index signature, so a key is exactly as model-controlled as a value — and it
 * is the LEFT half of `key: value` that decides where the block ENDS. A key
 * holding `\n---\ntipo: injetado` emits a second `---` mid-block, closing the
 * frontmatter early and turning the rest of the user's metadata into note body;
 * a milder `a: 1\nb` silently injects an entry that nobody wrote. Enumerating
 * the ways a key can break out is the losing side of that game; naming the
 * shapes that cannot is the winning one. Everything else is double-quoted, which
 * makes it one key with a strange name — never two keys, never a delimiter.
 */
const SAFE_KEY_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

/** Keys YAML would hand back as a boolean or null rather than a string. */
const RESERVED_WORD_RE = /^(?:true|false|null|yes|no|on|off)$/i;

/**
 * Only a key STARTING with a digit can be resolved to something other than a
 * string once `SAFE_KEY_RE` and `RESERVED_WORD_RE` have had their say: every
 * numeric, sexagesimal and timestamp shape begins with one, `.inf`/`.nan`/`~`
 * fail the allowlist outright, and the word-shaped resolutions are the reserved
 * words. So this is the gate that keeps `keyRoundTripsAsString` — a real YAML
 * parse — off the path of every ordinary key like `tipo` or `criado`.
 */
const NUMERIC_LOOKING_KEY_RE = /^\p{N}/u;

/**
 * Whether YAML reads `key` back as the SAME key, asked of the parser instead of
 * a regex that imitates it.
 *
 * `SAFE_KEY_RE` admits `2026-08-24`, `012`, `0x1f`, `1e5` and `1_000`, and every
 * one of them is resolved by js-yaml to a Date or a number — so the mapping
 * comes back keyed by `Sat Aug 23 2026 21:00:00 GMT-0300`, or by `10` for an
 * octal `012`, and `data['2026-08-24']` is undefined. Nothing looks broken: the
 * block parses, the note renders. But `ensureFrontmatter` then sees its own key
 * as MISSING on the next pass and appends it again, and a duplicated mapping key
 * is what js-yaml refuses outright — the same demotion-into-the-body failure
 * `topLevelKeyOf` exists to prevent, arriving by a different road. A model
 * filling `Frontmatter`'s index signature with a date-shaped key (`2026-08-24:
 * reuniao`) is ordinary use, not an attack.
 *
 * The check is a one-line parse rather than a copy of js-yaml's int/float/
 * timestamp resolvers because a copy is a fork: it drifts from the installed
 * parser and it has to re-derive, by hand, that `1.5` DOES round-trip (JS object
 * keys are strings, and `String(1.5) === '1.5'`) while `1.0` does not. Asking
 * the parser cannot be wrong about the parser. `NUMERIC_LOOKING_KEY_RE` keeps
 * the cost off ordinary keys, and `matter`'s `{}` is as load-bearing here as in
 * `parseBlock`.
 */
function keyRoundTripsAsString(key: string): boolean {
  try {
    const data = matter(`---\n${key}: x\n---\n`, {}).data as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(data, key);
  } catch {
    return false;
  }
}

function serializeKey(key: string): string {
  if (!SAFE_KEY_RE.test(key) || RESERVED_WORD_RE.test(key)) return doubleQuote(key);
  if (NUMERIC_LOOKING_KEY_RE.test(key) && !keyRoundTripsAsString(key)) return doubleQuote(key);
  return key;
}

function serializeEntry(key: string, value: unknown): string {
  return `${serializeKey(key)}: ${serializeValue(value)}`;
}

interface SplitContent {
  /** Raw lines of the frontmatter block, delimiters excluded. */
  block: string[];
  /** Everything after the closing delimiter, verbatim. */
  body: string;
  /** `block` as parsed by js-yaml; `{}` when it is malformed. */
  data: Frontmatter;
}

function parseBlock(block: string[]): Frontmatter {
  try {
    // The `{}` is load-bearing: called with no options at all, `gray-matter`
    // memoises every string it is handed in an unbounded process-global cache —
    // and it writes the entry BEFORE parsing, so a malformed block throws once
    // and from then on returns the half-built `{data: {}, content: <raw>}` to
    // every caller in the process. The spec forbids that cache for T3 and it is
    // no more acceptable here.
    const parsed = matter(`---\n${block.join('\n')}\n---\n`, {});
    return parsed.data as Frontmatter;
  } catch {
    // Malformed YAML: treat every required key as missing rather than crashing.
    return {};
  }
}

/**
 * Splits `content` into frontmatter block and body — but ONLY when the leading
 * `---` really opens a frontmatter block.
 *
 * A bare `---` is also valid Markdown (a horizontal rule), and `vault_write_note`
 * receives note bodies that start with one. Accepting any leading `---` with a
 * later `---` somewhere below silently swallows whatever sits between them:
 * `'---\n\n# Titulo\n\n---\n\ntexto\n'` put `# Titulo` inside the block, where
 * `#` is a YAML comment, and the heading simply disappeared from the note.
 *
 * So the block must actually look like frontmatter: it parses to a non-empty
 * mapping, or it is entirely blank. Anything else — a heading, prose, an opener
 * with no closing delimiter at all — stays body text, untouched, and a fresh
 * block is prefixed above it. Deleting the user's content is never the answer.
 */
function splitFrontmatter(content: string): SplitContent | undefined {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return undefined;

  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '---') continue;

    const block = lines.slice(1, i);
    const data = parseBlock(block);
    const isBlank = block.every((line) => line.trim() === '');
    if (!isBlank && Object.keys(data).length === 0) return undefined;

    return { block, body: lines.slice(i + 1).join('\n'), data };
  }
  return undefined;
}

/**
 * The key a frontmatter LINE declares, or `undefined` when the line opens no
 * top-level entry at all (indented, a comment, a list item, an unterminated
 * quote, a continuation of the value above).
 *
 * It READS the spelling instead of guessing it, and that is the fix rather than
 * an embellishment. Matching only the two spellings this module happens to
 * EMIT — plain and double-quoted — leaves out the one YAML spelling it never
 * writes but users and other tools produce constantly: single quotes. A vault
 * note carrying `'tipo': ` went unrecognised, so the missing-key fill APPENDED a
 * second `tipo:` line. The duplicate is not the damage: js-yaml REFUSES a
 * mapping with a duplicated key, so `parseBlock` throws, `splitFrontmatter`
 * returns undefined, and the next pass prefixes a brand-new block — demoting the
 * user's real frontmatter into the note BODY, where it reads as stray text. One
 * unrecognised spelling therefore costs the note its metadata on the pass after
 * next.
 *
 * Deriving the key from the line closes the whole family at once, including the
 * spellings nobody enumerated: extra space before the colon, `''` as the escaped
 * single quote, a plain key holding a `:` that no whitespace follows (`a:b: v`,
 * whose key is `a:b`). A double-quoted key using YAML-only escapes (`\x41`) is
 * beyond `JSON.parse` and reads as "no key here" — the conservative direction,
 * since this module only ever writes JSON-compatible escapes and an unread key
 * merely appends where it could have replaced.
 */
function topLevelKeyOf(line: string): string | undefined {
  if (line === '' || /^\s/.test(line)) return undefined;

  if (line.startsWith('"')) {
    let i = 1;
    while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
    if (i >= line.length) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(line.slice(0, i + 1));
    } catch {
      return undefined;
    }
    return typeof key === 'string' && /^\s*:/.test(line.slice(i + 1)) ? key : undefined;
  }

  if (line.startsWith("'")) {
    let key = '';
    let i = 1;
    while (i < line.length) {
      if (line[i] === "'") {
        // YAML escapes a single quote by DOUBLING it.
        if (line[i + 1] !== "'") break;
        key += "'";
        i += 2;
        continue;
      }
      key += line[i];
      i += 1;
    }
    if (i >= line.length) return undefined;
    return /^\s*:/.test(line.slice(i + 1)) ? key : undefined;
  }

  // Plain scalar: the key ends at the first `:` that whitespace or end-of-line
  // follows — the only `:` YAML reads as the mapping indicator.
  const match = /^(.*?):(?=\s|$)/.exec(line);
  const key = match?.[1]?.replace(/\s+$/, '');
  return key === undefined || key === '' ? undefined : key;
}

/**
 * The index of the line already declaring `key`, in ANY spelling that denotes
 * it, so the missing-key fill REPLACES rather than appending a duplicate.
 */
function topLevelKeyIndex(block: string[], key: string): number {
  return block.findIndex((line) => topLevelKeyOf(line) === key);
}

/**
 * Guarantees `content` starts with a frontmatter block carrying at least the
 * keys of `required`. An existing block is merged into: existing keys are kept
 * verbatim, and only the missing (or blank) ones are filled in. Without a block,
 * a new one is prefixed.
 */
export function ensureFrontmatter(content: string, required: Frontmatter): string {
  const entries = Object.entries(required);
  const split = splitFrontmatter(content);

  if (!split) {
    const block = entries.map(([key, value]) => serializeEntry(key, value));
    const body = content.replace(/^\n+/, '');
    const suffix = body === '' ? '' : `\n${body}`;
    return `---\n${block.join('\n')}\n---\n${suffix}`;
  }

  const block = [...split.block];
  const data = split.data;

  for (const [key, value] of entries) {
    if (!isEmptyValue(data[key])) continue;

    const line = serializeEntry(key, value);
    const index = topLevelKeyIndex(block, key);
    if (index >= 0) block[index] = line;
    else block.push(line);
  }

  return `---\n${block.join('\n')}\n---\n${split.body}`;
}
