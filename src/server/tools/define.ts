import { z } from 'zod';
import { errorContext, renderTemplate } from '../../i18n/errors.js';
import type { Messages } from '../../i18n/messages.js';
import type { Diagnostic } from '../../types.js';
import { forMessage, redactDeep } from './sanitize.js';
import {
  ANNOTATIONS,
  ERROR_META_KEY,
  type RefusalCode,
  type ToolDefinition,
  type ToolDeps,
  type ToolResult,
} from './types.js';

/**
 * How a tool is built: argument validation and legacy names, the translation of errors, the
 * diagnostics footer, and the wrapper that turns every failure into an answer.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/**
 * Brings the vault up to date THROUGH the retriever, which is the only component allowed to
 * consume the scanner's delta.
 *
 * `VaultScanner.refresh()` reports what changed SINCE THE LAST CALL and `Retriever.sync()` (called
 * at the top of every `search`) is what turns that delta into index and graph updates. So a read
 * tool that called `scanner.refresh()` on its own would swallow the delta: the retriever's next
 * `search` would be told nothing changed and would answer from an index missing the note the user
 * just wrote. Searching for the empty string is a no-op query — `tokenize('')` yields no terms, so
 * no posting list is walked and no suggestion pair is scored — whose only effect is the sync every
 * read tool needs anyway.
 */
export function refreshVault(deps: ToolDeps): void {
  deps.retriever.search({ query: '' });
}

/**
 * A refusal the AGENT is meant to read and act on — a path that names no note, an argument the
 * vault cannot accept — as opposed to a failure of this server.
 *
 * It exists so the two are distinguishable in the answer: `isError` is set either way (an agent
 * that cannot tell a refusal from an answer will happily quote "nota não encontrada" as content),
 * but a `ToolError`'s message is shown as written, while anything else is prefixed with the tool
 * name and the word "falhou".
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * `fail` with the code of the refusal beside the text, under {@link ERROR_META_KEY} in `_meta`.
 *
 * The text is written for a model and in the server's language; a program deciding what to do
 * next — retry a `lock.timeout`, re-preview a `preview_stale`, give up on a `path.outsideVault` —
 * should not have to parse it.
 */
export function refuse(text: string, code: string, params?: Record<string, unknown>): ToolResult {
  const refusal: RefusalCode = {
    code,
    ...(params === undefined || Object.keys(params).length === 0 ? {} : { params }),
  };
  return { ...fail(text), _meta: { [ERROR_META_KEY]: refusal } };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `query: campo obrigatório; limit: esperado number, recebido string`.
 *
 * zod's own messages are English, and everything this server says to its caller is Portuguese, so
 * the two shapes that make up virtually every rejection — a missing field and a wrong type — are
 * translated here rather than by hanging a custom message off each of the twenty-odd fields, where
 * the next field added would silently be the one in English.
 */
export function describeIssues(error: z.ZodError, m: Messages, args: unknown): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      // zod 4 no longer says what it RECEIVED, only what it expected, so the type is read off the
      // argument itself, at the path the issue names.
      const received = issue.code === 'invalid_type' ? receivedType(valueAt(args, issue.path)) : '';
      const message =
        issue.code === 'invalid_type'
          ? received === 'undefined'
            ? m.validation.requiredField
            : m.validation.wrongType
                .replace('{expected}', String(issue.expected))
                .replace('{received}', received)
          : issue.code === 'unrecognized_keys'
            ? renderTemplate(m.validation.unknownArgument, { keys: issue.keys.join(', ') })
            : issue.message;
      return where === '' ? message : `${where}: ${message}`;
    })
    .join('; ');
}

/** The value an issue's path points at inside the arguments, or `undefined` when it leads nowhere. */
export function valueAt(args: unknown, path: readonly PropertyKey[]): unknown {
  let value = args;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

/** The name of a value's type as a validation message says it: `array` and `null` are not `object`. */
export function receivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  return typeof value;
}

/**
 * The argument names each tool took before its schema was written in English, and what each is
 * called now.
 *
 * The published schema carries ONLY the new names: a model reads the schema on every session, so
 * it adapts by itself, and a schema that listed both would lose its `required` on four fields of
 * `vault_learn` (neither spelling could be marked mandatory). What cannot adapt by itself is a
 * script written against the old names, so those are still accepted — renamed by the handler
 * (`defineStructured`) before it validates. That is the only door: the server answers
 * `tools/call` itself, so no validation runs ahead of the handler.
 */
export const LEGACY_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  vault_search: { tipo: 'type' },
  vault_list: { tipo: 'type' },
  vault_graph: { tipo: 'type' },
  vault_learn: {
    titulo: 'title',
    contexto: 'context',
    dominio: 'domain',
    projeto: 'project',
    confirm_novo_dominio: 'confirm_new_domain',
  },
  vault_move: { confirm_novo_dominio: 'confirm_new_domain' },
};

/** Both spellings of one argument, sent with values that disagree. */
export interface LegacyConflict {
  legacy: string;
  canonical: string;
}

