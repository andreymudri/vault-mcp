import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { basename, join, relative, sep } from 'node:path';

import { tokenize } from '../index/tokenizer.js';
import { sliceAtCodePointBoundary } from '../retrieval/budget.js';
import type { Retriever } from '../retrieval/retrieval.js';
import type { ScoredChunk } from '../types.js';
import { commitFiles } from './git.js';
import { classifyStat, INVISIBLE_CHARS, resolveWritePath } from './paths.js';
import { propagate } from './propagate.js';
import { applyTemplate, formatLocal } from './template.js';
import { WriteRaceError, editNote, writeNote, type WriteResult } from './writer.js';

/**
 * `vault_learn`: one call that decides between appending to a note that already covers the
 * subject and creating a new one, writes it, propagates it and commits the whole set once.
 *
 * The bias is deliberately towards CREATING: a wrongly created note is a duplicate the user
 * can merge later, while a wrongly appended one buries an unrelated insight inside a note
 * nobody will look at for it. That is why the duplicate rule is conjunctive.
 */

/** Thrown for input this tool refuses before touching the vault. */
export class LearnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnError';
  }
}

export const DUPLICATE_SCORE_RATIO = 1.8;

/**
 * Ceilings that MIRROR `src/retrieval/retrieval.ts`'s own `MAX_QUERY_TERMS` and
 * `MAX_QUERY_CHARS`, and the reason this module builds its query out of terms instead of
 * handing over `${titulo} ${insight}` raw.
 *
 * Retrieval clamps the raw query at 1024 characters SILENTLY, with no diagnostic, and only
 * then cuts to 64 terms. For ordinary prose the term cap bites first and the clamp is inert,
 * but a long `insight` is the one plausible >1KB argument in this system, and there the clamp
 * changes which notes match — flipping "append to the existing note" into "create a new one",
 * which is precisely the decision this module exists to get right. Measured on the test
 * fixture: a title plus a 1136-character pasted blob plus prose about the BullMQ worker
 * returns NOTHING through the raw path (the clamp cuts inside the blob and the prose terms
 * never reach the index) and returns `bullmq-worker.md` at a ratio of 2.5 through the term
 * path.
 *
 * So the terms are extracted here, in order, and a term that does not fit the REMAINING budget
 * is skipped rather than ending the scan. Once the tokenizer discards over-long tokens, a
 * multi-kilobyte blob never reaches this loop at all; what still does is an ordinary long term —
 * a 60-character identifier — arriving with less budget left than it needs, and ending the scan
 * there would discard every plain word behind it. Re-tokenizing the result is lossless, since
 * `tokenize` output is already folded, hyphen-trimmed, stopword-free and separator-free.
 */
export const MAX_QUERY_TERMS = 64;
export const MAX_QUERY_CHARS = 1024;

/**
 * How much of `${titulo} ${insight}` is scanned for terms at all.
 *
 * Eight times retrieval's clamp — about 1200 words, far more than any single insight — and it
 * exists only to bound work: `tokenize` trims edge hyphens with a backtracking regex whose cost
 * is quadratic in the length of one token, so an unbounded scan of a tool argument is a stall
 * of the single-threaded stdio server. Unlike the clamp this module works around, reaching this
 * limit is REPORTED (`DuplicateQuery.truncated`, surfaced as a `warning`), because a silent
 * truncation of the duplicate check is the failure mode this whole design is about.
 */
export const MAX_QUERY_SOURCE_CHARS = 8192;

/** Where knowledge notes live. A learning is filed here or it is not filed at all. */
const WIKI_PREFIX = '02-wiki/';

/** Longest slug this module will turn a title into, so a long title cannot make an unwritable name. */
const MAX_SLUG_CHARS = 80;

/** Code points of the first sentence kept as the propagation `resumo`. */
const MAX_RESUMO_CHARS = 120;

/**
 * `paths.ts`'s set with `g`: the ONE list of characters this directory refuses in a path
 * and folds out of a line, derived from the shared source rather than written out again.
 *
 * Here it folds the free text that gets spliced into a single line (the section heading,
 * the commit subject, a link name) and refuses a `dominio` outright. A `titulo` carrying a
 * newline turns one commit subject into a forged multi-line message; one carrying U+202E
 * reads in the user's client as a name that is not the file on disk.
 */
const INVISIBLE_CHARS_GLOBAL = new RegExp(INVISIBLE_CHARS.source, 'g');

/**
 * The same set MINUS the two characters that carry meaning in a note body: `\n`, which is what
 * makes prose prose, and `\t`. Everything else goes — NUL, ESC (whose SGR sequences a terminal
 * printing the returned `diff` would execute), bare CR, the bidi overrides, U+2028.
 */
