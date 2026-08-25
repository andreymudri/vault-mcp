import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import matter from 'gray-matter';

import type { Frontmatter } from '../types.js';
import { resolveWritePath, assertNoSymlinkEscape, PathGuardError } from './paths.js';
import { applyTemplate, ensureFrontmatter, formatLocal } from './template.js';
import { commitFiles } from './git.js';
import { atomicWrite } from './atomic.js';
import { unifiedDiff } from './diff.js';

/** Thrown when `editNote` cannot locate exactly one occurrence of the text to replace. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

export interface WriteResult {
  path: string;
  absPath: string;
  created: boolean;
  committed: boolean;
  warning?: string;
  diff: string;
}

export interface WriteNoteOptions {
  vaultRoot: string;
  /** Vault-relative path, `.md`, validated by `resolveWritePath`. */
  path: string;
  content: string;
  frontmatter?: Frontmatter;
  tipo?: string;
  /** Write but do not commit, so a caller can batch several writes into one commit. */
  deferCommit?: boolean;
}

export interface EditNoteOptions {
  vaultRoot: string;
  path: string;
  oldText: string;
  newText: string;
  deferCommit?: boolean;
}

/** The `tipo` values that have a skeleton in `_templates/`. */
const TEMPLATED_TIPOS = new Set(['wiki', 'projeto']);

/** The frontmatter keys every note this module writes is guaranteed to carry. */
const DEFAULT_TIPO = 'nota';

/**
 * Directory names that are MACHINE STATE, not vault content, matched as a whole path
 * segment at any depth.
 *
 * `resolveWritePath`'s `DENIED_PREFIXES` is about READ-ONLY AREAS of the vault
 * (`99-archive/`, `_templates/`) and only looks at the first segment. That is a different
 * question from this one, and it left `.git/` wide open: `writeNote({path:
 * '.git/refs/heads/pwn.md'})` created the file and reported success, after which `git gc`,
 * `git log --all` and `git fsck` all failed on the user's real vault with `badRefContent`.
 * A malformed loose ref is not a note the user can delete and move on from — it breaks
 * every subsequent git operation, including the commits this module makes itself.
 *
 * The set is the ignore list T6's scanner uses. That is deliberate: a path the indexer
 * will never read is a path this module has no business writing, and the two disagreeing
 * is how a note becomes permanently invisible. Nothing enforces the agreement — the
 * scanner is not on this branch — so the two lists have to be changed together by hand.
 *
 * NOTE: this duplicates a boundary `paths.ts` should own. `resolveWritePath` is the one
 * place that already knows the vault's layout, and this check belongs beside
 * `DENIED_PREFIXES` — but `paths.ts` is outside this task's file set, so the guard lives
 * at the only other point every write passes through. Move it when the two are touched
 * together.
 */
const DENIED_SEGMENTS = new Set(['.git', '.obsidian', 'node_modules', '_templates']);

