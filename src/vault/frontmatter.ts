import matter from 'gray-matter';
import type { Frontmatter, Diagnostic } from '../types.js';

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
  diagnostic?: Diagnostic;
}

/** Never throws. A malformed frontmatter block yields empty frontmatter plus a diagnostic. */
export function parseFile(path: string, raw: string): ParsedFile {
  try {
    // `matter(raw)` memoises by content: a malformed block throws on the FIRST call of the
    // process and afterwards returns `{data:{}, content: <raw, frontmatter not stripped>}`.
    // Incremental reindex re-parses the same file repeatedly, so the cached path would silently
    // index the raw frontmatter as body text. The options object bypasses the cache.
    const parsed = matter(raw, {});
    return { frontmatter: normalize(parsed.data), body: parsed.content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      frontmatter: {},
      body: stripFrontmatterBlock(raw),
      diagnostic: {
        path,
        message: `frontmatter inválido: ${message}`,
        code: 'diag.frontmatterInvalid',
        params: { detail: message },
      },
    };
  }
}

/**
 * Frontmatter is parsed from note files, and `01-raw/clippings/` holds pages clipped from the
 * web, so this input is untrusted.
 *
 * js-yaml resolves aliases by reference with no depth limit, so a few hundred bytes can describe
 * a structure whose *text* is hundreds of megabytes — the "billion laughs" shape. `String(value)`
 * over such a value walks the entire expansion: `Array.prototype.join` detects cycles but does
 * not memoise a DAG, so each level multiplies. Measured on 269 bytes of frontmatter: 9,565,929
 * characters retained in `fm.tags`; one more nesting level throws `RangeError`, which `parseFile`'s
 * own `try` swallows — degrading to silent memory exhaustion rather than a visible failure.
 *
 * The defence is to never stringify a non-scalar, and to bound both how many tags survive and how
 * long each may be. These caps are far above any real note: the vault's own notes carry 2-4 tags.
 */
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 128;

function normalize(data: Record<string, unknown>): Frontmatter {
  // Note: unrelated keys are still carried through by reference, per the `Frontmatter` contract
  // that unknown keys are preserved. That is cheap — no expansion happens until something
  // stringifies them — but a consumer that serializes arbitrary frontmatter keys must impose its
  // own bound. Only `tags` is converted to text here, and only that conversion is bounded.
  const fm: Frontmatter = { ...data };
  fm.tags = toTags(data['tags']);
  // YAML resolves an unquoted `2026-01-10` to a Date. Every note in the vault writes dates that
  // way, and the rest of the system compares and serializes them as text, so convert back here
  // rather than letting a Date leak into `atualizado:` rewriting or a daily-note filename.
  for (const key of ['criado', 'atualizado'] as const) {
    const value = data[key];
    if (value instanceof Date) fm[key] = yamlDateToIsoDay(value);
  }
  return fm;
}

/** Bounded conversion of the raw `tags` value. Never throws, never stringifies a container. */
function toTags(value: unknown): string[] {
  if (typeof value === 'string') {
    // Bound the source before splitting: a multi-megabyte scalar would otherwise allocate a
    // million-element array only for `collectTags` to keep the first MAX_TAGS of it.
    return collectTags(value.slice(0, MAX_TAGS * (MAX_TAG_LENGTH + 1)).split(','));
  }
  if (Array.isArray(value)) return collectTags(value);
  return [];
}

function collectTags(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= MAX_TAGS) break;
    const tag = toTag(value);
    if (tag !== undefined) out.push(tag);
  }
  return out;
}

/**
 * A tag is a scalar. An array or object is not a tag, so it is dropped rather than stringified —
 * this is the guard that makes an aliased structure cost nothing instead of exploding.
 */
function toTag(value: unknown): string | undefined {
  if (typeof value === 'string') return clampTag(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return clampTag(String(value));
  }
  if (value instanceof Date) return clampTag(yamlDateToIsoDay(value));
  return undefined;
}

/** Truncates before trimming, so a huge scalar is never copied whole just to trim it. */
function clampTag(raw: string): string | undefined {
  const tag = raw.slice(0, MAX_TAG_LENGTH).trim();
  return tag === '' ? undefined : tag;
}

/**
 * YYYY-MM-DD in UTC. js-yaml builds a frontmatter date as UTC midnight, carrying no time zone
 * of its own, so local getters would read `2026-01-10` back as `2026-01-09` anywhere west of
 * Greenwich. This function is ONLY for dates that came out of YAML.
 */
function yamlDateToIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Drops a leading `---` block so a broken header never leaks into the indexed body. */
function stripFrontmatterBlock(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  // The closing `---` may be the last bytes of the file, with no trailing newline. `indexOf`
  // then returns -1, and `slice(-1 + 1)` is `slice(0)` — the entire raw input, frontmatter
  // included, which is exactly the leak this function exists to prevent. No newline after the
  // closer means there is no body at all.
  const bodyStart = raw.indexOf('\n', end + 1);
  return bodyStart === -1 ? '' : raw.slice(bodyStart + 1);
}
