import { posix } from 'node:path';

import { resolveLinkTarget, WIKI_LINK } from '../vault/links.js';
import { fencedLines } from './propagate.js';

/**
 * Link correction for a note that MOVED, as a pure function of text and two vault indexes.
 *
 * The whole module is one rule:
 *
 * > **An edge that resolved before the operation resolves to the SAME note after it.**
 *
 * Everything else falls out of it, which is the point of writing it this way instead of as a
 * pile of special cases. The three shapes that separate rules get wrong:
 *
 * - the slug changed, so `[[antigo]]` in every other note has to become `[[novo]]`;
 * - the slug did NOT change and the note only moved directory: `[[slug]]` still resolves
 *   through the basename index, to the same note, and NOTHING is rewritten. The naive rule
 *   "rename the slug everywhere" touches files for no reason and fills the commit with noise;
 * - nobody renamed anything and a link still has to change, because the move created a
 *   basename TIE where there was none, and the shallowest-wins rule now answers differently.
 *
 * No I/O and no filesystem: the caller owns both indexes, and passes the one describing the
 * vault as it WILL BE. That is what lets `relocate.ts` compute every rewrite in memory and
 * publish nothing until all of them are known, the way `writeAndCommit` computes its diff
 * before its write.
 */

/** The vault's path index, in the two shapes `resolveLinkTarget` reads. */
export interface VaultIndex {
  allPaths: Set<string>;
  /** Basename without `.md` to the vault-relative paths carrying it. */
  byBasename: Map<string, string[]>;
}

export function buildVaultIndex(paths: Iterable<string>): VaultIndex {
  const allPaths = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const path of paths) {
    allPaths.add(path);
    const base = posix.basename(path, '.md');
    const bucket = byBasename.get(base);
    if (bucket === undefined) byBasename.set(base, [path]);
    else bucket.push(path);
  }
  return { allPaths, byBasename };
}

export interface RewriteLinksOptions {
  /** The note's full text, frontmatter included. */
  text: string;
  /** Where the note lived when its links were written. */
  notePathBefore: string;
  /**
   * Where the note lives afterwards. Equal to `notePathBefore` for every note except the one
   * that moved — and the moved note's OWN outgoing relative links are corrected by this
   * difference alone, with no other special case: `[[../../00-index/index-knowledge]]`, which
   * `buildMoc` writes, was relative to the old directory and resolves to nothing from the new
   * one.
   */
  notePathAfter: string;
  before: VaultIndex;
  after: VaultIndex;
  /** Vault-relative path before the operation → after it, for every note that moved. */
  renames: ReadonlyMap<string, string>;
}

export interface RewriteLinksResult {
  text: string;
  /**
   * Links that had to change and could not be written in any form that resolves. Never a
   * silent rewrite to something broken: the caller reports these, naming the note.
   */
  warnings: string[];
}

/**
 * Applies the invariant to one note's text.
 *
 * Mechanically: for every wiki-link outside a fenced code block, resolve its raw target under
 * the BEFORE index from the old path and under the AFTER index from the new one. A target that
 * resolved to nothing is left exactly as it is — an edge that did not exist has nothing to
 * preserve, and repairing it here would be this function guessing at what the user meant. A
 * target whose two answers agree is left alone too, byte for byte, which is what keeps a move
 * from touching every note in the vault.
 *
 * Only a target whose answer CHANGED is rewritten, and it is rewritten to the shortest form
 * that verifiably resolves back to the note it used to name — never to a path composed and
 * hoped for. The candidates are tried in the vault's own order of preference (bare slug, then
 * the root-relative path, then the path relative to the note) and each is checked by
 * `resolveLinkTarget` itself, so what gets written is what the resolver will read.
 */
export function rewriteLinks(options: RewriteLinksOptions): RewriteLinksResult {
  const { text, notePathBefore, notePathAfter, before, after, renames } = options;
  const warnings: string[] = [];

  // Derived per call, never shared: `WIKI_LINK` carries `lastIndex`, and `replace` with a
  // global pattern resets it — two call sites sharing the object skip matches at random.
  const pattern = new RegExp(WIKI_LINK.source, 'g');

  const lines = text.split('\n');
  const inFence = fencedLines(lines);

  const out = lines.map((line, i) => {
    // A fenced `[[...]]` is a code sample, not a link — the vault's own notes about Obsidian
    // conventions contain one — and `extractLinkTargets` never saw it either. Rewriting it
    // would edit the user's example to describe a note it was never about.
    if (inFence[i] === true) return line;

    return line.replace(pattern, (whole: string, rawTarget: string) => {
      const target = rawTarget.trim();
      if (target === '') return whole;

      const wasAt = resolveLinkTarget(target, notePathBefore, before.byBasename, before.allPaths);
      if (wasAt === undefined) return whole;

      const desired = renames.get(wasAt) ?? wasAt;
      const nowAt = resolveLinkTarget(target, notePathAfter, after.byBasename, after.allPaths);
      if (nowAt === desired) return whole;

      const replacement = targetFor(desired, target, notePathAfter, after);
      if (replacement === undefined) {
        const warning =
          `[[${target}]] apontava para ${wasAt} e não pôde ser reescrito para ${desired}`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return whole;
      }

      return `[[${replacement}${retail(whole.slice(2 + rawTarget.length), target, replacement)}`;
    });
  });

  return { text: out.join('\n'), warnings };
}

