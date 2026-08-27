#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { resolveLang, type Lang } from '../i18n/lang.js';
import { messagesFor, type Messages } from '../i18n/messages.js';
import { Retriever } from '../retrieval/retrieval.js';
import { VaultScanner } from '../vault/scanner.js';
import { createTools, forMessage, makeRedactor, type ToolDefinition, type ToolResult } from './tools.js';

/**
 * The process a user starts: `npx @andreymudri/vault-mcp`, or `node
 * <caminho-absoluto>/dist/server/index.js` from a clone. It wires a `VaultScanner`, a `Retriever`
 * and the nine tools of `tools.ts` onto an MCP server speaking over stdio.
 *
 * The package is SCOPED for a concrete reason: the bare `vault-mcp` on npm belongs to somebody else
 * (`vault-mcp@0.0.1`, 443 bytes, a namespace placeholder by another author), so a plain
 * `npx vault-mcp` runs their code and not this. Under the scope there is no such collision, and the
 * `bin` keeps the short name because `npx` resolves it inside the package.
 *
 * The `npx`/`npm` mentions further down are a different subject: they are about how those tools
 * install a `bin` as a SYMLINK, which is why `isDirectRun` compares through `realpathSync`.
 *
 * The shebang on the first line is load-bearing — `package.json`'s `bin` points at the COMPILED
 * file and `tsc` copies the line through verbatim.
 */

/**
 * The version this server reports in `initialize`, read from the `package.json` that ships with it
 * instead of written out here.
 *
 * Two copies of a version number are one copy plus a lie waiting to happen: the literal that used to
 * sit in `createVaultServer` was already the published `0.1.0` by coincidence, with nothing to keep
 * it that way through the first release. The relative path resolves to the package root from BOTH
 * places this file runs — `src/server/` under vitest and `dist/server/` once compiled — and npm
 * always puts `package.json` in the tarball, `files` notwithstanding.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

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
  // O idioma sai do MESMO env, porque esta é a primeira mensagem que um usuário novo vê — e
  // quase sempre a única, já que quem esquece a variável nunca chega a ter uma sessão. Deixá-la
  // em português é entregar a um usuário do npm um erro que ele não lê, sobre a única coisa que
  // ele precisa corrigir para o servidor subir.
  const startup = messagesFor(resolveLang(env)).startup;
  const raw = env['VAULT_PATH'];
  if (raw === undefined || raw.trim() === '') throw new VaultPathError(startup.vaultPathMissing);

  const vaultRoot = resolve(raw);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(vaultRoot).isDirectory();
  } catch (err) {
    throw new VaultPathError(
      `${startup.vaultPathUnreadable} (${vaultRoot}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isDirectory) throw new VaultPathError(`${startup.vaultPathNotDirectory}: ${vaultRoot}`);
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
  messages: Messages = messagesFor('en'),
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return toCallToolResult(await tool.handler(args));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toCallToolResult({
        content: [
          { type: 'text', text: `${tool.name} ${messages.errors.toolFailed}: ${forMessage(redact(message))}` },
        ],
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
export function createVaultServer(vaultRoot: string, lang: Lang = 'en'): McpServer {
  const scanner = new VaultScanner({ vaultRoot });
  const retriever = new Retriever({ scanner });
  const messages = messagesFor(lang);
  const server = new McpServer(
    { name: 'vault-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: messages.instructions },
  );

  const redact = makeRedactor(vaultRoot);
  for (const tool of createTools({ retriever, scanner, vaultRoot, messages })) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      toolCallback(tool, redact, messages),
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

  const server = createVaultServer(vaultRoot, resolveLang(process.env));
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
    const startFailed = messagesFor(resolveLang(process.env)).startup.startFailed;
    process.stderr.write(`${startFailed}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
