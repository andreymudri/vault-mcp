import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promises as fs, type Stats } from 'node:fs';
import { coded } from '../i18n/errors.js';

export const DENIED_PREFIXES = ['99-archive', '_templates'] as const;

/**
 * Directory names that are MACHINE STATE, not vault content, matched as a whole path
 * segment at any depth.
 *
 * `DENIED_PREFIXES` above is about READ-ONLY AREAS of the vault (`99-archive/`,
 * `_templates/`) and only looks at the first segment. That is a different question from
 * this one, and it left `.git/` wide open: `writeNote({path: '.git/refs/heads/pwn.md'})`
 * created the file and reported success, after which `git gc`, `git log --all` and
 * `git fsck` all failed on the user's real vault with `badRefContent`. A malformed loose
 * ref is not a note the user can delete and move on from — it breaks every subsequent git
 * operation, including the commits this server makes itself.
 *
 * The set is the ignore list T6's scanner uses. That is deliberate: a path the indexer
 * will never read is a path this server has no business writing, and the two disagreeing
 * is how a note becomes permanently invisible. Nothing enforces the agreement — the
 * scanner keeps its own list — so the two have to be changed together by hand.
 *
 * It lives HERE, beside `DENIED_PREFIXES`, and every writer reaches it through
 * `guardedPath`. It used to live TWICE, once in `writer.ts` and once in `propagate.ts`,
 * because neither task that added it was allowed to touch this file. The two copies were
 * equivalent and the whole risk was that one day they would not be: one lenient writer is
 * enough to put a file in `.git/refs/heads/` and break the repository for every other one.
 */
export const DENIED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  '_templates',
]);

/**
 * Every C0 control, DEL, every C1 control, the two Unicode separators, and every bidi
 * control and zero-width format character — under ONE name, for the two modules that
 * refuse it and the one that folds it.
 *
 * A newline in a filename is not merely odd, it FORGES REPORTS. `unifiedDiff` labels its
 * output `--- a/<path>`, and a path carrying a newline followed by `+++ b/CLAUDE.md`, a
 * hunk header and a pair of `-`/`+` lines produced a diff containing a complete,
 * fabricated hunk attributing an edit to a file that was never opened. The same string
 * reaches `commitFiles` as a commit message subject. A user reading either has no way to
 * tell the forged lines from the real ones.
 *
 * `write/diff.ts`'s `headerPath` escapes this same set — this is the outer lock, refusing
 * the input rather than rendering it, because a path no legitimate note ever has is better
 * rejected than sanitised into something the user did not ask for. The two are NOT
 * redundant and neither may be dropped: this one rejects, that one escapes, and each has
 * to hold on its own — `unifiedDiff` is exported to callers that never pass through here,
 * and a path can reach a commit message without ever reaching a diff. NUL matters
 * separately again: it makes `fs` throw a bare `TypeError` from deep inside the write
 * instead of a `PathGuardError` the tool layer knows how to report.
 *
 * It is not just the C0 range for two separate reasons, and the second was missed when
 * only the first was fixed. Line breaks: a path carrying U+2028, U+2029 or U+0085 is ONE
 * line to `split()` — but CSS Text 3 makes all three FORCED LINE BREAKS in any
 * HTML-rendering client, so such a path shipped raw and rendered as a complete fabricated
 * hunk in the user's client. `git log --format=%B` showed the injected lines too: the same
 * string is the commit message subject.
 *
 * And characters that are INVISIBLE or REORDER what is around them. These break no line,
 * which is exactly why widening the set to the forced-break characters left every one of
 * them through: a name wrapped in U+202E and U+202C is one line by every reader's
 * definition, and in any bidi-aware renderer — a chat client, a terminal, Obsidian's file
 * list, `git log` — it reads back to front while the write lands somewhere else entirely.
 * The same string reaches `WriteResult.diff`, `WriteResult.path` and the commit subject,
 * so all three showed the user a filename that was not the file on disk.
 *
 * `propagate.ts` uses the very same set for a second job — folding the free prose it
 * splices into a single markdown line — which is why this is exported rather than private.
 *
 * NAMES, for anyone arriving from a docblock that still points at the old ones: this set was
 * `CONTROL_CHARS` in `writer.ts` and `INVISIBLE_CHARS` in `propagate.ts` and in `learn.ts`
 * before it moved here, and `write/diff.ts`'s docblock names the first of those. Nothing was
 * dropped in the move — the literal is byte-identical to all three — and `diff.ts` still
 * escapes exactly this set on the rendering side. There is one copy now and this is it.
 */
