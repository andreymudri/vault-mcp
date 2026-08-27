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
 * the end of the input from every one of them: quadratic in the input, ~65s on
 * 240KB. This form is a deterministic loop instead. Each alternative consumes
 * exactly one character and they are disjoint on that character, so at every
 * position at most one can apply, and the loop stops dead at a nested `<%`
 * (`<(?!%)`) — the bound that keeps each start position O(token length) rather
 * than O(input).
 *
 * `<(?!%)` is the load-bearing half, and it is the half a reader is most likely
 * to "simplify" away. Dropping it leaves `<%((?:[^%\n]|%(?!>))*)%>`, which looks
 * equivalent, still refuses multi-line tokens, and is still QUADRATIC: measured
 * 10.8ms on 4KB, 712ms on 32KB, ~20s on 240KB. That is cheap enough to pass any
 * absolute time budget while being the exact regression this regex exists to
 * prevent, which is why the cost test in `test/template.test.ts` asserts on the
 * growth RATIO across four sizes rather than on milliseconds at one.
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
  throw Object.assign(
    new TemplateError(
      `token Templater não resolvido (forma não suportada, possivelmente ` +
        `multi-linha): ${fragment.replace(/\n/g, '\\n')}${ellipsis}`,
    ),
    // `Object.assign` e não o helper `coded`, pelo mesmo motivo do outro sítio deste arquivo:
    // os testes de fuso rodam este módulo num filho sob type stripping, onde um import de valor
    // para `../i18n/errors.js` não resolve.
    { code: 'template.unresolvedToken', params: { fragment: fragment.replace(/\n/g, '\\n'), ellipsis } },
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

    // `Object.assign` em vez do helper `coded`, e por um motivo concreto: os testes de fuso de
    // `template.test.ts` rodam este arquivo num processo filho com `node probe.ts`, sob type
    // stripping, e ali um import de valor apontando para `../i18n/errors.js` não resolve — só
    // existe `errors.ts`. As outras importações deste módulo são `import type` (apagadas) ou um
    // pacote real, então esta seria a primeira de verdade. O formato do marcador é idêntico.
    throw Object.assign(new TemplateError(`expressão Templater não suportada: <% ${expr} %>`), {
      code: 'template.unsupportedExpr',
      params: { expr },
    });
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

/**
 * A YAML mapping, as opposed to the other things a frontmatter block can parse
 * to.
 *
 * The array case is not a nicety. `Object.keys(['a', 'b'])` is `['0', '1']`, so
 * a block whose top level is a SEQUENCE sailed through the "parses to a
 * non-empty mapping" check in `splitFrontmatter` — and the missing-key fill then
 * appended `tipo: wiki` INSIDE the sequence, producing a block js-yaml refuses
 * outright. Treating it as "not frontmatter" keeps the user's `---\n- a\n- b\n---`
 * intact as body text with a real block prefixed above it, which is the same
 * answer this module already gives a leading `---` that opens a horizontal rule.
 */
function isPlainMapping(value: unknown): value is Frontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The block as js-yaml reads it, or `undefined` when js-yaml REFUSES it.
 *
 * The two outcomes have to stay distinguishable — `{}` alone cannot mean both
 * "empty block" and "the parser threw", because `verifiedEdit` asks exactly that
 * question about a block it has just modified.
 */
function parseBlock(block: string[]): unknown {
  try {
    // The `{}` is load-bearing: called with no options at all, `gray-matter`
    // memoises every string it is handed in an unbounded process-global cache —
    // and it writes the entry BEFORE parsing, so a malformed block throws once
    // and from then on returns the half-built `{data: {}, content: <raw>}` to
    // every caller in the process. The spec forbids that cache for T3 and it is
    // no more acceptable here.
    return matter(`---\n${block.join('\n')}\n---\n`, {}).data;
  } catch {
    return undefined;
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
 * MAPPING, or it is entirely blank. Anything else — a heading, prose, a
 * top-level sequence, an opener with no closing delimiter at all — stays body
 * text, untouched, and a fresh block is prefixed above it. Deleting the user's
 * content is never the answer.
 */
function splitFrontmatter(content: string): SplitContent | undefined {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return undefined;

  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '---') continue;

    const block = lines.slice(1, i);
    const data = parseBlock(block);
    if (!isPlainMapping(data)) return undefined;
    const isBlank = block.every((line) => line.trim() === '');
    if (!isBlank && Object.keys(data).length === 0) return undefined;

    return { block, body: lines.slice(i + 1).join('\n'), data };
  }
  return undefined;
}

/**
 * The key a frontmatter line declares WHEN READ IN ISOLATION, or `undefined`
 * when it cannot tell.
 *
 * Reading the spelling beats enumerating the two this module happens to EMIT:
 * it closes single quotes, extra space before the colon, `''` as the escaped
 * single quote, and a plain key holding a `:` that no whitespace follows
 * (`a:b: v`, whose key is `a:b`) all at once.
 *
 * But `undefined` here means "this line does not declare a key I can READ", NOT
 * "this line declares no key". A double-quoted key using a YAML-only escape
 * (`"\x74ipo"`, which denotes `tipo`) is beyond `JSON.parse` and lands in that
 * bucket while being a perfectly ordinary top-level entry. That distinction is
 * why callers must never read `undefined` as "absent": `topLevelStarts` keeps
 * those lines as OPAQUE candidates and `verifiedEdit` decides, by asking the
 * parser, whether replacing one is the right edit. Guessing "absent" is what
 * appended a duplicate key, and a duplicated mapping key is what js-yaml refuses
 * outright — after which the next pass demotes the user's whole block into the
 * note body.
 *
 * Symmetrically, a key read here is only a CANDIDATE. Whether the parser sees
 * this line as a top-level entry at all depends on the lines above it, which
 * `topLevelStarts` — not this function — tracks.
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
 * How much of the block's structure is still OPEN at a given point.
 *
 * A line does not carry, on its own, whether the parser reads it as a top-level
 * entry — and reading lines in isolation is exactly what corrupted notes. A
 * multi-line quoted scalar and an unclosed flow collection both CONTINUE onto
 * the next line at column 0, and that continuation can have the precise shape of
 * a mapping entry:
 *
 *     titulo: "resumo do artigo
 *     tipo: nota"
 *
 * That is valid YAML — js-yaml folds the double-quoted scalar — so
 * `splitFrontmatter` accepts it and `data.tipo` is absent. Line 2 read alone
 * looks like `tipo:`, so the fill OVERWROTE it, leaving `titulo: "resumo do
 * artigo` with an unterminated quote and deleting the rest of the user's value.
 * Same shape with single quotes, and with `meta: {a: 1,` / `tipo: 2}`. The next
 * pass then finds a block js-yaml refuses and demotes the whole thing into the
 * body — the identical failure the false-negative direction produces.
 */
interface ScanState {
  /** The quote character of a quoted scalar still open, or `null`. */
  quote: '"' | "'" | null;
  /** How many `[`/`{` flow collections are still unclosed. */
  flow: number;
  /** Whether the next non-space character begins a fresh node. */
  nodeStart: boolean;
}

/**
 * Advances `state` across one line.
 *
 * Deliberately a SCANNER, not a parser: it answers one question — is the next
 * line still inside something? — and quotes and flow collections are the only
 * two things it tracks, because they are the only constructs whose CONTINUATION
 * lands at column 0 while still needing the character-level state of the line
 * before it. Block scalars, folded plain scalars and nested mappings all
 * continue INDENTED, and an indented line is disqualified as a top-level start
 * on sight.
 *
 * The one column-0 continuation that is NOT a quote or a flow collection is a
 * block sequence under a mapping key — YAML allows its items at the SAME
 * indentation as the key:
 *
 *     tags:
 *     - projeto
 *     - vault
 *
 * That is the most common frontmatter shape Obsidian writes, and it needs no
 * state at all: `BLOCK_SEQ_ITEM_RE` recognises such an item from the line
 * itself, and `topLevelStarts` drops it. An earlier version of this comment
 * claimed every non-quote, non-flow continuation was indented; it was wrong
 * about exactly this case, each `- item` became an unreadable key CANDIDATE, and
 * only `verifiedEdit`'s value comparison stood between that and a note silently
 * losing a tag.
 *
 * `nodeStart` is what keeps the quote tracking honest. A quote opens a quoted
 * scalar only where a node may begin; anywhere else it is literal content, so
 * `titulo: don't stop` must not be read as opening a single-quoted scalar that
 * swallows the rest of the block. The same rule makes `[` and `{` open a flow
 * collection only at a node start, since a plain scalar in block context is
 * allowed to contain them (`titulo: a [b] c`).
 */
function advance(line: string, state: ScanState): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;

    if (state.quote === '"') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') state.quote = null;
      i += 1;
      continue;
    }
    if (state.quote === "'") {
      // YAML escapes a single quote by DOUBLING it.
      if (ch === "'" && line[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") state.quote = null;
      i += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    // A `#` starts a comment only at line start or after whitespace.
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) break;

    const next = line[i + 1];
    const breaks = next === undefined || next === ' ' || next === '\t';

    if (state.nodeStart) {
      if (ch === '"' || ch === "'") {
        state.quote = ch;
        i += 1;
        continue;
      }
      if (ch === '[' || ch === '{') {
        state.flow += 1;
        i += 1;
        continue;
      }
      if (ch === ']' || ch === '}') {
        if (state.flow > 0) state.flow -= 1;
        state.nodeStart = false;
        i += 1;
        continue;
      }
      if (ch === ',') {
        i += 1;
        continue;
      }
      // `- `, `? ` and `: ` open a node without being one.
      if ((ch === '-' || ch === '?' || ch === ':') && breaks) {
        i += 1;
        continue;
      }
      // A block scalar header (`|`, `>`): its content is INDENTED, so nothing
      // on a following column-0 line belongs to it.
      if (ch === '|' || ch === '>') break;
      // An anchor, alias or tag prefixes the node without ending the node start.
      if (ch === '&' || ch === '*' || ch === '!') {
        while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i += 1;
        continue;
      }
      state.nodeStart = false;
      i += 1;
      continue;
    }

    // Inside (or just after) a scalar.
    if (ch === ':' && (breaks || (state.flow > 0 && (next === ',' || next === ']' || next === '}')))) {
      state.nodeStart = true;
      i += 1;
      continue;
    }
    if (state.flow > 0) {
      if (ch === ',') {
        state.nodeStart = true;
        i += 1;
        continue;
      }
      if (ch === ']' || ch === '}') {
        state.flow -= 1;
        i += 1;
        continue;
      }
    }
    i += 1;
  }

  // Nothing open: the next line starts a fresh node at column 0.
  if (state.quote === null && state.flow === 0) state.nodeStart = true;
}

