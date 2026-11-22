import { z } from 'zod';
import { LinkGraph } from '../../graph/graph.js';
import { coded, renderTemplate } from '../../i18n/errors.js';
import { sliceAtCodePointBoundary } from '../../retrieval/budget.js';
import { autoPushEnabled, repoState } from '../../write/git.js';
import { ToolError, define, defineStructured, refreshVault, withDiagnostics } from './define.js';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, MAX_NOTE_CHARS } from './limits.js';
import { byPath, matchesFilters, noteTags, renderFrontmatterBlock, renderNoteLine, renderResult, stringField } from './render.js';
import { forMessage } from './sanitize.js';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * The six tools that read: search, get_note, list, backlinks, graph and status.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/**
 * `index` recuado até o começo do ponto de código que o contém.
 *
 * O par de `sliceAtCodePointBoundary`, que cuida do FIM de uma fatia: aqui o que se protege é o
 * COMEÇO. Os offsets que este servidor anuncia caem sempre em fronteira, então o recuo só entra
 * quando alguém escreve um offset à mão — e é exatamente aí que ele importa, porque começar num
 * surrogate BAIXO devolve meio par, que não é caractere nenhum e que qualquer camada por cima
 * substitui por U+FFFD antes de o leitor ver.
 *
 * Recuar, e não avançar: avançar descartaria em silêncio o caractere que o chamador pediu.
 */
function snapToCodePointStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/** Default and ceiling of `vault_graph`'s `max_nodes` (contract 1.11). */
const DEFAULT_GRAPH_NODES = 2000;

const MAX_GRAPH_NODES = 5000;

const GRAPH_LINK = z.object({ source: z.string(), target: z.string() }).strict();

/**
 * The `structuredContent` of `vault_graph`, as fleetmates deck contract 1.11 fixes it.
 *
 * Strict objects: a client drawing the graph reads these keys by name, so a field that drifts is a
 * schema failure in the SDK, not a node that silently loses its colour. `broken` is present only
 * with `include_broken`; `counts.broken` is always the number of broken links of the returned
 * nodes, so a client can show it without asking for the list.
 */
