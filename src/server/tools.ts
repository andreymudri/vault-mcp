import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { LinkGraph } from '../graph/graph.js';
import { sliceAtCodePointBoundary } from '../retrieval/budget.js';
import type { Retriever } from '../retrieval/retrieval.js';
import type { Frontmatter, Note, ScoredChunk } from '../types.js';
import type { VaultScanner } from '../vault/scanner.js';
import { learn } from '../write/learn.js';
import { editNote, writeNote, type WriteResult } from '../write/writer.js';

/**
 * The seven tools the MCP server exposes, as plain objects: a name, a description written for an
 * agent to route on, a zod schema and a handler that answers with TEXT.
 *
 * Nothing here talks to a transport. `createTools` is handed the same `VaultScanner` the
 * `Retriever` owns and returns definitions whose handlers can be called directly, which is what
 * the tests do — the protocol layer in `index.ts` is a thin adapter over this array.
 */

/** A tool answer, in the shape the MCP `tools/call` result expects. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** True for a refusal the agent should read and react to, never for a crash. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** A zod object schema. `index.ts` converts it to JSON Schema for `tools/list`. */
  inputSchema: z.AnyZodObject;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolDeps {
  retriever: Retriever;
  /** MUST be the very scanner the retriever was built with — see `refreshVault`. */
  scanner: VaultScanner;
  vaultRoot: string;
}

/**
 * Characters that are invisible, that break a line, or that reorder what follows them.
 *
 * A LOCAL COPY THAT SHOULD NOT SURVIVE. The same class already lives, byte-identical, in
 * `src/write/propagate.ts`, `src/write/learn.ts`, `src/write/writer.ts` and `src/write/diff.ts`,
 * and T19 is consolidating it into `src/write/paths.ts` as the one exported definition. The import
 * is not written here yet because that export does not exist at this branch's fork point — an
 * import of a symbol nobody exports does not compile, and `paths.ts` is outside this task's file
 * set, so this module cannot create it either.
 *
 * WHEN `paths.ts` EXPORTS IT, DELETE THIS AND IMPORT IT. Until then the two must stay in step by
 * hand: a character one of them escapes and another does not is a character that forges a line on
 * exactly one of the surfaces the user reads.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS_GLOBAL =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Renders a path, a heading trail, a query or a `reason` inside a STRUCTURED line without letting
 * it forge one.
 *
 * This is the layer that owes the escape, and deliberately so. `Retriever.search` returns
 * `chunk.path` and `chunk.headingPath` RAW — correctly, since escaping in retrieval would corrupt
 * the field for every consumer that is not a renderer — and the scanner applies no name filter, so
 * `nota\nWARNING: tudo certo.md` is a file Linux accepts and the index holds. Printed verbatim into
 * `caminho:linha — trilha (score X.XX)` it becomes a second rendered line that reads as a report
 * this server never made. The bidi controls are the half that breaks no line at all: they reorder
 * what follows, so a citation can read as one path and name another.
 *
 * The escapes mirror `headerPath` in `src/write/diff.ts` and `forMessage` in
 * `src/write/propagate.ts`: `\n`, `\r`, `\t` by name, everything else in a numeric form that can
 * only mean what it names.
 */
