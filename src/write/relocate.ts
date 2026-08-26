import { promises as fs } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';

import { LinkGraph } from '../graph/graph.js';
import { parseFile } from '../vault/frontmatter.js';
import { extractLinkTargets, resolveLinkTarget } from '../vault/links.js';
import type { VaultScanner } from '../vault/scanner.js';
import { atomicWrite } from './atomic.js';
import { unifiedDiff } from './diff.js';
import { commitFiles, headBlobState, headSha } from './git.js';
import { classifyNode, forMessage, guardedPath } from './paths.js';
import {
  bumpAtualizado,
  buildMoc,
  insertUnderSection,
  removeFromSection,
} from './propagate.js';
import { buildVaultIndex, rewriteLinks, type VaultIndex } from './rewrite-links.js';
import { formatLocal } from './template.js';

/**
 * Moving, renaming, promoting, archiving and deleting a note — the four operations that
 * existed only OUTSIDE this server, and that done by hand leave the vault silently
 * inconsistent.
 *
 * Only orchestration lives here. The decisions are in pure functions elsewhere and are reused
 * rather than reimplemented: `resolveLinkTarget` (src/vault/links.ts) answers where a link
 * points, `rewriteLinks` (./rewrite-links.ts) applies the invariant, `insertUnderSection` and
 * `removeFromSection` (./propagate.ts) own MOC membership, and `headBlobState` (./git.ts)
 * answers whether a deletion can be undone.
 *
 * TWO INVARIANTS carry the whole module.
 *
 * The first is about links: **an edge that resolved before the operation resolves to the SAME
 * note after it**. It is what makes moving, renaming and promoting one operation instead of
 * three, because `to` is a full vault-relative path and
 * `01-raw/inbox/rascunho.md → 02-wiki/nestjs/auth-guard.md` is all three at once.
 *
 * The second is about publication order, and it is the one `writeAndCommit` (./writer.ts:332)
 * already states: **everything is computed in memory — the rename, every rewrite, every MOC
 * edit and every diff — before a single byte is published**. "Written but not reported" is not
 * a state this code can reach, rather than one it avoids by being careful.
 *
 * The rename itself publishes with `fs.link` followed by `unlink`, never `fs.rename`. `rename`
 * REPLACES silently, so a move onto an existing note destroys it; `link` fails with `EEXIST`
 * and nothing is lost. `atomic.ts` uses the same trick for the same reason.
 *
 * The DAILY NOTE is never touched by either operation. The MOC indexes what the domain HAS;
 * the daily records what HAPPENED on a given day. Rewriting an August 20th capture because the
 * note was renamed today would be falsifying the diary.
 */

export class RelocateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelocateError';
  }
}

export interface MoveNoteOptions {
  vaultRoot: string;
  /**
   * The vault as the retriever currently sees it. It MUST be fresh: backlinks and link
   * resolution both come out of it, and a stale index rewrites the wrong file. The caller
   * refreshes — inside the write queue's exclusive slot, so nothing lands between the refresh
   * and the move — because the delta belongs to the retriever (`refreshVault`, server/tools.ts).
   */
  scanner: VaultScanner;
  from: string;
  to: string;
  confirmNovoDominio?: boolean;
  now: Date;
}

export interface DeleteNoteOptions {
  vaultRoot: string;
  scanner: VaultScanner;
  path: string;
  confirm?: boolean;
  now: Date;
}

export interface MoveResult {
  from: string;
  to: string;
  /** The rename, every link rewrite and every MOC edit, concatenated. */
  diff: string;
  /** Vault-relative paths whose links were corrected. */
  rewritten: string[];
  /** Vault-relative MOC and index paths whose membership lines changed. */
  propagated: string[];
  committed: boolean;
  pushed?: boolean;
  warnings: string[];
}

export interface DeleteResult {
  path: string;
  diff: string;
  propagated: string[];
  committed: boolean;
  pushed?: boolean;
  warnings: string[];
  /** The exact command that brings the note back, run from INSIDE the vault. */
  undo?: string;
}

