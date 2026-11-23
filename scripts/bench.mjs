#!/usr/bin/env node
/**
 * How the server behaves as the vault grows: `node --expose-gc scripts/bench.mjs [notes]`.
 *
 * It builds a synthetic vault of `notes` files (default 5000) in a temporary directory, runs the
 * BUILT server code from `dist/` over it, and prints one JSON object: how long the first search
 * takes (scan plus index), how long a warm one does, what a scan alone costs, what one edited note
 * and a touch of every file cost, and how much memory the index holds.
 *
 * It exists so that a change to the scanner or the index is measured the same way every time. The
 * numbers quoted in the code and in CHANGELOG.md come from here. `--expose-gc` is optional; with
 * it the heap figure is what is LIVE after a collection, which is the one worth comparing — without
 * it the figure includes whatever garbage the cold start left behind.
 *
 * The vault is deterministic (a fixed-seed generator), so two runs differ only by the machine.
 * Run `npm run build` first: this measures what ships.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(join(dist, 'server', 'tools.js'))) {
  process.stderr.write('bench: dist/ is missing — run `npm run build` first\n');
  process.exit(1);
}
const load = (relative) => import(pathToFileURL(join(dist, relative)).href);
const [{ VaultScanner }, { Retriever }, { createTools }, { messagesFor }] = await Promise.all([
  load('vault/scanner.js'),
  load('retrieval/retrieval.js'),
  load('server/tools.js'),
  load('i18n/messages.js'),
]);

const notes = Number(process.argv[2] ?? 5000);
if (!Number.isInteger(notes) || notes < 1) {
  process.stderr.write('usage: bench.mjs [notes]\n');
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'vault-mcp-bench-'));
const root = join(base, 'vault');
try {
  // A small linear congruential generator: the same vault on every run and every machine.
  let seed = 42;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const vocabulary = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}term`);
  // Squaring the draw skews it towards the head of the vocabulary, roughly as real text does.
  const words = (count) =>
    Array.from({ length: count }, () => vocabulary[Math.floor(random() * random() * vocabulary.length)]).join(' ');

  const DOMAINS = 40;
  for (let d = 0; d < DOMAINS; d += 1) mkdirSync(join(root, '02-wiki', `dom${d}`), { recursive: true });
  const paths = [];
  for (let i = 0; i < notes; i += 1) {
    const path = join(root, '02-wiki', `dom${i % DOMAINS}`, `note-${i}.md`);
    paths.push(path);
    const links = Array.from({ length: 3 }, () => `[[note-${Math.floor(random() * notes)}]]`).join(' ');
    writeFileSync(
      path,
      `---\ntipo: wiki\ntags: [t${i % 50}, t${i % 7}]\n---\n\n# Note ${i} ${words(4)}\n\n${words(60)}\n\n` +
        `## Solution\n\n${words(90)} ${links}\n\n## Example\n\n\`\`\`ts\n${words(30)}\n\`\`\`\n`,
    );
  }

  // `scanTtlMs: 0` so every call below really walks the vault: the scan cost is one of the things
  // measured, and the adaptive validity would hide it after the first call.
  const scanner = new VaultScanner({ vaultRoot: root, scanTtlMs: 0 });
  const retriever = new Retriever({ scanner });
  const tools = createTools({ retriever, scanner, vaultRoot: root, messages: messagesFor('en') });
  const call = (name, args) => tools.find((tool) => tool.name === name).handler(args);
  const timed = async (run, times = 1) => {
    const started = performance.now();
    for (let i = 0; i < times; i += 1) await run();
    return Number(((performance.now() - started) / times).toFixed(1));
  };
  const search = () => call('vault_search', { query: `${vocabulary[17]} ${vocabulary[230]} ${vocabulary[1200]}` });
  const megabytes = (bytes) => Math.round(bytes / 1048576);

  const result = { notes, node: process.version };
  result.coldFirstSearchMs = await timed(search);
  result.warmSearchMs = await timed(search, 10);
  result.scanOnlyMs = await timed(() => scanner.refresh(), 10);
  appendFileSync(paths[5], '\nedited\n');
  result.searchAfterOneEditMs = await timed(search);
  const now = new Date();
  for (const path of paths) utimesSync(path, now, now);
  result.searchAfterTouchingEveryFileMs = await timed(search);
  result.listPageMs = await timed(() => call('vault_list', {}));
  result.rssMB = megabytes(process.memoryUsage().rss);
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
    result.liveHeapMB = megabytes(process.memoryUsage().heapUsed);
  } else {
    result.heapMB = megabytes(process.memoryUsage().heapUsed);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
