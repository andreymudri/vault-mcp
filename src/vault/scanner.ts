import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Diagnostic, Note } from '../types.js';
import { classifyStat, type StatLike } from '../write/paths.js';
import { parseFile } from './frontmatter.js';
import { extractLinkTargets, resolveLinks } from './links.js';

/** The subset of `fs.Dirent` the walker needs. A real `Dirent` satisfies it as-is. */
export interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Every filesystem call the scanner makes, injectable so tests can count them.
 *
 * `readdir` deliberately takes a directory and NOTHING else: there is no options argument, so
 * `{ recursive: true }` cannot be expressed through this interface. That is a design constraint,
 * not an omission. A single recursive listing would make the "never opens `.obsidian/` or `.git/`"
 * assertion pass while Node walked both in full underneath — and against the user's real vault,
 * which is a git repository, every `refresh()` would traverse the entire object store.
 */
export interface FsOps {
  readdir(dir: string): DirEntry[];
  /**
   * `nlink` and `isFile()` beyond the mtime: the same `Stats` that answers "is this stale"
   * answers "is this a note", so the two can never describe different nodes.
   */
  stat(path: string): StatLike & { mtimeMs: number };
  readFile(path: string): string;
}

const REAL_FS: FsOps = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  stat: (path) => statSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
};

/**
 * Directories never descended into. `.git` and `.obsidian` are already covered by the
 * dot-prefix rule below and are named anyway, because they are the two that matter and the
 * cost of stating them is nothing.
 *
 * `_templates` carries no leading dot and would otherwise be indexed like any other folder.
 * It must not be: `_templates/projeto.md` declares `tipo: projeto`, so it would surface in
 * `vault_list` next to real projects, and its body is Templater syntax rather than prose.
 */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  '_templates',
]);

/** Hidden entries are skipped wholesale — dotfiles are tooling state, not notes. */
function isIgnored(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

export interface VaultScannerOptions {
  vaultRoot: string;
  fs?: FsOps;
}

/**
 * Owns the vault's notes. Nothing else in the system reads the filesystem for note content:
 * every consumer goes through `getNote` / `allNotes`, so mtime revalidation is the one place
 * that decides what is stale.
 */
export class VaultScanner {
  readonly root: string;

  /** Rebuilt on every `refresh`, so a file that got fixed stops being reported. */
  diagnostics: Diagnostic[] = [];

  private readonly fs: FsOps;
  private readonly notes = new Map<string, Note>();
  private readonly mtimes = new Map<string, number>();
  /** Per-path diagnostics, kept across refreshes so an unread file keeps reporting its own. */
  private readonly fileDiagnostics = new Map<string, Diagnostic>();
  /** Raw link targets per note, cached at parse time so pass two never re-scans a body. */
  private readonly linkTargets = new Map<string, string[]>();

  constructor(options: VaultScannerOptions) {
    this.root = options.vaultRoot;
    this.fs = options.fs ?? REAL_FS;
  }

  getNote(path: string): Note | undefined {
    return this.notes.get(path);
  }

  allNotes(): Note[] {
    return [...this.notes.values()];
  }

  /**
   * Walks the vault, re-reading only what changed, and returns what moved.
   *
   * `changed` holds paths read this pass (new or modified); `removed` holds paths that were in
   * the map and are no longer on disk. The index consumer uses exactly those two lists to decide
   * what to re-chunk, so a note must appear in `changed` whenever its body may differ.
   */
  refresh(): { changed: string[]; removed: string[] } {
    const walkDiagnostics: Diagnostic[] = [];
    const found: string[] = [];
    this.walk('', found, walkDiagnostics);

    const changed: string[] = [];
    const seen = new Set<string>();

    for (const path of found) {
      const absolute = this.absolute(path);

      let stat: StatLike & { mtimeMs: number };
      try {
        stat = this.fs.stat(absolute);
      } catch (err) {
        // The file was listed a moment ago and is unreachable now — deleted mid-walk, or a
        // permission change. Treating it as absent lets the removal path clean up after it.
        walkDiagnostics.push({
          path,
          message: `não foi possível ler metadados: ${message(err)}`,
          code: 'diag.statFailed',
          params: { detail: message(err) },
        });
        continue;
      }

      // The same rule the write guard applies, from the same function. `Dirent.isFile()` is
      // true for a hard link, so without this a link into the vault publishes bytes that live
      // outside it — indexed, searchable, and returned in full by `vault_get_note`.
      //
      // Deliberately about `nlink` and not about where the other name lives: a hard link cannot
      // be asked where its counterpart is without walking the whole filesystem. A vault restored
      // with `cp -al` therefore drops out of the index — loudly, one diagnostic per note.
      if (classifyStat(stat) === 'foreign') {
        walkDiagnostics.push({
          path,
          message:
            'ignorado: é um hard link (nlink > 1), e o conteúdo pode viver fora do vault. ' +
            'Substitua por uma cópia real (`cp --reflink=never`) para indexar.',
          code: 'diag.hardLink',
        });
        continue;
      }

      const mtimeMs = stat.mtimeMs;

      if (this.notes.has(path) && this.mtimes.get(path) === mtimeMs) {
        seen.add(path);
        continue;
      }

      let raw: string;
      try {
        raw = this.fs.readFile(absolute);
      } catch (err) {
        // Unreadable is not fatal: one bad file must not cost the whole vault. It drops out of
        // the map (a stale copy of a file we can no longer verify is worse than none) and is
        // reported. Not marked as seen, so a previously indexed copy is removed below.
        walkDiagnostics.push({
          path,
          message: `não foi possível ler o arquivo: ${message(err)}`,
          code: 'diag.readFailed',
          params: { detail: message(err) },
        });
        continue;
      }

      seen.add(path);
      const parsed = parseFile(path, raw);
      this.notes.set(path, {
        path,
        title: extractTitle(parsed.body, path),
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        links: [],
        brokenLinks: [],
        bodyStartLine: bodyStartLine(raw, parsed.body),
        mtimeMs,
      });
      this.mtimes.set(path, mtimeMs);
      this.linkTargets.set(path, extractLinkTargets(parsed.body));
      if (parsed.diagnostic === undefined) this.fileDiagnostics.delete(path);
      else this.fileDiagnostics.set(path, parsed.diagnostic);
      changed.push(path);
    }

    const removed: string[] = [];
    for (const path of this.notes.keys()) if (!seen.has(path)) removed.push(path);
    for (const path of removed) {
      this.notes.delete(path);
      this.mtimes.delete(path);
      this.linkTargets.delete(path);
      this.fileDiagnostics.delete(path);
    }

    // Second pass, after every file has been read. Basename lookup and relative resolution both
    // need the complete path set: resolving as we read would mark every forward reference broken
    // (`00-index/` is walked before `02-wiki/`), and an added or deleted note changes how OTHER
    // notes' links resolve, so all of them are re-resolved rather than only the changed ones.
    this.resolveAllLinks();

    this.diagnostics = [
      ...[...this.fileDiagnostics.keys()].sort().map((path) => this.fileDiagnostics.get(path)!),
      ...walkDiagnostics,
    ];

    return { changed, removed };
  }

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  /**
   * One `readdir` per directory, depth-first, in sorted order so `changed` is deterministic.
   *
   * Entries are followed only when they are real directories: `Dirent.isDirectory()` is false for
   * a symlink, so a link pointing at an ancestor cannot loop the walk.
   */
  private walk(relativeDir: string, out: string[], diagnostics: Diagnostic[]): void {
    const absoluteDir = relativeDir === '' ? this.root : this.absolute(relativeDir);

    let entries: DirEntry[];
    try {
      entries = this.fs.readdir(absoluteDir);
    } catch (err) {
      diagnostics.push({
        path: relativeDir,
        message: `não foi possível listar o diretório: ${message(err)}`,
        code: 'diag.readdirFailed',
        params: { detail: message(err) },
      });
      return;
    }

    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (isIgnored(entry.name)) continue;
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) this.walk(path, out, diagnostics);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
  }

  private resolveAllLinks(): void {
    const allPaths = new Set(this.notes.keys());
    const byBasename = new Map<string, string[]>();
    for (const path of allPaths) {
      const base = basenameWithoutExtension(path);
      const bucket = byBasename.get(base);
      if (bucket === undefined) byBasename.set(base, [path]);
      else bucket.push(path);
    }

    for (const [path, note] of this.notes) {
      const targets = this.linkTargets.get(path) ?? [];
      const { links, brokenLinks } = resolveLinks(targets, path, byBasename, allPaths);
      note.links = links;
      note.brokenLinks = brokenLinks;
    }
  }
}

