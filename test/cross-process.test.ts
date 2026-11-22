import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Two MCP clients are two PROCESSES.
 *
 * Every other test in this suite calls the tools from one process, where `WriteQueue` already
 * serializes them — which is why the suite was green while eight servers editing one note lost one
 * or two edits out of eight (measured on 0.5.0: 7, 6 and 6 edits landed in three runs, all eight
 * calls answering success). A stdio MCP server is started per client, so "two writers" in real use
 * always means two processes, and only a test that starts real processes can see what they do to
 * each other.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'vault');
const HOOK = pathToFileURL(join(HERE, 'helpers', 'ts-resolve.mjs')).href;
const WORKER = join(HERE, 'helpers', 'tool-worker.ts');

interface Answer {
  isError: boolean;
  text: string;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/** One tool call in a fresh process. Rejects when the worker itself fails to answer. */
function callInProcess(
  root: string,
  name: string,
  args: unknown,
  env: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', HOOK, WORKER, root, name, JSON.stringify(args)], {
      env: { ...process.env, VAULT_AUTO_PUSH: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      try {
        resolve(JSON.parse(stdout) as Answer);
      } catch {
        reject(new Error(`worker exited ${code} without an answer: ${stderr.slice(0, 600)}`));
      }
    });
  });
}

describe('two processes writing one vault', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'vault-mcp-xproc-'));
    root = join(base, 'vault');
    cpSync(FIXTURE, root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'gc.auto', '0');
    git(root, 'config', 'user.name', 'Vault MCP Test');
    git(root, 'config', 'user.email', 'vault-mcp-test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const commitCount = (): number => Number(git(root, 'rev-list', '--count', 'HEAD'));

  it('keeps every edit when eight processes edit different passages of the same note', async () => {
    const path = '02-wiki/docker/shared.md';
    const markers = Array.from({ length: 8 }, (_, i) => `marker-${i}-old`);
    writeFileSync(join(root, path), `---\ntipo: wiki\n---\n\n# Shared\n\n${markers.join('\n\n')}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'shared');
    const before = commitCount();

    const answers = await Promise.all(
      markers.map((marker, i) =>
        callInProcess(root, 'vault_edit_note', { path, old_text: marker, new_text: `marker-${i}-NEW` }),
      ),
    );

    expect(answers.filter((answer) => answer.isError)).toEqual([]);
    const body = readFileSync(join(root, path), 'utf8');
    expect(body.match(/marker-\d-NEW/g)?.length).toBe(8);
    expect(body).not.toContain('-old');
    expect(commitCount() - before).toBe(8);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, 120_000);

  it('keeps every edit when half the processes have no git on their PATH', async () => {
    // The lock file has to be the same one for a process that can run git and for one that cannot:
    // asking the binary where the repository is gave each half its own lock (9 and 10 of 12 edits
    // in two rounds out of four). The processes with no git still answer success — their commit
    // is the warning, the edit is on disk — so only the file can tell.
    const path = '02-wiki/docker/shared.md';
    const markers = Array.from({ length: 12 }, (_, i) => `marker-${i}-old`);
    writeFileSync(join(root, path), `---\ntipo: wiki\n---\n\n# Shared\n\n${markers.join('\n\n')}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'shared');
    const noGit = join(base, 'no-git-here');
    mkdirSync(noGit);
    // On Windows the variable is `Path`, and a second spelling beside it is ambiguous.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

    const answers = await Promise.all(
      markers.map((marker, i) =>
        callInProcess(
          root,
          'vault_edit_note',
          { path, old_text: marker, new_text: `marker-${i}-NEW` },
          i % 2 === 1 ? { [pathKey]: noGit } : {},
        ),
      ),
    );

    expect(answers.filter((answer) => answer.isError)).toEqual([]);
    const body = readFileSync(join(root, path), 'utf8');
    expect(body.match(/marker-\d+-NEW/g)?.length).toBe(12);
    expect(body).not.toContain('-old');
  }, 120_000);

  it('keeps every MOC entry, daily line and commit when six processes learn into one domain', async () => {
    const topics: Array<[string, string, string]> = [
      ['Kubernetes ingress timeout behind a load balancer', 'idle timeouts on the ingress controller cut websocket sessions', 'k8s'],
      ['Postgres autovacuum never catches up on a hot table', 'bloat grows when long transactions pin the xmin horizon', 'postgres'],
      ['Redis eviction policy drops session keys silently', 'allkeys-lru evicts sessions when memory is shared with the cache', 'redis'],
      ['Kafka consumer group rebalances forever', 'max.poll.interval exceeded by slow handlers triggers rebalance storms', 'kafka'],
      ['Terraform state drift after manual console changes', 'refresh-only plans reveal resources edited outside the pipeline', 'terraform'],
      ['Chrome extension manifest v3 service worker sleeps', 'background workers are killed after thirty seconds without events', 'chrome'],
    ];
    const mocPath = join(root, '02-wiki', 'docker', 'docker-moc.md');
    const entries = (): number =>
      readFileSync(mocPath, 'utf8').split('\n').filter((line) => line.startsWith('- [[')).length;
    const notes = (): number => readdirSync(join(root, '02-wiki', 'docker')).length;
    const before = { commits: commitCount(), entries: entries(), notes: notes() };
    const dailiesBefore = new Set(readdirSync(join(root, '04-daily')));

    const answers = await Promise.all(
      topics.map(([titulo, insight, tag]) =>
        callInProcess(root, 'vault_learn', {
          titulo,
          insight,
          contexto: 'cross-process test',
          dominio: 'docker',
          tags: [tag],
        }),
      ),
    );

    expect(answers.filter((answer) => answer.isError)).toEqual([]);
    expect(notes() - before.notes).toBe(6);
    expect(entries() - before.entries).toBe(6);
    const daily = readdirSync(join(root, '04-daily')).filter((name) => !dailiesBefore.has(name));
    expect(daily).toHaveLength(1);
    const captures = readFileSync(join(root, '04-daily', daily[0] ?? ''), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(captures).toHaveLength(6);
    expect(commitCount() - before.commits).toBe(6);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(root, '.git', 'vault-mcp-pending.json'))).toBe(false);
    expect(existsSync(join(root, '.git', 'vault-mcp.lock'))).toBe(false);
  }, 120_000);
});
