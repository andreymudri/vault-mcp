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
      diagnostic: { path, message: `frontmatter inválido: ${message}` },
    };
  }
}

function normalize(data: Record<string, unknown>): Frontmatter {
  const fm: Frontmatter = { ...data };
  const tags = data['tags'];
  if (typeof tags === 'string') fm.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  else if (Array.isArray(tags)) fm.tags = tags.map((t) => String(t));
  else fm.tags = [];
  // YAML resolves an unquoted `2026-01-10` to a Date. Every note in the vault writes dates that
  // way, and the rest of the system compares and serializes them as text, so convert back here
  // rather than letting a Date leak into `atualizado:` rewriting or a daily-note filename.
  for (const key of ['criado', 'atualizado'] as const) {
    const value = data[key];
    if (value instanceof Date) fm[key] = yamlDateToIsoDay(value);
  }
  return fm;
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
  return end === -1 ? raw : raw.slice(raw.indexOf('\n', end + 1) + 1);
}