/** A file whose new content is already known and not yet on disk. */
interface PlannedWrite {
  relPath: string;
  absPath: string;
  before: string;
  after: string;
}

/** Paths that are STRUCTURE rather than knowledge, and are never deleted through this server. */
const KNOWLEDGE_INDEX = '00-index/index-knowledge.md';

function toVaultRelative(vaultRoot: string, absPath: string): string {
  return relative(resolve(vaultRoot), absPath).split(sep).join('/');
}

/** `02-wiki/<dominio>/...` → `<dominio>`, and `undefined` for a note outside the wiki. */
function domainOf(relPath: string): string | undefined {
  const parts = relPath.split('/');
  return parts.length >= 3 && parts[0] === '02-wiki' ? parts[1] : undefined;
}

function mocPathOf(dominio: string): string {
  return `02-wiki/${dominio}/${dominio}-moc.md`;
}

/** The basename a raw link target names, which is the only part that can change resolution. */
function targetBasename(target: string): string {
  return posix.basename(target.endsWith('.md') ? target : `${target}.md`, '.md');
}

/** Reads a note, or `''` when it is not there. Anything that is not a plain file refuses. */
async function readIfPresent(absPath: string, relPath: string): Promise<string> {
  const kind = await classifyNode(absPath);
  if (kind === 'foreign') {
    throw new RelocateError(
      `caminho não é uma nota (link, diretório ou dispositivo): ${forMessage(relPath)}`,
    );
  }
  if (kind === 'missing') return '';
  return fs.readFile(absPath, 'utf8');
}

/**
 * Every note whose links have to be reconsidered, and NOT the whole vault.
 *
 * The two indexes differ in exactly one way: `from` left and `to` arrived. Every step of
 * `resolveLinkTarget` — relative to the note, relative to the root, the basename bucket — is
 * a lookup keyed by the target's own basename, so a target whose basename is neither of those
 * two resolves identically under both indexes and cannot possibly need rewriting.
 *
 * That turns "re-resolve every link in the vault" into "re-resolve the handful of notes that
 * mention either name", and it is the difference between a move that reads four thousand files
 * and one that reads three. Candidacy is decided from `note.body` — the very text the link
 * graph is built from — so a note this skips is a note whose edges the graph does not have
 * either.
 */
function candidates(notes: readonly { path: string; body: string }[], names: Set<string>): string[] {
  const out: string[] = [];
  for (const note of notes) {
    if (extractLinkTargets(note.body).some((target) => names.has(targetBasename(target)))) {
      out.push(note.path);
    }
  }
  return out;
}

/**
 * The MOC entry that names `notePath`, found by RESOLVING each entry rather than by matching
 * its text.
 *
 * A MOC line is `- [[slug]] — resumo`, and the obvious implementation compares `slug` to the
 * moved note's basename. That is wrong in both directions in a vault that has two notes with
 * one basename: it removes an entry pointing at the OTHER note, and it misses an entry written
 * as `- [[02-wiki/nestjs/auth-guard]] — ...`. Asking the resolver is the same question the
 * reader's own client will ask.
 */
function entryFor(mocPath: string, notePath: string, index: VaultIndex): (line: string) => boolean {
  return (line) =>
    extractLinkTargets(line).some(
      (target) => resolveLinkTarget(target, mocPath, index.byBasename, index.allPaths) === notePath,
    );
}

/** True when `text`, read as a note at `fromPath`, still has a link resolving to `target`. */
function stillLinks(text: string, fromPath: string, target: string, index: VaultIndex): boolean {
  return extractLinkTargets(text).some(
    (raw) => resolveLinkTarget(raw, fromPath, index.byBasename, index.allPaths) === target,
  );
}

/** The `— resumo` half of a MOC entry, or `undefined` when the entry carries none. */
function resumoOf(entry: string | undefined): string | undefined {
  if (entry === undefined) return undefined;
  const cut = entry.indexOf('—');
  if (cut === -1) return undefined;
  const resumo = entry.slice(cut + 1).trim();
  return resumo === '' ? undefined : resumo;
}