/**
 * The tail of a wiki-link — `#anchor`, `|alias`, `]]` — carried over, with a STALE ALIAS fixed.
 *
 * The tail is normally copied verbatim: the pattern captures only the target, so re-composing the
 * rest would mean parsing it a second time in order to write it back exactly as it already was.
 *
 * The one thing that cannot be copied verbatim is an alias that REPEATS the old name. Found on a
 * copy of the real vault: `[[../../02-wiki/nestjs/database-connection-singleton|
 * database-connection-singleton]]`. Correcting the target alone left the alias — which is the text
 * the reader actually SEES — naming a note that no longer exists under that name. A link that
 * displays one name and points at another is the "reads as one thing, is another" defect this
 * project keeps closing, and here the rewrite itself would have created it.
 *
 * The rule is deliberately narrow: only an alias equal to the old target in full, or to its
 * basename, is touched, because only those are the slug repeated rather than prose. A `|o guard de
 * JWT]]` is a phrase the user wrote for a reader, and rewriting it would be the tool editing text
 * that is not its own.
 */
function retail(tail: string, oldTarget: string, newTarget: string): string {
  const match = /^(#[^[\]|\n]*)?\|([^[\]\n]*)\]\]$/.exec(tail);
  if (match === null) return tail;
  const anchor = match[1] ?? '';
  const alias = match[2] ?? '';
  if (alias.trim() === oldTarget.trim()) return `${anchor}|${newTarget}]]`;
  if (alias.trim() === posix.basename(oldTarget, '.md')) {
    return `${anchor}|${posix.basename(newTarget, '.md')}]]`;
  }
  return tail;
}

/**
 * The link target, written in `fromPath`, that `resolveLinkTarget` answers `desired` for — in the
 * SHAPE the author used — or `undefined` when no form does.
 *
 * Three forms can name a note: the bare slug, the path from the vault root, and the path relative
 * to the linking note. All three are equally correct, and which one appears in a note is the
 * author's choice: this vault's MOCs write `[[../nestjs/x]]` and `[[../../00-index/y|índice]]` on
 * purpose. So the ORIGINAL target's shape picks the order they are tried in.
 *
 * That ordering was measured against a copy of the real vault, and it replaced "shortest that
 * resolves". Shortest-first flattened every one of eight rewrites to a bare slug — every one
 * resolving correctly, and every one silently restyling a link the author had written the long
 * way, in a diff they then had to review. Correcting the TARGET is what the invariant demands;
 * restyling is not, and a rewrite that touches more than it must is a rewrite that gets trusted
 * less.
 *
 * Shape is a PREFERENCE and never a constraint. Every candidate is still verified with
 * `resolveLinkTarget`, and the preferred one is dropped without ceremony when it no longer answers
 * the right note — which is exactly what happens when a move creates a basename tie and the bare
 * slug stops resolving.
 *
 * Checking instead of composing is the whole design, and the note-relative candidate is the proof
 * it has to be. `resolveLinkTarget` tries the relative path FIRST, so a vault holding a directory
 * named `02-wiki` inside `02-wiki/` captures the perfectly reasonable-looking root-relative target
 * and hands it to a different note — absurd, legal, and covered by a test. A rewrite that trusted
 * its own arithmetic would write that target and report success. Here the answer comes from the
 * resolver that will actually read it.
 *
 * `undefined` is not reachable by any vault this server can produce, and it is still handled,
 * because the alternative to handling it is writing a broken link and calling the move a success.
 * The caller turns it into a warning naming the note.
 */
function targetFor(
  desired: string,
  oldTarget: string,
  fromPath: string,
  after: VaultIndex,
): string | undefined {
  const withoutExtension = desired.endsWith('.md') ? desired.slice(0, -'.md'.length) : desired;
  const fromDir = posix.dirname(fromPath);
  const slug = posix.basename(withoutExtension);
  const rootRelative = withoutExtension;
  const noteRelative = posix.relative(fromDir === '.' ? '' : fromDir, withoutExtension);

  // `..` means the author wrote it relative to their own note; any other `/` means relative to the
  // root; no `/` at all means the bare slug. Each keeps its own fallbacks, in the vault's order.
  const ordered = oldTarget.includes('/')
    ? oldTarget.split('/').includes('..')
      ? [noteRelative, rootRelative, slug]
      : [rootRelative, noteRelative, slug]
    : [slug, rootRelative, noteRelative];

  for (const candidate of ordered) {
    if (candidate === '') continue;
    if (resolveLinkTarget(candidate, fromPath, after.byBasename, after.allPaths) === desired) {
      return candidate;
    }
  }
  return undefined;
}
