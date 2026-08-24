import { resolve, relative, sep } from 'node:path';
import { promises as fs } from 'node:fs';

export const DENIED_PREFIXES = ['99-archive', '_templates'] as const;

export class PathGuardError extends Error {}

/**
 * Resolves a vault-relative path to an absolute one, refusing anything that escapes
 * the vault or lands in a read-only area. Returns the absolute path.
 */
export function resolveWritePath(vaultRoot: string, relPath: string): string {
  if (!relPath.endsWith('.md')) {
    throw new PathGuardError(`caminho deve terminar em .md: ${relPath}`);
  }
  const root = resolve(vaultRoot);
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== abs) {
    throw new PathGuardError(`caminho fora do vault: ${relPath}`);
  }
  const head = rel.split(sep)[0];
  if (head !== undefined && (DENIED_PREFIXES as readonly string[]).includes(head)) {
    throw new PathGuardError(`escrita negada em ${head}/ (somente leitura)`);
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
  const realRoot = await fs.realpath(root);

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
    throw new PathGuardError(`symlink apontaria para fora do vault: ${abs}`);
  }
}