const VAULT_GRAPH_OUTPUT = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          tipo: z.string().nullable(),
          status: z.string().nullable(),
          tags: z.array(z.string()),
          area: z.string(),
          domain: z.string().nullable(),
          in_degree: z.number().int().nonnegative(),
          out_degree: z.number().int().nonnegative(),
          mtime_ms: z.number(),
        })
        .strict(),
    ),
    edges: z.array(GRAPH_LINK),
    broken: z.array(GRAPH_LINK).optional(),
    truncated: z.boolean(),
    counts: z
      .object({
        notes: z.number().int().nonnegative(),
        edges: z.number().int().nonnegative(),
        orphans: z.number().int().nonnegative(),
        broken: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/** The `structuredContent` of `vault_status`. `null` where a fact does not apply, never an absent key. */
const VAULT_STATUS_OUTPUT = z.object({
  version: z.string(),
  notes: z.number(),
  chunks: z.number(),
  diagnostics: z.number(),
  readOnly: z.boolean(),
  autoPush: z.boolean(),
  repository: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  pendingCommits: z.array(
    z.object({ paths: z.array(z.string()), message: z.string(), attempts: z.number(), at: z.string() }),
  ),
  lock: z.object({ pid: z.number(), host: z.string(), at: z.string() }).nullable(),
});

/** The read tools, in the order `tools/list` publishes them. */
export function readTools(ctx: ToolContext): ToolDefinition[] {
  const { deps, m, redact, layout, vaultLock } = ctx;

  const vaultSearch = define(
    redact,
    m,
    'vault_search',
    m.tools.vault_search.description,
    {
      query: z.string().min(1, m.validation.queryEmpty).describe(m.tools.vault_search.query),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(m.tools.vault_search.limit),
      type: z.string().optional().describe(m.tools.vault_search.type),
      folder: z.string().optional().describe(m.tools.vault_search.folder),
      tags: z.array(z.string()).optional().describe(m.tools.vault_search.tags),
      status: z.string().optional().describe(m.tools.vault_search.status),
      include_raw: z
        .boolean()
        .optional()
        .describe(m.tools.vault_search.include_raw),
    },
    async (input) => {
      const { results, suggestions } = deps.retriever.search({
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.type === undefined ? {} : { tipo: input.type }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.include_raw === undefined ? {} : { includeRaw: input.include_raw }),
      });

      // The query is caller-supplied and echoed back, so it is escaped like anything else that
      // lands in a structured line: a query carrying a newline would otherwise print a line
      // shaped exactly like a result this search never found.
      const query = forMessage(input.query);
      if (results.length === 0) {
        const head = `${m.results.noResultsFor} "${query}".`;
        return withDiagnostics(
          suggestions === undefined
            ? head
            : `${head}\n${m.results.similarTerms}: ${forMessage(suggestions.join(', '))}`,
          deps,
          redact,
          m,
        );
      }

      const head =
        `${results.length} ${m.results.resultsFor} "${query}". ` +
        m.results.citePreamble +
        m.results.citePreambleTail;
      return withDiagnostics(
        [head, ...results.map((item) => renderResult(item, m))].join('\n\n'),
        deps,
        redact,
        m,
      );
    },
  );

  const vaultGetNote = define(
    redact,
    m,
    'vault_get_note',
    m.tools.vault_get_note.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_get_note.path),
      offset: z.number().int().min(0).optional().describe(m.tools.vault_get_note.offset),
    },
    async (input) => {
      refreshVault(deps);
      const note = deps.scanner.getNote(input.path);
      if (note === undefined) {
        throw coded(new ToolError(`nota não encontrada: ${forMessage(input.path)}`), 'note.notFound', { path: forMessage(input.path) });
      }

      const asked = input.offset ?? 0;
      // Um offset no fim ou além dele é RECUSADO, não atendido com vazio. As duas situações que
      // ele confunde — "já li a nota inteira" e "pedi o lugar errado" — pedem coisas opostas de
      // quem chamou, e uma resposta vazia não distingue as duas. `asked === 0` fica de fora
      // porque é a chamada padrão: uma nota de corpo vazio não é um erro.
      if (asked > 0 && asked >= note.body.length) {
        throw coded(
          new ToolError(
            `offset ${asked} além do fim de ${forMessage(input.path)}: a nota tem ${note.body.length} caracteres`,
          ),
          'note.offsetPastEnd',
          { offset: asked, path: forMessage(input.path), total: note.body.length },
        );
      }
      const offset = snapToCodePointStart(note.body, asked);

      // The body is relayed RAW — no `sanitizeQuoted`, no `> ` — and that is a decision, not an
      // omission. `vault_edit_note` locates `old_text` as an EXACT substring of the file, so an
      // agent that reads a note here and then edits a piece of it must be handed the bytes that are
      // on disk; escaping a control would make every such edit fail to match, silently, on exactly
      // the notes that carry one. This tool also makes no structural claim to undermine: it returns
      // one note, with no per-line prefix contract and no citation lines a body could forge. The
      // surfaces that DO make such a claim — the search snippet and the relayed diff — are
      // sanitised, and this one is bounded instead (`MAX_NOTE_CHARS`).
      // O corte é o mesmo de sempre; o que mudou é que ele agora ANUNCIA onde parou. Sem isso o
      // limite era um teto sem porta: uma nota de 39 KB — e existe uma — saía pela metade, e a
      // outra metade não era alcançável por tool nenhuma. Pior, `vault_edit_note` casa `old_text`
      // como substring EXATA do arquivo e o trecho do `vault_search` é sanitizado de propósito,
      // então não havia caminho para obter os bytes da cauda: ela era ilegível E inalterável.
      const rest = note.body.slice(offset);
      const shown = sliceAtCodePointBoundary(rest, MAX_NOTE_CHARS);
      // `sliceAtCodePointBoundary` devolve o próprio texto quando ele cabe, então comparar os
      // comprimentos responde "cortou?" exatamente — sem procurar a marca dentro do texto, que é
      // prosa comum e uma nota pode conter.
      const body =
        shown.length === rest.length
          ? shown
          : `${shown}\n[…${renderTemplate(m.results.noteTruncated, {
              max: MAX_NOTE_CHARS,
              total: note.body.length,
              // O ponto onde o corte REALMENTE parou, e não `offset + MAX_NOTE_CHARS`: os dois
              // divergem em um quando recuar de um par surrogate encolheu a fatia, e um offset
              // anunciado que não é o do corte deixa um caractere para trás a cada página.
              next: offset + shown.length,
            })}]`;

      // A continuação não repete frontmatter, links e links quebrados: eles saíram inteiros na
      // primeira página e não mudam entre as páginas de uma mesma leitura. O caminho fica, porque
      // um trecho sem ele é um trecho que ninguém consegue citar.
      const head =
        offset === 0
          ? [
              forMessage(`${note.path} — ${note.title}`),
              `${m.results.frontmatter}:`,
              // Renderizado DENTRO do ramo que o mostra: o resumo de frontmatter é a parte cara
              // desta tool (um mapa com alias expande muito além do que o YAML pesa em disco), e
              // pagá-lo numa página de continuação seria pagá-lo para descartar.
              renderFrontmatterBlock(note.frontmatter) || `  ${m.results.none}`,
              `${m.results.links}: ${note.links.length === 0 ? m.results.none : forMessage(note.links.join(', '))}`,
              `${m.results.brokenLinks}: ${
                note.brokenLinks.length === 0 ? m.results.none : forMessage(note.brokenLinks.join(', '))
              }`,
            ]
          : [
              forMessage(`${note.path} — ${note.title}`),
              `[${renderTemplate(m.results.noteSliceFrom, { offset, total: note.body.length })}]`,
            ];

      return [...head, '', body].join('\n');
    },
  );

  const vaultList = define(
    redact,
    m,
    'vault_list',
    m.tools.vault_list.description,
    {
      type: z.string().optional().describe(m.tools.vault_list.type),
      tags: z.array(z.string()).optional().describe(m.tools.vault_list.tags),
      status: z.string().optional().describe(m.tools.vault_list.status),
      folder: z.string().optional().describe(m.tools.vault_list.folder),
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional().describe(m.tools.vault_list.limit),
      offset: z.number().int().min(0).optional().describe(m.tools.vault_list.offset),
    },
    async (input) => {
      refreshVault(deps);
      // A regra é a de `matchesFilters`, a MESMA que o `vault_graph` aplica; a de tags dentro
      // dela é a do `vault_search` (`hasAllTags`).
      const notes = deps.scanner
        .allNotes()
        .filter((note) => matchesFilters(note, { ...input, tipo: input.type }))
        .sort(byPath);

      if (notes.length === 0) {
        return withDiagnostics(m.results.noNotesMatchingFilters, deps, redact, m);
      }

      const offset = input.offset ?? 0;
      // Refused, like an offset past the end of a note in `vault_get_note`: an empty page would
      // make "I have read them all" and "I asked for the wrong place" look the same.
      if (offset >= notes.length) {
        throw coded(
          new ToolError(`offset ${offset} além do fim: há ${notes.length} nota(s) com esses filtros`),
          'list.offsetPastEnd',
          { offset, total: notes.length },
        );
      }
      const page = notes.slice(offset, offset + (input.limit ?? LIST_DEFAULT_LIMIT));
      const next = offset + page.length;

      // The headline of an answer that carries everything stays the one it always was. Only a
      // page says it is a page — with the total, and with where the next one starts.
      const whole = offset === 0 && next === notes.length;
      const headline = whole
        ? `${notes.length} ${m.results.notesCount}`
        : renderTemplate(next < notes.length ? m.results.listPage : m.results.listLastPage, {
            from: offset + 1,
            to: next,
            total: notes.length,
            next,
          });
      return withDiagnostics(
        [`${headline}:`, ...page.map(renderNoteLine)].join('\n'),
        deps,
        redact,
        m,
      );
    },
  );

  const vaultBacklinks = define(
    redact,
    m,
    'vault_backlinks',
    m.tools.vault_backlinks.description,
    { path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_backlinks.path) },
    async (input) => {
      refreshVault(deps);
      const target = deps.scanner.getNote(input.path);
      // Asked rather than answered with an empty list: the graph only holds edges to notes that
      // exist, so a wrong path and a genuinely unlinked note would give the same answer, and the
      // agent would read a typo as "this note is isolated".
      if (target === undefined) {
        throw coded(new ToolError(`nota não encontrada: ${forMessage(input.path)}`), 'note.notFound', { path: forMessage(input.path) });
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
        return `${m.results.noNotesPointTo} ${forMessage(target.path)}.`;
      }
      const lines = backlinks.map((path) => {
        const note = deps.scanner.getNote(path);
        return forMessage(`- ${path}${note === undefined ? '' : ` — ${note.title}`}`);
      });
      return [`${backlinks.length} ${m.results.notesPointTo} ${forMessage(target.path)}:`, ...lines].join('\n');
    },
  );

  const vaultGraph = defineStructured(
    redact,
    m,
    'vault_graph',
    m.tools.vault_graph.description,
    {
      folder: z.string().optional().describe(m.tools.vault_graph.folder),
      type: z.string().optional().describe(m.tools.vault_graph.type),
      tags: z.array(z.string()).optional().describe(m.tools.vault_graph.tags),
      status: z.string().optional().describe(m.tools.vault_graph.status),
      include_raw: z.boolean().optional().describe(m.tools.vault_graph.include_raw),
      include_broken: z.boolean().optional().describe(m.tools.vault_graph.include_broken),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(MAX_GRAPH_NODES)
        .optional()
        .describe(m.tools.vault_graph.max_nodes),
    },
    VAULT_GRAPH_OUTPUT,
    async (input) => {
      refreshVault(deps);
      // Rebuilt per call, for the reason `vault_backlinks` gives.
      const graph = new LinkGraph();
      graph.build(deps.scanner.allNotes());

      // Filters select NODES, with the rule `vault_list` applies; `01-raw/` is left out unless asked
      // for, like in `vault_search`, and `99-archive/` stays in (it is findable, only demoted in
      // ranking).
      const selected = deps.scanner
        .allNotes()
        .filter((note) => input.include_raw === true || !note.path.startsWith(`${layout.folders.raw}/`))
        .filter((note) => matchesFilters(note, { ...input, tipo: input.type }))
        .sort(byPath);
      const max = input.max_nodes ?? DEFAULT_GRAPH_NODES;
      const truncated = selected.length > max;
      const notes = truncated ? selected.slice(0, max) : selected;
      const ids = new Set(notes.map((note) => note.path));

      // An edge only when BOTH ends are returned: a filtered view with one end missing would draw
      // a line to nothing. Degrees count within that subgraph, for the same reason.
      const edges = graph
        .edges()
        .filter(([source, target]) => ids.has(source) && ids.has(target))
        .map(([source, target]) => ({ source, target }));
      const inDegree = new Map<string, number>();
      const outDegree = new Map<string, number>();
      for (const { source, target } of edges) {
        outDegree.set(source, (outDegree.get(source) ?? 0) + 1);
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }

      const nodes = notes.map((note) => {
        const segments = note.path.split('/');
        return {
          id: note.path,
          title: note.title,
          tipo: stringField(note, 'tipo') ?? null,
          status: stringField(note, 'status') ?? null,
          tags: noteTags(note),
          // A note at the vault root has no area: its first segment is its own file name.
          area: segments.length > 1 ? segments[0]! : '',
          domain: segments.length > 2 && segments[0] === layout.folders.wiki ? segments[1]! : null,
          in_degree: inDegree.get(note.path) ?? 0,
          out_degree: outDegree.get(note.path) ?? 0,
          mtime_ms: note.mtimeMs,
        };
      });
      const broken = notes.flatMap((note) =>
        note.brokenLinks.map((target) => ({ source: note.path, target })),
      );
      const orphans = nodes.filter((node) => node.in_degree === 0 && node.out_degree === 0).length;
      const counts = { notes: nodes.length, edges: edges.length, orphans, broken: broken.length };

      const text = [
        renderTemplate(m.results.graphSummary, {
          notes: counts.notes,
          edges: counts.edges,
          orphans: counts.orphans,
        }),
        ...edges.map(({ source, target }) => forMessage(`- ${source} -> ${target}`)),
      ].join('\n');
      return {
        text: withDiagnostics(text, deps, redact, m),
        structured: {
          nodes,
          edges,
          ...(input.include_broken === true ? { broken } : {}),
          truncated,
          counts,
        },
      };
    },
  );

  /**
   * The operator's view, and the one read tool that looks at git.
   *
   * It exists because a write that could not be committed answers "Commit: no" once, to whoever
   * happened to make it, and until now nothing could be asked afterwards: not whether a commit is
   * still pending, not whether the branch ever left the machine, not who is holding the lock a
   * write is waiting on.
   */
  const vaultStatus = defineStructured(
    redact,
    m,
    'vault_status',
    m.tools.vault_status.description,
    {},
    VAULT_STATUS_OUTPUT,
    async () => {
      const stats = deps.retriever.stats();
      const [repo, holder] = await Promise.all([
        repoState(deps.vaultRoot),
        vaultLock().then((lock) => lock.holder()),
      ]);
      const diagnostics = deps.scanner.diagnostics.length;
      const autoPush = autoPushEnabled();
      const s = m.status;

      const lines = [
        `vault-mcp ${deps.version ?? '?'}`,
        renderTemplate(s.vault, { notes: stats.notes, chunks: stats.chunks, diagnostics }),
        !repo.repository
          ? s.repositoryNone
          : repo.detached || repo.branch === undefined
            ? s.repositoryDetached
            : renderTemplate(s.repositoryBranch, { branch: forMessage(repo.branch) }),
      ];
      if (repo.repository) {
        lines.push(
          repo.ahead === undefined || repo.behind === undefined
            ? s.upstreamNone
            : renderTemplate(s.upstream, { ahead: repo.ahead, behind: repo.behind }),
          renderTemplate(s.pending, { count: repo.pending.length }),
          // A commit message carries a note title, which is text a model chose over clipped
          // content: escaped like everything else that lands on a line of its own.
          ...repo.pending.map(
            (entry) =>
              `  ${renderTemplate(s.pendingItem, {
                at: forMessage(entry.at),
                attempts: entry.attempts,
                message: forMessage(entry.message),
              })}`,
          ),
        );
      }
      lines.push(
        holder === undefined
          ? s.lockFree
          : renderTemplate(s.lockHeld, { pid: holder.pid, host: forMessage(holder.host), at: forMessage(holder.at) }),
        autoPush ? s.autoPushOn : s.autoPushOff,
        deps.readOnly === true ? s.modeReadOnly : s.modeReadWrite,
      );

      return {
        text: lines.join('\n'),
        structured: {
          version: deps.version ?? '?',
          notes: stats.notes,
          chunks: stats.chunks,
          diagnostics,
          readOnly: deps.readOnly === true,
          autoPush,
          repository: repo.repository,
          branch: repo.branch ?? null,
          detached: repo.detached,
          ahead: repo.ahead ?? null,
          behind: repo.behind ?? null,
          pendingCommits: repo.pending,
          lock: holder === undefined ? null : { pid: holder.pid, host: holder.host, at: holder.at },
        },
      };
    },
  );

  return [vaultSearch, vaultGetNote, vaultList, vaultBacklinks, vaultGraph, vaultStatus];
}