/**
 * Control characters, which cannot appear in a path this module will accept.
 *
 * A newline in a filename is not merely odd, it FORGES REPORTS. `unifiedDiff` labels its
 * output `--- a/${path}`, and a path carrying `\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-real\n+forjado`
 * produced a diff containing a complete, fabricated hunk attributing an edit to a file that
 * was never opened. The same string reaches `commitFiles` as a commit message subject.
 * A user reading either has no way to tell the forged lines from the real ones.
 *
 * `unifiedDiff` escapes its own header too — this is the outer lock, refusing the input
 * rather than rendering it, because a path no legitimate note ever has is better rejected
 * than sanitised into something the user did not ask for. The two are NOT redundant and
 * neither may be dropped: this one rejects, that one escapes, and each has to hold on its
 * own — `unifiedDiff` is exported to callers that never pass through here, and a path can
 * reach a commit message without ever reaching a diff. NUL matters separately again: it
 * makes `fs` throw a bare `TypeError` from deep inside the write instead of a
 * `PathGuardError` the tool layer knows how to report.
 *
 * The set is every C0 control, DEL, every C1 control, the two Unicode separators, and
 * every bidi control and zero-width format character. It is not just `\u0000-\u001f` for
 * two separate reasons, and the second was missed when only the first was fixed. Line
 * breaks: `split('\n')` sees one
 * line in a path carrying U+2028, U+2029 or U+0085 — but CSS Text 3 makes all three FORCED
 * LINE BREAKS in any HTML-rendering client, so `02-wiki/a\u2028+++ b/CLAUDE.md\u2028@@ -1
 * +1 @@\u2028-real\u2028+forjado.md` shipped raw and rendered as a complete fabricated
 * hunk in the user's client. `git log --format=%B` showed the injected lines too: the same
 * string is the commit message subject.
 *
 * And characters that are INVISIBLE or REORDER what is around them. These break no line,
 * which is exactly why widening the set to the forced-break characters left every one of
 * them through: `02-wiki/nota\u202edm.hsab\u202c.md` is one line by every reader's
 * definition, and in any bidi-aware renderer — a chat client, a terminal, Obsidian's file
 * list, `git log` — it reads as `nota basit.md` while the write lands somewhere else
 * entirely. The same string reaches `WriteResult.diff`, `WriteResult.path` and the commit
 * subject, so all three showed the user a filename that was not the file on disk. It
 * cannot forge a hunk, which is why this is not the line-break hole over again; but a name
 * the user cannot read is a name the user cannot check, and this docblock asserting the
 * set was complete while U+202E walked through it is what made it worth closing rather
 * than documenting.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * A path segment as the FILESYSTEM will compare it, not as the string was typed.
 *
 * `.git` is one directory under three different spellings, and the guard has to see all
 * of them. On macOS's HFS+/APFS and on every Windows volume the comparison is
 * case-insensitive, so `.GIT/` and `.Git/` open the real `.git`. Windows additionally
 * STRIPS trailing dots and spaces from a component before it reaches the filesystem, so
 * `.git./` and `.git /` open it too — all four were confirmed creatable, and each one of
 * them arrives here as a string that `Set.has('.git')` answers `false` for.
 *
 * Normalising on every platform rather than only where it matters is deliberate: a vault
 * is a directory a user syncs between machines, so a note this Linux process considers
 * legal is a note that will be checked out on the macOS laptop too. The cost of the extra
 * strictness is a directory literally named `.Git` that holds notes, which no vault has.
 */