interface TopLevelStart {
  index: number;
  /** The key the line spells, or `undefined` when the spelling is unreadable. */
  key: string | undefined;
}

/**
 * A block sequence ENTRY: `-` followed by whitespace or nothing at all.
 *
 * At column 0 such a line is never a mapping entry — it is an item of a sequence
 * that either belongs to the mapping key above it or makes the whole document a
 * sequence (which `isPlainMapping` refuses). Either way it declares no top-level
 * key, readable or not, so it must not enter the candidate set.
 *
 * The `[ \t]` is what keeps `-foo: bar` — a plain scalar key that merely starts
 * with a dash — out of this: YAML reads `-` as the sequence indicator only when
 * whitespace or the end of the line follows it, and this matches that rule
 * exactly rather than approximating it with `startsWith('-')`.
 */
const BLOCK_SEQ_ITEM_RE = /^-(?:[ \t]|$)/;

/**
 * Every line the parser would read as opening a top-level MAPPING entry, with
 * the key it spells when that spelling is readable.
 */
function topLevelStarts(block: string[]): TopLevelStart[] {
  const state: ScanState = { quote: null, flow: 0, nodeStart: true };
  const starts: TopLevelStart[] = [];

  for (let index = 0; index < block.length; index += 1) {
    const line = block[index] ?? '';
    const open = state.quote !== null || state.flow > 0;
    if (
      !open &&
      line !== '' &&
      !/^[ \t]/.test(line) &&
      !line.startsWith('#') &&
      !BLOCK_SEQ_ITEM_RE.test(line)
    ) {
      starts.push({ index, key: topLevelKeyOf(line) });
    }
    advance(line, state);
  }
  return starts;
}