/** A ``` or ~~~ fence line, with its optional info string. Mirrors `links.ts` and `chunker.ts`. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const H1 = /^ {0,3}# +(.*)$/;

/**
 * The note's display title: the first level-one heading of the body, falling back to the file's
 * basename. Notes captured into `01-raw/inbox/` routinely have neither frontmatter nor heading,
 * and a nameless entry in a search result is useless.
 *
 * Fenced code is skipped: a snippet documenting markdown would otherwise name the note.
 * `\r` is trimmed so a CRLF-authored note (clippings, Windows editors) titles identically.
 */
function extractTitle(body: string, path: string): string {
  let openFence: string | undefined;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const marker = FENCE.exec(line);
    if (openFence === undefined) {
      if (marker?.[1] !== undefined) {
        openFence = marker[1];
        continue;
      }
    } else {
      const closing = marker?.[1];
      if (
        closing !== undefined &&
        closing[0] === openFence[0] &&
        closing.length >= openFence.length &&
        (marker?.[2] ?? '') === ''
      ) {
        openFence = undefined;
      }
      continue;
    }
    const heading = H1.exec(line)?.[1]?.trim();
    if (heading !== undefined && heading !== '') return heading;
  }
  return basenameWithoutExtension(path);
}

/** `'\n'.charCodeAt(0)`. */
const NEWLINE = 10;

/**
 * The 1-based line of `raw` where `body` starts. This is the one place in the system that still
 * holds both, which is why the offset is computed here and carried on `Note`.
 *
 * It reads the offset from the LENGTHS rather than re-parsing the delimiters: `body` is always a
 * suffix of `raw` — `parseFile` either hands back gray-matter's `content`, which is a plain slice
 * of the input, or `stripFrontmatterBlock`'s slice for a malformed block — so the number of
 * newlines in the part that was cut away is exactly how many lines the body starts below the top
 * of the file. Re-deriving the closing `---` here instead would be a second, independently
 * drifting frontmatter parser: it would have to reproduce gray-matter's own edge cases (the BOM
 * it strips, the single `\r` and single `\n` it eats after the delimiter, a `---` that never
 * closes) and the two would disagree on exactly the files that are already malformed.
 *
 * Counting `\n` treats CRLF identically to LF, since a line is what a newline terminates.
 */
function bodyStartLine(raw: string, body: string): number {
  const offset = raw.length - body.length;
  let line = 1;
  for (let i = 0; i < offset; i++) if (raw.charCodeAt(i) === NEWLINE) line++;
  return line;
}

function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