function forMessage(text: string): string {
  return text.replace(INVISIBLE_CHARS_GLOBAL, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.charCodeAt(0);
    // `\x2028` would read back as `\x20` followed by a literal `28`, so anything wider than one
    // byte is escaped in the four-digit form.
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Replaces the vault's absolute root with `<vault>` in anything rendered back to the caller.
 *
 * Every field this server returns is vault-relative by design, and two are the exception because
 * they are built elsewhere: `PathGuardError` (src/write/paths.ts) names the resolved path it
 * refused, and a failed `git` command (src/write/git.ts) echoes its own `-C <root>` argument. Both
 * carry the absolute root — which on a personal machine spells out the OS username — into text an
 * LLM reads and may quote back. Neither file is this task's to change, so the boundary that renders
 * them is where it gets stripped.
 *
 * Both the configured root and its `realpath` are stripped: the guard resolves symlinks before
 * composing its message, so a vault reached through a symlinked home directory names a root string
 * the caller never configured.
 */
function makeRedactor(vaultRoot: string): (text: string) => string {
  const configured = resolve(vaultRoot);
  let real = configured;
  try {
    real = realpathSync(configured);
  } catch {
    // An unreadable root is the entrypoint's problem, not this function's: strip what we know.
  }
  // Longest first, so a root that is a prefix of the other cannot leave a tail behind.
  const roots = [...new Set([configured, real])]
    .filter((root) => root !== '' && root !== '/')
    .sort((a, b) => b.length - a.length);
  return (text) => roots.reduce((acc, root) => acc.split(root).join('<vault>'), text);
}

/** How much of a note's body `vault_get_note` returns before cutting it. */
const MAX_NOTE_CHARS = 20_000;

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
function refreshVault(deps: ToolDeps): void {
  deps.retriever.search({ query: '' });
}

/**
 * How long the queue waits for one write before it lets the NEXT one start.
 *
 * Far above any real write — a `vault_learn` touching four files and committing measures in tens of
 * milliseconds — because the bound is not a performance knob: it is the line between "slow" and
 * "never going to finish".
 */
export const WRITE_SLOT_TIMEOUT_MS = 60_000;

const EXCLUSIVITY_WARNING =
  `uma escrita anterior passou de ${WRITE_SLOT_TIMEOUT_MS} ms e pode ainda estar em andamento; ` +
  'esta chamada não teve exclusão garantida contra ela';

/**
 * Serializes the write tools against each other.
 *
 * `learn()` checks whether a path exists and then publishes with `rename` (src/write/atomic.ts),
 * and the window between the two is a TOCTOU: two overlapping `vault_learn` calls both reported
 * `{action:'created', committed:true}` while the FIRST insight survived in no file and in no blob —
 * the second `rename` simply replaced it. That was rated low only because nothing could issue
 * concurrent calls; this server is exactly the thing that can, so the precondition expires here.
 *
 * The queue closes it AT THIS PROCESS: no two write tool calls of one server overlap, so no write
 * can land inside another's window. It does NOT close the race against a writer outside this
 * process (Obsidian, a second server, a checkout of the vault repository) — only an
 * `O_CREAT|O_EXCL` publish in `atomic.ts` can, and that file belongs to another task. Reads are
 * deliberately NOT queued: `Retriever.search` is synchronous and the writers publish atomically, so
 * a reader sees either the old file or the new one and never waits for a commit.
 *
 * LIVENESS. The queue does not chain on the task's own promise, and that is the whole point of
 * `slot`. A task that NEVER settles — a `readFile` on a FIFO nobody writes to, a lock another
 * process holds — would otherwise leave `tail` pending forever and wedge every later write for the
 * lifetime of the process, while unqueued reads keep answering: a server that looks alive with a
 * dead write surface, reporting nothing. So each task gets a SLOT, and the slot ends when the task
 * settles OR when `slotTimeoutMs` elapses, whichever comes first.
 *
 * Losing exclusion is the deliberate trade, taken only where the alternative is losing the tool
 * entirely, and it is never taken SILENTLY: the abandoned task stays tracked, and every call that
 * could have overlapped it is answered with `EXCLUSIVITY_WARNING`. The caller whose own write hung
 * still waits for it — the bound frees the QUEUE, not the caller, because resolving a caller's
 * promise before its write finished would report an outcome nobody observed.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Tasks whose slot expired and that have not settled since. */
  private outstanding = 0;
  /** Monotonic count of expired slots, so a call can tell whether one expired while it waited. */
  private expired = 0;

  constructor(private readonly slotTimeoutMs: number = WRITE_SLOT_TIMEOUT_MS) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    // Both arms are `task`: a rejected predecessor must not stall the queue, and a write tool that
    // failed says nothing about whether the next one may run. `slot` already resolves rather than
    // rejects, and the second arm is what keeps the queue's liveness from depending on that.
    const result = this.tail.then(task, task);
    this.tail = this.slot(result);
    return result;
  }

  /**
   * `run`, plus whether the call actually had the queue to itself.
   *
   * The question is asked across the call's whole lifetime, not at one instant: a slot that expired
   * while this call was WAITING is what let it start early, and one still outstanding when it
   * finished may have been writing the whole time.
   */
  async runExclusive<T>(task: () => Promise<T>): Promise<{ value: T; warning?: string }> {
    const expiredOnEntry = this.expired;
    const value = await this.run(task);
    const overlapped = this.expired > expiredOnEntry || this.outstanding > 0;
    return overlapped ? { value, warning: EXCLUSIVITY_WARNING } : { value };
  }

  /** True while a write that overran its slot may still be running. */
  get hasOutstanding(): boolean {
    return this.outstanding > 0;
  }

  /** Settles when `result` settles or when the slot expires, whichever comes first. */
  private slot(result: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (closed) return;
        this.outstanding += 1;
        this.expired += 1;
        // Still tracked after being abandoned: `runExclusive` reports the lost exclusion for
        // exactly as long as the task can still be writing, and stops once it cannot.
        const settled = (): void => {
          this.outstanding -= 1;
        };
        result.then(settled, settled);
        close();
      }, this.slotTimeoutMs);
      // A pending write must not be the reason the process stays alive — the transport decides
      // that. `unref` also keeps this timer from holding a test runner open.
      timer.unref();
      result.then(close, close);
    });
  }
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
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function messageOf(err: unknown): string {
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
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      const message =
        issue.code === 'invalid_type'
          ? issue.received === 'undefined'
            ? 'campo obrigatório'
            : `esperado ${issue.expected}, recebido ${issue.received}`
          : issue.message;
      return where === '' ? message : `${where}: ${message}`;
    })
    .join('; ');
}