// eslint-disable-next-line no-control-regex
const BLOCK_INVISIBLE_CHARS_GLOBAL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Folds a fragment into something safe to splice into a single markdown or commit line. */
function oneLine(text: string): string {
  return text.replace(INVISIBLE_CHARS_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Free text on its way into the note BODY: line structure kept, every invisible dropped, line
 * endings normalised to LF for `withEol` to rewrite.
 *
 * Brackets are deliberately NOT touched here. The body is the user's own prose, and `[[nota]]`
 * written inside an insight is an authored link — the one place in this module where a wiki-link
 * out of free text is legitimate. `indexText` is the other half of that boundary.
 */
function blockText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(BLOCK_INVISIBLE_CHARS_GLOBAL, ' ');
}

/**
 * Free text on its way into a line the MACHINE writes ABOUT the note — a MOC entry, a knowledge
 * index entry, a daily capture, a link name.
 *
 * One line, and no brackets at all. Those lines are structure rather than prose, and this
 * project's own `extractLinkTargets` reads them back as graph edges, which `graph.ts` turns into
 * backlinks and retrieval's one-hop expansion turns into search results. A `resumo` of
 * `a]] - [[cache-wrapper]] e [[auth-guard]] fim.` — the shape of an insight clipped off a page —
 * writes two edges the user never authored and quietly pulls unrelated notes into later searches;
 * a `projeto` of `x]] (nada) [[auth-guard]] (` does the same through the daily capture line. No
 * legitimate entry needs a bracket, so every one of them is dropped.
 */
function indexText(text: string): string {
  return oneLine(text).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The vault's filename convention: accents folded, lowercase, every run of non-alphanumerics
 * collapsed to a single hyphen, edges trimmed. `Auth Service Singleton` → `auth-service-singleton`.
 *
 * The trim is written as two single-character replaces rather than `^-+|-+$`: the run has
 * already been collapsed, so at most one hyphen can be at each edge, and `-+$` is the
 * backtracking pattern that is quadratic in a long hyphen run.
 */
export function slug(titulo: string): string {
  const folded = titulo
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const trimmed = folded.replace(/^-/, '').replace(/-$/, '');
  if (trimmed.length <= MAX_SLUG_CHARS) return trimmed;
  return trimmed.slice(0, MAX_SLUG_CHARS).replace(/-$/, '');
}

export interface DuplicateQuery {
  query: string;
  /** True when the source text was longer than `MAX_QUERY_SOURCE_CHARS` and got cut. */
  truncated: boolean;
}

/** The duplicate-check query: see `MAX_QUERY_TERMS` for why it is terms and not raw prose. */
export function duplicateQuery(titulo: string, insight: string): DuplicateQuery {
  const source = `${titulo} ${insight}`;
  const scanned = sliceAtCodePointBoundary(source, MAX_QUERY_SOURCE_CHARS);

  const picked: string[] = [];
  let used = 0;
  for (const term of tokenize(scanned)) {
    if (picked.length >= MAX_QUERY_TERMS) break;
    const cost = picked.length === 0 ? term.length : term.length + 1;
    // `continue`, not `break`: a single oversized token must not discard the terms after it.
    if (used + cost > MAX_QUERY_CHARS) continue;
    picked.push(term);
    used += cost;
  }

  return { query: picked.join(' '), truncated: scanned.length < source.length };
}

export interface DuplicateDecision {
  isDuplicate: boolean;
  targetPath?: string;
  reason: string;
}

/**
 * Conjunctive rule: the top hit must both stand out from the runner-up in another
 * note, and share a tag or the domain. Raw BM25 scores are not comparable across
 * queries, so the score test is relative, never absolute.
 *
 * The runner-up is the best chunk of ANOTHER note, never the next chunk of the same one: a
 * strong hit routinely fills the whole result window with its own chunks, and comparing a note
 * against itself would refuse every real duplicate.
 *
 * A top hit that only entered through graph EXPANSION is refused outright. A neighbour inherits
 * a damped share of a hit's undamped score while a direct hit has already paid
 * `NOTE_TYPE_WEIGHTS`, so a neighbour can lead the list without its own words ever matching —
 * and appending an insight to a note that never mentioned the subject is the worst outcome this
 * rule can produce. `viaGraph` answers exactly that question and nothing else: a chunk that
 * matched BM25 directly keeps `viaGraph: false` even when a neighbour's damped score raises its
 * number.
 */
export function decideDuplicate(
  results: ScoredChunk[],
  tags: string[],
  dominio: string,
  noteTags: (path: string) => string[],
): DuplicateDecision {
  const top = results[0];
  if (!top) return { isDuplicate: false, reason: 'nenhum match' };

  // An append target is a WIKI note or it is nothing. The best match for a learning is perfectly
  // capable of being a project README, a daily, the knowledge index or an archived note, and
  // appending to each is wrong in its own way — `99-archive/` and `_templates/` are read-only
  // areas the write guard refuses outright, so routing there does not merely misfile the insight,
  // it is the one path that could throw it away.
  if (!top.chunk.path.startsWith(WIKI_PREFIX)) {
    return { isDuplicate: false, reason: `topo fora de ${WIKI_PREFIX}: ${top.chunk.path}` };
  }

  // UNREACHABLE as retrieval stands, and kept as an assertion rather than as a live branch: a
  // neighbour inherits `GRAPH_DAMPING` (0.4) times the best DIRECT score and every idf here is
  // strictly positive, so a graph-only chunk cannot outrank the hit it inherited from — a sweep
  // of 4497 queries over the test fixture found 1546 results carrying a graph chunk and not one
  // of them at rank 1. It becomes reachable the moment `GRAPH_DAMPING` REACHES 1 — at exactly 1
  // an inherited score ties the direct one and the chunk-id tie-break can seat the neighbour
  // first — and what it
  // refuses then is the worst outcome this rule has: appending an insight to a note whose own
  // words never matched the query. The unit test below builds the state synthetically, which is
  // the only way to reach it.
  if (top.viaGraph) {
    return { isDuplicate: false, reason: 'topo entrou por expansão do grafo, não por match direto' };
  }

  const runnerUp = results.find((r) => r.chunk.path !== top.chunk.path);
  const ratio = runnerUp ? top.score / runnerUp.score : Infinity;
  if (ratio < DUPLICATE_SCORE_RATIO) {
    return { isDuplicate: false, reason: `topo não se destaca (razão ${ratio.toFixed(2)})` };
  }

  const shared = noteTags(top.chunk.path).some((t) => tags.includes(t));
  const sameDomain = top.chunk.path.startsWith(`${WIKI_PREFIX}${dominio}/`);
  if (!shared && !sameDomain) {
    return { isDuplicate: false, reason: 'sem overlap de tag nem de domínio' };
  }

  return { isDuplicate: true, targetPath: top.chunk.path, reason: `duplicata de ${top.chunk.path}` };
}

export interface LearnOptions {
  vaultRoot: string;
  retriever: Retriever;
  titulo: string;
  insight: string;
  contexto: string;
  dominio: string;
  projeto?: string;
  tags?: string[];
  links?: string[];
  confirmNovoDominio?: boolean;
  now: Date;
}

export interface LearnResult {
  action: 'appended' | 'created';
  path: string;
  reason: string;
  /** Concatenated diff of every file touched: the note plus each propagation target. */
  diff: string;
  /** Vault-relative paths of the propagation targets actually written. */
  propagated: string[];
  committed: boolean;
  warning?: string;
}

/**
 * Why a `dominio` cannot be used, or `undefined` when it can.
 *
 * Not looser than `propagate`'s own check, on purpose: a domain this module accepts and
 * propagation refuses writes a note into a domain whose MOC never gets created, and the index
 * entry then points at a file that does not exist. Refused rather than folded, because a domain
 * is an identifier and a repaired one is silently not the domain the caller asked for.
 */
function dominioProblem(dominio: string): string | undefined {
  if (dominio === '') return 'domínio vazio';
  if (dominio.length > 64) return 'domínio longo demais';
  if (INVISIBLE_CHARS.test(dominio)) return 'domínio com caractere de controle';
  if (/\s/.test(dominio)) return 'domínio não pode conter espaço';
  if (/[\\/]/.test(dominio)) return 'domínio não pode conter separador de caminho';
  if (dominio.startsWith('.')) return 'domínio não pode começar com ponto';
  if (/[*?[\]:"<>|]/.test(dominio)) return 'domínio com caractere não permitido';
  return undefined;
}

/** Directory names under `02-wiki/`, which are the vault's domains. */
async function existingDomains(vaultRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(vaultRoot, '02-wiki'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A vault with no `02-wiki/` has no domains yet; every domain is then a new one.
    return [];
  }
}

/**
 * How much of a file is read at a time while deciding whether it is blank, and the ceiling on how
 * much is read in total.
 *
 * A note's first bytes are its frontmatter, so the answer is settled in the first chunk and the
 * loop below stops there. The total ceiling is for the other shape: a file that really is nothing
 * but whitespace for megabytes. Reading it whole to say so cost +1063 MB of RSS on a 209 MB file,
 * three times over, because this path is asked more than once per call. Past the ceiling the
 * answer is `note` — the safe direction, since a `note` is never written over.
 */
const BLANK_PROBE_BYTES = 4096;
const MAX_BLANK_BYTES = 1024 * 1024;

/**
 * What stands on a path, from the point of view of a module that may write a note there.
 *
 * - `free`: nothing at all.
 * - `blank`: a regular file with NO content. Obsidian leaves one whenever a user clicks an
 *   unresolved link or presses Enter in a new note; it is a placeholder, not a note.
 * - `note`: a regular file with content.
 * - `foreign`: a SYMLINK, a HARD LINK, a directory, a FIFO, a socket, a device. Not a note,
 *   and nothing this module may read, write, or rename onto.
 *
 * `foreign` exists so that no path in `learn()` OPENS one, and that is a claim about every
 * read this call makes, not only the ones on the note itself. It was false when it was first
 * written: the note path was classified, while `_templates/wiki.md` and `propagate`'s three
 * targets were read with no classification at all, and a `mkfifo` on any of them left the
 * promise pending for as long as the process lived. `skeletonContent` below asks this same
 * question before the template read, `writer.ts` asks it before its own, and `propagate.ts`
 * lstats each target before opening it.
 *
 * A symlink is `foreign` and that is the whole of its handling here. It cannot be read through:
 * `readFile` follows it, so a link to a FIFO is a read that never returns, on the single thread
 * that serves every tool call. It cannot be written through either: an atomic rename lands ON the
 * link, so the user's alias becomes a regular file holding a divergent copy while the note it
 * pointed at never receives the learning — reproduced in a git repo, mode 120000 committed as
 * 100644. And its blankness is not its own: judging the target's bytes and then acting on the link
 * is how a placeholder check ends up standing on an alias.
 *
 * The blank/note line is the one `propagate` already draws with `before.trim() !== ''`, and the
 * two modules in this directory must not disagree about what blank means: treated as a note, a
 * placeholder gets APPENDED to by `editNote`, which runs neither `ensureFrontmatter` nor
 * `applyTemplate` — the result carries no `tipo: wiki`, no tags, no `# H1` and no skeleton, so the
 * next scan reads it as an untyped note, `vault_list({tipo:'wiki'})` never returns it, and the
 * tag-overlap arm of `decideDuplicate` can never fire for it again.
 */
type PathState = 'free' | 'blank' | 'note' | 'foreign';

async function pathState(absPath: string): Promise<PathState> {
  let stat;
  try {
    // `lstat`, never `stat`: a symlink has to be seen as itself, and a `stat` here would answer
    // for the target — including by hanging on a FIFO behind it.
    stat = await fs.lstat(absPath);
  } catch {
    return 'free';
  }

  // The SHARED rule, over the `Stats` this function already has: not a regular file, or a
  // regular file wearing a second name. A hard link classifies here for the reason `paths.ts`
  // spells out — `fs.link(<segredo fora do vault>, <vault>/.../<slug>.md)` otherwise reads as
  // an ordinary note, the append reads it, and the secret travels into the note, into the
  // commit and into the `result.diff` handed back to the caller.
  if (classifyStat(stat) === 'foreign') return 'foreign';
  if (stat.size === 0) return 'blank';
  if (stat.size > MAX_BLANK_BYTES) return 'note';

  let handle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    // Unreadable is not writable: treat it as content rather than risk standing on it.
    return 'note';
  }

  try {
    // `StringDecoder` holds back an incomplete UTF-8 sequence at the end of a chunk and prepends
    // it to the next, so a multi-byte character straddling the chunk boundary cannot decode to a
    // replacement character and flip the answer on alignment alone.
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(BLANK_PROBE_BYTES);
    let read = 0;
    while (read < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, BLANK_PROBE_BYTES, read);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (decoder.write(buffer.subarray(0, bytesRead)).trim() !== '') return 'note';
    }
    return decoder.end().trim() === '' ? 'blank' : 'note';
  } catch {
    return 'note';
  } finally {
    // A rejecting `close` must not escape: the answer is already decided, the descriptor is
    // gone either way, and neither call site of `pathState` guards against a throw. A raw EIO
    // from here left `learn` with nothing written and the user's insight lost — for a file
    // this function had already finished reading.
    try {
      await handle.close();
    } catch {
      // Nothing to do about it, and nothing that depends on it.
    }
  }
}

/** True when a note may be written at this path without anything being lost. */
function isWritable(state: PathState): boolean {
  return state === 'free' || state === 'blank';
}

/**
 * A human title from the file name, and the `_templates/wiki.md` skeleton with the body spliced
 * in above its first section — the same two rules `writeNote` applies when it CREATES a note
 * (`titleFromPath` and `spliceBody` in `src/write/writer.ts`), reproduced here for the one case
 * `writeNote` cannot cover.
 *
 * That case is a BLANK placeholder standing on the new note's path: `writeNote` decides between
 * creating and replacing by whether it could READ the path, so it takes the replace branch and
 * skips the template, and the note is born with no `# H1` and no `## Contexto` / `## Solução` /
 * `## Exemplo` — violating the plan's "cria nota nova a partir de `_templates/wiki.md`".
 *
 * Handing `writeNote` the COMPLETE content is what makes that unnecessary. The alternative —
 * deleting the placeholder so `writeNote` sees a free path — is an unlink running BEFORE
 * `writeNote`'s own guards (`DENIED_SEGMENTS`, `assertNoSymlinkEscape`): a destructive operation
 * on a path checked for nothing but its suffix and its containment. This module removes nothing,
 * ever.
 *
 * The two routes are pinned against each other by test, and they agree byte for byte except in
 * ONE field: `criado`. `writeNote` stamps it from wall-clock time on the free path (through the
 * template's own `tp.date.now`), while this one passes `opts.now` — the same instant the MOC
 * entry, the daily capture and the append heading of this very call already use. `opts.now` is
 * the right value and `writeNote` is the outlier, but its stamp is its contract with every other
 * caller and not only with this one, so the divergence stands and is ASSERTED by test rather than
 * described here. The assertion names both calendar days the wall clock can be on, because a
 * single sample taken after the call fails on a correct note whenever the run crosses midnight.
 */
function titleFromPath(relPath: string): string {
  return basename(relPath, '.md')
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Trailing newlines dropped by scanning, not by `/\n+$/`, which backtracks quadratically. */
function stripTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  return text.slice(0, end);
}

function spliceIntoSkeleton(skeleton: string, body: string): string {
  const content = body.trim();
  if (content === '') return skeleton;

  const lines = skeleton.split('\n');
  // The search starts after the frontmatter block, so a `## ` inside a quoted YAML value cannot
  // be mistaken for the first section.
  let from = 0;
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if ((lines[i] ?? '').trim() === '---') {
        from = i + 1;
        break;
      }
    }
  }

  let at = -1;
  for (let i = from; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? '')) {
      at = i;
      break;
    }
  }

  if (at === -1) return `${stripTrailingNewlines(skeleton)}\n\n${content}\n`;
  const head = stripTrailingNewlines(lines.slice(0, at).join('\n'));
  const tail = lines.slice(at).join('\n');
  return `${head}\n\n${content}\n\n${tail}`;
}