// eslint-disable-next-line no-control-regex
export const INVISIBLE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * A path segment as the FILESYSTEM will compare it, not as the string was typed.
 *
 * `.git` is one directory under several spellings, and the guard has to see all of them.
 * On macOS's HFS+/APFS and on every Windows volume the comparison is case-insensitive, so
 * `.GIT/` and `.Git/` open the real `.git`. Windows additionally STRIPS trailing dots and
 * spaces from a component before it reaches the filesystem, so `.git./` and `.git /` open
 * it too — all four were confirmed creatable, and each one of them arrives here as a
 * string that `Set.has('.git')` answers `false` for.
 *
 * Normalising on every platform rather than only where it matters is deliberate: a vault is
 * a directory a user syncs between machines, so a note this Linux process considers legal
 * is a note that will be checked out on the macOS laptop too. The cost of the extra
 * strictness is a directory literally named `.Git` that holds notes, which no vault has.
 */
export function normalizeSegment(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

/**
 * Renders a caller-influenced string inside a message WITHOUT letting it forge a line.
 *
 * Naming the refused input is the whole value of a guard message, and the refusal is
 * concatenated into the tool response the user reads. A `dominio` of `../.. tudo propagado
 * com sucesso` produced a message whose second rendered line read as a success report
 * attached to a write that was actually REFUSED. Refusing the input is not enough on its
 * own, because the input has to be NAMED in the refusal for the message to be worth
 * anything.
 */
export function forMessage(text: string): string {
  return text.replace(new RegExp(INVISIBLE_CHARS.source, 'g'), (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

export class PathGuardError extends Error {}

/**
 * The one exemption a caller may ask for, and the only one there will ever be here.
 *
 * `allowArchive` makes `99-archive/` legal as a source and as a destination, for
 * `vault_move` and for nothing else. Archiving and unarchiving are the same move in
 * opposite directions, so one flag buys both; without it `99-archive/` is a directory a
 * note enters by hand and never leaves through this server.
 *
 * It exempts `99-archive` BY NAME, never "the first list". `_templates` is in
 * `DENIED_PREFIXES` and in `DENIED_SEGMENTS` at once, and a flag that lifted the whole
 * prefix list would open the first of those while looking like it only touched the
 * archive. `DENIED_SEGMENTS` — the MACHINE areas, `.git/` above all — is not reachable
 * from here under any flag, which is what keeps the escape phase 4 closed shut.
 *
 * Writing content into `99-archive/` stays refused everywhere else: `vault_write_note`,
 * `vault_edit_note`, `vault_learn` and `propagate` all call without the flag, so nothing
 * can CREATE or EDIT a note in there — only move one in or out. `vault_delete` does not
 * get the flag either, and that is what makes the directory mean what it says: nothing is
 * destroyed in there, it only enters and leaves.
 */
export interface PathGuardOptions {
  allowArchive?: boolean;
}

/** The read-only prefixes still in force under `options`. */
function deniedPrefixes(options: PathGuardOptions): readonly string[] {
  const all = DENIED_PREFIXES as readonly string[];
  return options.allowArchive === true ? all.filter((prefix) => prefix !== '99-archive') : all;
}

/**
 * Resolves a vault-relative path to an absolute one, refusing anything that escapes
 * the vault or lands in a read-only area. Returns the absolute path.
 */
export function resolveWritePath(
  vaultRoot: string,
  relPath: string,
  options: PathGuardOptions = {},
): string {
  if (!relPath.endsWith('.md')) {
    throw coded(new PathGuardError(`caminho deve terminar em .md: ${relPath}`), 'path.mustEndMd', { relPath });
  }
  // The contract is "vault-relative path in": an absolute relPath must be rejected even when
  // it happens to resolve inside the vault, because `resolve(root, absPath)` ignores `root`
  // for an absolute `absPath` and the containment check below would otherwise let it through.
  if (isAbsolute(relPath)) {
    throw coded(new PathGuardError(`caminho deve ser relativo ao vault: ${relPath}`), 'path.mustBeRelative', { relPath });
  }
  // git interpreta pathspec como glob. `*.md` passa em qualquer checagem de contenção e de
  // sufixo, mas chega ao `git add` como curinga e arrasta arquivos que a tool nunca tocou.
  if (/[*?[\]]/.test(relPath)) {
    throw coded(new PathGuardError(`caminho não pode conter metacaractere de glob: ${relPath}`), 'path.noGlob', { relPath });
  }
  const root = resolve(vaultRoot);
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== abs) {
    throw coded(new PathGuardError(`caminho fora do vault: ${relPath}`), 'path.outsideVault', { relPath });
  }
  const head = rel.split(sep)[0];
  if (head !== undefined && deniedPrefixes(options).includes(head)) {
    throw coded(new PathGuardError(`escrita negada em ${head}/ (somente leitura)`), 'path.readOnlyArea', { head });
  }
  return abs;
}

/**
 * Verifies that the given absolute path (if created) would not escape the vault through
 * symlinks. Walks up from abs to the nearest existing directory, calls fs.promises.realpath
 * on it, and confirms the real path is still inside realpath(vaultRoot).
 */
export async function assertNoSymlinkEscape(vaultRoot: string, abs: string): Promise<void> {
  const root = resolve(vaultRoot);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch (err) {
    throw coded(new PathGuardError(`raiz do vault inexistente ou inacessível: ${root} (${(err as Error).message})`), 'path.rootMissing', { root, detail: (err as Error).message });
  }

  // Walk up from abs to find the nearest existing directory
  let checkPath = abs;
  let realPath: string | null = null;

  while (checkPath !== resolve(checkPath, '..')) {
    try {
      realPath = await fs.realpath(checkPath);
      break;
    } catch {
      // Directory doesn't exist, try parent
      checkPath = resolve(checkPath, '..');
    }
  }

  if (realPath === null) {
    // Couldn't realpath anything, shouldn't happen but treat as safe
    return;
  }

  // Confirm the real path is inside the vault
  const rel = relative(realRoot, realPath);
  if (rel.startsWith('..')) {
    throw coded(new PathGuardError(`symlink apontaria para fora do vault: ${abs}`), 'path.symlinkEscapes', { abs });
  }
}

/**
 * The segments of `absPath` LEXICALLY and as they exist AFTER every symlink on the way has
 * been followed, relative to the vault's own real root.
 *
 * Both, and a denied segment in EITHER refuses the write. The lexical path is not the path
 * that gets written: an in-vault symlink `02-wiki/compartilhado -> ../.git/refs/heads` is
 * not an escape — it stays inside the vault, so `assertNoSymlinkEscape` passes it — and
 * `02-wiki/compartilhado/pwn.md` carries no `.git` segment for a string check to find, yet
 * the write lands in `<vault>/.git/refs/heads/pwn.md` and breaks every subsequent git
 * operation exactly as the plain `.git/refs/heads/pwn.md` did. And the resolved path is not
 * the path the caller MEANT: `.git` could itself be a symlink to an innocent directory, and
 * honouring that would let `.git/x.md` — a path the user plainly meant as the repository —
 * through on the strength of a link the repository never had.
 *
 * `assertNoSymlinkEscape` already realpaths the deepest existing ancestor, and this walks
 * the same ground for a different question: is the RESOLVED path in a denied directory,
 * rather than is it outside the vault.
 */
async function pathSegments(vaultRoot: string, absPath: string): Promise<string[]> {
  const lexicalRoot = resolve(vaultRoot);
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
 * What stands on a path, answered WITHOUT opening it.
 *
 * - `missing`: nothing is there. The ordinary "create it" case.
 * - `file`: a regular file with ONE name, safe to read and to rename over.
 * - `foreign`: a SYMLINK, a HARD LINK, a directory, a FIFO, a socket, a device. Not a note.
 *
 * `guardedPath` answers a question about the PATH — containment, suffix, denied segments,
 * symlink escape — and none of that says what the NODE is. A FIFO inside the vault passes
 * every one of those checks (it is `.md`, it is contained, it is in no denied directory) and
 * the read that follows blocks on `open()` of a pipe with no writer and never returns.
 * Measured: still pending after 4 seconds, and the process had to be killed. The server
 * serialises writes by chaining each onto the previous promise, so ONE call that never settles
 * wedges every later write for the life of the process while unqueued reads keep answering —
 * a server that looks alive with its whole write surface dead.
 *
 * `lstat` and not `stat`, so a symlink is seen as itself: a `stat` would answer for the target,
 * including by hanging on a FIFO behind it. And a symlink is not a note either way — an atomic
 * rename lands ON the link, so the user's alias becomes a regular file holding a divergent copy
 * while the note it named never receives the write.
 *
 * A HARD link is the case neither `lstat` nor `realpath` can see on its own: there is no
 * "original" to resolve to, because the second name IS the file. `fs.link(<segredo fora do
 * vault>, <vault>/02-wiki/nota.md)` therefore satisfies every check above, and the read that
 * follows hands the out-of-vault bytes to `unifiedDiff`, which returns them in
 * `WriteResult.diff` — reproduced end to end, with the secret's lines in the diff and the
 * replacement committed. The LINK COUNT is what gives it away: a note has exactly one name, and
 * a second one means the bytes are shared with a file this server never inspected. It is a copy
 * and a leak rather than corruption — the atomic rename breaks the link, so the file outside
 * survives — and it is refused for the same reason a symlink is: a name shared with something
 * outside the vault is not a note.
 *
 * This is the ONE mechanism for that question in this directory. `writer.ts` asks it before both
 * of its reads and before the template read, `propagate.ts` before each of its three targets,
 * and `learn.ts`'s `pathState` asks the same question of the same `Stats` through
 * `classifyStat` before going on to separate a blank placeholder from a note. One rule, one
 * place: a boundary that refuses a shape on one route and accepts it on another is the drift
 * this whole task exists to remove.
 */
export type NodeKind = 'missing' | 'file' | 'foreign';

/**
 * The `file`/`foreign` half, over `Stats` a caller already has.
 *
 * Split out so that `learn.ts`, which needs the same `Stats` for the file's SIZE, applies the
 * identical rule without a second `lstat` — and therefore without a window in which the answer
 * to "is this a note" and the answer to "how big is it" describe different nodes.
 *
 * The parameter is `StatLike` and not `Stats` for one caller only: `vault/scanner.ts` runs the
 * same rule on the READ path, through its injectable `FsOps`. A real `Stats` satisfies it. The
 * read path matters as much as the write one — a hard link IS a regular file, so `isFile()`
 * alone lets `fs.link(<file outside the vault>, <vault>/x.md)` publish foreign bytes into the
 * index, which is the exact thing this guard exists to prevent.
 */
export interface StatLike {
  isFile(): boolean;
  readonly nlink: number;
}

export function classifyStat(stat: StatLike): 'file' | 'foreign' {
  if (!stat.isFile()) return 'foreign';
  if (stat.nlink > 1) return 'foreign';
  return 'file';
}

export async function classifyNode(absPath: string): Promise<NodeKind> {
  try {
    return classifyStat(await fs.lstat(absPath));
  } catch {
    // Anything that cannot be lstat'd is not a file this module can read. ENOENT is the common
    // case by far, and a path whose parent is unreadable fails the write that follows anyway,
    // with its own errno.
    return 'missing';
  }
}

/**
 * EVERY half of the path guard, in the order they have to run — the one entry point every
 * write in this directory passes through.
 *
 * `resolveWritePath` is purely SYNTACTIC: it rejects `..`, absolute paths, non-`.md`, glob
 * metacharacters and the read-only prefixes by reading the string. It cannot see a symlink,
 * and `02-wiki/atalho/nota.md` is a perfectly well-formed vault-relative path even when
 * `02-wiki/atalho` is a link to `/etc`. `assertNoSymlinkEscape` is another half, the
 * segment scan a third, and calling only some of them is the mistake this function exists
 * to make impossible for its callers.
 *
 * Symmetry between the exported write paths is the point of having exactly ONE of these:
 * `propagate` writes files whose paths are built from caller-supplied input just as
 * `writeNote` does, and a path `writeNote` refuses must not be a path `propagate` accepts.
 */
export async function guardedPath(
  vaultRoot: string,
  relPath: string,
  options: PathGuardOptions = {},
): Promise<string> {
  // First, before any `fs` call and before `resolveWritePath` interpolates the string into
  // a message: a NUL makes `fs` throw its own `TypeError` from inside the write.
  if (INVISIBLE_CHARS.test(relPath)) {
    throw coded(
        new PathGuardError(`caminho não pode conter caractere de controle: ${forMessage(relPath)}`),
        'path.noControlChar',
        { relPath: forMessage(relPath) },
      );
  }

  const absPath = resolveWritePath(vaultRoot, relPath, options);

  // Segment-wise, on the RESOLVED path as well as the lexical one, so `02-wiki/./.git/x.md`
  // and a link that lands in `.git` are both caught. Matching whole segments and not string
  // prefixes is what keeps an ordinary note at `02-wiki/git/rebase-interativo.md` legal,
  // exactly as `99-archive-notes/` stays legal beside the denied `99-archive/`.
  for (const segment of await pathSegments(vaultRoot, absPath)) {
    if (DENIED_SEGMENTS.has(normalizeSegment(segment))) {
      throw coded(
          new PathGuardError(`escrita negada em ${forMessage(segment)}/ (área interna, não é conteúdo)`),
          'path.internalArea',
          { segment: forMessage(segment) },
        );
    }
  }

  await assertNoSymlinkEscape(vaultRoot, absPath);
  return absPath;
}
