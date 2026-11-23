import type { Messages } from '../../i18n/messages.js';
import { translatePhrases } from '../../i18n/phrases.js';
import { hasAllTags, inFolder } from '../../retrieval/retrieval.js';
import type { Frontmatter, Note, ScoredChunk } from '../../types.js';
import type { DeleteResult, MoveResult } from '../../write/relocate.js';
import type { WriteResult } from '../../write/writer.js';
import { clamp, forMessage, quoteSnippet, relayDiff } from './sanitize.js';

/**
 * How a note, a search result and the outcome of a write are rendered as text.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/** Frontmatter comes from files nobody validated, so every field may be any YAML scalar. */
export function stringField(note: Note, key: string): string | undefined {
  const value = note.frontmatter[key];
  return typeof value === 'string' ? value : undefined;
}

export function noteTags(note: Note): string[] {
  const tags = note.frontmatter.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

/** The metadata filters `vault_list` and `vault_graph` share. */
export interface NoteFilters {
  tipo?: string | undefined;
  status?: string | undefined;
  folder?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Whether `note` passes the metadata filters: the one rule `vault_list` and `vault_graph` both
 * apply. The tag rule inside it is `hasAllTags` (src/retrieval/retrieval.ts), the SAME one
 * `vault_search` applies: two copies would disagree in silence about what `tags: ['NestJS']`
 * selects, and a graph drawing a different set of notes than the list for the same filters would
 * be exactly that bug.
 */
export function matchesFilters(note: Note, filters: NoteFilters): boolean {
  if (filters.tipo !== undefined && stringField(note, 'tipo') !== filters.tipo) return false;
  if (filters.status !== undefined && stringField(note, 'status') !== filters.status) return false;
  if (filters.folder !== undefined && !inFolder(note.path, filters.folder)) return false;
  return hasAllTags(noteTags(note), filters.tags ?? []);
}

/** Code-unit order, the same on every platform and locale. */
export function byPath(a: Note, b: Note): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Bounds on the frontmatter block `vault_get_note` renders. All three exist because the SOURCE
 * bytes say nothing about the rendered size.
 *
 * YAML aliases share nodes, so a mapping of 300 bytes can describe a structure whose TEXT is
 * megabytes: nine levels of nine references each is 9^5 leaves. `frontmatter.ts` bounds `tags` for
 * exactly this reason and carries every other key through by reference, with an explicit note that
 * "a consumer that serializes arbitrary frontmatter keys must impose its own bound". This is that
 * consumer, and it did not: `JSON.stringify` over such a value produced a 1,2 MB answer from a
 * 330-byte note in this project's own test, and larger shapes reach tens of megabytes and then a
 * `RangeError` — on a single-threaded stdio server, a wedge followed by a crash, from a note a
 * poisoned `01-raw/` clipping delivers with no caller cooperation at all.
 *
 * The per-VALUE bound matters as much as the total: without it one enormous value spends the whole
 * budget and hides every other key, which is the same note losing its `tipo` and its links.
 */
export const MAX_FRONTMATTER_KEYS = 32;

export const MAX_FRONTMATTER_VALUE_CHARS = 512;

export const MAX_FRONTMATTER_CHARS = 4_000;

/**
 * One frontmatter value as text, in work PROPORTIONAL TO WHAT IS EMITTED rather than to what the
 * value expands to.
 *
 * That is the whole design, and it is why the budget is threaded THROUGH the walk instead of being
 * applied to its result: a container is never handed to `String` or `JSON.stringify`, both of which
 * expand everything before anything can be truncated, so a check on the output is a check that runs
 * after the damage.
 *
 * `depth` is 1 at the top, which buys back the thing the first version of this bound took away. A
 * `fonte:` mapping of a URL and an author is 40 bytes and rendered `{objeto com 2 chave(s)}` it was
 * UNREACHABLE — `vault_get_note` is the only tool that returns note content, so summarising a value
 * that fits is simply losing it. One level down, `{url: https://…, autor: fulano}` costs the same
 * worst case, because the character budget is what bounds the work, not the depth.
 *
 * The cap is on TEXT, never on element count: `frontmatter.ts` lets a note carry 64 tags, and a
 * 40-item list is about 190 characters — well inside the budget — so counting items made
 * `vault_get_note` summarise a list `vault_list` printed in full, two tools disagreeing about the
 * same note.
 */
export function renderFrontmatterValue(value: unknown, depth = 1, memo: RenderMemo = new WeakMap()): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (depth <= 0) return `[lista com ${value.length} item(ns)]`;
    return remember(memo, value, depth, () =>
      clamp(
        joinBudgeted(value, (item) => renderFrontmatterValue(item, depth - 1, memo), value.length),
        MAX_FRONTMATTER_VALUE_CHARS,
      ),
    );
  }

  if (typeof value === 'object') {
    // The depth test comes FIRST, before any enumeration. `Object.entries` on the way to a
    // summary that only needs the count builds one two-element array per key, and an alias makes
    // that happen once per reference to the same object.
    if (depth <= 0) {
      return remember(memo, value, depth, () => `{objeto com ${Object.keys(value).length} chave(s)}`);
    }
    return remember(memo, value, depth, () => {
      const entries = Object.entries(value);
      const inner = joinBudgeted(
        entries,
        ([key, item]) => `${clamp(key, MAX_FRONTMATTER_VALUE_CHARS)}: ${renderFrontmatterValue(item, depth - 1, memo)}`,
        entries.length,
      );
      return clamp(`{${inner}}`, MAX_FRONTMATTER_VALUE_CHARS);
    });
  }

  return clamp(String(value), MAX_FRONTMATTER_VALUE_CHARS);
}