/**
 * How many lines of unreadable spelling `verifiedEdit` will try per key.
 *
 * Each attempt costs a YAML parse of the whole block, so an unbounded retry is
 * O(lines²) on a block built to have many of them. In a real note the count is
 * zero; a handful is generous.
 *
 * This bound is also where the structure tracking earns its keep. `verifiedEdit`
 * would REJECT an edit to a continuation line anyway — but every rejection burns
 * one of these slots, so without `topLevelStarts` the continuations of a `resumo`
 * folded over a dozen lines (ordinary content in a clipped note) exhaust the
 * budget before the line that really declares the key is ever tried, and the key
 * stays unfilled forever. The scanner keeps the candidate set to lines the
 * parser actually reads as top-level entries, which is what makes a small bound
 * both safe and sufficient.
 */
const MAX_OPAQUE_CANDIDATES = 8;

/**
 * How much of a value graph `provablyEqual` will walk before it gives up.
 *
 * The caps are what make comparison safe on frontmatter a model controls, and
 * `JSON.stringify` — the comparison they replace — had none. js-yaml resolves an
 * alias by REFERENCE, so `a0: &a0 [q ×10]` followed by `a1: &a1 [*a0 ×10]` and
 * so on parses in linear time and holds a handful of arrays; serialising it
 * MATERIALISES the full 10ⁿ expansion. Measured through `ensureFrontmatter`: 394
 * bytes of input cost 4055ms and ~1GB, and 502 bytes never finished at all. That
 * is not merely a slow function — the MCP server is a single event loop and
 * `ensureFrontmatter` is synchronous and never awaits, so no timeout at the tool
 * layer can interrupt it and the whole server stops. `src/vault/frontmatter.ts:47`
 * documents this obligation and hands it to whoever serialises arbitrary
 * frontmatter keys; this is that bound.
 *
 * Ordinary frontmatter is orders of magnitude under both numbers — a note with
 * fifty keys and a dozen tags is a few hundred nodes, three deep — so a cap is
 * reached only by something built to reach it, and reaching one means REFUSING
 * the edit rather than guessing about it.
 */