/** The complete note content for a path that already holds a blank placeholder. */
async function skeletonContent(
  opts: LearnOptions,
  relPath: string,
  body: string,
): Promise<{ content: string; warning?: string }> {
  const templatePath = join(opts.vaultRoot, '_templates', 'wiki.md');
  // Classified BEFORE it is opened, by the same `pathState` the note path goes through.
  // `readFile` on a FIFO never returns, and this path is not caller-supplied but it is inside
  // a directory the user syncs: `mkfifo <vault>/_templates/wiki.md` left this promise pending
  // for ~6000 ms and then for as long as the process lived, wedging every later tool call on
  // the single-threaded stdio server. Reproduced; SIGKILL was the only way out.
  if ((await pathState(templatePath)) === 'foreign') {
    return {
      content: body,
      warning: 'template ignorado: _templates/wiki.md não é um arquivo comum',
    };
  }

  let templateText: string;
  try {
    templateText = await fs.readFile(templatePath, 'utf8');
  } catch {
    // The same warning `writeNote` raises for the same missing file, since it will not raise it
    // itself on this route. The learning is still written: the body is what the user asked for.
    return { content: body, warning: 'template não encontrado: _templates/wiki.md' };
  }
  // `applyTemplate` throws on an unresolved Templater token, exactly as it does inside
  // `writeNote`: an unsubstituted `<% %>` written into the vault is the bug it exists to prevent.
  const skeleton = applyTemplate(templateText, { title: titleFromPath(relPath), now: opts.now });
  return { content: spliceIntoSkeleton(skeleton, body) };
}

