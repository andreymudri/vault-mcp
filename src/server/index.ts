#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { resolveLang, type Lang } from '../i18n/lang.js';
import { resolveConfig, type ServerConfig } from './config.js';
import { NULL_LOGGER, createLogger, type LogEntry, type Logger } from './logger.js';
import { messagesFor, type Messages } from '../i18n/messages.js';
import { Retriever } from '../retrieval/retrieval.js';
import { VaultScanner } from '../vault/scanner.js';
import { autoPushEnabled } from '../write/git.js';
import { createToolset, forMessage, makeRedactor, type ToolDefinition, type ToolResult } from './tools.js';

/**
 * The process a user starts: `npx @andreymudri/vault-mcp`, or `node
 * <caminho-absoluto>/dist/server/index.js` from a clone. It wires a `VaultScanner`, a `Retriever`
 * and the eleven tools of `tools.ts` onto an MCP server speaking over stdio.
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
 * `ToolResult` is deliberately the narrower type — text blocks, plus `structuredContent` on the
 * tools that declare an `outputSchema` — so `tools.ts` never has to import the protocol types; this
 * is the one place the two shapes meet.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((part) => ({ type: 'text' as const, text: part.text })),
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
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
  messages: Messages,
  logger: Logger = NULL_LOGGER,
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    try {
      const result = await tool.handler(args);
      // One line per call, at `info`: which tool, how long, and whether it answered or refused. A
      // refusal is ordinary operation — a path that names no note — so it is not a warning; what
      // an operator wants from this line is the duration and the rate of each.
      const code =
        result.isError === true
          ? (result.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code
          : undefined;
      logger.info('tool.call', {
        tool: tool.name,
        ms: elapsed(),
        ok: result.isError !== true,
        ...(typeof code === 'string' ? { code } : {}),
      });
      return toCallToolResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Reaching here means a handler let an exception out, which `define` exists to prevent.
      logger.error('tool.crashed', { tool: tool.name, ms: elapsed(), error: message });
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
 * The server with the eleven tools registered, ready for any transport.
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
/** What `createVaultServer` takes beyond the vault and the language: the parsed environment, and a logger. */
export type ServerOptions = Partial<ServerConfig> & { logger?: Logger };

/** The MCP name of each of this server's log levels. */
const MCP_LEVEL = { error: 'error', warn: 'warning', info: 'info', debug: 'debug' } as const;

/** The server, plus the two things its process needs in order to stop without leaving a mess. */
export interface VaultApp {
  server: McpServer;
  /** Resolves when no write is in flight. */
  idle(): Promise<void>;
  /** Removes any vault lock this process still holds. Synchronous: it runs on the way out. */
  releaseLocks(): void;
}

/** The server alone, for a caller that only speaks the protocol to it. */
export function createVaultServer(
  vaultRoot: string,
  lang: Lang = 'en',
  config: ServerOptions = {},
): McpServer {
  return createVaultApp(vaultRoot, lang, config).server;
}