/**
 * Moves, renames, promotes or archives one note, correcting every link that would otherwise
 * change meaning, and commits the whole set once.
 */
export async function moveNote(opts: MoveNoteOptions): Promise<MoveResult> {
  // `allowArchive` on BOTH sides: archiving and unarchiving are this one operation run in
  // opposite directions. It exempts `99-archive/` and nothing else — `_templates/`, `.git/`,
  // `.obsidian/` and `node_modules/` stay refused, with no flag that opens them.
  const fromAbs = await guardedPath(opts.vaultRoot, opts.from, { allowArchive: true });
  const toAbs = await guardedPath(opts.vaultRoot, opts.to, { allowArchive: true });

  const fromRel = toVaultRelative(opts.vaultRoot, fromAbs);
  const toRel = toVaultRelative(opts.vaultRoot, toAbs);
  if (fromAbs === toAbs) {
    throw new RelocateError(`origem e destino são o mesmo caminho: ${forMessage(fromRel)}`);
  }

  if ((await classifyNode(fromAbs)) !== 'file') {
    throw new RelocateError(`origem não é uma nota: ${forMessage(fromRel)}`);
  }
  // Asked, and answered by the `link` publish below as well. This is the message the user
  // reads; that is the guarantee, and neither one substitutes for the other.
  if ((await classifyNode(toAbs)) !== 'missing') {
    throw new RelocateError(`destino já existe: ${forMessage(toRel)}`);
  }

  const notes = opts.scanner.allNotes();
  const pathsBefore = new Set(notes.map((note) => note.path));
  // The note may not be indexed yet — it was written since the last refresh, or it lives in a
  // corner the scanner reached after this call started. Its own move must still resolve.
  pathsBefore.add(fromRel);
  const pathsAfter = new Set(pathsBefore);
  pathsAfter.delete(fromRel);
  pathsAfter.add(toRel);
  const before = buildVaultIndex(pathsBefore);
  const after = buildVaultIndex(pathsAfter);
  const renames = new Map([[fromRel, toRel]]);

  const warnings: string[] = [];
  const date = formatLocal(opts.now, 'YYYY-MM-DD');

  // ── Phase A: MOC membership, on the source side only ────────────────────────────────────
  //
  // Removal comes FIRST and the link rewrite runs on its result, because the two edit the same
  // line: a move that changes both domain and slug would otherwise have the rewrite fix a link
  // that is about to be deleted, and the diff would show an edit that means nothing.
  const seeded = new Map<string, string>();
  const propagated: string[] = [];

  const fromDomain = domainOf(fromRel);
  const toDomain = domainOf(toRel);
  const domainChanged = fromDomain !== toDomain;

  let resumo: string | undefined;
  const sourceMoc = fromDomain === undefined ? undefined : mocPathOf(fromDomain);
  if (domainChanged && sourceMoc !== undefined && sourceMoc !== fromRel) {
    const abs = resolve(opts.vaultRoot, sourceMoc);
    const text = await readIfPresent(abs, sourceMoc);
    if (text !== '') {
      const { content, removed } = removeFromSection(
        text,
        '## Notas',
        entryFor(sourceMoc, fromRel, before),
      );
      resumo = resumoOf(removed);
      if (removed !== undefined) seeded.set(sourceMoc, bumpAtualizado(content, date));
    }
  }

  // ── Phase B: the link rewrite, over the notes that can possibly be affected ──────────────
  const plans = new Map<string, PlannedWrite>();

  const movedBefore = await fs.readFile(fromAbs, 'utf8');
  const movedRewrite = rewriteLinks({
    text: movedBefore,
    notePathBefore: fromRel,
    notePathAfter: toRel,
    before,
    after,
    renames,
  });
  const movedAfter = movedRewrite.text;
  for (const warning of movedRewrite.warnings) {
    warnings.push(`${forMessage(toRel)}: ${warning}`);
  }

  const names = new Set([posix.basename(fromRel, '.md'), posix.basename(toRel, '.md')]);
  const affected = new Set([...candidates(notes, names), ...seeded.keys()]);
  affected.delete(fromRel);

  const rewritten: string[] = [];
  for (const relPath of [...affected].sort()) {
    const absPath = resolve(opts.vaultRoot, relPath);
    const seed = seeded.get(relPath);
    const original = seed ?? (await readIfPresent(absPath, relPath));
    if (original === '') continue;
    const result = rewriteLinks({
      text: original,
      notePathBefore: relPath,
      notePathAfter: relPath,
      before,
      after,
      renames,
    });
    for (const warning of result.warnings) warnings.push(`${forMessage(relPath)}: ${warning}`);

    // The file on disk, not the seed: the diff has to describe what actually changes there.
    const onDisk = seed === undefined ? original : await readIfPresent(absPath, relPath);
    if (result.text === onDisk) continue;
    plans.set(relPath, { relPath, absPath, before: onDisk, after: result.text });
    if (result.text !== original) rewritten.push(relPath);
    if (seed !== undefined) propagated.push(relPath);
  }

  // ── Phase C: MOC membership, on the destination side ─────────────────────────────────────
  //
  // After the rewrite, so the entry this composes is never re-resolved against an index it was
  // written for. It mirrors `vault_learn` exactly: the bare slug under `## Notas`, the domain
  // line in the knowledge index when the domain is new.
  const destMoc = toDomain === undefined ? undefined : mocPathOf(toDomain);
  if (domainChanged && destMoc !== undefined && destMoc !== toRel) {
    const absMoc = resolve(opts.vaultRoot, destMoc);
    const existing = plans.get(destMoc)?.after ?? (await readIfPresent(absMoc, destMoc));
    const onDisk = plans.get(destMoc)?.before ?? existing;
    const domainIsNew = existing === '';
    if (domainIsNew && opts.confirmNovoDominio !== true) {
      throw new RelocateError(
        `${forMessage(toDomain ?? '')} ainda não tem MOC em 02-wiki/; ` +
          'passe confirm_novo_dominio para criá-lo',
      );
    }

    const slug = posix.basename(toRel, '.md');
    const entry = resumo === undefined ? `- [[${slug}]]` : `- [[${slug}]] — ${resumo}`;
    const base = domainIsNew ? buildMoc(toDomain ?? '', date) : existing;
    const updated = bumpAtualizado(insertUnderSection(base, '## Notas', entry), date);
    if (updated !== onDisk) {
      plans.set(destMoc, { relPath: destMoc, absPath: absMoc, before: onDisk, after: updated });
      if (!propagated.includes(destMoc)) propagated.push(destMoc);
    }

    if (domainIsNew) {
      // The knowledge index, exactly as `propagate` writes it. A vault without one is left
      // alone with a warning rather than given a file it never had: `vault_move` is not the
      // operation that decides a vault needs an index.
      const absIndex = resolve(opts.vaultRoot, KNOWLEDGE_INDEX);
      const indexBefore = await readIfPresent(absIndex, KNOWLEDGE_INDEX);
      if (indexBefore === '') {
        warnings.push(`${KNOWLEDGE_INDEX} não existe; o domínio novo não foi indexado`);
      } else {
        const line =
          `- [[../02-wiki/${toDomain}/${toDomain}-moc|${toDomain}]]` +
          (resumo === undefined ? '' : ` — ${resumo}`);
        const indexAfter = bumpAtualizado(
          insertUnderSection(indexBefore, '## Domínios', line),
          date,
        );
        if (indexAfter !== indexBefore) {
          plans.set(KNOWLEDGE_INDEX, {
            relPath: KNOWLEDGE_INDEX,
            absPath: absIndex,
            before: indexBefore,
            after: indexAfter,
          });
          propagated.push(KNOWLEDGE_INDEX);
        }
      }
    }
  }

  // ── Publication ─────────────────────────────────────────────────────────────────────────
  //
  // Rename first, rewrites second, and deliberately so: the rename is the step that can lose a
  // race, and rewrites that had landed before a failed rename would point at a note that never
  // moved. A rewrite that fails AFTER the rename is a warning naming the file, never a
  // rollback — the note is already where the user asked for it.
  const diffs = [unifiedDiff(movedBefore, movedAfter, fromRel, toRel)];
  for (const plan of plans.values()) {
    diffs.push(unifiedDiff(plan.before, plan.after, plan.relPath));
  }

  await fs.mkdir(dirname(toAbs), { recursive: true });
  try {
    await fs.link(fromAbs, toAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RelocateError(
        `${forMessage(toRel)} passou a existir enquanto a nota era movida; nada foi sobrescrito`,
      );
    }
    throw err;
  }
  await fs.unlink(fromAbs);
  if (movedAfter !== movedBefore) await atomicWrite(toAbs, movedAfter);

  const written = [fromAbs, toAbs];
  for (const plan of plans.values()) {
    try {
      await atomicWrite(plan.absPath, plan.after);
      written.push(plan.absPath);
    } catch (err) {
      warnings.push(
        `falha ao reescrever ${forMessage(plan.relPath)}: ` +
          forMessage(err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // One commit over both paths plus everything rewritten. `git add` on the old path AND the
  // new one is what records the delete beside the add, which is what lets git render a rename.
  const commit = await commitFiles(
    opts.vaultRoot,
    [...new Set(written)],
    `docs(vault): mover ${fromRel} para ${toRel}`,
  );
  if (commit.warning !== undefined) warnings.push(commit.warning);

  return {
    from: fromRel,
    to: toRel,
    diff: joinDiffs(diffs),
    rewritten,
    propagated,
    committed: commit.committed,
    ...(commit.pushed === undefined ? {} : { pushed: commit.pushed }),
    warnings,
  };
}

/**
 * Deletes one note, after asking git whether that is undoable at all.
 *
 * The order of refusals is structure → git → backlinks, and structure comes first on purpose
 * even though it is the cheapest to check last: "this is a MOC" is a better answer than "this
 * has uncommitted edits" for someone who was never allowed to delete it either way.
 *
 * `99-archive/` gets NO exemption here — `guardedPath` is called without the flag `vault_move`
 * passes. That is what makes the directory mean what it says: notes enter and leave it, and
 * nothing in it is destroyed. Deleting an archived note stays `rm`'s job, outside this server.
 */
export async function deleteNote(opts: DeleteNoteOptions): Promise<DeleteResult> {
  const absPath = await guardedPath(opts.vaultRoot, opts.path);
  const relPath = toVaultRelative(opts.vaultRoot, absPath);

  if ((await classifyNode(absPath)) !== 'file') {
    throw new RelocateError(`nota não encontrada: ${forMessage(relPath)}`);
  }

  const content = await fs.readFile(absPath, 'utf8');
  // Parsed from the FILE and not read off the scanner: a note written since the last refresh is
  // not in the index, and "not indexed" must not be the way a MOC becomes deletable.
  const { frontmatter } = parseFile(relPath, content);
  const tipo = typeof frontmatter.tipo === 'string' ? frontmatter.tipo : undefined;
  if (relPath === KNOWLEDGE_INDEX || tipo === 'moc' || tipo === 'daily') {
    throw new RelocateError(
      `${forMessage(relPath)} é uma nota estrutural (${tipo ?? 'índice'}) e não é apagada por aqui`,
    );
  }

  const warnings: string[] = [];
  const head = await headBlobState(opts.vaultRoot, relPath);
  if (!head.inHead) {
    throw new RelocateError(
      `${forMessage(relPath)} não tem versão commitada no HEAD, então apagá-la é irreversível; ` +
        'commite a nota antes, ou apague fora do MCP' +
        (head.reason === undefined ? '' : ` (${forMessage(head.reason)})`),
    );
  }
  if (head.modified) {
    warnings.push(
      `${forMessage(relPath)} tem edições não commitadas; ` +
        'restaurar traz de volta a versão commitada, não o que está em disco agora',
    );
  }

  const date = formatLocal(opts.now, 'YYYY-MM-DD');
  const propagated: string[] = [];
  const plans: PlannedWrite[] = [];
  const index = buildVaultIndex(opts.scanner.allNotes().map((note) => note.path));

  // The MOC entry is computed BEFORE the backlink check, and that order is load-bearing.
  //
  // A domain's MOC links to every note in the domain, so counting it as a backlink would make
  // `confirm` mandatory for every single note under `02-wiki/` — a flag that is always required
  // is a flag that means nothing, and it would have trained the caller to pass it blind.
  //
  // And it is not a link that BREAKS: this operation removes it. So the MOC is excluded only
  // when the removal actually happened AND the resulting text no longer resolves to the note at
  // all. A MOC that also names it under `## Relacionados` keeps its backlink and its refusal.
  const dominio = domainOf(relPath);
  const mocPath = dominio === undefined ? undefined : mocPathOf(dominio);
  let mocSettled: string | undefined;
  if (mocPath !== undefined && mocPath !== relPath) {
    const absMoc = resolve(opts.vaultRoot, mocPath);
    const mocBefore = await readIfPresent(absMoc, mocPath);
    if (mocBefore !== '') {
      const { content: mocAfter, removed } = removeFromSection(
        mocBefore,
        '## Notas',
        entryFor(mocPath, relPath, index),
      );
      if (removed !== undefined) {
        const bumped = bumpAtualizado(mocAfter, date);
        plans.push({ relPath: mocPath, absPath: absMoc, before: mocBefore, after: bumped });
        propagated.push(mocPath);
        if (!stillLinks(bumped, mocPath, relPath, index)) mocSettled = mocPath;
      }
    }
  }

  // Rebuilt per call, like `vault_backlinks` does, because the scanner's delta belongs to the
  // retriever and this layer cannot tell whether the vault moved underneath it.
  const graph = new LinkGraph();
  graph.build(opts.scanner.allNotes());
  const backlinks = graph.backlinks(relPath).filter((path) => path !== mocSettled).sort();
  if (backlinks.length > 0 && opts.confirm !== true) {
    // The list is the whole point of the refusal: there is nowhere to rewrite these links to,
    // so whoever confirms is choosing to leave them broken and has to see which ones.
    throw new RelocateError(
      `${backlinks.length} nota(s) apontam para ${forMessage(relPath)} e os links ficarão ` +
        `quebrados: ${forMessage(backlinks.join(', '))}; passe confirm para apagar mesmo assim`,
    );
  }

  const diffs = [unifiedDiff(content, '', relPath)];
  for (const plan of plans) diffs.push(unifiedDiff(plan.before, plan.after, plan.relPath));

  await fs.unlink(absPath);
  const written = [absPath];
  for (const plan of plans) {
    try {
      await atomicWrite(plan.absPath, plan.after);
      written.push(plan.absPath);
    } catch (err) {
      warnings.push(
        `falha ao atualizar ${forMessage(plan.relPath)}: ` +
          forMessage(err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const titulo = posix.basename(relPath, '.md');
  const commit = await commitFiles(opts.vaultRoot, written, `docs(vault): remover ${titulo}`);
  if (commit.warning !== undefined) warnings.push(commit.warning);

  // The sha of the commit JUST made, never `HEAD^`: the user may commit again before they read
  // this, and by then `HEAD^` names something else entirely.
  //
  // And no `-C <root>`, deliberately. The command is rendered back to the caller and the vault's
  // absolute path spells out the OS username on a personal machine — which is why the tool layer
  // runs every message through `makeRedactor` (server/tools.ts). A command carrying `<vault>`
  // where a path belongs is a command the user pastes and watches fail. Relative to the vault it
  // leaks nothing and still runs; the answer says where to run it.
  const sha = commit.committed ? await headSha(opts.vaultRoot) : undefined;

  return {
    path: relPath,
    diff: joinDiffs(diffs),
    propagated,
    committed: commit.committed,
    ...(commit.pushed === undefined ? {} : { pushed: commit.pushed }),
    warnings,
    ...(sha === undefined
      ? {}
      : { undo: `git checkout ${sha}^ -- ${relPath}` }),
  };
}

function joinDiffs(parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .map((part) => (part.endsWith('\n') ? part : `${part}\n`))
    .join('');
}