/** Tags of a note as the index knows them, read off the result set rather than re-reading disk. */
function tagsByPath(results: ScoredChunk[]): (path: string) => string[] {
  const byPath = new Map<string, string[]>();
  for (const scored of results) {
    if (!byPath.has(scored.chunk.path)) byPath.set(scored.chunk.path, scored.chunk.tags);
  }
  return (path) => byPath.get(path) ?? [];
}

/**
 * A link name as a wiki-link target: no brackets, no `.md`, no line of its own.
 *
 * `indexText` drops every bracket, which both unwraps the `[[nota]]` form a caller may hand over
 * and closes the injection `a]] texto forjado [[b` — a name that would otherwise close this
 * item's link and open another, putting text into the note that reads as content the user never
 * wrote. No legitimate wiki-link target contains a bracket.
 *
 * An alias goes with them: `auth-guard|cache-wrapper` RENDERS as `cache-wrapper` while the edge
 * it creates points at `auth-guard`, and a line that reads as one note and links to another is
 * the same "not what it says it is" problem the brackets are. `links` names notes, so there is
 * nothing to alias. An anchor (`nota#secao`) is kept: it points where it says it points.
 */
function linkName(raw: string): string {
  return indexText(raw)
    .replace(/\|.*$/, '')
    .replace(/\.md$/i, '')
    .trim();
}