/**
 * Wraps a tool body so that NOTHING escapes as an exception: bad input and a thrown error both
 * come back as `isError` content.
 *
 * That is the contract the plan asks for — a malformed note must never take the process down — and
 * it holds for direct callers too, not only for the ones coming through the protocol adapter.
 */
function define<Shape extends z.ZodRawShape>(
  redact: (text: string) => string,
  name: string,
  description: string,
  shape: Shape,
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<string>,
): ToolDefinition {
  const inputSchema = z.object(shape);
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) {
        return fail(`entrada inválida para ${name}: ${forMessage(describeIssues(parsed.error))}`);
      }
      try {
        return ok(await run(parsed.data));
      } catch (err) {
        // Redacted BEFORE escaping: the errors that carry an absolute root come from `paths.ts` and
        // `git.ts`, which build it from the real filesystem, so the root reaches here unescaped.
        if (err instanceof ToolError) return fail(forMessage(redact(err.message)));
        return fail(`${name} falhou: ${forMessage(redact(messageOf(err)))}`);
      }
    },
  };
}

/** Folder match on whole path segments, so `02-wiki/nest` never selects `02-wiki/nestjs/`. */
function inFolder(path: string, folder: string): boolean {
  const normalized = folder.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '' ? true : path.startsWith(`${normalized}/`);
}

/** Frontmatter comes from files nobody validated, so every field may be any YAML scalar. */
function stringField(note: Note, key: string): string | undefined {
  const value = note.frontmatter[key];
  return typeof value === 'string' ? value : undefined;
}

