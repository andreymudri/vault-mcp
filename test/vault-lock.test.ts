import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorContext } from '../src/i18n/errors.js';
import { VaultLock, type LockInfo } from '../src/write/vault-lock.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('VaultLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-mcp-lock-test-'));
    lockPath = join(dir, 'vault-mcp.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLock = (): LockInfo => JSON.parse(readFileSync(lockPath, 'utf8')) as LockInfo;
  const plant = (info: Partial<LockInfo>): void => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, host: hostname(), token: 'planted', at: new Date().toISOString(), ...info }),
    );
  };

  it('writes who holds the lock and removes the file on release', async () => {
    const lock = new VaultLock({ lockPath });
    const release = await lock.acquire();

    const info = readLock();
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe(hostname());
    expect(info.token).toMatch(/^[a-f0-9]{32}$/);
    expect(await lock.holder()).toEqual(info);

    expect(await release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(await lock.holder()).toBeUndefined();
  });

  it('makes a second acquirer wait until the first releases', async () => {
    const first = new VaultLock({ lockPath });
    const second = new VaultLock({ lockPath });
    const events: string[] = [];

    const release = await first.acquire();
    const waiting = second.acquire().then((r) => {
      events.push('second acquired');
      return r;
    });
    await sleep(60);
    events.push('first releasing');
    await release();
    await (await waiting)();

    expect(events).toEqual(['first releasing', 'second acquired']);
  });

  it('never lets two tasks run at once, across instances', async () => {
    let running = 0;
    let peak = 0;
    let counter = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        new VaultLock({ lockPath }).with(async () => {
          running += 1;
          peak = Math.max(peak, running);
          const seen = counter;
          await sleep(2);
          counter = seen + 1;
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(counter).toBe(20);
  });

  it('refuses with lock.timeout when a live holder never lets go', async () => {
    plant({ pid: process.pid });
    const lock = new VaultLock({ lockPath, timeoutMs: 80 });

    const err = await lock.acquire().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(errorContext(err).code).toBe('lock.timeout');
    // The holder's file is untouched: a timeout is a refusal, never a takeover.
    expect(readLock().token).toBe('planted');
  });

  it('takes over a lock whose holder process no longer exists', async () => {
    plant({ pid: 424_242 });
    const lock = new VaultLock({ lockPath, timeoutMs: 500, isAlive: () => false });

    const release = await lock.acquire();
    expect(readLock().pid).toBe(process.pid);
    await release();
  });

  it('takes over a lock older than staleMs even when the pid is alive', async () => {
    plant({ pid: process.pid, at: new Date(Date.now() - 10_000).toISOString() });
    const lock = new VaultLock({ lockPath, timeoutMs: 500, staleMs: 5_000 });

    const release = await lock.acquire();
    expect(readLock().token).not.toBe('planted');
    await release();
  });

  it('cannot judge a pid on another host, so only age makes that lock stale', async () => {
    plant({ pid: 1, host: 'some-other-machine' });
    const lock = new VaultLock({ lockPath, timeoutMs: 80, isAlive: () => false });

    const err = await lock.acquire().catch((e: unknown) => e);
    expect(errorContext(err).code).toBe('lock.timeout');
  });

  it('waits on a lock file it cannot parse while it is fresh, and takes it over once it is old', async () => {
    writeFileSync(lockPath, '{ not json');
    const fresh = await new VaultLock({ lockPath, timeoutMs: 80 }).acquire().catch((e: unknown) => e);
    expect(errorContext(fresh).code).toBe('lock.timeout');

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const release = await new VaultLock({ lockPath, timeoutMs: 500 }).acquire();
    expect(readLock().pid).toBe(process.pid);
    await release();
  });

  it('does not delete a lock it no longer owns, and says so', async () => {
    const lock = new VaultLock({ lockPath });
    const release = await lock.acquire();
    // Somebody judged this holder stale and took over.
    plant({ token: 'the new owner' });

    expect(await release()).toBe(false);
    expect(readLock().token).toBe('the new owner');
  });

  it('with() releases when the task throws, and reports the value otherwise', async () => {
    const lock = new VaultLock({ lockPath });
    await expect(
      lock.with(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);

    expect(await lock.with(async () => 42)).toEqual({ value: 42, lost: false });
  });

  it('with() reports a lost lock instead of hiding it', async () => {
    const lock = new VaultLock({ lockPath });
    const result = await lock.with(async () => {
      plant({ token: 'the new owner' });
      return 'written';
    });
    expect(result).toEqual({ value: 'written', lost: true });
  });

  it('releaseSync removes a held lock and leaves a foreign one alone', async () => {
    const lock = new VaultLock({ lockPath });
    await lock.acquire();
    lock.releaseSync();
    expect(existsSync(lockPath)).toBe(false);

    plant({});
    lock.releaseSync();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('fails with lock.failed when the lock cannot be created at all', async () => {
    const lock = new VaultLock({ lockPath: join(dir, 'missing-dir', 'vault-mcp.lock'), timeoutMs: 80 });
    const err = await lock.acquire().catch((e: unknown) => e);
    expect(errorContext(err).code).toBe('lock.failed');
  });
});