/**
 * The `## Links` block, or `undefined` when there is nothing to link.
 *
 * A new note with no link is a note the one-hop graph expansion can never reach, so this is what
 * keeps the graph dense as the vault grows.
 */
function renderLinks(links: string[] | undefined, eol: string): string | undefined {
  const names = (links ?? []).map(linkName).filter((name) => name !== '');
  if (names.length === 0) return undefined;
  return ['## Links', '', ...names.map((name) => `- [[${name}]]`)].join(eol);
}

/** Rewrites every line ending as `eol`, so an append never mixes CRLF and LF in one file. */
function withEol(text: string, eol: string): string {
  return eol === '\n' ? text.replace(/\r\n/g, '\n') : text.replace(/\r?\n/g, eol);
}

/**
 * The learning as markdown: the insight as the note's lead, the context labelled under it, the
 * links last.
 *
 * `writeNote` splices this ABOVE the first section heading of the `_templates/wiki.md` skeleton,
 * so the context is labelled inline rather than given a `## Contexto` heading of its own: the
 * skeleton already declares one, and emitting a second would show the reader two sections with
 * the same name, one of them empty.
 */
function buildBody(opts: LearnOptions, eol: string): string {
  const blocks: string[] = [];
  const insight = withEol(blockText(opts.insight), eol).trim();
  if (insight !== '') blocks.push(insight);
  const contexto = oneLine(opts.contexto);
  if (contexto !== '') blocks.push(`**Contexto:** ${contexto}`);
  const links = renderLinks(opts.links, eol);
  if (links !== undefined) blocks.push(links);
  return `${blocks.join(`${eol}${eol}`)}${eol}`;
}

/** The dated section an append adds to the end of an existing note. */
function buildSection(opts: LearnOptions, titulo: string, date: string, eol: string): string {
  return `## ${date} — ${titulo}${eol}${eol}${buildBody(opts, eol)}`;
}

/**
 * The first sentence of `insight`, at most `MAX_RESUMO_CHARS` CODE POINTS.
 *
 * Code points, never UTF-16 units: cutting at a fixed index in the middle of a surrogate pair —
 * an emoji, which shows up in clipped content — leaves an unpaired surrogate, and js-yaml then
 * refuses the whole document with "the stream contains non-printable characters". The note loses
 * its frontmatter and the next `ensureFrontmatter` pass prefixes a second block instead of
 * repairing the first. The UTF-16 slice below is a bound on the WORK, at twice the code-point
 * budget, so it can never cut inside the first `MAX_RESUMO_CHARS` code points.
 */
