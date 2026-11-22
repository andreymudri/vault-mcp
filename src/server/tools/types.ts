import type { z } from 'zod';
import type { Layout } from '../../config/layout.js';
import type { Messages } from '../../i18n/messages.js';
import type { Retriever } from '../../retrieval/retrieval.js';
import type { VaultScanner } from '../../vault/scanner.js';
import type { Logger } from '../logger.js';
import type { VaultLock } from '../../write/vault-lock.js';
import type { Committed, DeferredPush, WriteQueue } from './write-queue.js';

/**
 * What a tool is, what it is handed, and what it claims about itself: the shapes every other
 * module in this directory builds or consumes.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/** A tool answer, in the shape the MCP `tools/call` result expects. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** True for a refusal the agent should read and react to, never for a crash. */
  isError?: boolean;
  /** The same answer as data, for the tools that declare an `outputSchema`. Never on an error. */
  structuredContent?: Record<string, unknown>;
}

/**
 * What a tool does to the vault, in the terms the MCP spec gives a client to decide with — whether
 * to ask the user first, whether a call can be retried, whether calls can run side by side.
 *
 * They are hints and they are claims: a client is told not to trust them from a server it does not
 * trust, and this one should be able to stand behind each. `destructiveHint: false` means "only
 * ever adds", which is true of exactly one writer here.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // The vault is a closed set of files on this machine. Nothing a tool reads comes from elsewhere.
  openWorldHint: false,
};

/** A writer that can replace or remove what was there, and that is not the same call twice. */
export const REPLACES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * One entry per tool, by name. `createTools` refuses to build a tool that is missing here, so a
 * twelfth tool cannot ship without somebody deciding what it does to the vault.
 */
export const ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  vault_search: READ_ONLY,
  vault_get_note: READ_ONLY,
  vault_list: READ_ONLY,
  vault_backlinks: READ_ONLY,
  vault_graph: READ_ONLY,
  vault_status: READ_ONLY,
  // Writing the same content to the same path twice leaves what the first call left.
  vault_write_note: { ...REPLACES, idempotentHint: true },
  vault_edit_note: REPLACES,
  // Creates a note or appends to one, and appends to the MOC and the daily note: additive. Not
  // idempotent — said twice, the learning is recorded twice.
  vault_learn: { ...REPLACES, destructiveHint: false },
  vault_move: REPLACES,
  vault_delete: REPLACES,
};

export interface ToolDefinition {
  name: string;
  /** A short human name for the tool, in the server's language. */
  title: string;
  description: string;
  annotations: ToolAnnotations;
  /** A zod object schema. `index.ts` converts it to JSON Schema for `tools/list`. */
  inputSchema: z.ZodObject;
  /**
   * A zod object schema for `structuredContent`, on the tools that answer data as well as text.
   * `index.ts` publishes it in `tools/list`, and the SDK validates every successful answer with it.
   */
  outputSchema?: z.ZodObject;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolDeps {
  retriever: Retriever;
  /** MUST be the very scanner the retriever was built with — see `refreshVault`. */
  scanner: VaultScanner;
  vaultRoot: string;
  /**
   * O catálogo do idioma em que este servidor FALA. OBRIGATÓRIO, e não opcional-com-padrão: a
   * versão opcional deixava um chamador esquecer o argumento e receber inglês num servidor
   * português sem erro de compilação, e o número desses padrões silenciosos CRESCEU no mesmo
   * commit que consertava esta classe de bug. O único padrão do sistema mora em `resolveLang`,
   * onde está documentado. Ver `src/i18n/lang.ts` para a fronteira entre o traduzível e o
   * vocabulário do vault.
   */
  messages: Messages;
  /**
   * The cross-process lock every write takes. Optional, and the default is the right one: a lock at
   * the path `lockPathFor` derives from the vault, which is the path every other server over the
   * same vault derives too. Injected only by a test that needs to hold or to break it.
   */
  lock?: VaultLock;
  /** How long a write waits for that lock, from `VAULT_LOCK_TIMEOUT_MS`. Default in `vault-lock.ts`. */
  lockTimeoutMs?: number;
  /**
   * The server's version, for `vault_status`. Handed in rather than imported: the one module that
   * knows it is `index.ts`, which imports this one.
   */
  version?: string;
  /** Where a write that did not go as asked is recorded. Absent in tests that do not look. */
  logger?: Logger;
  /** True when the server publishes no write tool (`VAULT_READ_ONLY`), for `vault_status` to say so. */
  readOnly?: boolean;
  /**
   * The vault's layout (`.vault-mcp.json`): where the wiki, the journal and the archive are. It
   * MUST be the one the scanner and the retriever were built with. The default one when absent.
   */
  layout?: Layout;
}

/**
 * What the tool definitions close over: the server's dependencies, and the write machinery
 * `createToolset` builds once and hands to both families of tools.
 */
export interface ToolContext {
  deps: ToolDeps;
  m: Messages;
  redact: (text: string) => string;
  layout: Layout;
  writes: WriteQueue;
  /** The cross-process lock of this vault. */
  vaultLock: () => Promise<VaultLock>;
  /** A write with exclusion against this process and every other. See `createToolset`. */
  lockedWrite: <T extends Committed>(
    tool: string,
    run: (git: DeferredPush) => Promise<T>,
  ) => Promise<{ value: T; warning?: string }>;
}