/**
 * `args` with every legacy name replaced by its current one.
 *
 * Sent under both names with the SAME value, the legacy one is simply dropped. With different
 * values there is no right answer to pick, so nothing is renamed and the conflict is reported for
 * the caller to refuse.
 */
export function applyLegacyArguments(
  tool: string,
  args: unknown,
): { args: unknown; conflict?: LegacyConflict } {
  const renames = LEGACY_ARGUMENTS[tool];
  if (renames === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { args };
  }
  const source = args as Record<string, unknown>;
  if (!Object.keys(renames).some((legacy) => Object.hasOwn(source, legacy))) return { args };

  const out: Record<string, unknown> = { ...source };
  for (const [legacy, canonical] of Object.entries(renames)) {
    if (!Object.hasOwn(source, legacy)) continue;
    if (Object.hasOwn(source, canonical) && JSON.stringify(source[canonical]) !== JSON.stringify(source[legacy])) {
      return { args, conflict: { legacy, canonical } };
    }
    out[canonical] = source[legacy];
    delete out[legacy];
  }
  return { args: out };
}

/**
 * Wraps a tool body so that NOTHING escapes as an exception: bad input and a thrown error both
 * come back as `isError` content.
 *
 * That is the contract the plan asks for — a malformed note must never take the process down — and
 * it holds for direct callers too, not only for the ones coming through the protocol adapter.
 */
/**
 * A mensagem de um erro no idioma do catálogo, ou a original quando ele não carrega código.
 *
 * O português do template é BYTE-IDÊNTICO ao literal do `throw`, então em modo pt nada muda —
 * o que mantém verdes as dezenas de testes de unidade que afirmam sobre `err.message` direto.
 */
export function translateError(err: unknown, m: Messages): string {
  const { code, params, hint } = errorContext(err);
  if (code === undefined) return messageOf(err);
  const codes = m.errorCodes as Record<string, string | undefined>;
  const template = codes[code];
  if (template === undefined) return messageOf(err);
  // Um parâmetro pode ser ELE PRÓPRIO um código — `learn.badDomain` recebe o motivo apurado por
  // `dominioProblem`. Sem resolver aqui, o invólucro sai traduzido com o miolo em português, que
  // é exatamente o defeito que este trabalho todo existe para fechar.
  const resolved = Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) => [k, (typeof v === 'string' && codes[v]) || v]),
  );
  const text = renderTemplate(template, resolved);
  const hintTemplate = hint === undefined ? undefined : codes[hint.code];
  if (hint === undefined || hintTemplate === undefined) return text;
  return `${text}; ${renderTemplate(hintTemplate, hint.params)}`;
}

/**
 * Quantos arquivos com problema o rodapé NOMEIA antes de virar contagem.
 *
 * Um vault restaurado com `cp -al` põe todas as notas fora do índice de uma vez, e listar as 104
 * empurraria para fora da tela a resposta que foi pedida — o aviso passaria a esconder aquilo
 * sobre o que ele avisa. Três nomes bastam para o leitor reconhecer a CLASSE do problema, e a
 * contagem diz o tamanho dele.
 */
export const MAX_DIAGNOSTIC_LINES = 3;

/**
 * A mensagem de um diagnóstico no idioma do catálogo, ou a original quando ele não traz código.
 * A mesma regra de `translateError`, e pela mesma razão — ver `src/i18n/errors.ts`.
 */
export function translateDiagnostic(diagnostic: Diagnostic, m: Messages): string {
  const codes = m.errorCodes as Record<string, string | undefined>;
  const template = diagnostic.code === undefined ? undefined : codes[diagnostic.code];
  return template === undefined
    ? diagnostic.message
    : renderTemplate(template, diagnostic.params ?? {});
}

/**
 * O que o scanner descobriu de errado, anexado à resposta de uma tool que varre o vault inteiro.
 *
 * `VaultScanner.diagnostics` era um beco sem saída: nada fora do scanner o lia. Isso tornava
 * FALSA a justificativa de três decisões documentadas — dropar hard link do índice foi defendido
 * porque a nota sai "de forma RUIDOSA, um diagnostic por nota", e o `catch` do arquivo ilegível
 * diz "reported". Na prática, um vault restaurado com `cp -al` respondia "nenhum resultado" e
 * nada explicava por quê.
 *
 * Vai nas duas tools que respondem "o que existe no vault" (`vault_search`, `vault_list`), e em
 * TODOS os caminhos de saída delas — inclusive o "nenhum resultado", que é justamente onde a
 * explicação vale mais.
 *
 * As linhas são REDIGIDAS antes de escapadas, na mesma ordem que `define` usa: o detalhe de um
 * erro de `stat` traz o caminho absoluto que a raiz do vault não deve vazar, e o nome do arquivo
 * vem do disco — um nome com quebra de linha forjaria uma linha do servidor sem o escape.
 */