const MAX_COMPARE_NODES = 20000;
const MAX_COMPARE_DEPTH = 64;

/**
 * Whether `a` and `b` are PROVED equal by a bounded structural walk.
 *
 * `false` means "not proved", which merges two outcomes deliberately: they
 * really differ, or the walk hit a cap and cannot say. Both have to lead to the
 * same place — `verifiedEdit` refuses — so separating them would be a
 * distinction with no caller. Merging them the OTHER way is the defect this
 * replaces: every value `JSON.stringify` refused collapsed to one sentinel, so
 * `sentinel === sentinel` and a check whose entire job is to refuse passed
 * vacuously on exactly the inputs it exists for. A self-referential
 * `notas: &n [*n, …]` was enough to make `verifiedEdit` certify an edit that
 * deleted one of the user's list items.
 *
 * Comparison is by REFERENCE, which is the same thing that makes it cheap and
 * makes it total. `assumed` records every object pair the walk has entered and
 * answers `true` on re-entry, so a DAG of aliases costs one visit per distinct
 * PAIR instead of one per path — the alias bomb above collapses from 10ⁿ to n —
 * and a CYCLE terminates instead of recursing forever. Assuming a pair equal
 * while still comparing it is sound because a real difference underneath makes
 * the enclosing call return `false`, and `false` propagates all the way out: a
 * `true` result requires every assumption on the path to have been confirmed.
 * That is ordinary co-inductive equality on regular trees.
 *
 * Dates are compared by `getTime`, because `criado: 2026-08-24` comes back as a
 * `Date` on both sides and two distinct `Date` objects are never `===`.
 */
function provablyEqual(a: unknown, b: unknown): boolean {
  const assumed = new Map<object, Set<object>>();
  let budget = MAX_COMPARE_NODES;

  const walk = (x: unknown, y: unknown, depth: number): boolean => {
    if (budget <= 0 || depth > MAX_COMPARE_DEPTH) return false;
    budget -= 1;

    if (x === y) return true;

    const bothObjects =
      typeof x === 'object' && x !== null && typeof y === 'object' && y !== null;
    // Not both objects and not `===`: only NaN is left, which is never `===`
    // itself and is what a `.nan` scalar parses to.
    if (!bothObjects) return Number.isNaN(x) && Number.isNaN(y);

    const seen = assumed.get(x as object);
    if (seen) {
      if (seen.has(y as object)) return true;
      seen.add(y as object);
    } else {
      assumed.set(x as object, new Set([y as object]));
    }

    if (x instanceof Date || y instanceof Date) {
      if (!(x instanceof Date) || !(y instanceof Date)) return false;
      const tx = x.getTime();
      const ty = y.getTime();
      return tx === ty || (Number.isNaN(tx) && Number.isNaN(ty));
    }

    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      return x.every((item, i) => walk(item, y[i], depth + 1));
    }

    const xr = x as Record<string, unknown>;
    const yr = y as Record<string, unknown>;
    const keys = Object.keys(xr);
    if (keys.length !== Object.keys(yr).length) return false;
    return keys.every(
      (k) => Object.prototype.hasOwnProperty.call(yr, k) && walk(xr[k], yr[k], depth + 1),
    );
  };

  return walk(a, b, 0);
}

