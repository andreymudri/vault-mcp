import { promises as fs } from 'node:fs';

import { atomicWrite } from './atomic.js';
import { unifiedDiff } from './diff.js';
import { resolveWritePath, assertNoSymlinkEscape } from './paths.js';
import { formatLocal } from './template.js';

/**
 * Automatic propagation of a learning into the three places that make it findable again:
 * the domain MOC, the knowledge index and today's daily note.
 *
 * A note nobody links to is a note nobody finds. Every write path in this server funnels
 * through here precisely so that the graph the retrieval side walks (`vault/links.ts`,
 * and the one-hop expansion of the search) is maintained by the machine rather than by
 * the user remembering to do it.
 *
 * The decisions live in PURE functions — `classifyTipo`, `bumpAtualizado`,
 * `insertUnderSection`, `buildMoc`, `buildDaily` — and only `propagate` touches disk.
 * That split is what makes the interesting behaviour testable without a vault, and it is
 * also why this module never commits: `vault_learn` touches up to four files and needs
 * ONE commit covering the set, so the caller owns `commitFiles`.
 */

/** Maps frontmatter tags to the daily-capture kind, defaulting to a generic learning. */
export function classifyTipo(tags: string[]): string {
  const folded = tags.map((t) => t.toLowerCase());
  if (folded.some((t) => t === 'gotcha')) return 'gotcha';
  if (folded.some((t) => t === 'pattern' || t === 'padrao' || t === 'padrão')) return 'pattern';
  if (folded.some((t) => t === 'decisao' || t === 'decisão' || t === 'adr')) return 'decisão';
  if (folded.some((t) => t === 'estado' || t === 'status')) return 'estado';
  return 'aprendizado';
}

/**
 * Rewrites the `atualizado:` frontmatter field, inserting it after `criado:` when absent.
 * Returns the content unchanged when there is no frontmatter block to write into.
 */
export function bumpAtualizado(content: string, date: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const head = content.slice(0, end);
  const rest = content.slice(end);
  if (/^atualizado:/m.test(head)) {
    return head.replace(/^atualizado:.*$/m, `atualizado: ${date}`) + rest;
  }
  if (/^criado:.*$/m.test(head)) {
    return head.replace(/^(criado:.*)$/m, `$1\natualizado: ${date}`) + rest;
  }
  return `${head}\natualizado: ${date}${rest}`;
}

/** An ATX heading of any level, once leading indentation is allowed for. */
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

/** A bullet or ordered list item. */
const ITEM_RE = /^\s*(?:[-*+]\s|\d+[.)]\s)/;

/** The opening or closing line of a fenced code block. */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/**
 * Marks every line that sits INSIDE a fenced code block.
 *
 * Without this, a MOC whose body quotes markdown — and the vault's own notes about
 * Obsidian conventions do exactly that — has its `## Notas` example treated as the real
 * section, and the new entry lands inside a code fence where no link resolver will ever
 * see it. Fence state is computed once over the whole file so heading detection and item
 * detection agree on it.
 */
function fencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array<boolean>(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      // The fence delimiter itself counts as inside: it is never a heading or an item.
      inFence[i] = true;
      open = !open;
      continue;
    }
    inFence[i] = open;
  }
  return inFence;
}