/**
 * One rendering per (container, depth), for the whole block.
 *
 * A YAML alias makes the SAME object reachable by many paths, and the rendering of a container is
 * a pure function of the container and the depth it is reached at — so the second path can only
 * ever recompute an answer that is already known. Without this, a 60.000-key map under 40 keys of
 * 25 aliases each was summarised ~640 times and cost 5,2 s of synchronous work on a server that
 * answers nothing else meanwhile; with it, once.
 *
 * The map is created per `renderFrontmatterBlock` call and thrown away with it, deliberately: a
 * module-level cache would key on objects the scanner holds across refreshes, and would answer
 * from a stale rendering if any of them were ever mutated in place.
 */
export type RenderMemo = WeakMap<object, Map<number, string>>;

export function remember(memo: RenderMemo, value: object, depth: number, compute: () => string): string {
  let byDepth = memo.get(value);
  if (byDepth === undefined) {
    byDepth = new Map();
    memo.set(value, byDepth);
  }
  const hit = byDepth.get(depth);
  if (hit !== undefined) return hit;
  const rendered = compute();
  byDepth.set(depth, rendered);
  return rendered;
}

/**
 * `render` applied to as many items as fit in `MAX_FRONTMATTER_VALUE_CHARS`, with the rest counted
 * rather than rendered.
 *
 * The loop STOPS at the budget instead of rendering everything and cutting afterwards, which is
 * what keeps a billion-element alias list from costing a billion renders. Every item contributes at
 * least the two characters of its separator, so the iteration count is bounded by the budget even
 * when every item renders empty.
 */
export function joinBudgeted<T>(items: readonly T[], render: (item: T) => string, total: number): string {
  const parts: string[] = [];
  let length = 0;
  for (const item of items) {
    const part = render(item);
    parts.push(part);
    length += part.length + 2;
    if (length > MAX_FRONTMATTER_VALUE_CHARS) break;
  }
  const rest = total - parts.length;
  return `${parts.join(', ')}${rest > 0 ? `, …+${rest} item(ns)` : ''}`;
}

/**
 * The whole frontmatter block, one line per key, escaped per key and per value, and bounded in key
 * count and in total size. Returns the marker line itself so the caller is told what was left out —
 * a silently shortened block is a note whose metadata the caller believes it has seen.
 */
