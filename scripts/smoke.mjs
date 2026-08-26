#!/usr/bin/env node
/**
 * The compiled server, started as a PROGRAM and asked for its tools over stdio.
 *
 * This exists because `package.json` promises `engines.node >= 20` and nothing verified it. The
 * suite cannot: `test/frontmatter.test.ts` spawns `node <arquivo>.ts` and depends on the type
 * stripping of the runtime it runs on, so CI pins Node 26 and an older runner fails there for a
 * TOOLCHAIN reason, telling us nothing about whether the shipped code runs. What ships is `dist/`,
 * plain compiled JavaScript, and this script is what can honestly be run on every version the
 * `engines` range claims.
 *
 * It also covers a failure the unit tests reach only in pieces: the entrypoint deciding it is a
 * library and starting nothing (see `isDirectRun`), which looks like a clean exit 0 to a shell and
 * like an eternal wait to a client. Here it is a timeout with a message.
 *
 * The vault is a throwaway directory created per run. NEVER point this at a real vault — it is the
 * server's own guards, not this script, that keep writes inside the tree, and a smoke check has no
 * business being the thing that tests them.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The nine tools, by name: the contract `tools/list` has to answer with. */
const EXPECTED = [
  'vault_search',
  'vault_get_note',
  'vault_list',
  'vault_backlinks',
  'vault_write_note',
  'vault_edit_note',
  'vault_learn',
  'vault_move',
  'vault_delete',
];

const TIMEOUT_MS = Number(process.env.VAULT_MCP_SMOKE_TIMEOUT_MS ?? 30_000);

const serverPath = resolve(fileURLToPath(new URL('../dist/server/index.js', import.meta.url)));

const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-mcp-smoke-'));
writeFileSync(join(vaultRoot, 'nota.md'), '---\ntipo: wiki\n---\n\n# Nota\n\nCorpo.\n');

const fail = (message) => {
  process.stderr.write(`vault-mcp smoke: ${message}\n`);
  rmSync(vaultRoot, { recursive: true, force: true });
  process.exit(1);
};

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, VAULT_PATH: vaultRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('error', (err) => fail(`não foi possível iniciar o servidor: ${err.message}`));

child.on('exit', (code) => {
  // Reaching here before the assertions ran means the server died instead of serving.
  fail(`o servidor saiu com código ${code} antes de responder${stderr ? `:\n${stderr}` : ''}`);
});

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  fail(
    `nenhuma resposta em ${TIMEOUT_MS} ms. Um servidor que sobe e não responde é o modo de falha ` +
      'do entrypoint que se acha biblioteca: sai 0 sem imprimir nada e deixa o cliente esperando.' +
      (stderr ? `\nstderr:\n${stderr}` : ''),
  );
}, TIMEOUT_MS);

/** Resolves for the response carrying `id`; the transport is newline-delimited JSON-RPC. */
const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`linha que não é JSON no canal do protocolo: ${line.slice(0, 200)}`);
      return;
    }
    const resolveFor = pending.get(message.id);
    if (resolveFor !== undefined) {
      pending.delete(message.id);
      resolveFor(message);
    }
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

const request = (id, method, params) =>
  new Promise((res) => {
    pending.set(id, res);
    send({ jsonrpc: '2.0', id, method, params });
  });

const initialize = await request(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'vault-mcp-smoke', version: '0' },
});
if (initialize.error) fail(`initialize falhou: ${JSON.stringify(initialize.error)}`);

send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const listed = await request(2, 'tools/list', {});
if (listed.error) fail(`tools/list falhou: ${JSON.stringify(listed.error)}`);

const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
const missing = EXPECTED.filter((name) => !names.includes(name));
const extra = names.filter((name) => !EXPECTED.includes(name));
if (missing.length > 0 || extra.length > 0) {
  fail(
    `tools/list não bate com as nove tools.${missing.length > 0 ? ` Faltando: ${missing.join(', ')}.` : ''}` +
      `${extra.length > 0 ? ` Sobrando: ${extra.join(', ')}.` : ''}`,
  );
}

clearTimeout(timer);
child.removeAllListeners('exit');
child.kill('SIGTERM');
rmSync(vaultRoot, { recursive: true, force: true });
process.stdout.write(
  `vault-mcp smoke: OK em ${process.version} — servidor subiu e ${names.length} tools responderam.\n`,
);
process.exit(0);