/** Compares two lines ignoring the trailing `\r` of a CRLF file and surrounding spaces. */
function sameLine(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Inserts `line` at the end of the list under `heading`.
 *
 * The rules, in order:
 *
 * - The section is located by an EXACT heading line (`## Notas`, `## Domínios`,
 *   `## Capturas`) and ends at the next heading or at the end of the file.
 * - Insertion goes after the LAST item of the section's list, never at the end of the
 *   file. A MOC's `## Notas` is followed by `## Relacionados`, and a daily's
 *   `## Capturas` by `## Próximo`; appending to the file would file every new entry
 *   under the wrong heading.
 * - A section that exists but is empty gets the line as its first item, keeping the blank
 *   line that separates the heading from its list.
 * - A section that does not exist at all is appended, with the item inside it.
 * - If `line` is ALREADY in the section, the content comes back byte-identical. That
 *   idempotency is what stops the MOC from growing a duplicate entry every time the same
 *   note is learned again, and it is what lets `propagate` skip the write entirely.
 */
export function insertUnderSection(content: string, heading: string, line: string): string {
  const hadTrailingNewline = content.endsWith('\n');
  // The `\r` of a CRLF file is carried along by `split('\n')`, so an inserted line has to
  // carry one too or the file ends up with mixed line endings after a single capture.
  const eolSuffix = content.includes('\r\n') ? '\r' : '';
  const lines = content.split('\n');
  if (hadTrailingNewline) lines.pop();

  const inFence = fencedLines(lines);

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i] === true) continue;
    if (sameLine(lines[i] ?? '', heading)) {
      headingIdx = i;
      break;
    }
  }

  const join = (out: string[]): string => out.join('\n') + (hadTrailingNewline ? '\n' : '');

  if (headingIdx === -1) {
    // No such section: append it, separated from whatever came before by a blank line.
    const out = [...lines];
    if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') out.push(eolSuffix);
    out.push(heading + eolSuffix, eolSuffix, line + eolSuffix);
    return out.join('\n') + '\n';
  }

  // Where the section ends: the next heading outside a fence, or the end of the file.
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    if (inFence[i] === true) continue;
    if (HEADING_RE.test(lines[i] ?? '')) {
      sectionEnd = i;
      break;
    }
  }

  for (let i = headingIdx + 1; i < sectionEnd; i += 1) {
    if (sameLine(lines[i] ?? '', line)) return content;
  }

  // The last item of the section's list, together with any indented continuation lines
  // that belong to it. A blank line only stays inside the run when a further item follows,
  // so trailing blank lines before the next heading are left where they are.
  let lastItem = -1;
  let started = false;
  for (let i = headingIdx + 1; i < sectionEnd; i += 1) {
    if (inFence[i] === true) continue;
    const raw = lines[i] ?? '';
    if (ITEM_RE.test(raw)) {
      lastItem = i;
      started = true;
      continue;
    }
    if (!started) continue;
    // A continuation of the current item: indented, non-empty, not a new item.
    if (raw.trim() !== '' && /^\s+\S/.test(raw)) {
      lastItem = i;
      continue;
    }
    if (raw.trim() === '') continue;
    // Prose after the list closes the run: the item goes after the list, not after prose.
    break;
  }

  const out = [...lines];
  if (lastItem !== -1) {
    out.splice(lastItem + 1, 0, line + eolSuffix);
    return join(out);
  }

  // Empty section: first item, keeping one blank line under the heading and one above
  // whatever follows.
  let at = headingIdx + 1;
  const toInsert: string[] = [line + eolSuffix];
  if ((out[at] ?? '').trim() === '' && at < out.length) {
    at += 1;
  } else {
    toInsert.unshift(eolSuffix);
  }
  if (at < out.length && (out[at] ?? '').trim() !== '') toInsert.push(eolSuffix);
  out.splice(at, 0, ...toInsert);
  return join(out);
}

/** The domain with its initial letter capitalised, for the MOC title. */
function capitalize(dominio: string): string {
  const chars = Array.from(dominio);
  const first = chars[0];
  if (first === undefined) return dominio;
  return first.toUpperCase() + chars.slice(1).join('');
}

/**
 * A brand new MOC for `dominio`, in the format of the ones already in the vault.
 *
 * `## Notas` is born EMPTY on purpose: `insertUnderSection` fills it in the same flow, so
 * there is one code path that appends an entry rather than two that must agree.
 */
export function buildMoc(dominio: string, date: string): string {
  return [
    '---',
    'tipo: moc',
    `tags: [${dominio}]`,
    `criado: ${date}`,
    `atualizado: ${date}`,
    '---',
    '',
    `# ${capitalize(dominio)} — Mapa de Conteúdo`,
    '',
    '## Notas',
    '',
    '## Relacionados',
    '',
    '- [[../../00-index/index-knowledge|índice de conhecimento]]',
    '',
  ].join('\n');
}

/** A brand new daily note, with an empty `## Capturas` for the capture line to land in. */
export function buildDaily(date: string): string {
  return ['---', 'tipo: daily', `criado: ${date}`, '---', '', `# ${date}`, '', '## Capturas', '', ''].join(
    '\n',
  );
}

/**
 * A brand new knowledge index, for the vault that does not have one yet.
 *
 * Not in the plan's step list because the fixture and the real vault both ship one; it
 * exists so that the "new domain" path cannot produce a file WITHOUT frontmatter, which
 * the scanner would then classify as a `nota` and rank as ordinary prose.
 */
function buildIndex(date: string): string {
  return [
    '---',
    'tipo: moc',
    `criado: ${date}`,
    `atualizado: ${date}`,
    '---',
    '',
    '# Índice de Conhecimento',
    '',
    '## Domínios',
    '',
    '',
  ].join('\n');
}

/**
 * Folds a caller-supplied fragment into something safe to splice into a single markdown
 * line.
 *
 * `resumo` comes from model-clipped content and `projeto` from tool input; a newline in
 * either splits the entry in two, and the second half lands in the MOC as a stray line
 * that no longer parses as a list item. Tabs and carriage returns get the same treatment
 * for the same reason.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface PropagateOptions {
  vaultRoot: string;
  dominio: string;
  slug: string;
  resumo: string;
  tags: string[];
  projeto?: string;
  /** true when a new note was created, false when an insight was appended to an existing one. */
  created: boolean;
  /** true when `02-wiki/<dominio>/` did not exist before this operation. */
  domainIsNew: boolean;
  now: Date;
}

