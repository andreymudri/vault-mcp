import { promises as fs } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { tokenize } from '../index/tokenizer.js';
import { sliceAtCodePointBoundary } from '../retrieval/budget.js';
import type { Retriever } from '../retrieval/retrieval.js';
import type { ScoredChunk } from '../types.js';
import { commitFiles } from './git.js';
import { PathGuardError, resolveWritePath } from './paths.js';
import { propagate } from './propagate.js';
import { formatLocal } from './template.js';
import { EditError, editNote, writeNote, type WriteResult } from './writer.js';

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
 * Every C0 control, DEL, every C1 control, the two Unicode separators, and every bidi control
 * and zero-width format character — the same set `write/writer.ts` and `write/propagate.ts`
 * refuse, and it must not drift from them.
 *
 * Here it folds the free text that gets spliced into a single line (the section heading, the
 * commit subject, a link name) and refuses a `dominio` outright. A `titulo` carrying a newline
 * turns one commit subject into a forged multi-line message; one carrying U+202E reads in the
 * user's client as a name that is not the file on disk.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
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
  // of them at rank 1. It becomes reachable the moment `GRAPH_DAMPING` rises above 1, and what it
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

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * True for the three failures that mean "this target cannot take the text", as opposed to a real
 * fault: the write guard refusing the path, the edit finding nothing to anchor to (an empty stub
 * note), and the file having vanished between the index read and now.
 */
function isRecoverableAppendFailure(err: unknown): boolean {
  if (err instanceof EditError || err instanceof PathGuardError) return true;
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
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
 */
function linkName(raw: string): string {
  return indexText(raw)
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
  const newRelPath = `02-wiki/${opts.dominio}/${noteSlug}.md`;

  let targetPath = decision.targetPath;
  let reason = decision.reason;
  // The rule said "not a duplicate", but the vault's identity for a note is its FILE NAME:
  // `writeNote` would replace an existing `cache-wrapper.md` with these three paragraphs and
  // report it as an ordinary write. Same title, same note — append instead.
  if (targetPath === undefined && (await fileExists(resolveWritePath(opts.vaultRoot, newRelPath)))) {
    targetPath = newRelPath;
    reason = `nota já existe em ${newRelPath}`;
  }

  let write: WriteResult | undefined;
  let action: 'appended' | 'created' = 'created';
  let appendFailure: string | undefined;

  if (targetPath !== undefined) {
    try {
      write = await appendSection(opts, targetPath, titulo, date);
      action = 'appended';
    } catch (err) {
      // Losing the user's insight is the worst outcome this tool has, so a target that cannot
      // take the text becomes a NEW NOTE rather than an exception: the learning is written either
      // way and the warning says where it did not land. Anything that is not one of the three
      // recoverable failures is a real fault and must surface.
      if (!isRecoverableAppendFailure(err)) throw err;
      const detail = oneLine(err instanceof Error ? err.message : String(err));
      appendFailure = `não foi possível anexar em ${oneLine(targetPath)} (${detail}); nota nova criada`;
      reason = `${reason}; ${appendFailure}`;
    }
  }

  if (write === undefined) {
    write = await writeNote({
      vaultRoot: opts.vaultRoot,
      path: newRelPath,
      content: buildBody(opts, '\n'),
      frontmatter: { tags },
      tipo: 'wiki',
      deferCommit: true,
    });
  }

  // `projeto` lands inside the daily capture line, which is one of the machine-written index
  // lines, so it goes through `indexText` like the `resumo` does.
  const projeto = opts.projeto === undefined ? '' : indexText(opts.projeto);

  const prop = await propagate({
    vaultRoot: opts.vaultRoot,
    dominio: opts.dominio,
    // An append is filed under the note it landed in, so the daily and the MOC link to the note
    // the reader has to open, not to a note that was never created.
    slug: action === 'appended' ? basename(write.path, '.md') : noteSlug,
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