function resumoOf(insight: string): string {
  const flat = indexText(insight);
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  const bounded = sliceAtCodePointBoundary(sentence, MAX_RESUMO_CHARS * 2);
  return Array.from(bounded).slice(0, MAX_RESUMO_CHARS).join('');
}

/** Joins the warnings one call can produce, keeping every one of them visible. */
function joinWarnings(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== '');
  return kept.length === 0 ? undefined : kept.join('; ');
}

function toVaultRelative(vaultRoot: string, absPath: string): string {
  return relative(vaultRoot, absPath).split(sep).join('/');
}

/**
 * Appends the section to the end of `relPath` through `editNote`, so the append pays the same
 * path guard, the same atomic write and the same diff as any other edit.
 *
 * The whole current content is the `oldText`: it occurs exactly once by construction, which is
 * what `editNote`'s ambiguity rule demands, and it makes the append a no-op-safe read → replace
 * rather than a blind concatenation. `trimEnd` plus one blank line keeps the diff to the added
 * lines instead of rewriting the last one.
 */
async function appendSection(
  opts: LearnOptions,
  relPath: string,
  titulo: string,
  date: string,
): Promise<WriteResult> {
  const absPath = resolveWritePath(opts.vaultRoot, relPath);
  const before = await fs.readFile(absPath, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const section = buildSection(opts, titulo, date, eol);
  return editNote({
    vaultRoot: opts.vaultRoot,
    path: relPath,
    oldText: before,
    newText: `${before.trimEnd()}${eol}${eol}${section}`,
    deferCommit: true,
  });
}

/** The outcome of one append attempt: the write, or the reason this target could not take it. */
interface AppendAttempt {
  write?: WriteResult;
  failure?: string;
}

/**
 * Appends to `relPath`, turning the three "this target cannot take the text" failures into a
 * reportable reason instead of an exception. Anything else is a real fault and is rethrown.
 */
async function attemptAppend(
  opts: LearnOptions,
  relPath: string,
  titulo: string,
  date: string,
): Promise<AppendAttempt> {
  const refusal = (detail: string): AppendAttempt => ({
    failure: `não foi possível anexar em ${oneLine(relPath)} (${detail})`,
  });

  let absPath: string;
  try {
    absPath = resolveWritePath(opts.vaultRoot, relPath);
  } catch (err) {
    return refusal(oneLine(err instanceof Error ? err.message : String(err)));
  }

  // Asked BEFORE anything is opened. `appendSection` reads with `readFile`, which follows a
  // symlink — onto a FIFO that never returns, or onto a note whose alias the rename would then
  // replace — and `editNote` renames onto whatever the name holds. The classifier answers from
  // `lstat`, so a target that is not a plain note with content is refused without being touched.
  const state = await pathState(absPath);
  if (state !== 'note') {
    return refusal(
      state === 'free'
        ? 'a nota não está mais no disco'
        : state === 'blank'
          ? 'a nota está em branco'
          : 'o caminho não é uma nota (link, diretório ou dispositivo)',
    );
  }

  try {
    return { write: await appendSection(opts, relPath, titulo, date) };
  } catch (err) {
    // Every failure from here is about THIS target and none of them may cost the user the
    // insight: `freeNotePath` below is the loss-free answer, and a fault that is not about the
    // path — no space, a broken template — surfaces from the write that follows instead. An
    // errno list stood here before, and the states it did not name (a symlink loop, a link to a
    // directory, a file the process cannot open) threw a raw errno out of `learn` with nothing
    // written.
    return refusal(oneLine(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * How many times a creation that lost the publish race looks for another free name.
 *
 * Two is already the interesting case and this is not a lock: a name taken again and again is a
 * second writer working the same domain, and spinning would only make this call the one that
 * never returns.
 */
const CREATE_RACE_ATTEMPTS = 8;

/**
 * A path in the domain that NO file occupies, for the one case where the learning has nowhere
 * else to go: the note of this title exists and cannot be appended to.
 *
 * `writeNote` is create-OR-REPLACE, so handing it an occupied path is how an existing note gets
 * destroyed. The date suffix keeps the name meaningful (`cache-wrapper-ttl-2026-08-20.md`) and
 * the numeric suffixes after it keep the search bounded and terminating. Exhausting them means a
 * vault state no ordinary use produces, and it is refused loudly rather than written over: the
 * caller still holds the text, which a silent overwrite would not leave true of the note.
 *
 * A sibling name loses nothing only because `pathState` reads a BLANK file as writable: were a
 * placeholder counted as a note, the user who clicked a link to `cache-wrapper-ttl` would be left
 * with that file blank forever while the learning sat in `cache-wrapper-ttl-2026-08-20.md` — and
 * nothing would report it, since the link is not broken and the file exists.
 */
async function freeNotePath(
  vaultRoot: string,
  dominio: string,
  noteSlug: string,
  date: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? date : `${date}-${attempt + 1}`;
    const room = MAX_SLUG_CHARS - suffix.length - 1;
    const head = (noteSlug.length <= room ? noteSlug : noteSlug.slice(0, room)).replace(/-$/, '');
    const candidate = `${WIKI_PREFIX}${dominio}/${head}-${suffix}.md`;
    if (isWritable(await pathState(resolveWritePath(vaultRoot, candidate)))) return candidate;
  }
  throw new LearnError(
    `não há nome livre para a nota em ${WIKI_PREFIX}${dominio}/: 100 variações já existem`,
  );
}

/**
 * Learns one insight: route, write, propagate, commit once.
 *
 * The order is deliberate — every file is written first and the commit comes last, covering the
 * whole set. Committing per file would produce an unreadable history and, worse, a committed
 * state where the note exists and the MOC does not list it. A git failure is a `warning`, never
 * a rollback: the note is what the user asked for.
 */
export async function learn(opts: LearnOptions): Promise<LearnResult> {
  const titulo = oneLine(opts.titulo);
  const noteSlug = slug(titulo);
  if (noteSlug === '') {
    throw new LearnError('título inválido: não gera um nome de arquivo (use letras ou números)');
  }

  // `writeNote` hands the composed body to `ensureFrontmatter`, which reads a `---` on the FIRST
  // line as the note's own frontmatter block. With `_templates/wiki.md` in place the body is
  // spliced below the skeleton's block and the question never arises — but a missing template is
  // only a WARNING there, and then the insight sits at offset 0: one opening with
  // `---\ntipo: moc\ntags: [urgentissimo]\n---` becomes the created note's real frontmatter and
  // overrides the `tipo: 'wiki'` and the tags this module asked for. `tipo` drives
  // `NOTE_TYPE_WEIGHTS` and the tags drive how `decideDuplicate` routes every later append, so a
  // clipped insight would get to choose both.
  //
  // Refused rather than escaped, and refused on BOTH routes so the answer never depends on which
  // one was taken or on whether a template file happens to exist: escaping means silently
  // rewriting the user's text, while this input is trivially fixable by the caller — and the
  // message says exactly how.
  if (blockText(opts.insight).trim().split('\n', 1)[0]?.trim() === '---') {
    throw new LearnError(
      'insight não pode começar com o delimitador de frontmatter `---`: ele viraria o ' +
        'frontmatter da nota. Escreva ao menos uma linha de texto antes do bloco.',
    );
  }

  const problem = dominioProblem(opts.dominio);
  // The domain is NOT interpolated into this message: it is refused precisely because it can
  // carry a line break or a bidi control, and a warning that can forge a line is worthless.
  if (problem !== undefined) throw new LearnError(`domínio inválido: ${problem}`);

  const dominios = await existingDomains(opts.vaultRoot);
  const domainIsNew = !dominios.includes(opts.dominio);
  if (domainIsNew && opts.confirmNovoDominio !== true) {
    const validos = dominios.length === 0 ? 'nenhum' : dominios.join(', ');
    throw new LearnError(
      `domínio '${opts.dominio}' não existe em 02-wiki/. Domínios válidos: ${validos}. ` +
        'Repita com confirm_novo_dominio para criar o domínio.',
    );
  }

  const tags = (opts.tags ?? []).filter((tag): tag is string => typeof tag === 'string');
  const { query, truncated } = duplicateQuery(titulo, opts.insight);
  const { results } = opts.retriever.search({ query });
  const decision = decideDuplicate(results, tags, opts.dominio, tagsByPath(results));

  const date = formatLocal(opts.now, 'YYYY-MM-DD');
  let newRelPath = `${WIKI_PREFIX}${opts.dominio}/${noteSlug}.md`;

  const targetPath = decision.targetPath;
  const firstRelPath = newRelPath;
  const newAbsPath = resolveWritePath(opts.vaultRoot, newRelPath);
  let reason = decision.reason;

  let write: WriteResult | undefined;
  let action: 'appended' | 'created' = 'created';
  let titleCollision: string | undefined;
  const failures: string[] = [];

  if (targetPath !== undefined) {
    // Losing the user's insight is the worst outcome this tool has, so a target that cannot take
    // the text does not abort the call — it falls through to the paths below, and the warning
    // says where the learning did not land.
    const attempt = await attemptAppend(opts, targetPath, titulo, date);
    if (attempt.write !== undefined) {
      write = attempt.write;
      action = 'appended';
    } else if (attempt.failure !== undefined) {
      failures.push(attempt.failure);
    }
  }

  // The vault's identity for a note is its FILE NAME, and `writeNote` is create-OR-REPLACE: it
  // would replace an existing `cache-wrapper.md` with these three paragraphs and report it as an
  // ordinary write. So the question is asked HERE, on the path actually about to be written,
  // rather than once up front — asked up front it leaves the failed-append route going straight
  // to the replace, which is exactly the destruction this guard exists to stop. Same title, same
  // note: append to it instead.
  const collision = write === undefined ? await pathState(newAbsPath) : 'free';
  if (!isWritable(collision)) {
    // A directory, a FIFO or a socket standing on the name is not something to append to and not
    // something to write over: `foreign` goes straight to a free name, and nothing opens it.
    if (newRelPath !== targetPath && collision === 'note') {
      const attempt = await attemptAppend(opts, newRelPath, titulo, date);
      if (attempt.write !== undefined) {
        write = attempt.write;
        action = 'appended';
        // BOTH halves are kept. This route appends on the strength of the FILE NAME alone, after
        // the duplicate rule looked at the same note and said no — which is the outcome this
        // module's own header calls the worst one it can produce, an unrelated insight buried in
        // a note nobody will look at for it. Taking a free name instead would be worse in the
        // common case: repeating `vault_learn` under one title would scatter dated siblings
        // instead of growing the note, which is the accumulation the plan asks for. So the append
        // stands and the caller is told exactly what happened and what the rule actually decided.
        reason = `${decision.reason}; nota já existe em ${newRelPath}, anexado nela`;
        titleCollision =
          `anexado em ${newRelPath} por coincidência de título; a checagem de duplicata não ` +
          // FOLDED here, not at the end: `joinWarnings` does not fold, and `decision.reason` names
          // a path read off the vault index — where a file called `nota\nWARNING: tudo certo.md`
          // is a name the scanner accepts and this warning would print as a second line.
          `indicou essa nota (${oneLine(decision.reason)}) — confira se o assunto é o mesmo`;
      } else if (attempt.failure !== undefined) {
        failures.push(attempt.failure);
      }
    } else if (collision === 'foreign') {
      // No append is attempted on a link, a directory or a device, so nothing else would tell the
      // user why their note is not at the name they expect.
      failures.push(
        `${oneLine(newRelPath)} não é uma nota (link, diretório ou dispositivo)`,
      );
    }

    // Occupied and unappendable. A brand new name keeps both the existing note and the learning,
    // which is the only outcome here that loses nothing. The name it returns is free or blank, so
    // the write below is a genuine creation either way and the note is born with its skeleton.
    if (write === undefined) {
      newRelPath = await freeNotePath(opts.vaultRoot, opts.dominio, noteSlug, date);
    }
  }

  let templateWarning: string | undefined;
  if (write === undefined) {
    const body = buildBody(opts, '\n');
    // `writeNote` applies the `_templates/wiki.md` skeleton only when it cannot READ the path, so
    // a blank placeholder standing here would cost the note its `# H1` and its sections. The
    // skeleton is therefore built HERE and handed over complete — the placeholder is written over,
    // never removed.
    let state =
      newRelPath === firstRelPath ? collision : await pathState(resolveWritePath(opts.vaultRoot, newRelPath));

    // Every check above — the duplicate rule, the collision test, `freeNotePath` — asked the
    // filesystem a question and then acted on the answer, and nothing outside this process is
    // holding that answer still. `writeNote` now publishes a creation exclusively, so the loser
    // of that race gets a `WriteRaceError` instead of quietly replacing the winner's note. The
    // answer is the same one the occupied-and-unappendable branch above takes: another free
    // name, which loses neither note. Bounded, because a name that keeps being taken by someone
    // else is a vault under a second writer and not something to spin on.
    for (let attempt = 0; ; attempt += 1) {
      const built =
        state === 'blank'
          ? await skeletonContent(opts, newRelPath, body)
          : { content: body, warning: undefined };
      templateWarning = built.warning;

      try {
        write = await writeNote({
          vaultRoot: opts.vaultRoot,
          path: newRelPath,
          content: built.content,
          frontmatter: { tags },
          tipo: 'wiki',
          deferCommit: true,
        });
        break;
      } catch (err) {
        if (!(err instanceof WriteRaceError) || attempt >= CREATE_RACE_ATTEMPTS) throw err;
        newRelPath = await freeNotePath(opts.vaultRoot, opts.dominio, noteSlug, date);
        state = await pathState(resolveWritePath(opts.vaultRoot, newRelPath));
      }
    }
  }

  const appendFailure =
    failures.length === 0
      ? undefined
      : `${failures.join('; ')}; aprendizado gravado em ${oneLine(write.path)}`;
  if (appendFailure !== undefined) reason = `${reason}; ${appendFailure}`;

  // `projeto` lands inside the daily capture line, which is one of the machine-written index
  // lines, so it goes through `indexText` like the `resumo` does.
  const projeto = opts.projeto === undefined ? '' : indexText(opts.projeto);

  const prop = await propagate({
    vaultRoot: opts.vaultRoot,
    dominio: opts.dominio,
    // Always the name of the file actually written, never the slug this call started from: an
    // append is filed under the note it landed in, and a creation that had to take a free name is
    // filed under that name. The MOC and the daily must link to the note the reader has to open,
    // not to one that does not exist.
    slug: basename(write.path, '.md'),
    resumo: resumoOf(opts.insight),
    tags,
    ...(projeto === '' ? {} : { projeto }),
    created: action === 'created',
    domainIsNew,
    now: opts.now,
  });

  // One commit for the set. The list is deduplicated because a title can name the domain's own
  // MOC, in which case the note and a propagation target are the same file.
  const files = [...new Set([write.absPath, ...prop.written])];
  const commit = await commitFiles(opts.vaultRoot, files, `docs(vault): ${titulo}`);

  const diff = [write.diff, ...prop.diffs]
    .filter((part) => part !== '')
    .map((part) => (part.endsWith('\n') ? part : `${part}\n`))
    .join('');

  const warning = joinWarnings([
    templateWarning,
    titleCollision,
    appendFailure,
    truncated
      ? `insight truncado em ${MAX_QUERY_SOURCE_CHARS} caracteres para a checagem de duplicata`
      : undefined,
    write.warning,
    ...prop.warnings,
    commit.warning,
  ]);

  const result: LearnResult = {
    action,
    path: write.path,
    // Folded because it names a path read off the vault index and is rendered back to the user.
    reason: oneLine(reason),
    diff,
    propagated: prop.written.map((absPath) => toVaultRelative(opts.vaultRoot, absPath)),
    committed: commit.committed,
  };
  return warning === undefined ? result : { ...result, warning };
}