export interface PropagateResult {
  /** Absolute paths actually written, for the caller's single batched commit. */
  written: string[];
  diffs: string[];
  warnings: string[];
}

/** Everything one target needs, so the read/transform/write/report dance lives in one place. */
interface Target {
  relPath: string;
  /** Produces the new content. `exists` is false when the file has to be created. */
  transform: (before: string, exists: boolean) => string;
}

/**
 * Reads one target, transforms it and writes it back ONLY if the bytes changed.
 *
 * The "only if changed" rule is not an optimisation. An unchanged file that is rewritten
 * anyway moves its mtime, which both Obsidian and the scanner's mtime revalidation watch,
 * and it enters the caller's commit as a no-op change. Repeating the same `vault_learn`
 * must be a genuine no-op, not a commit full of untouched files.
 */
async function applyTarget(
  vaultRoot: string,
  target: Target,
  result: PropagateResult,
): Promise<void> {
  try {
    const absPath = resolveWritePath(vaultRoot, target.relPath);
    await assertNoSymlinkEscape(vaultRoot, absPath);

    let before = '';
    let exists = true;
    try {
      before = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      // ENOENT is the ordinary "create it" case. Anything else — a directory in the way,
      // a permission problem — is a real failure and must be reported, not papered over
      // by writing a fresh file on top of whatever is actually there.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      exists = false;
    }

    const after = target.transform(before, exists);
    if (after === before) return;

    await atomicWrite(absPath, after);
    result.written.push(absPath);
    result.diffs.push(unifiedDiff(before, after, target.relPath));
  } catch (err) {
    // Naming the target is the whole value of the warning: the caller reports it verbatim
    // to the user, who needs to know WHICH of the three places did not get updated.
    result.warnings.push(
      `falha ao propagar ${target.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Propagates a learning to the domain MOC, the knowledge index and the daily note.
 *
 * Order is MOC → index (only for a brand new domain) → daily, and each target is wrapped
 * in its own try/catch: a failure becomes a warning naming that target and the next one
 * still runs. Nothing here throws, and nothing here commits — the note has already been
 * written by the caller, and a propagation failure must not undo it nor abort the commit
 * that covers it.
 */
export async function propagate(opts: PropagateOptions): Promise<PropagateResult> {
  const result: PropagateResult = { written: [], diffs: [], warnings: [] };

  const date = formatLocal(opts.now, 'YYYY-MM-DD');
  const time = formatLocal(opts.now, 'HH:mm');
  const dominio = opts.dominio;
  const slug = oneLine(opts.slug);
  const resumo = oneLine(opts.resumo);

  // 1. The domain MOC, created when the domain has none — `02-wiki/performance/` and
  //    `02-wiki/tauri/` in the real vault are exactly that case.
  const mocRel = `02-wiki/${dominio}/${dominio}-moc.md`;
  await applyTarget(
    opts.vaultRoot,
    {
      relPath: mocRel,
      transform: (before, exists) => {
        let text = exists ? before : buildMoc(dominio, date);
        if (opts.created) {
          text = insertUnderSection(text, '## Notas', `- [[${slug}]] — ${resumo}`);
        }
        // Even an append to an existing note moves the MOC's `atualizado:`: the domain did
        // gain knowledge, and the date is what tells the user which areas are alive.
        return bumpAtualizado(text, date);
      },
    },
    result,
  );

  // 2. The knowledge index, ONLY for a domain that did not exist before. A domain already
  //    listed leaves this file byte-identical, which is why it is guarded here and not by
  //    a re-scan of the section.
  if (opts.domainIsNew) {
    await applyTarget(
      opts.vaultRoot,
      {
        relPath: '00-index/index-knowledge.md',
        transform: (before, exists) => {
          const text = insertUnderSection(
            exists ? before : buildIndex(date),
            '## Domínios',
            `- [[../02-wiki/${dominio}/${dominio}-moc|${dominio}]] — ${resumo}`,
          );
          return bumpAtualizado(text, date);
        },
      },
      result,
    );
  }

  // 3. Today's daily note. `formatLocal` is local wall-clock time, deliberately: in UTC a
  //    learning at 22:00 in São Paulo would be filed under TOMORROW with a 22:00 stamp.
  const tipo = classifyTipo(opts.tags);
  const projeto = opts.projeto === undefined ? '' : oneLine(opts.projeto);
  const suffix = projeto === '' ? tipo : `${tipo}, ${projeto}`;
  const capture = `- ${time} [[${slug}]] (${suffix})`;
  await applyTarget(
    opts.vaultRoot,
    {
      relPath: `04-daily/${date}.md`,
      transform: (before, exists) =>
        insertUnderSection(exists ? before : buildDaily(date), '## Capturas', capture),
    },
    result,
  );

  return result;
}
