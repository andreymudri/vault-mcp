#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { Retriever } from '../retrieval/retrieval.js';
import { VaultScanner } from '../vault/scanner.js';
import { createTools, forMessage, makeRedactor, type ToolDefinition, type ToolResult } from './tools.js';

/**
 * The process a user starts: `node <caminho-absoluto>/dist/server/index.js`. It wires a
 * `VaultScanner`, a `Retriever` and the nine tools of `tools.ts` onto an MCP server speaking over
 * stdio.
 *
 * NOT `npx vault-mcp`, which the README and this server's own `VAULT_PATH` error used to suggest
 * and no longer do: that name belongs to a different package on npm (`vault-mcp@0.0.1`, 443 bytes,
 * by another author), so the suggestion ran somebody else's code. `package.json` carries
 * `"private": true` so an accidental publish fails here rather than in the registry. The `npx`/`npm`
 * mentions further down are about how those tools install a `bin` as a SYMLINK, which is why
 * `isDirectRun` compares through `realpathSync` — that part stays true and is a different subject.
 *
 * The shebang on the first line is load-bearing — `package.json`'s `bin` points at the COMPILED
 * file and `tsc` copies the line through verbatim.
 */

/** The one fatal error of the system: no usable vault to serve. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/**
 * The vault root from the environment, absolute and verified to be a directory.
 *
 * Takes the environment as an argument rather than reading `process.env` itself so the failure
 * modes are testable without mutating global state in a parallel test runner.
 */
export function resolveVaultPath(env: NodeJS.ProcessEnv): string {
  const raw = env['VAULT_PATH'];
  if (raw === undefined || raw.trim() === '') {
    throw new VaultPathError(
      'VAULT_PATH não definida: aponte-a para a pasta raiz do vault, ex.: ' +
        'VAULT_PATH="/caminho/absoluto/do/vault" node /caminho/absoluto/do/vault-mcp/dist/server/index.js',
    );
  }

  const vaultRoot = resolve(raw);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(vaultRoot).isDirectory();
  } catch (err) {
    throw new VaultPathError(
      `VAULT_PATH não pôde ser lida (${vaultRoot}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isDirectory) throw new VaultPathError(`VAULT_PATH não é um diretório: ${vaultRoot}`);
  return vaultRoot;
}

/**
 * A tool answer in the SDK's own result shape.
 *
 * `ToolResult` is deliberately the narrower type — text blocks only — so `tools.ts` never has to
 * import the protocol types; this is the one place the two shapes meet.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((part) => ({ type: 'text' as const, text: part.text })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

/**
 * The SDK-facing callback for one tool: a second belt on top of the one inside `define`.
 *
 * Every handler already converts its own failures into `isError` content, so this catch is for what
 * the SDK layer itself can throw — a schema surprise, an argument shape nobody predicted. It must
 * answer the way every other answer is built: REDACTED, so the vault's absolute root does not leak
 * out through the one path that skipped it, and ESCAPED, so a message carrying a newline cannot
 * forge a line. Getting that wrong here is not cosmetic — this is the branch that runs when nothing
 * else worked, which is exactly when the message is least predictable.
 */
export function toolCallback(
  tool: ToolDefinition,
  redact: (text: string) => string,
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return toCallToolResult(await tool.handler(args));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toCallToolResult({
        content: [{ type: 'text', text: `${tool.name} falhou: ${forMessage(redact(message))}` }],
        isError: true,
      });
    }
  };
}

/**
 * The server with the nine tools registered, ready for any transport.
 *
 * `McpServer` is the SDK's registration front end over its own `Server` (it is reachable as
 * `.server`); it takes the zod schema each tool already carries, publishes the JSON Schema that
 * `tools/list` requires and validates arguments before the handler runs. Building the JSON Schema
 * by hand here would be a second, silently drifting copy of every input contract.
 *
 * The scanner instance is shared with the `Retriever` on purpose: the retriever consumes the
 * scanner's change delta, and a second scanner over the same vault would answer from an index
 * nobody kept in step.
 */
export function createVaultServer(vaultRoot: string): McpServer {
  const scanner = new VaultScanner({ vaultRoot });
  const retriever = new Retriever({ scanner });
  const server = new McpServer(
    { name: 'vault-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Servidor do vault de conhecimento. Busque antes de responder sobre decisões, padrões ou ' +
        'histórico do usuário, cite sempre `caminho:linha`, e registre aprendizados com vault_learn.',
    },
  );

  const redact = makeRedactor(vaultRoot);
  for (const tool of createTools({ retriever, scanner, vaultRoot })) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      toolCallback(tool, redact),
    );
  }

  return server;
}

/** Reads the environment, brings the server up on stdio, and never returns while it is connected. */
export async function main(): Promise<void> {
  let vaultRoot: string;
  try {
    vaultRoot = resolveVaultPath(process.env);
  } catch (err) {
    // stderr, never stdout: stdout IS the protocol channel, and one stray line on it desynchronises
    // the client's JSON-RPC stream.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const server = createVaultServer(vaultRoot);
  await server.connect(new StdioServerTransport());
}

/**
 * True when `entry` (i.e. `process.argv[1]`) is the module at `moduleUrl` — that is, when this file
 * is the PROGRAM being run rather than a module something imported.
 *
 * Compared through `realpathSync` because `npx` and `npm` install `bin` as a SYMLINK: `argv[1]` is
 * then the link inside `node_modules/.bin/` while `import.meta.url` is the file it points at, and a
 * raw string comparison would decide the entrypoint is a library and start nothing — `npx vault-mcp`
 * would exit 0 having printed nothing, with the client waiting forever for an `initialize` reply.
 *
 * Both arguments are parameters rather than globals so this decision is testable as the pure
 * function it is: the failure it guards against is invisible from inside a test runner, where
 * `argv[1]` is always the runner.
 */
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry === '') return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  void main().catch((err: unknown) => {
    process.stderr.write(`vault-mcp falhou ao iniciar: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