function normalizeSegment(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

/**
 * The segments of `absPath` as they exist AFTER every symlink on the way has been
 * followed, relative to the vault's own real root.
 *
 * The lexical path is not the path that gets written. An in-vault symlink
 * `02-wiki/compartilhado → ../.git/refs/heads` is not an escape — it stays inside the
 * vault, so `assertNoSymlinkEscape` passes it — and `02-wiki/compartilhado/pwn.md` carries
 * no `.git` segment for a string check to find, yet the write lands in
 * `<vault>/.git/refs/heads/pwn.md` and breaks every subsequent git operation exactly as
 * the plain `.git/refs/heads/pwn.md` did. Reproduced on Linux; the same hole exists for
 * any denied directory reachable through a link a user or a sync client created.
 *
 * `assertNoSymlinkEscape` already realpaths the deepest existing ancestor, and this walks
 * the same ground for a different question — is the RESOLVED path in a denied directory,
 * rather than is it outside the vault. The duplication is not free and is not wanted; it
 * is here because the answer belongs beside `DENIED_PREFIXES` in `paths.ts`, which this
 * task may not touch. Move both there together.
 */
async function pathSegments(vaultRoot: string, absPath: string): Promise<string[]> {
  const lexicalRoot = resolve(vaultRoot);
  // The lexical segments are checked as well as the resolved ones, and a denied segment in
  // EITHER refuses the write. A link is capable of pointing both ways: `.git` could itself
  // be a symlink to an innocent directory, and honouring that would let `.git/x.md` — a
  // path the user plainly meant as the repository — through on the strength of a link the
  // repository never had.
  const segments = relative(lexicalRoot, absPath).split(sep);

  let realRoot: string;
  try {
    realRoot = await fs.realpath(lexicalRoot);
  } catch {
    // A vault root that cannot be resolved is `assertNoSymlinkEscape`'s error to raise,
    // with its own message. Here it just means there is nothing more to add.
    return segments;
  }

  // Walk up to the deepest ancestor that exists — a new note's own directories may not
  // exist yet — realpath it, and put the not-yet-existing tail back on the end.
  let head = absPath;
  const tail: string[] = [];
  for (;;) {
    try {
      head = await fs.realpath(head);
      break;
    } catch {
      const parent = dirname(head);
      if (parent === head) return segments;
      tail.unshift(basename(head));
      head = parent;
    }
  }

  const resolved = tail.length === 0 ? head : join(head, ...tail);
  return [...segments, ...relative(realRoot, resolved).split(sep)];
}

/**
 * Both halves of the path guard, in the order they have to run.
 *
 * `resolveWritePath` is purely SYNTACTIC — it rejects `..`, absolute paths, non-`.md`,
 * glob metacharacters and the read-only prefixes by reading the string. It cannot see a
 * symlink, and `02-wiki/atalho/nota.md` is a perfectly well-formed vault-relative path
 * even when `02-wiki/atalho` is a link to `/etc`. `assertNoSymlinkEscape` is the other
 * half, and calling only the first one is the mistake this helper exists to make
 * impossible for the two callers below.
 */
async function guardedPath(vaultRoot: string, relPath: string): Promise<string> {
  // First, before any `fs` call and before `resolveWritePath` interpolates the string into
  // a message: a NUL makes `fs` throw its own `TypeError` from inside the write.
  if (CONTROL_CHARS.test(relPath)) {
    throw new PathGuardError(
      `caminho não pode conter caractere de controle: ${JSON.stringify(relPath)}`
    );
  }

  const absPath = resolveWritePath(vaultRoot, relPath);

  // Segment-wise, on the RESOLVED path as well as the lexical one, so `02-wiki/./.git/x.md`
  // and a link that lands in `.git` are both caught. Matching whole segments and not string
  // prefixes is what keeps an ordinary note at `02-wiki/git/rebase-interativo.md` legal,
  // exactly as `99-archive-notes/` stays legal beside the denied `99-archive/`.
  for (const segment of await pathSegments(vaultRoot, absPath)) {
    if (DENIED_SEGMENTS.has(normalizeSegment(segment))) {
      throw new PathGuardError(`escrita negada em ${segment}/ (área interna, não é conteúdo)`);
    }
  }

  await assertNoSymlinkEscape(vaultRoot, absPath);
  return absPath;
}

/**
 * A human title for the note, derived from its filename.
 *
 * `writeNote`'s signature carries no title: the vault's own convention is that the file
 * name IS the title in slug form (`cache-wrapper.md` is "Cache Wrapper"), and that is
 * what `[[cache-wrapper]]` links resolve against. Deriving it keeps the `# <title>`
 * heading a template writes and the filename a caller chose from ever disagreeing.
 */
function titleFromPath(relPath: string): string {
  const slug = basename(relPath, '.md');
  return slug
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Inserts the caller's body into a rendered template skeleton, ABOVE its first section
 * heading.
 *
 * Above, not appended, because appending puts the note's actual prose under whatever
 * section happens to come last — `## Links` for a project, which is plainly wrong. The
 * vault's own notes are shaped `# Titulo` / prose / `## Contexto`, so the lead paragraph
 * position is where a reader expects it and where the sections the template declares
 * stay empty and ready to be filled in.
 *
 * The search starts after the frontmatter block, so a `## ` that somehow appears inside
 * a quoted YAML value cannot be mistaken for the first section.
 */
function spliceBody(skeleton: string, content: string): string {
  const body = content.trim();
  if (body === '') return skeleton;

  const lines = skeleton.split('\n');
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

  if (at === -1) return `${skeleton.replace(/\n+$/, '')}\n\n${body}\n`;
  const head = lines.slice(0, at).join('\n').replace(/\n+$/, '');
  const tail = lines.slice(at).join('\n');
  return `${head}\n\n${body}\n\n${tail}`;
}

/** True when a parsed frontmatter value counts as "not filled in". Mirrors `ensureFrontmatter`. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * The required keys `ensureFrontmatter` did NOT manage to fill.
 *
 * `ensureFrontmatter` is allowed to REFUSE: when it meets a YAML construct it cannot
 * edit safely — an explicit key spanning two lines, a block whose modification js-yaml
 * would reject — it returns the content UNCHANGED rather than corrupting the block. That
 * is the right call there (an unfilled key is recoverable; a destroyed block is not), but
 * it is invisible in the return value: refusal and success are the same `string`.
 *
 * As the first caller, `writeNote` has to decide what that silence means, and writing a
 * note whose `tipo`/`tags`/`criado` were quietly dropped is not an outcome a user would
 * ever discover on their own — the note looks fine, and T3's scanner simply never
 * indexes it by type. So the output is re-read through the SAME parser that will read
 * the file back, and any required key still empty becomes a `warning` naming it. The
 * write still happens: the body is the user's content and losing it to a metadata
 * problem would be the larger wrong answer.
 *
 * A required value that is itself empty (`tags: []` on a note with no tags) is not a
 * refusal and is not reported.
 */
function unfilledKeys(content: string, required: Frontmatter): string[] {
  let data: Record<string, unknown>;
  try {
    // The `{}` is load-bearing: with no options `gray-matter` memoises every string it
    // parses in an unbounded process-global cache. The rest of this codebase refuses
    // that cache for the same reason.
    data = matter(content, {}).data as Record<string, unknown>;
  } catch {
    // The block does not parse at all, so nothing was filled and everything asked for
    // is missing.
    return Object.entries(required)
      .filter(([, value]) => !isEmptyValue(value))
      .map(([key]) => key);
  }

  return Object.entries(required)
    .filter(([key, value]) => !isEmptyValue(value) && isEmptyValue(data[key]))
    .map(([key]) => key);
}

/** Joins the warnings a single write can produce, keeping every one of them visible. */
function joinWarnings(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== '');
  return kept.length === 0 ? undefined : kept.join('; ');
}

/** Lines in `text`, counting a trailing newline as a terminator, without allocating. */
function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return text.charCodeAt(text.length - 1) === 10 ? lines : lines + 1;
}

