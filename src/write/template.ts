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
 * Refuses any `<%` still standing after substitution.
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
 */
function assertNoResidualToken(out: string): void {
  const at = out.indexOf('<%');
  if (at < 0) return;

  // Bounded slice: the fragment must name the offender without pasting a 240KB
  // adversarial input into an error message.
  const fragment = out.slice(at, at + 60);
  const ellipsis = out.length > at + 60 ? '…' : '';
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
  const out = templateText.replace(TOKEN_RE, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();

    if (expr === 'tp.file.title') return ctx.title;

    const dateMatch = DATE_NOW_RE.exec(expr);
    if (dateMatch) return formatLocal(ctx.now, dateMatch[2] ?? '');

    throw new TemplateError(`expressão Templater não suportada: <% ${expr} %>`);
  });

  assertNoResidualToken(out);
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
  /^$|^\s|\s$|[\u0000-\u001f\u007f-\u009f\u2028\u2029]|:\s|:$|\s#|[,[\]{}]|^[-?:#&*!|>'"%@`]|^(?:true|false|null|yes|no|on|off|~)$/i;

/** The characters js-yaml refuses to see RAW anywhere in the stream. */
const RAW_UNPRINTABLE_RE = /[\u007f-\u009f\u2028\u2029]/g;

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
 * only escaping does.
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

function serializeKey(key: string): string {
  if (!SAFE_KEY_RE.test(key) || RESERVED_WORD_RE.test(key)) return doubleQuote(key);
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

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Both spellings are matched — the plain key and the double-quoted one
 * `serializeKey` may have written — so a key that needed quoting is still
 * recognised as already present and gets REPLACED rather than appended a second
 * time. Without that, `ensureFrontmatter` would stop being idempotent for
 * exactly the keys it had to harden.
 */
function topLevelKeyIndex(block: string[], key: string): number {
  const plain = escapeForRegExp(key);
  const quoted = escapeForRegExp(doubleQuote(key));
  const re = new RegExp(`^(?:${plain}|${quoted})\\s*:`);
  return block.findIndex((line) => re.test(line));
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