function noteTags(note: Note): string[] {
  const tags = note.frontmatter.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

/** Frontmatter values are whatever YAML parsed: a scalar, a list, or a nested mapping. */
function renderFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The prefix every line of quoted note text carries.
 *
 * It is what keeps a NOTE from forging a RESULT. The citation line is `caminho:linha — trilha
 * (score X.XX)` and results are separated by a blank line, so a note whose body contains a line in
 * that exact shape — trivial to plant in `01-raw/inbox/`, which is where clipped web pages land —
 * used to render as an additional result citing a note that does not exist, with content nobody
 * wrote. Escaping the body is not the answer: it is quoted prose, and a search tool that mangles
 * the text it found is worse than one that quotes it. Marking it is: with every body line prefixed,
 * a line at column zero can only have come from this server.
 */
const QUOTE_PREFIX = '> ';

/** Note text as a block that cannot be read as anything but quoted text. */
function quoteSnippet(text: string): string {
  return text
    .split('\n')
    .map((line) => `${QUOTE_PREFIX}${line}`)
    .join('\n');
}

/** One rendered result: the citation line the vault's `CLAUDE.md` requires, then the text. */
function renderResult(item: ScoredChunk): string {
  const { chunk } = item;
  const trail =
    chunk.headingPath.length === 0 ? '' : ` — ${forMessage(chunk.headingPath.join(' > '))}`;
  const flags = [
    `score ${item.score.toFixed(2)}`,
    item.viaGraph ? 'via grafo' : undefined,
    // The BOOLEAN, never the marker text. `TRUNCATION_MARKER` is ordinary prose that a note can
    // quote verbatim (`src/types.ts` says so), so matching on it would label an intact note as cut.
    item.truncated === true ? 'trecho truncado' : undefined,
  ]
    .filter((flag): flag is string => flag !== undefined)
    .join(', ');
  return `${forMessage(chunk.path)}:${chunk.lineStart}${trail} (${flags})\n${quoteSnippet(chunk.text)}`;
}

function renderNoteLine(note: Note): string {
  const details = [
    `tipo: ${stringField(note, 'tipo') ?? '—'}`,
    `status: ${stringField(note, 'status') ?? '—'}`,
    `tags: ${noteTags(note).join(', ') || '—'}`,
  ].join(', ');
  return forMessage(`- ${note.path} — ${note.title} (${details})`);
}

/** Shared tail of `vault_write_note` and `vault_edit_note`. */
function renderWrite(
  result: WriteResult,
  verb: string,
  redact: (text: string) => string,
  queueWarning?: string,
): string {
  const lines = [
    `${verb}: ${forMessage(result.path)}`,
    `Commit: ${result.committed ? 'sim' : 'não'}`,
  ];
  for (const warning of [result.warning, queueWarning]) {
    if (warning !== undefined) lines.push(`Aviso: ${forMessage(redact(warning))}`);
  }
  lines.push('', 'Diff:', result.diff === '' ? '(sem alteração de conteúdo)' : result.diff);
  return lines.join('\n');
}

/**
 * The caps `toTags` in `src/vault/frontmatter.ts` applies when it READS a note's tags back.
 *
 * Mirrored rather than imported because that function is not exported, and mirrored at all because
 * the two have to agree: a tag this tool writes past those bounds is a tag the scanner will not
 * hand back, so `vault_list` would not find the note the caller just tagged.
 */
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 128;

/**
 * `tags` as the SCANNER would read it back, from what a caller sent.
 *
 * A bare `'jwt'` is coerced, not dropped: `toTags` splits exactly such a string on commas when it
 * parses a note, so coercing here is what keeps "written by the tool" and "read by the scanner"
 * the same set — dropping it answered `Nota criada` while `vault_list {tags:['jwt']}` then failed
 * to return the note, with only the diff's `tags: []` as a signal.
 *
 * What cannot be coerced is REFUSED rather than silently reduced. A number or an object in the
 * `tags` slot has no reading that preserves the caller's intent, and `frontmatter.ts` drops a
 * container deliberately (that drop is its defence against an aliased YAML structure); reporting
 * success over a tag nobody will ever see is the outcome this refusal exists to prevent.
 */
function coerceTags(value: unknown): string[] {
  const items =
    typeof value === 'string'
      ? // Bounded before splitting, like `toTags`: a multi-megabyte scalar must not allocate a
        // million-element array only for the first `MAX_TAGS` of it to survive.
        value.slice(0, MAX_TAGS * (MAX_TAG_LENGTH + 1)).split(',')
      : value;
  if (!Array.isArray(items)) {
    throw new ToolError(
      'frontmatter.tags precisa ser uma lista de textos ou um texto com tags separadas por vírgula',
    );
  }

  const out: string[] = [];
  for (const item of items) {
    if (out.length >= MAX_TAGS) break;
    if (item === null || item === undefined || typeof item === 'object') {
      throw new ToolError('frontmatter.tags só aceita textos ou números; remova listas e objetos');
    }
    const tag = String(item).slice(0, MAX_TAG_LENGTH).trim();
    if (tag !== '') out.push(tag);
  }
  return out;
}

function toFrontmatter(input: Record<string, unknown> | undefined): Frontmatter | undefined {
  if (input === undefined) return undefined;
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(input)) {
    // `out['__proto__'] = value` is not a property assignment — it runs the setter and REPLACES
    // this object's prototype, so a caller could hand the writer an object whose inherited members
    // it never expected. The key is dropped rather than escaped: nothing in a vault's frontmatter
    // is legitimately called `__proto__`.
    if (key === '__proto__') continue;
    // An explicit `undefined` reads as "campo ausente" — `String(undefined)` would write the word
    // `undefined` into the note's metadata.
    if (value === undefined) continue;

    // The three declared fields are typed on `Frontmatter`, and a caller can send anything: a
    // `tipo` of `42` would not typecheck as the string the rest of the system compares against.
    // A scalar is coerced; `null` and a container are REFUSED, because both would fall through to
    // the writer's own default (`tipo: nota`) while the answer said the note was created as asked.
    if (key === 'tipo' || key === 'status' || key === 'criado') {
      if (value === null || typeof value === 'object') {
        throw new ToolError(`frontmatter.${key} precisa ser um texto`);
      }
      out[key] = String(value);
      continue;
    }
    if (key === 'tags') {
      out.tags = coerceTags(value);
      continue;
    }
    // Every other key keeps whatever it carries — `serializeEntry` in `src/write/template.ts`
    // quotes and escapes every value it emits, so an odd one becomes a strange string, never a
    // second key.
    out[key] = value;
  }
  return out;
}