export function createVaultApp(
  vaultRoot: string,
  lang: Lang = 'en',
  config: ServerOptions = {},
): VaultApp {
  const logger = config.logger ?? NULL_LOGGER;
  const scanner = new VaultScanner({
    vaultRoot,
    ...(config.maxNoteBytes === undefined ? {} : { maxNoteBytes: config.maxNoteBytes }),
  });
  const retriever = new Retriever({ scanner });
  const messages = messagesFor(lang);
  const server = new McpServer(
    { name: 'vault-mcp', version: VERSION },
    { capabilities: { tools: {}, logging: {} }, instructions: messages.instructions },
  );

  // The same events that go to stderr go to the client, as `notifications/message`. The SDK
  // drops what is below the level the client asked for with `logging/setLevel`, and a server
  // nobody is connected to rejects the send — which is every event logged before the handshake,
  // and is why the rejection is swallowed rather than reported back into the log it came from.
  logger.addSink((entry: LogEntry) => {
    void server
      .sendLoggingMessage({
        level: MCP_LEVEL[entry.level],
        logger: 'vault-mcp',
        data: { event: entry.event, ...entry.fields },
      })
      .catch(() => undefined);
  });

  const redact = makeRedactor(vaultRoot);
  const toolset = createToolset({
    retriever,
    scanner,
    vaultRoot,
    messages,
    version: VERSION,
    logger,
    ...(config.readOnly === true ? { readOnly: true } : {}),
    ...(config.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: config.lockTimeoutMs }),
  });
  // What is not published cannot be called: the SDK answers an unknown tool name itself. That is
  // the whole mechanism of read-only mode, and why it is decided here and not inside each handler.
  const disabled = new Set(config.disabledTools ?? []);
  const known = new Set(toolset.tools.map((tool) => tool.name));
  for (const name of disabled) {
    if (!known.has(name)) logger.warn('config.unknownTool', { variable: 'VAULT_DISABLED_TOOLS', tool: name });
  }
  const published = toolset.tools.filter(
    (tool) => !disabled.has(tool.name) && (config.readOnly !== true || tool.annotations.readOnlyHint),
  );

  for (const tool of published) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
        // Where a tool has one, the SDK publishes it and validates each successful answer.
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      },
      toolCallback(tool, redact, messages, logger),
    );
  }

  return { server, idle: toolset.idle, releaseLocks: toolset.releaseLocks };
}

/**
 * How long a termination signal waits for a write in flight before the process leaves anyway.
 *
 * A write is a file rename followed by a commit, tens of milliseconds unless a hook is slow; five
 * seconds covers a slow hook and stays under the ten most supervisors give before they stop asking.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * What the process does when it is told to stop, and when something escapes it.
 *
 * Without this a SIGTERM killed the server wherever it was. If that was between a note's `rename`
 * and its commit, the note stayed on disk in no commit and the vault lock stayed behind for the
 * next writer to wait on — and the client that had asked for the write got no answer. So a signal
 * lets the write in flight finish, hands its answer to the transport, releases the lock and only
 * then exits. A second signal is not caught: asked twice, the process just goes.
 */
function installProcessHandlers(app: VaultApp, logger: Logger): void {
  const leave = (code: number): void => {
    app.releaseLocks();
    // stdout is the protocol channel: what was written to it gets out before the process does.
    process.stdout.write('', () => process.exit(code));
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info('server.stop', { signal });
    const grace = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS).unref();
    });
    void Promise.race([app.idle().then(() => true), grace]).then((drained) => {
      if (!drained) logger.warn('server.stopForced', { signal, graceMs: SHUTDOWN_GRACE_MS });
      // One turn of the event loop first: the write that just finished still has to be rendered
      // and handed to the transport, and all of that is already queued ahead of this.
      setImmediate(() => leave(0));
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  // Whatever the way out, a lock this process holds does not outlive it.
  process.on('exit', () => app.releaseLocks());

  const onFatal = (event: string) => (reason: unknown): void => {
    logger.error(event, { error: reason instanceof Error ? reason.message : String(reason) });
    app.releaseLocks();
    process.exit(1);
  };
  process.on('uncaughtException', onFatal('server.uncaughtException'));
  process.on('unhandledRejection', onFatal('server.unhandledRejection'));
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

  const config = resolveConfig(process.env);
  const logger = createLogger({
    ...(config.logLevel === undefined ? {} : { level: config.logLevel }),
    write: (line) => process.stderr.write(`${line}\n`),
    redact: makeRedactor(vaultRoot),
  });
  // Said before anything else: a setting the server could not honour is in force as its DEFAULT,
  // and the operator who set it believes otherwise.
  for (const warning of config.warnings) logger.warn('config.invalid', { ...warning });

  const app = createVaultApp(vaultRoot, config.lang, { ...config, logger });
  installProcessHandlers(app, logger);
  await app.server.connect(new StdioServerTransport());
  logger.info('server.start', {
    version: VERSION,
    lang: config.lang,
    autoPush: autoPushEnabled(),
    readOnly: config.readOnly === true,
    node: process.version,
    pid: process.pid,
  });
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