/**
 * The diff, and the warning to carry when it could not be produced.
 *
 * `unifiedDiff` bounds itself and returns its own coarse summary for an input too large to
 * diff line by line, so in normal operation this never catches anything. It exists for the
 * case where that self-defence is not enough — a `RangeError` from a typed-array
 * allocation the process could not satisfy, say — and the question that case forces is
 * which of two wrongs to commit.
 *
 * Losing the user's content to a REPORTING failure is the larger wrong: the note is what
 * they asked for, the diff is how it gets narrated. So the throw is swallowed here, the
 * report degrades to a summary that says plainly it is one, and the failure travels back
 * as a `warning`. The caller learns the note was written and that the diff is not
 * trustworthy — which is the truth, and is strictly more than a rejection would tell them
 * about a file that is already on disk.
 *
 * The summary is built HERE rather than borrowed from `diff.js`: this is the path taken
 * when that module has just failed, and reaching back into it for the recovery would make
 * the recovery depend on the thing that broke.
 */
function safeDiff(
  before: string,
  after: string,
  relPath: string
): { diff: string; warning?: string } {
  try {
    return { diff: unifiedDiff(before, after, relPath) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // `relPath` is already through `guardedPath`, so it carries no control character and
    // cannot add a line to this header.
    const diff = [
      before === '' ? '--- /dev/null' : `--- a/${relPath}`,
      after === '' ? '+++ /dev/null' : `+++ b/${relPath}`,
      '@@ diff indisponível @@',
      ` falha ao gerar o diff (${reason}); ${countLines(before)} linhas antes, ` +
        `${countLines(after)} linhas depois`,
      '',
    ].join('\n');
    return { diff, warning: `diff não pôde ser gerado (${reason})` };
  }
}

/**
 * Writes `text` to a path already guarded, then commits it unless the caller is batching.
 *
 * The diff is computed BEFORE the write, and that order is the whole point of this
 * function. It is a pure function of the two strings already in memory — nothing about it
 * needs the file on disk — so computing it first makes "written but unreported" a state
 * this code cannot reach, rather than one it merely avoids as long as `unifiedDiff`'s size
 * bounds are set correctly. Written the other way round, a diff that threw left the
 * replacement published and the call rejecting, and the user was never shown what changed.
 * `safeDiff` closes the other half: a diff failure must not swallow the content either.
 *
 * The commit is deliberately the LAST thing and deliberately cannot undo the write.
 * `commitFiles` never throws; a git failure comes back as a warning and the note stays on
 * disk. Losing a user's note because their vault is not a git repository, or because a
 * pre-commit hook rejected it, would be an absurd trade.
 */
async function writeAndCommit(
  opts: {
    vaultRoot: string;
    relPath: string;
    absPath: string;
    before: string;
    after: string;
    created: boolean;
    deferCommit?: boolean;
    message: string;
  },
  extraWarning?: string
): Promise<WriteResult> {
  const { diff, warning: diffWarning } = safeDiff(opts.before, opts.after, opts.relPath);
  await atomicWrite(opts.absPath, opts.after);

  const base = {
    path: opts.relPath,
    absPath: opts.absPath,
    created: opts.created,
    diff,
  };

  if (opts.deferCommit === true) {
    const warning = joinWarnings([extraWarning, diffWarning]);
    return warning === undefined
      ? { ...base, committed: false }
      : { ...base, committed: false, warning };
  }

  const commit = await commitFiles(opts.vaultRoot, [opts.absPath], opts.message);
  const warning = joinWarnings([extraWarning, diffWarning, commit.warning]);
  return warning === undefined
    ? { ...base, committed: commit.committed }
    : { ...base, committed: commit.committed, warning };
}

/**
 * Creates or replaces a note.
 *
 * Flow: resolve and guard the path → apply the `_templates/` skeleton when the note is
 * new and its `tipo` has one → guarantee the frontmatter → write atomically → commit,
 * unless `deferCommit` says the caller will.
 *
 * `deferCommit` exists for `vault_learn`, which touches up to four files and needs ONE
 * commit covering the set rather than four partial ones. `absPath` comes back so the
 * caller can assemble that list and hand it to `commitFiles` itself.
 */
export async function writeNote(opts: WriteNoteOptions): Promise<WriteResult> {
  const absPath = await guardedPath(opts.vaultRoot, opts.path);

  let before = '';
  let created = true;
  try {
    before = await fs.readFile(absPath, 'utf8');
    created = false;
  } catch {
    created = true;
  }

  const now = new Date();
  let text = opts.content;
  let templateWarning: string | undefined;

  if (created && opts.tipo !== undefined && TEMPLATED_TIPOS.has(opts.tipo)) {
    // `opts.tipo` is compared against a closed set before it reaches the path, so no
    // caller-controlled segment ever enters this join.
    const templatePath = join(opts.vaultRoot, '_templates', `${opts.tipo}.md`);
    let templateText: string | undefined;
    try {
      templateText = await fs.readFile(templatePath, 'utf8');
    } catch {
      templateWarning = `template não encontrado: _templates/${opts.tipo}.md`;
    }
    if (templateText !== undefined) {
      // `applyTemplate` runs over the SKELETON, and the caller's content is spliced in
      // afterwards. The order is not incidental: the token scanner exists to catch an
      // unresolved Templater token in a template the user wrote, and running it over
      // model-supplied prose instead makes a note that legitimately discusses `<% %>`
      // syntax permanently unwritable — while adding nothing, since content is not a
      // template and its `<%` is just text.
      const skeleton = applyTemplate(templateText, { title: titleFromPath(opts.path), now });
      text = spliceBody(skeleton, opts.content);
    }
  }

  const required: Frontmatter = {
    tipo: DEFAULT_TIPO,
    tags: [],
    criado: formatLocal(now, 'YYYY-MM-DD'),
    ...(opts.frontmatter ?? {}),
  };
  if (opts.tipo !== undefined) required.tipo = opts.tipo;

  const after = ensureFrontmatter(text, required);

  const missing = unfilledKeys(after, required);
  const frontmatterWarning =
    missing.length === 0
      ? undefined
      : `frontmatter não preenchido (bloco YAML não editável com segurança): ${missing.join(', ')}`;

  return writeAndCommit(
    {
      vaultRoot: opts.vaultRoot,
      relPath: opts.path,
      absPath,
      before,
      after,
      created,
      ...(opts.deferCommit === undefined ? {} : { deferCommit: opts.deferCommit }),
      message: `docs(vault): ${titleFromPath(opts.path)}`,
    },
    joinWarnings([templateWarning, frontmatterWarning])
  );
}

/**
 * Occurrences of `needle` in `haystack`, INCLUDING overlapping ones.
 *
 * Advancing by `needle.length` — the obvious way to count — asks "how many copies fit
 * side by side", which is a different question from the one `editNote` needs answered.
 * `aa` sits in `aaa` at offset 0 and at offset 1: two distinct places the edit could land,
 * and no way to know which the caller meant. Counting non-overlapping matches reported ONE
 * and silently replaced the first — precisely the "edited a line the caller never looked
 * at" outcome the exactly-one-occurrence rule exists to prevent. Advancing by 1 counts
 * every starting position, so ambiguity is refused wherever it actually exists.
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * Replaces one exact substring of an existing note.
 *
 * Exact-substring, and exactly ONE occurrence: zero is an error naming the file, two or
 * more is an error naming the count. Neither guesses. An edit that silently matched
 * nothing would report success on a note it never touched, and one that replaced the
 * first of several matches would edit a line the caller never looked at — in a vault the
 * user reads by hand, both are worse than being told to be more specific.
 *
 * No write happens in either error case. The occurrence count is taken before anything
 * is opened for writing, so a rejected edit leaves the file byte-identical and its mtime
 * untouched — which matters because Obsidian and T6's scanner both watch mtime.
 */
export async function editNote(opts: EditNoteOptions): Promise<WriteResult> {
  const absPath = await guardedPath(opts.vaultRoot, opts.path);

  if (opts.oldText === '') {
    // The empty string occurs between every pair of characters, so "exactly one
    // occurrence" is never true of it and counting it would not terminate.
    throw new EditError(`trecho vazio para edição em ${opts.path}`);
  }

  const before = await fs.readFile(absPath, 'utf8');
  const occurrences = countOccurrences(before, opts.oldText);

  if (occurrences === 0) throw new EditError(`trecho não encontrado em ${opts.path}`);
  if (occurrences > 1) {
    throw new EditError(`trecho ambíguo em ${opts.path}: ${occurrences} ocorrências`);
  }

  const at = before.indexOf(opts.oldText);
  const after = before.slice(0, at) + opts.newText + before.slice(at + opts.oldText.length);

  return writeAndCommit({
    vaultRoot: opts.vaultRoot,
    relPath: opts.path,
    absPath,
    before,
    after,
    created: false,
    ...(opts.deferCommit === undefined ? {} : { deferCommit: opts.deferCommit }),
    message: `docs(vault): atualizar ${titleFromPath(opts.path)}`,
  });
}
