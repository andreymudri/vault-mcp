/**
 * One tool call, in a process of its own: `node --import ts-resolve.mjs tool-worker.ts <vault>
 * <tool> <json-args>`.
 *
 * It builds the scanner, the retriever and the tools exactly as `createVaultServer` does and calls
 * the handler directly — the protocol adapter adds nothing to a question about two processes
 * writing one vault, and leaving it out keeps the answer on stdout a single JSON line.
 */
import { messagesFor } from '../../src/i18n/messages.js';
import { Retriever } from '../../src/retrieval/retrieval.js';
import { createTools } from '../../src/server/tools.js';
import { VaultScanner } from '../../src/vault/scanner.js';

const [vaultRoot, name, argsJson] = process.argv.slice(2);
if (vaultRoot === undefined || name === undefined || argsJson === undefined) {
  throw new Error('usage: tool-worker.ts <vault> <tool> <json-args>');
}

const scanner = new VaultScanner({ vaultRoot });
const retriever = new Retriever({ scanner });
const tool = createTools({ retriever, scanner, vaultRoot, messages: messagesFor('en') }).find(
  (candidate) => candidate.name === name,
);
if (tool === undefined) throw new Error(`no such tool: ${name}`);

const result = await tool.handler(JSON.parse(argsJson));
process.stdout.write(
  JSON.stringify({
    isError: result.isError === true,
    text: result.content.map((part) => part.text).join('\n'),
  }),
);
