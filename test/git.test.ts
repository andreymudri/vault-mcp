import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitFiles } from '../src/write/git.js';

const execFileAsync = promisify(execFile);

/** Runs a git command in `repoRoot`, returning trimmed stdout. */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

describe('commitFiles', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-git-test-'));
    await git(repoRoot, ['init']);
    await git(repoRoot, ['config', 'user.name', 'Vault MCP Test']);
    await git(repoRoot, ['config', 'user.email', 'vault-mcp-test@example.com']);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('commits a single new file with the given message', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');

    const result = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');

    expect(result).toEqual({ committed: true });
    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toContain('feat: adicionar nota');
  });

  it('commits three files in a single commit', async () => {
    const files = ['nota.md', 'moc.md', 'index.md'];
    const absPaths = files.map((f) => path.join(repoRoot, f));
    for (const absPath of absPaths) {
      await fs.writeFile(absPath, `conteudo de ${path.basename(absPath)}\n`, 'utf8');
    }

    const result = await commitFiles(repoRoot, absPaths, 'feat: aprender novo conceito');

    expect(result).toEqual({ committed: true });

    const logBefore = await git(repoRoot, ['log', '--oneline']);
    expect(logBefore.split('\n')).toHaveLength(1);

    const nameOnly = await git(repoRoot, ['show', '--name-only', '--pretty=format:']);
    const committedFiles = nameOnly
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    expect(committedFiles).toEqual([...files].sort());
  });

  it('returns { committed: false, warning } without throwing when not a git repository', async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-not-a-repo-'));
    try {
      const absPath = path.join(notARepo, 'nota.md');
      await fs.writeFile(absPath, '# Nota\n', 'utf8');

      const result = await commitFiles(notARepo, [absPath], 'feat: adicionar nota');

      expect(result.committed).toBe(false);
      expect(result.warning).toBeTruthy();
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });

  it('returns { committed: false } with a warning when there is nothing to commit', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    const first = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota');
    expect(first.committed).toBe(true);

    // Same content, no changes staged the second time around.
    const second = await commitFiles(repoRoot, [absPath], 'feat: adicionar nota de novo');

    expect(second.committed).toBe(false);
    expect(second.warning).toBeTruthy();

    const log = await git(repoRoot, ['log', '--oneline']);
    expect(log.split('\n')).toHaveLength(1);
  });

  it('uses the passed message literally', async () => {
    const absPath = path.join(repoRoot, 'nota.md');
    await fs.writeFile(absPath, '# Nota\n', 'utf8');
    const message = 'fix: corrigir link quebrado em nestjs-moc';

    await commitFiles(repoRoot, [absPath], message);

    const subject = await git(repoRoot, ['log', '-1', '--pretty=%s']);
    expect(subject).toBe(message);
  });
});