export function diagnosticsFooter(deps: ToolDeps, redact: (text: string) => string, m: Messages): string {
  const diagnostics = deps.scanner.diagnostics;
  if (diagnostics.length === 0) return '';
  const shown = diagnostics.slice(0, MAX_DIAGNOSTIC_LINES);
  const rest = diagnostics.length - shown.length;
  return [
    `${m.results.warning}: ${renderTemplate(m.results.diagnosticsHeader, { count: diagnostics.length })}`,
    ...shown.map(
      (diagnostic) =>
        `  ${forMessage(redact(`${diagnostic.path}: ${translateDiagnostic(diagnostic, m)}`))}`,
    ),
    ...(rest > 0 ? [`  ${renderTemplate(m.results.diagnosticsMore, { count: rest })}`] : []),
  ].join('\n');
}

/** `text` com o rodapé de diagnósticos, quando há algum. */
export function withDiagnostics(
  text: string,
  deps: ToolDeps,
  redact: (text: string) => string,
  m: Messages,
): string {
  const footer = diagnosticsFooter(deps, redact, m);
  return footer === '' ? text : `${text}\n\n${footer}`;
}

export function define<Shape extends z.ZodRawShape>(
  redact: (text: string) => string,
  m: Messages,
  name: string,
  description: string,
  shape: Shape,
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<string>,
): ToolDefinition {
  return defineStructured(redact, m, name, description, shape, undefined, async (input) => ({
    text: await run(input),
  }));
}

/**
 * `define` for a tool that answers data as well as text: `run` returns both, the text goes out as
 * every other tool's does and the data as `structuredContent`, under `outputSchema`.
 *
 * `define` delegates here with no schema, so the tools that answer only text keep exactly the
 * path they had. Errors take the same route in both: an `isError` answer carries the text and, in
 * `_meta`, the code of the refusal — never `structuredContent`, which on a tool with an
 * `outputSchema` has to obey it on every answer (see {@link ERROR_META_KEY}).
 */
export function defineStructured<Shape extends z.ZodRawShape>(
  redact: (text: string) => string,
  m: Messages,
  name: string,
  description: string,
  shape: Shape,
  outputSchema: z.ZodObject | undefined,
  run: (
    input: z.infer<z.ZodObject<Shape>>,
  ) => Promise<{ text: string; structured?: Record<string, unknown> }>,
): ToolDefinition {
  // STRICT: an argument this tool does not declare is refused, not dropped. zod's default is to
  // strip unknown keys, and for a filter that is the worst possible reading — `pasta` typed for
  // `folder` gave a search over the whole vault, an answer that is wrong and does not look it. The
  // published JSON Schema says the same thing (`additionalProperties: false`), so a client that
  // validates before sending catches it too.
  const inputSchema = z.object(shape).strict();
  const annotations = ANNOTATIONS[name];
  const title = (m.tools as Record<string, { displayName?: string } | undefined>)[name]?.displayName;
  if (annotations === undefined || title === undefined) {
    throw new Error(`tool ${name} has no annotations or no title`);
  }
  return {
    name,
    title,
    description,
    annotations,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    handler: async (rawArgs) => {
      const { args, conflict } = applyLegacyArguments(name, rawArgs);
      if (conflict !== undefined) {
        return refuse(
          `${m.errors.invalidInput} ${name}: ${forMessage(renderTemplate(m.validation.aliasConflict, { ...conflict }))}`,
          'input.invalid',
        );
      }
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) {
        return refuse(
          `${m.errors.invalidInput} ${name}: ${forMessage(describeIssues(parsed.error, m, args))}`,
          'input.invalid',
        );
      }
      try {
        const { text, structured } = await run(parsed.data);
        if (structured === undefined) return ok(text);
        return {
          ...ok(text),
          structuredContent: redactDeep(structured, redact) as Record<string, unknown>,
        };
      } catch (err) {
        // Redacted BEFORE escaping: the errors that carry an absolute root come from `paths.ts` and
        // `git.ts`, which build it from the real filesystem, so the root reaches here unescaped.
        // O código, quando o erro traz um, decide o texto: é assim que um erro nascido fundo em
        // `paths.ts` ou `relocate.ts` — que não tem catálogo nenhum, nem deveria ter — sai no
        // idioma pedido. Sem código, sai como veio, que é o comportamento de sempre.
        const text = translateError(err, m);
        const { code, params } = errorContext(err);
        // A refusal the caller is meant to read comes out as it is; anything else is prefixed with
        // the tool that failed. `preview_stale` is the first kind.
        const bare = err instanceof ToolError || code === 'preview_stale';
        const body = bare
          ? forMessage(redact(text))
          : `${name} ${m.errors.toolFailed}: ${forMessage(redact(text))}`;
        // The same refusal as DATA. A filesystem error carries its errno here, and one with no
        // code at all says `unknown`.
        return refuse(
          body,
          code ?? 'unknown',
          params === undefined ? undefined : (redactDeep(params, redact) as Record<string, unknown>),
        );
      }
    },
  };
}
