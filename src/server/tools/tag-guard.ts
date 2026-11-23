import { coded } from '../../i18n/errors.js';
import type { Frontmatter } from '../../types.js';
import { ToolError } from './define.js';
import { forMessage } from './sanitize.js';

/**
 * The guard that refuses a frontmatter tag YAML would not hand back as the same string.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/**
 * The caps `toTags` in `src/vault/frontmatter.ts` applies when it READS a note's tags back.
 *
 * Mirrored rather than imported because that function is not exported, and mirrored at all because
 * the two have to agree: a tag this tool writes past those bounds is a tag the scanner will not
 * hand back, so `vault_list` would not find the note the caller just tagged.
 */
export const MAX_TAGS = 64;

export const MAX_TAG_LENGTH = 128;

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
export const NUMERIC_LIKE_RE = new RegExp(
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
export const SEXAGESIMAL_INT_RE = /^[+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/;

/**
 * js-yaml's YAML 1.1 sexagesimal FLOAT, which is a SEPARATE resolver and a different shape.
 *
 * Two differences from the integer above, and both are measured: the leading group may start with
 * a zero (`0:30.5` → 30.5, while `0:30` survives), and it ends in a dot whose digits are optional
 * (`1:30.` → 90). Covering only the integer form let every one of `1:30.5`, `12:00.25`,
 * `1:30:00.5` and `59:59.999` through as a tag that comes back a number.
 */
export const SEXAGESIMAL_FLOAT_RE = /^[+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/;

/**
 * js-yaml's short timestamp form: a two-digit month AND day, and nothing after it.
 *
 * `2026-1-5` is deliberately NOT this shape — it survives as text, measured — which is why the
 * one-or-two-digit form belongs to the timestamp regex below and not to this one.
 */
export const YAML_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * js-yaml's FULL timestamp: the same date with a time part, which the short form above never
 * matched — so `2026-01-10T00:00:00Z` sailed past the guard and came back as `2026-01-10`.
 *
 * The time part is what makes the one-or-two-digit month and day legal here: `2026-1-5` alone is
 * text, `2026-1-5T01:02:03Z` is the fifth of January. The separator is `T`, `t`, or runs of blanks;
 * the fraction and the zone are optional; the zone may be `Z` or an offset.
 */
export const YAML_TIMESTAMP_RE =
  /^(\d{4})-(\d\d?)-(\d\d?)(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))?(?:[ \t]*(?:Z|([-+])(\d\d?)(?::(\d\d))?))?$/;

/** What `1:30` becomes: base-60 digits, most significant first. */
export function sexagesimalValue(tag: string): string {
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
export function yamlDateDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * The same, for the full timestamp form, assembled exactly as js-yaml assembles it: build the
 * instant in UTC, then SUBTRACT the zone offset. An hour of 25 is not rejected, it rolls the day —
 * measured, `2026-01-10T25:00:00Z` comes back as `2026-01-11`.
 */
export function yamlTimestampDay(match: RegExpExecArray): string {
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
export function yamlNumberText(tag: string): string {
  const body = tag.replace(/^[+]/, '').replace(/_/g, '');
  if (/^0x/.test(body)) return String(parseInt(body.slice(2), 16));
  if (/^0b/.test(body)) return String(parseInt(body.slice(2), 2));
  if (/^0[0-7]+$/.test(body)) return String(parseInt(body, 8));
  return String(Number(body));
}

/** `undefined` when the tag survives the write/read round trip, or why it would not. */
export function tagRoundTripProblem(tag: string): string | undefined {
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

export function coerceTags(value: unknown): string[] {
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
      throw coded(new ToolError('frontmatter.tags só aceita textos ou números; remova listas e objetos'), 'tags.scalarOnly');
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

export function toFrontmatter(input: Record<string, unknown> | undefined): Frontmatter | undefined {
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
