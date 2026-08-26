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

      const replacement = shortestTargetFor(desired, notePathAfter, after);
      if (replacement === undefined) {
        const warning =
          `[[${target}]] apontava para ${wasAt} e não pôde ser reescrito para ${desired}`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return whole;
      }

      // Everything after the target — `#âncora`, `|alias`, the closing brackets — is carried
      // over verbatim by slicing rather than by re-composing it: the pattern captures only the
      // target, so re-composing would mean parsing the rest a second time in order to write it
      // back the way it already was. Incidental spaces INSIDE the target (`[[ slug ]]`) do not
      // survive, and only on a link that is being rewritten anyway.
      return `[[${replacement}${whole.slice(2 + rawTarget.length)}`;
    });
  });

  return { text: out.join('\n'), warnings };
}

/**
 * The shortest link target, written in `fromPath`, that `resolveLinkTarget` answers `desired`
 * for — or `undefined` when no form does.
 *
 * Candidates in the vault's order of preference, each one VERIFIED rather than assumed:
 *
 * 1. the bare slug, which is the convention and what the user writes by hand;
 * 2. the path from the vault root, which is what disambiguates a shared basename;
 * 3. the path relative to the linking note, for the note whose own directory shadows the
 *    root-relative form.
 *
 * Checking instead of composing is the whole design, and candidate 3 is the proof that it has
 * to be. `resolveLinkTarget` tries the relative path FIRST, so a vault holding a directory
 * named `02-wiki` inside `02-wiki/` captures the perfectly reasonable-looking root-relative
 * target and hands it to a different note — absurd, legal, and covered by a test. A rewrite
 * that trusted its own arithmetic would write that target and report success. Here the answer
 * comes from the resolver that will actually read it.
 *
 * `undefined` is not reachable by any vault this server can produce, and it is still handled,
 * because the alternative to handling it is writing a broken link and calling the move a
 * success. The caller turns it into a warning naming the note.
 */
function shortestTargetFor(desired: string, fromPath: string, after: VaultIndex): string | undefined {
  const withoutExtension = desired.endsWith('.md') ? desired.slice(0, -'.md'.length) : desired;
  const fromDir = posix.dirname(fromPath);
  const candidates = [
    posix.basename(withoutExtension),
    withoutExtension,
    posix.relative(fromDir === '.' ? '' : fromDir, withoutExtension),
  ];
  for (const candidate of candidates) {
    if (candidate === '') continue;
    if (resolveLinkTarget(candidate, fromPath, after.byBasename, after.allPaths) === desired) {
      return candidate;
    }
  }
  return undefined;
}