export function renderFrontmatterBlock(frontmatter: Frontmatter): string {
  const entries = Object.entries(frontmatter);
  const memo: RenderMemo = new WeakMap();
  const lines: string[] = [];
  let length = 0;
  let cut = entries.length > MAX_FRONTMATTER_KEYS;

  for (const [key, value] of entries.slice(0, MAX_FRONTMATTER_KEYS)) {
    // Escaped PER KEY AND PER VALUE, then joined. Escaping the assembled block instead turns the
    // separators into the two literal characters `\` and `n`, which is every note with two keys.
    const line = `  ${forMessage(clamp(key, MAX_FRONTMATTER_VALUE_CHARS))}: ${forMessage(renderFrontmatterValue(value, 1, memo))}`;
    if (length + line.length > MAX_FRONTMATTER_CHARS) {
      cut = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  if (cut) lines.push(`  […frontmatter cortado em ${MAX_FRONTMATTER_KEYS} chaves / ${MAX_FRONTMATTER_CHARS} caracteres]`);
  return lines.join('\n');
}

/** One rendered result: the citation line the vault's `CLAUDE.md` requires, then the text. */
export function renderResult(item: ScoredChunk, m: Messages): string {
  const { chunk } = item;
  const trail =
    chunk.headingPath.length === 0 ? '' : ` — ${forMessage(chunk.headingPath.join(' > '))}`;
  const flags = [
    `score ${item.score.toFixed(2)}`,
    item.viaGraph ? m.results.viaGraph : undefined,
    // The BOOLEAN, never the marker text. `TRUNCATION_MARKER` is ordinary prose that a note can
    // quote verbatim (`src/types.ts` says so), so matching on it would label an intact note as cut.
    item.truncated === true ? m.results.snippetTruncated : undefined,
  ]
    .filter((flag): flag is string => flag !== undefined)
    .join(', ');
  return `${forMessage(chunk.path)}:${chunk.lineStart}${trail} (${flags})\n${quoteSnippet(chunk.text)}`;
}

export function renderNoteLine(note: Note): string {
  // Clamped even though `tipo`/`status` are string-typed and `tags` arrives bounded from
  // `frontmatter.ts`: this line is emitted once per note in the vault, so an unbounded field here
  // multiplies by the size of the vault rather than by one note.
  const details = [
    `tipo: ${clamp(stringField(note, 'tipo') ?? '—', MAX_FRONTMATTER_VALUE_CHARS)}`,
    `status: ${clamp(stringField(note, 'status') ?? '—', MAX_FRONTMATTER_VALUE_CHARS)}`,
    `tags: ${clamp(noteTags(note).join(', '), MAX_FRONTMATTER_VALUE_CHARS) || '—'}`,
  ].join(', ');
  return forMessage(`- ${note.path} — ${note.title} (${details})`);
}

/** One line per recovery fact of the commit, and none when the pending journal was not involved. */
export function recoveryLines(result: { recovered?: number; dropped?: number }, m: Messages): string[] {
  return [
    ...(result.recovered === undefined ? [] : [`${m.results.recoveredCommits}: ${result.recovered}`]),
    ...(result.dropped === undefined ? [] : [`${m.results.droppedCommits}: ${result.dropped}`]),
  ];
}

/** Shared tail of `vault_write_note` and `vault_edit_note`. */
export function renderWrite(
  result: WriteResult,
  verb: string,
  redact: (text: string) => string,
  m: Messages,
  queueWarning?: string,
): string {
  const lines = [
    `${verb}: ${forMessage(result.path)}`,
    `${m.results.commit}: ${result.committed ? m.results.yes : m.results.no}`,
    // Only when a push was ATTEMPTED. With `VAULT_AUTO_PUSH` unset the server touches no network at
    // all, and a `Push: não` line there would report on something nobody asked for.
    ...(result.pushed === undefined ? [] : [`${m.results.push}: ${result.pushed ? m.results.yes : m.results.no}`]),
    ...recoveryLines(result, m),
  ];
  for (const warning of [result.warning, queueWarning]) {
    if (warning !== undefined) {
      lines.push(`${m.results.warning}: ${forMessage(redact(translatePhrases(warning, m.phrases)))}`);
    }
  }
  lines.push('', `${m.results.diff}:`, result.diff === '' ? m.results.noContentChange : relayDiff(result.diff, m));
  return lines.join('\n');
}

/**
 * Shared tail of `vault_move` and `vault_delete`.
 *
 * Every list is rendered even when empty, spelled `(nada)`. An absent line reads as "this did not
 * apply"; `Reescritos: (nada)` reads as "no other note needed changing", which is a claim the
 * caller wants and is the usual, correct outcome of a move that only changed a directory.
 */
export function renderRelocate(
  headline: string,
  result: MoveResult | DeleteResult,
  redact: (text: string) => string,
  m: Messages,
  queueWarning?: string,
): string {
  const lines = [headline];
  if ('rewritten' in result) {
    lines.push(
      `${m.results.linksFixedIn}: ${
        result.rewritten.length === 0 ? m.results.nothing : forMessage(result.rewritten.join(', '))
      }`,
    );
  }
  lines.push(
    `${m.results.mocIndexUpdated}: ${
      result.propagated.length === 0 ? m.results.nothing : forMessage(result.propagated.join(', '))
    }`,
    `${m.results.commit}: ${result.committed ? m.results.yes : m.results.no}`,
    ...(result.pushed === undefined ? [] : [`${m.results.push}: ${result.pushed ? m.results.yes : m.results.no}`]),
    ...recoveryLines(result, m),
  );
  if ('undo' in result && result.undo !== undefined) {
    // Vault-relative on purpose (see `relocate.ts`): a command carrying the redactor's `<vault>`
    // is a command the user pastes and watches fail, so the answer says where to run it instead.
    lines.push(`${m.results.undoFromVault}: ${forMessage(result.undo)}`);
  }
  for (const warning of [...result.warnings, queueWarning]) {
    if (warning !== undefined) {
      lines.push(`${m.results.warning}: ${forMessage(redact(translatePhrases(warning, m.phrases)))}`);
    }
  }
  lines.push('', `${m.results.diffShowUser}:`, result.diff === '' ? m.results.empty : relayDiff(result.diff, m));
  return lines.join('\n');
}
