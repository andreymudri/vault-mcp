import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes `text` to `absPath` so that no reader ever observes a partial file.
 *
 * The sequence is: create the parent directory, write the whole text to a temporary
 * file IN THE SAME DIRECTORY, `fsync` the handle, close it, then `rename` over the
 * target. `rename` within one filesystem is atomic, so Obsidian — which watches the
 * vault and re-reads a note the instant its mtime moves — sees either the old file or
 * the complete new one, never a truncated note. Writing the temporary file into the
 * same directory rather than `os.tmpdir()` is what keeps the rename same-filesystem;
 * across devices `rename` fails with `EXDEV` and a copy-then-replace fallback would
 * give up the atomicity this function exists for.
 *
 * The `fsync` before the rename is the other half: without it the rename can reach the
 * disk while the data behind it has not, and a crash leaves the note pointing at
 * garbage. Ordering the flush before the rename is what makes the on-disk state at any
 * instant a state the vault could legitimately be in.
 *
 * This lives in its own module because `write/writer.ts` and `write/propagate.ts` both
 * write notes, and a second, subtly different copy of this dance is exactly how one of
 * them ends up non-atomic.
 */
export async function atomicWrite(absPath: string, text: string): Promise<void> {
  const dir = dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${absPath}.${process.pid}.tmp`;
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    // The rename is the only step that publishes anything. If it fails the target is
    // untouched, and leaving the temporary file behind would litter the vault with a
    // `.tmp` file Obsidian would happily index.
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
