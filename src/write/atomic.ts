import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/** How many times a colliding temporary name is retried before giving up. */
const TMP_ATTEMPTS = 8;

/**
 * The flags the temporary file is created with.
 *
 * `O_EXCL` is the load-bearing one, and it is doing two jobs. It makes the creation
 * ATOMIC against another writer — two concurrent `atomicWrite` calls can no longer end up
 * holding the same temporary file, which is how a single published note came to contain
 * 199,950 'A' and 50 'B' that neither caller asked for. And, per POSIX, `O_CREAT|O_EXCL`
 * REFUSES to follow a symlink at the final component, so a link planted at the temporary
 * name cannot redirect the note's contents outside the vault. `O_NOFOLLOW` says the same
 * thing a second way for platforms that define it.
 */
const TMP_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/**
 * The mode the temporary file is CREATED with — owner-only, always.
 *
 * The note's real mode is applied afterwards, and that ordering is the whole point.
 * Creating the temporary file 0666 and chmod'ing it down after the write meant the entire
 * plaintext of a note deliberately kept at 0600 — the vault holds credentials, tokens and
 * client notes — sat world-readable in the vault directory for as long as the write took,
 * under a name any other process on the machine could stat and open. The window is small
 * and it is entirely avoidable: a file created 0600 and widened later is never readable by
 * anyone who was not already allowed to read it.
 *
 * A file's mode is fixed at open() and is not affected by a later chmod for handles that
 * are already open, so nothing that could not read the temporary file at creation gains
 * access when the mode is widened at the end.
 */
const TMP_MODE = 0o600;

/**
 * The mode a NEW note gets, since there is no existing file whose mode should be kept.
 *
 * `0o666` minus the process umask is what `fs.writeFile` would have produced, and a note
 * this module creates has no business being less readable than one the user created with
 * an editor. `process.umask()` is read rather than assumed because a server started under
 * a restrictive umask means it deliberately; it throws in a worker thread, hence the
 * fallback to the ordinary 022.
 */
function defaultMode(): number {
  try {
    return 0o666 & ~process.umask();
  } catch {
    return 0o666 & ~0o022;
  }
}

/**
 * Writes `text` to `absPath` so that no reader ever observes a partial file.
 *
 * The sequence is: create the parent directory, create a UNIQUELY NAMED temporary file
 * IN THE SAME DIRECTORY, write the whole text to it, restore the target's mode, `fsync`
 * the handle, close it, then `rename` over the target. `rename` within one filesystem is
 * atomic, so Obsidian — which watches the vault and re-reads a note the instant its mtime
 * moves — sees either the old file or the complete new one, never a truncated note.
 * Writing the temporary file into the same directory rather than `os.tmpdir()` is what
 * keeps the rename same-filesystem; across devices `rename` fails with `EXDEV`, which is
 * not a theoretical concern — any vault not on the same filesystem as `/tmp` would hit it
 * on every single write.
 *
 * That same-directory rule is also the path guard's business. `writer.ts` guards the
 * TARGET path — inside the vault, no traversal, no symlink escape, no `.git`/`.obsidian`
 * and no control characters in the name — and
 * the temporary file inherits every one of those guarantees for free precisely because it
 * is a sibling of the target and nothing else. A temporary path assembled anywhere else
 * would be a second, unguarded way into the filesystem.
 *
 * The `fsync` before the rename is the other half: without it the rename can reach the
 * disk while the data behind it has not, and a crash leaves the note pointing at garbage.
 * Ordering the flush before the rename is what makes the on-disk state at any instant a
 * state the vault could legitimately be in.
 *
 * This lives in its own module because `write/writer.ts` and `write/propagate.ts` both
 * write notes, and a second, subtly different copy of this dance is exactly how one of
 * them ends up non-atomic.
 */
export async function atomicWrite(absPath: string, text: string): Promise<void> {
  const dir = dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  // Captured BEFORE anything is published. `rename` replaces the target inode outright,
  // so the replacement carries the mode the temporary file was created with and not the
  // one the note had — a note chmod'd 0600 because it holds credentials would come back
  // 0644 after a routine edit, silently. Only an EXISTING target has a mode worth
  // restoring; a new note should get the ordinary default.
  let targetMode: number | undefined;
  try {
    targetMode = (await fs.stat(absPath)).mode & 0o7777;
  } catch {
    targetMode = undefined;
  }

  let handle: FileHandle | undefined;
  let tmpPath = '';

  for (let attempt = 0; attempt < TMP_ATTEMPTS; attempt += 1) {
    // `process.pid` alone is NOT unique: two concurrent `writeNote` calls to the same path
    // run in one process and produced the same name. The random suffix is what separates
    // them; the leading dot keeps the file out of Obsidian's index while it exists.
    tmpPath = join(dir, `.${basename(absPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);

    // Defence in depth against a future edit moving the temporary file elsewhere: it must
    // be a direct child of the target's own directory, which is the guarded one.
    if (dirname(resolve(tmpPath)) !== resolve(dir)) {
      throw new Error(`arquivo temporário fora do diretório do destino: ${tmpPath}`);
    }

    try {
      handle = await fs.open(tmpPath, TMP_FLAGS, TMP_MODE);
      break;
    } catch (err) {
      // EEXIST means either a name collision or a planted symlink; both are answered by
      // picking a different name rather than by writing through whatever is there.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  if (handle === undefined) {
    throw new Error(`não foi possível criar um arquivo temporário em ${dir}`);
  }

  try {
    try {
      await handle.writeFile(text, 'utf8');
      // Only now, with the bytes already down in a file nobody else could open: the note's
      // own mode if it is replacing one, and the ordinary default if it is a new note.
      await handle.chmod(targetMode ?? defaultMode());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    // The rename is the only step that publishes anything. If anything above failed the
    // target is untouched, and leaving the temporary file behind would litter the vault
    // with a file the next `git add` would happily stage.
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
