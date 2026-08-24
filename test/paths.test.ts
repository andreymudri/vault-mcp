import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveWritePath, assertNoSymlinkEscape, PathGuardError } from '../src/write/paths.js';
import { symlink } from 'node:fs/promises';

describe('resolveWritePath', () => {
  it('accepts a valid vault-relative path and returns absolute normalized path', () => {
    const vaultRoot = '/vault';
    const result = resolveWritePath(vaultRoot, '02-wiki/nestjs/nova.md');
    expect(result).toBe(resolve(vaultRoot, '02-wiki/nestjs/nova.md'));
  });

  it('rejects paths escaping via ../', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '../fora.md')).toThrow(PathGuardError);
  });

  it('rejects absolute paths', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '/etc/passwd')).toThrow(PathGuardError);
  });

  it('rejects paths that escape via traversal', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '02-wiki/../../fora.md')).toThrow(
      PathGuardError,
    );
  });

  it('rejects paths in 99-archive/ with message naming the folder', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '99-archive/x.md')).toThrow(PathGuardError);
    try {
      resolveWritePath(vaultRoot, '99-archive/x.md');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
      expect((err as Error).message).toMatch(/99-archive/);
    }
  });

  it('rejects paths in _templates/ with message naming the folder', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '_templates/x.md')).toThrow(PathGuardError);
    try {
      resolveWritePath(vaultRoot, '_templates/x.md');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
      expect((err as Error).message).toMatch(/_templates/);
    }
  });

  it('rejects paths not ending in .md', () => {
    const vaultRoot = '/vault';
    expect(() => resolveWritePath(vaultRoot, '02-wiki/nestjs/nova.txt')).toThrow(
      PathGuardError,
    );
  });

  it('throws PathGuardError, not generic Error', () => {
    const vaultRoot = '/vault';
    try {
      resolveWritePath(vaultRoot, '../fora.md');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathGuardError);
    }
  });
});

describe('assertNoSymlinkEscape', () => {
  let tmpVault: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpVault = resolve(tmpdir(), `vault-${Date.now()}-${Math.random()}`);
    await mkdir(tmpVault, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directories
    try {
      if (tmpVault) await rm(tmpVault, { recursive: true, force: true });
      if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('allows paths inside the vault', async () => {
    const notePath = resolve(tmpVault, '02-wiki/test.md');
    await mkdir(resolve(tmpVault, '02-wiki'), { recursive: true });
    // Should not throw
    await assertNoSymlinkEscape(tmpVault, notePath);
  });

  it('rejects symlinks pointing outside the vault', async () => {
    outsideDir = resolve(tmpdir(), `outside-${Date.now()}-${Math.random()}`);
    await mkdir(outsideDir, { recursive: true });

    const symlinkDir = resolve(tmpVault, 'linked');
    await symlink(outsideDir, symlinkDir, 'dir');

    const notePathThroughSymlink = resolve(symlinkDir, 'test.md');

    await expect(assertNoSymlinkEscape(tmpVault, notePathThroughSymlink)).rejects.toThrow();
  });
});