const SEARCH_DESCRIPTION =
  'Busca semântica-lexical no vault (BM25 + um salto de wiki-links). Chame antes de responder ' +
  'qualquer pergunta sobre decisões, padrões, gotchas ou histórico do usuário, e antes de gravar ' +
  'um aprendizado novo. Devolve trechos já citados como `caminho:linha` — repita essa citação na ' +
  'resposta ao usuário. Notas de `01-raw/` ficam de fora salvo include_raw.';

const GET_NOTE_DESCRIPTION =
  'Lê uma nota inteira pelo caminho relativo ao vault (ex.: `02-wiki/nestjs/auth-guard.md`), com ' +
  'frontmatter, links resolvidos e links quebrados. Use depois de vault_search quando o trecho ' +
  'não bastar, ou antes de editar a nota.';

const LIST_DESCRIPTION =
  'Lista notas por metadado — tipo, tags, status, pasta — sem olhar o conteúdo. Use para ' +
  'inventário ("quais projetos ativos existem?", "quais notas têm a tag jwt?"), não para buscar ' +
  'assunto: para assunto use vault_search.';

const BACKLINKS_DESCRIPTION =
  'Lista as notas que apontam para a nota informada. Use para medir o quanto um assunto está ' +
  'conectado, achar o MOC que indexa a nota, ou avaliar o impacto de mudar/renomear uma nota.';

const WRITE_NOTE_DESCRIPTION =
  'Cria ou substitui uma nota inteira, com frontmatter garantido, e commita no git do vault. ' +
  'Substitui o arquivo inteiro: para mudar um trecho use vault_edit_note, e para registrar um ' +
  'aprendizado use vault_learn, que decide o destino e propaga sozinho.';

const EDIT_NOTE_DESCRIPTION =
  'Substitui UM trecho exato de uma nota existente e commita. Falha, sem escrever, se o trecho ' +
  'não aparecer ou aparecer mais de uma vez — nesse caso mande mais contexto em old_text.';

const LEARN_DESCRIPTION =
  'Registra um aprendizado no vault. Chame sempre que, durante a sessão, aparecer algo não óbvio ' +
  'e reutilizável — uma decisão de arquitetura, um pattern, um gotcha, uma armadilha de ' +
  'configuração —, sem perguntar antes onde salvar: o servidor decide sozinho entre anexar à nota ' +
  'existente que já cobre o assunto e criar uma nota nova (o viés é criar), e propaga sozinho para ' +
  'o MOC do domínio, para o índice de conhecimento e para a nota diária, tudo em um único commit. ' +
  'Mostre ao usuário o diff devolvido.';