/**
 * Applies one edit and keeps it ONLY if js-yaml agrees it did what was intended.
 *
 * This is the guarantee the line-reading heuristics cannot give on their own.
 * Every way `topLevelKeyOf` can be wrong — a spelling it cannot read, a
 * continuation the scanner mis-tracks, a construct nobody enumerated — ends in
 * the same place: a block js-yaml refuses, after which the next pass demotes the
 * user's frontmatter into the note body. So the edit is not trusted, it is
 * CHECKED, against the same parser that will read the file back:
 *
 *  - the modified block still parses, and still to a mapping;
 *  - its key set is exactly the old one plus `key`;
 *  - every other key still resolves to exactly what it did before — compared
 *    THROUGH the parser, so `criado: 2026-08-24` coming back as a `Date` on both
 *    sides is a match rather than a mismatch, and by a bounded walk that can
 *    answer "I could not compare these", which is REFUSED like any other
 *    mismatch. Treating incomparable as equal is the wrong default for a check
 *    whose only job is to refuse; see `provablyEqual`.
 *
 * Those two together also settle the value of `key` itself, which is why nothing
 * here checks it: a mapping js-yaml accepts has no duplicated key, so if `key`
 * is in the key set then the line just written is the only thing declaring it.
 * That is the same invariant this module's entire failure model rests on — a
 * duplicate is precisely what makes js-yaml refuse the block — and the tests
 * exercise it directly, so re-asserting it here would be untestable ceremony.
 *
 * The two checks are NOT redundant, and an earlier version of this comment
 * claimed they were. A block sequence separates them:
 *
 *     tags:
 *     - projeto
 *     - vault
 *
 * Replacing `- vault` with `tipo: wiki` yields the key set `{tags, tipo}` —
 * exactly what was expected, because `tags` still exists — while `tags` has
 * quietly lost an item. Only the VALUE check catches that. And only the KEY-SET
 * check constrains the APPEND path, where nothing is removed. Each is the sole
 * guard on a case the other misses; neither may be dropped as ceremony.
 *
 * A check that asks the parser cannot be wrong about the parser, and the cost is
 * one parse of a frontmatter-sized block per key filled.
 */
function verifiedEdit(
  block: string[],
  data: Frontmatter,
  key: string,
  line: string,
  index: number,
): { block: string[]; data: Frontmatter } | undefined {
  const next = [...block];
  if (index >= 0) next[index] = line;
  else next.push(line);

  const parsed = parseBlock(next);
  if (!isPlainMapping(parsed)) return undefined;

  const expected = new Set([...Object.keys(data), key]);
  const got = Object.keys(parsed);
  if (got.length !== expected.size || !got.every((k) => expected.has(k))) return undefined;

  for (const other of Object.keys(data)) {
    if (other === key) continue;
    if (!provablyEqual(parsed[other], data[other])) return undefined;
  }

  return { block: next, data: parsed };
}

/**
 * Fills `key` in, REPLACING the line that declares it when there is one and
 * appending only when there is not — or leaving the block untouched when neither
 * can be verified.
 *
 * Refusing is a deliberate outcome, not a gap. Some spellings cannot be resolved
 * from the block alone: an explicit key (`? tipo` on its own line, its `:` on the
 * next) spans two lines, and replacing either one is a different mapping. Rather
 * than reimplement js-yaml's scanner here — a fork that would drift from the
 * installed parser, which is the very thing `keyRoundTripsAsString` and
 * `verifiedEdit` exist to avoid — the module declines the edit. The user then
 * sees a key that is still blank, which is visible and fixable in one keystroke.
 * The alternative it replaces was appending a duplicate: silent on the pass that
 * writes it, and on the NEXT pass it costs the note every key it had. An
 * unfilled key is a smaller wrong answer than a destroyed block, and it is the
 * only one that is recoverable.
 */
function fillKey(
  block: string[],
  data: Frontmatter,
  key: string,
  line: string,
): { block: string[]; data: Frontmatter } | undefined {
  const starts = topLevelStarts(block);
  const named = starts.filter((start) => start.key === key);
  const opaque = starts.filter((start) => start.key === undefined).slice(0, MAX_OPAQUE_CANDIDATES);

  for (const candidate of [...named, ...opaque]) {
    const applied = verifiedEdit(block, data, key, line, candidate.index);
    if (applied) return applied;
  }

  // No line declares it: appending adds an entry rather than a duplicate. Still
  // verified — a block can end inside a construct an appended line would join.
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return verifiedEdit(block, data, key, line, -1);
  }
  return undefined;
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

  let block = split.block;
  let data = split.data;

  for (const [key, value] of entries) {
    if (!isEmptyValue(data[key])) continue;

    // `data` advances with `block`: each fill is verified against the block as
    // the fills before it left it, never against the original.
    const applied = fillKey(block, data, key, serializeEntry(key, value));
    if (applied) ({ block, data } = applied);
  }

  return `---\n${block.join('\n')}\n---\n${split.body}`;
}
