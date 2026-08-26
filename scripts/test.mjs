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
 * So the bound comes from outside the runner. The child is spawned in its own process GROUP and the
 * group is signalled, because the wedged worker is not the process this script started and killing
 * only the parent would leave it behind.
 *
 * The limit is deliberately far above an ordinary run — the whole suite is about ten seconds — so
 * this never truncates real work. Override with VAULT_MCP_TEST_TIMEOUT_MS when bisecting something
 * genuinely slow.
 */
import { spawn } from 'node:child_process';

const TIMEOUT_MS = Number(process.env.VAULT_MCP_TEST_TIMEOUT_MS ?? 900_000);
/** Between SIGTERM and SIGKILL: enough for vitest to flush its reporter, not enough to hang. */
const GRACE_MS = 10_000;

const child = spawn('vitest', ['run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  detached: true,
  shell: false,
});

let timedOut = false;

/** Signals the whole GROUP: the wedged worker is a child of the child. */
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
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