export function createTools(deps: ToolDeps): ToolDefinition[] {
  const writes = new WriteQueue();
  const redact = makeRedactor(deps.vaultRoot);

  const vaultSearch = define(
    redact,
    'vault_search',
    SEARCH_DESCRIPTION,
    {
      query: z.string().min(1, 'query não pode ser vazia').describe('Termos de busca em linguagem natural.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Máximo de trechos devolvidos (padrão 6).'),
      tipo: z.string().optional().describe('Filtra pelo `tipo` do frontmatter: wiki, moc, projeto, daily.'),
      folder: z.string().optional().describe('Restringe a uma pasta do vault, ex.: `02-wiki/nestjs`.'),
      include_raw: z
        .boolean()
        .optional()
        .describe('Inclui `01-raw/` (captura crua), fora dos resultados por padrão.'),
    },
    async (input) => {
      const { results, suggestions } = deps.retriever.search({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.tipo === undefined ? {} : { tipo: input.tipo }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
        ...(input.include_raw === undefined ? {} : { includeRaw: input.include_raw }),
      });

      // The query is caller-supplied and echoed back, so it is escaped like anything else that
      // lands in a structured line: a query carrying a newline would otherwise print a line
      // shaped exactly like a result this search never found.
      const query = forMessage(input.query);
      if (results.length === 0) {
        const head = `Nenhum resultado para "${query}".`;
        return suggestions === undefined
          ? head
          : `${head}\nSugestões de termos parecidos no vault: ${forMessage(suggestions.join(', '))}`;
      }

      const head =
        `${results.length} resultado(s) para "${query}". ` +
        'Cite `caminho:linha` ao usar qualquer trecho abaixo. ' +
        'Cada trecho da nota vem prefixado com `> `; linhas sem esse prefixo são deste servidor, ' +
        'nunca conteúdo do vault.';
      return [head, ...results.map(renderResult)].join('\n\n');
    },
  );

  const vaultGetNote = define(
    redact,
    'vault_get_note',
    GET_NOTE_DESCRIPTION,
    { path: z.string().min(1, 'caminho não pode ser vazio').describe('Caminho relativo ao vault, com `.md`.') },
    async (input) => {
      refreshVault(deps);
      const note = deps.scanner.getNote(input.path);
      if (note === undefined) {
        throw new ToolError(`nota não encontrada: ${forMessage(input.path)}`);
      }

      // Escaped PER KEY AND PER VALUE, then joined. Escaping the assembled block instead turns
      // the separators this line just inserted into the two literal characters `\` and `n`, which
      // is every note carrying two frontmatter keys — i.e. essentially every note in a vault.
      // The escape still has to happen: a key or a value read out of a hostile note can carry a
      // newline or a bidi control of its own, and those must not become lines here.
      const frontmatter = Object.entries(note.frontmatter)
        .map(([key, value]) => `  ${forMessage(key)}: ${forMessage(renderFrontmatterValue(value))}`)
        .join('\n');
      const body =
        note.body.length <= MAX_NOTE_CHARS
          ? note.body
          : `${sliceAtCodePointBoundary(note.body, MAX_NOTE_CHARS)}\n[…nota cortada em ${MAX_NOTE_CHARS} caracteres]`;

      return [
        forMessage(`${note.path} — ${note.title}`),
        'Frontmatter:',
        frontmatter === '' ? '  (nenhum)' : frontmatter,
        `Links: ${note.links.length === 0 ? '(nenhum)' : forMessage(note.links.join(', '))}`,
        `Links quebrados: ${
          note.brokenLinks.length === 0 ? '(nenhum)' : forMessage(note.brokenLinks.join(', '))
        }`,
        '',
        body,
      ].join('\n');
    },
  );

  const vaultList = define(
    redact,
    'vault_list',
    LIST_DESCRIPTION,
    {
      tipo: z.string().optional().describe('`tipo` do frontmatter: wiki, moc, projeto, daily.'),
      tags: z.array(z.string()).optional().describe('Todas estas tags precisam estar na nota.'),
      status: z.string().optional().describe('`status` do frontmatter, ex.: ativo, pausado.'),
      folder: z.string().optional().describe('Pasta do vault, casada em fronteira de segmento.'),
    },
    async (input) => {
      refreshVault(deps);
      // Tags are compared case-insensitively: the vault writes `nestjs` and an agent routinely
      // asks for `NestJS`, and a filter that answers "nenhuma nota" to a tag that exists is read
      // as an empty vault rather than as a case mismatch.
      const wanted = (input.tags ?? []).map((tag) => tag.toLowerCase());
      const notes = deps.scanner
        .allNotes()
        .filter((note) => {
          if (input.tipo !== undefined && stringField(note, 'tipo') !== input.tipo) return false;
          if (input.status !== undefined && stringField(note, 'status') !== input.status) return false;
          if (input.folder !== undefined && !inFolder(note.path, input.folder)) return false;
          if (wanted.length > 0) {
            const tags = noteTags(note).map((tag) => tag.toLowerCase());
            if (!wanted.every((tag) => tags.includes(tag))) return false;
          }
          return true;
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      if (notes.length === 0) return 'Nenhuma nota com os filtros informados.';
      return [`${notes.length} nota(s):`, ...notes.map(renderNoteLine)].join('\n');
    },
  );

  const vaultBacklinks = define(
    redact,
    'vault_backlinks',
    BACKLINKS_DESCRIPTION,
    { path: z.string().min(1, 'caminho não pode ser vazio').describe('Caminho relativo ao vault, com `.md`.') },
    async (input) => {
      refreshVault(deps);
      const target = deps.scanner.getNote(input.path);
      // Asked rather than answered with an empty list: the graph only holds edges to notes that
      // exist, so a wrong path and a genuinely unlinked note would give the same answer, and the
      // agent would read a typo as "this note is isolated".
      if (target === undefined) {
        throw new ToolError(`nota não encontrada: ${forMessage(input.path)}`);
      }

      // Rebuilt per call rather than cached: the scanner's delta is consumed by the retriever
      // (see `refreshVault`), so this layer cannot tell whether the vault moved, and `build` is a
      // pass over the edges the scanner already resolved.
      const graph = new LinkGraph();
      graph.build(deps.scanner.allNotes());
      // `LinkGraph` stores edges in a `Set`, so a note linking `[[auth-guard]]` twice is ONE
      // backlink here — deduplicated, not dropped.
      const backlinks = graph.backlinks(target.path).sort();

      if (backlinks.length === 0) {
        return `Nenhuma nota aponta para ${forMessage(target.path)}.`;
      }
      const lines = backlinks.map((path) => {
        const note = deps.scanner.getNote(path);
        return forMessage(`- ${path}${note === undefined ? '' : ` — ${note.title}`}`);
      });
      return [`${backlinks.length} nota(s) apontam para ${forMessage(target.path)}:`, ...lines].join('\n');
    },
  );

  const vaultWriteNote = define(
    redact,
    'vault_write_note',
    WRITE_NOTE_DESCRIPTION,
    {
      path: z.string().min(1, 'caminho não pode ser vazio').describe('Caminho relativo ao vault, com `.md`.'),
      content: z.string().describe('Conteúdo markdown da nota, sem o bloco de frontmatter.'),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe('Campos do frontmatter, ex.: `{ "tipo": "wiki", "tags": ["jwt"] }`.'),
    },
    async (input) => {
      const frontmatter = toFrontmatter(input.frontmatter);
      // `writeNote`'s `tipo` argument is deliberately NOT passed, even when the caller sends
      // `tipo: 'wiki'` in the frontmatter — which still lands in the block, since `writeNote`
      // merges `frontmatter` over its defaults. That argument is what selects a `_templates/`
      // skeleton, and splicing one under content the caller already authored gives the note two
      // `# H1`s and a set of empty sections nobody asked for. The skeleton belongs to `vault_learn`,
      // which composes the body itself; here the content is the note.
      const { value: result, warning } = await writes.runExclusive(() =>
        writeNote({
          vaultRoot: deps.vaultRoot,
          path: input.path,
          content: input.content,
          ...(frontmatter === undefined ? {} : { frontmatter }),
        }),
      );
      return renderWrite(result, result.created ? 'Nota criada' : 'Nota substituída', redact, warning);
    },
  );

  const vaultEditNote = define(
    redact,
    'vault_edit_note',
    EDIT_NOTE_DESCRIPTION,
    {
      path: z.string().min(1, 'caminho não pode ser vazio').describe('Caminho relativo ao vault, com `.md`.'),
      old_text: z.string().min(1, 'old_text não pode ser vazio').describe('Trecho exato a substituir; precisa ser único na nota.'),
      new_text: z.string().describe('Texto que entra no lugar.'),
    },
    async (input) => {
      const { value: result, warning } = await writes.runExclusive(() =>
        editNote({
          vaultRoot: deps.vaultRoot,
          path: input.path,
          oldText: input.old_text,
          newText: input.new_text,
        }),
      );
      return renderWrite(result, 'Nota editada', redact, warning);
    },
  );

  const vaultLearn = define(
    redact,
    'vault_learn',
    LEARN_DESCRIPTION,
    {
      titulo: z.string().min(1, 'título não pode ser vazio').describe('Título curto do aprendizado; vira o nome do arquivo.'),
      insight: z.string().min(1, 'insight não pode ser vazio').describe('O aprendizado em si, em markdown.'),
      contexto: z.string().min(1, 'contexto não pode ser vazio').describe('Onde e por que isso apareceu.'),
      dominio: z
        .string()
        .min(1, 'domínio não pode ser vazio')
        .describe('Domínio em `02-wiki/`, ex.: nestjs, docker, patterns. Um domínio novo exige confirm_novo_dominio.'),
      projeto: z
        .string()
        .optional()
        .describe('Nome do projeto em `03-projects/` a que o aprendizado pertence; entra na linha de captura da nota diária.'),
      tags: z.array(z.string()).optional().describe('Tags do frontmatter da nota.'),
      links: z.array(z.string()).optional().describe('Wiki-links relacionados, sem os colchetes.'),
      confirm_novo_dominio: z
        .boolean()
        .optional()
        .describe('Confirma a criação de um domínio que ainda não existe em `02-wiki/`.'),
    },
    async (input) => {
      const { value: result, warning: queueWarning } = await writes.runExclusive(() =>
        learn({
          vaultRoot: deps.vaultRoot,
          retriever: deps.retriever,
          titulo: input.titulo,
          insight: input.insight,
          contexto: input.contexto,
          dominio: input.dominio,
          ...(input.projeto === undefined ? {} : { projeto: input.projeto }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.links === undefined ? {} : { links: input.links }),
          ...(input.confirm_novo_dominio === undefined
            ? {}
            : { confirmNovoDominio: input.confirm_novo_dominio }),
          now: new Date(),
        }),
      );

      const lines = [
        result.action === 'created'
          ? `Aprendizado registrado em nota NOVA: ${forMessage(result.path)}`
          : `Aprendizado ANEXADO à nota existente: ${forMessage(result.path)}`,
        // `reason` and `warning` name paths read off the vault index, so they carry whatever a
        // file name carries.
        `Motivo: ${forMessage(redact(result.reason))}`,
        `Propagado para: ${
          result.propagated.length === 0 ? '(nada)' : forMessage(result.propagated.join(', '))
        }`,
        `Commit: ${result.committed ? 'sim' : 'não'}`,
      ];
      for (const aviso of [result.warning, queueWarning]) {
        if (aviso !== undefined) lines.push(`Aviso: ${forMessage(redact(aviso))}`);
      }
      lines.push('', 'Diff (mostre ao usuário):', result.diff === '' ? '(vazio)' : result.diff);
      return lines.join('\n');
    },
  );

  return [
    vaultSearch,
    vaultGetNote,
    vaultList,
    vaultBacklinks,
    vaultWriteNote,
    vaultEditNote,
    vaultLearn,
  ];
}
