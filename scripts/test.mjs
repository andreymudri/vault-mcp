#!/usr/bin/env node
/**
 * `vitest run` under a HARD wall-clock bound.
 *
 * The gate reads the EXIT CODE of `npm test`, so a suite that wedges is worse than a suite that
 * fails: a failing run is evidence, an indefinite stop is nothing at all. And vitest cannot bound
 * this case itself — measured on vitest 4.1: a test blocked in a SYNCHRONOUS read of a FIFO with no
 * writer (the shape `learn.ts` and `propagate.ts` hit if their guard ever regresses) blocks the
 * worker's event loop before any timeout can fire, so the run prints its header and stops there,
 * forever. Neither `testTimeout`, nor `teardownTimeout`, nor `pool: 'forks'` ends it — all three
 * were measured hanging past 120 s.
 *
 * So the bound comes from outside the runner, and the two mechanisms it needs — starting vitest,
 * and killing everything it started — are the two things that do NOT port between platforms. Both
 * are handled below rather than assumed.
 *
 * The limit is deliberately far above an ordinary run — the whole suite is about ten seconds — so
 * this never truncates real work. Override with VAULT_MCP_TEST_TIMEOUT_MS when bisecting something
 * genuinely slow.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const TIMEOUT_MS = Number(process.env.VAULT_MCP_TEST_TIMEOUT_MS ?? 900_000);
/** Between SIGTERM and SIGKILL: enough for vitest to flush its reporter, not enough to hang. */
const GRACE_MS = 10_000;

const isWindows = process.platform === 'win32';

/**
 * vitest's own JS entrypoint, run through `process.execPath` rather than spawning the name `vitest`.
 *
 * Spawning the bare name is what a shell does for you, and there is no shell here (`shell: false`
 * is not negotiable — the arguments are forwarded from a command line). On POSIX that works anyway,
 * because `node_modules/.bin/vitest` is an executable script with a shebang. On Windows the same
 * entry is `vitest.CMD`, a batch file, and `CreateProcess` cannot run one: the spawn fails with
 * ENOENT before a single test starts. Resolving the `.mjs` and handing it to node sidesteps the
 * whole question on both platforms.
 *
 * Resolution goes through `package.json` and its `bin` field, not a hardcoded path: `vitest/*.mjs`
 * is not in the package's `exports`, so it cannot be resolved directly, and `node_modules/vitest/`
 * is not where a hoisting install necessarily puts it.
 */
function resolveVitestBin() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const { bin } = require(manifestPath);
  const entry = typeof bin === 'string' ? bin : bin?.vitest;
  if (entry === undefined) throw new Error("o package.json do vitest não declara um bin 'vitest'");
  return resolve(dirname(manifestPath), entry);
}

let vitestBin;
try {
  vitestBin = resolveVitestBin();
} catch (err) {
  process.stderr.write(`vault-mcp: não foi possível localizar o vitest: ${err.message}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [vitestBin, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  // POSIX only: it is what puts the child in its own process GROUP, which is the thing
  // `signalGroup` signals. On Windows `detached` means "own console window" instead, which would
  // hand the suite its own window and detach it from the job's output — so it stays off there and
  // the tree is killed by pid instead.
  detached: !isWindows,
  shell: false,
});

let timedOut = false;

/**
 * Ends the child AND everything it started. The wedged worker is a child of the child, so
 * signalling only the process this script spawned leaves the actual problem running.
 *
 * The two platforms have nothing in common here. POSIX: negative pid, signal the group. Windows:
 * there are no process groups to signal and `process.kill(-pid)` is not merely unsupported but
 * SILENT — it throws, the catch swallows it, and the wall-clock bound quietly becomes a no-op that
 * still reports 124 while vitest keeps running. `taskkill /T` is the tree kill that actually works.
 */
const signalGroup = (signal) => {
  if (child.pid === undefined) return;
  try {
    if (isWindows) {
      // /T the tree, /F forced: there is no graceful signal to send a wedged worker on Windows,
      // so the SIGTERM-then-SIGKILL escalation collapses into one call and the grace period is
      // spent by the caller either way.
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone, or never started — either way there is nothing left to signal.
  }
};

const killTimer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `\nvault-mcp: a suíte passou de ${TIMEOUT_MS} ms e foi encerrada. ` +
      'Isso é uma FALHA, não um resultado: quase sempre um teste bloqueado em leitura ' +
      '(FIFO sem escritor, lock preso) que trava o worker antes de qualquer timeout do vitest.\n',
  );
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), GRACE_MS).unref();
}, TIMEOUT_MS);
killTimer.unref();

child.on('error', (err) => {
  clearTimeout(killTimer);
  process.stderr.write(`vault-mcp: não foi possível iniciar o vitest: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(killTimer);
  // A timeout must never look like a pass, whatever the signal turned into on the way out.
  if (timedOut) process.exit(124);
  process.exit(code ?? (signal === null ? 1 : 128 + 15));
});

// Ctrl-C reaches this script; the group has to go with it, or the wedged worker outlives the shell.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signalGroup(signal);
    process.exit(130);
  });
}
