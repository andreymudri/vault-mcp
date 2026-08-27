import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';

import matter from 'gray-matter';

import type { Frontmatter } from '../types.js';
import {
  classifyNode,
  forMessage,
  guardedPath,
  PathGuardError,
  type NodeKind,
} from './paths.js';
import { applyTemplate, ensureFrontmatter, formatLocal } from './template.js';
import { commitFiles } from './git.js';
import { atomicWrite } from './atomic.js';
import { unifiedDiff } from './diff.js';

/** Thrown when `editNote` cannot locate exactly one occurrence of the text to replace. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/**
 * Thrown when a CREATION lost a race: the caller had established the name was free, and by the
 * time the finished bytes were published something else had taken it.
 *
 * A distinct type because it is the one write failure with a sensible automatic answer — take
 * another free name and try again, which is what `learn.ts` does. Reported rather than absorbed
 * for `vault_write_note`, where the caller named the path and only they can decide what to do
 * about a note that is suddenly not theirs.
 */
export class WriteRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRaceError';
  }
}

export interface WriteResult {
  path: string;
  absPath: string;
  created: boolean;
  committed: boolean;
  /**
   * Whether the commit reached the remote, or `undefined` when no push was attempted. Carried
   * through unchanged from `commitFiles`: "not asked for" and "asked for and failed" are different
   * answers, and only the caller can render them differently.
   */
  pushed?: boolean;
  warning?: string;
  diff: string;
}

export interface WriteNoteOptions {
  vaultRoot: string;
  /** Vault-relative path, `.md`, validated by `guardedPath`. */
  path: string;
  content: string;
  frontmatter?: Frontmatter;
  tipo?: string;
  /**
   * The note's own title, for the template's `tp.file.title`. Defaults to a title-cased rebuild of
   * the FILE NAME, which is all this module has when the caller does not say.
   *
   * A rebuild is a lossy one: the file name is a slug, so `Check-then-act não é garantia: publique
   * com escrita exclusiva` came back as `Check Then Act Nao E Garantia Publique Com Escrita
   * Exclusiva` — accents gone, punctuation gone, every word capitalised. `vault_learn` is handed
   * the real title and passes it here; the FILE NAME stays a slug either way, because that is the
   * note's identity in the vault and in every `[[wiki-link]]` pointing at it.
   */
  title?: string;
  /**
   * Section names the caller's own body already answers, e.g. `['Contexto']`.
   *
   * An EMPTY section in the skeleton is an invitation to fill the note in later, which is why the
   * others are left standing. One the body already answered two lines above is not an invitation,
   * it is a duplicate — `vault_learn` writes `**Contexto:** …` and the vault's template declares an
   * empty `## Contexto` right under it. A section the template brings already FILLED is never
   * dropped: that would be deleting the user's own text.
   */
  answeredSections?: readonly string[];
  /** Write but do not commit, so a caller can batch several writes into one commit. */
  deferCommit?: boolean;
}

export interface EditNoteOptions {
  vaultRoot: string;
  path: string;
  oldText: string;
  newText: string;
  deferCommit?: boolean;
}

/** The `tipo` values that have a skeleton in `_templates/`. */
const TEMPLATED_TIPOS = new Set(['wiki', 'projeto']);

/** The frontmatter keys every note this module writes is guaranteed to carry. */
const DEFAULT_TIPO = 'nota';

/**
 * A human title for the note, derived from its filename.
 *
 * `writeNote`'s signature carries no title: the vault's own convention is that the file
 * name IS the title in slug form (`cache-wrapper.md` is "Cache Wrapper"), and that is
 * what `[[cache-wrapper]]` links resolve against. Deriving it keeps the `# <title>`
 * heading a template writes and the filename a caller chose from ever disagreeing.
 */
function titleFromPath(relPath: string): string {
  const slug = basename(relPath, '.md');
  return slug
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Inserts the caller's body into a rendered template skeleton, ABOVE its first section
 * heading.
 *
 * Above, not appended, because appending puts the note's actual prose under whatever
 * section happens to come last — `## Links` for a project, which is plainly wrong. The
 * vault's own notes are shaped `# Titulo` / prose / `## Contexto`, so the lead paragraph
 * position is where a reader expects it and where the sections the template declares
 * stay empty and ready to be filled in.
 *
 * The search starts after the frontmatter block, so a `## ` that somehow appears inside
 * a quoted YAML value cannot be mistaken for the first section.
 */
export function spliceBody(skeleton: string, content: string): string {
  const body = content.trim();
  if (body === '') return skeleton;

  const lines = skeleton.split('\n');
  let from = 0;
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if ((lines[i] ?? '').trim() === '---') {
        from = i + 1;
        break;
      }
    }
  }

  let at = -1;
  for (let i = from; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? '')) {
      at = i;
      break;
    }
  }

  if (at === -1) return `${stripTrailingNewlines(skeleton)}\n\n${body}\n`;
  const head = stripTrailingNewlines(lines.slice(0, at).join('\n'));
  const tail = lines.slice(at).join('\n');
  // The trailing newline is the skeleton's to lose: a template file saved without one produced a
  // note without one, and `\ No newline at end of file` in every diff of it afterwards.
  return `${head}\n\n${body}\n\n${stripTrailingNewlines(tail)}\n`;
}

/** Trailing newlines dropped by scanning, not by `/\n+$/`, which backtracks quadratically. */
function stripTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  return text.slice(0, end);
}

/**
 * The skeleton with its EMPTY `## <name>` sections named in `answered` removed.
 *
 * "Empty" is the whole rule and it is checked, never assumed: a section counts only when nothing
 * but blank lines stands between its heading and the next one. A template that ships prose under
 * `## Contexto` keeps it — dropping that would be deleting the user's writing to avoid a
 * duplication the user did not create.
 */
export function dropAnsweredSections(skeleton: string, answered: readonly string[]): string {
  if (answered.length === 0) return skeleton;
  const wanted = new Set(answered.map((name) => name.trim().toLowerCase()));

  const lines = skeleton.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading === null || !wanted.has((heading[1] ?? '').trim().toLowerCase())) {
      out.push(line);
      continue;
    }

    let next = i + 1;
    while (next < lines.length && !/^##\s/.test(lines[next] ?? '')) next += 1;
    if (!lines.slice(i + 1, next).every((body) => body.trim() === '')) {
      out.push(line);
      continue;
    }
    // Skip the heading and the blank run under it; `next` is the following heading, or the end.
    i = next - 1;
  }

  // Removing a section from the middle leaves the blank line that preceded it next to the blank
  // line that followed the one before.
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** True when a parsed frontmatter value counts as "not filled in". Mirrors `ensureFrontmatter`. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * The required keys `ensureFrontmatter` did NOT manage to fill.
 *
 * `ensureFrontmatter` is allowed to REFUSE: when it meets a YAML construct it cannot
 * edit safely — an explicit key spanning two lines, a block whose modification js-yaml
 * would reject — it returns the content UNCHANGED rather than corrupting the block. That
 * is the right call there (an unfilled key is recoverable; a destroyed block is not), but
 * it is invisible in the return value: refusal and success are the same `string`.
 *
 * As the first caller, `writeNote` has to decide what that silence means, and writing a
 * note whose `tipo`/`tags`/`criado` were quietly dropped is not an outcome a user would
 * ever discover on their own — the note looks fine, and T3's scanner simply never
 * indexes it by type. So the output is re-read through the SAME parser that will read
 * the file back, and any required key still empty becomes a `warning` naming it. The
 * write still happens: the body is the user's content and losing it to a metadata
 * problem would be the larger wrong answer.
 *
 * A required value that is itself empty (`tags: []` on a note with no tags) is not a
 * refusal and is not reported.
 */
function unfilledKeys(content: string, required: Frontmatter): string[] {
  let data: Record<string, unknown>;
  try {
    // The `{}` is load-bearing: with no options `gray-matter` memoises every string it
    // parses in an unbounded process-global cache. The rest of this codebase refuses
    // that cache for the same reason.
    data = matter(content, {}).data as Record<string, unknown>;
  } catch {
    // The block does not parse at all, so nothing was filled and everything asked for
    // is missing.
    return Object.entries(required)
      .filter(([, value]) => !isEmptyValue(value))
      .map(([key]) => key);
  }

  return Object.entries(required)
    .filter(([key, value]) => !isEmptyValue(value) && isEmptyValue(data[key]))
    .map(([key]) => key);
}

/** Joins the warnings a single write can produce, keeping every one of them visible. */
function joinWarnings(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== '');
  return kept.length === 0 ? undefined : kept.join('; ');
}

/** Lines in `text`, counting a trailing newline as a terminator, without allocating. */
function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return text.charCodeAt(text.length - 1) === 10 ? lines : lines + 1;
}

/**
 * The diff, and the warning to carry when it could not be produced.
 *
 * `unifiedDiff` bounds itself and returns its own coarse summary for an input too large to
 * diff line by line, so in normal operation this never catches anything. It exists for the
 * case where that self-defence is not enough — a `RangeError` from a typed-array
 * allocation the process could not satisfy, say — and the question that case forces is
 * which of two wrongs to commit.
 *
 * Losing the user's content to a REPORTING failure is the larger wrong: the note is what
 * they asked for, the diff is how it gets narrated. So the throw is swallowed here, the
 * report degrades to a summary that says plainly it is one, and the failure travels back
 * as a `warning`. The caller learns the note was written and that the diff is not
 * trustworthy — which is the truth, and is strictly more than a rejection would tell them
 * about a file that is already on disk.
 *
 * The summary is built HERE rather than borrowed from `diff.js`: this is the path taken
 * when that module has just failed, and reaching back into it for the recovery would make
 * the recovery depend on the thing that broke.
 */
function safeDiff(
  before: string,
  after: string,
  relPath: string
): { diff: string; warning?: string } {
  try {
    return { diff: unifiedDiff(before, after, relPath) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // `relPath` is already through `guardedPath`, so it carries no control character and
    // cannot add a line to this header.
    const diff = [
      before === '' ? '--- /dev/null' : `--- a/${relPath}`,
      after === '' ? '+++ /dev/null' : `+++ b/${relPath}`,
      '@@ diff indisponível @@',
      ` falha ao gerar o diff (${reason}); ${countLines(before)} linhas antes, ` +
        `${countLines(after)} linhas depois`,
      '',
    ].join('\n');
    return { diff, warning: `diff não pôde ser gerado (${reason})` };
  }
}

/**
 * Writes `text` to a path already guarded, then commits it unless the caller is batching.
 *
 * The diff is computed BEFORE the write, and that order is the whole point of this
 * function. It is a pure function of the two strings already in memory — nothing about it
 * needs the file on disk — so computing it first makes "written but unreported" a state
 * this code cannot reach, rather than one it merely avoids as long as `unifiedDiff`'s size
 * bounds are set correctly. Written the other way round, a diff that threw left the
 * replacement published and the call rejecting, and the user was never shown what changed.
 * `safeDiff` closes the other half: a diff failure must not swallow the content either.
 *
 * The commit is deliberately the LAST thing and deliberately cannot undo the write.
 * `commitFiles` never throws; a git failure comes back as a warning and the note stays on
 * disk. Losing a user's note because their vault is not a git repository, or because a
 * pre-commit hook rejected it, would be an absurd trade.
 */
async function writeAndCommit(
  opts: {
    vaultRoot: string;
    relPath: string;
    absPath: string;
    before: string;
    after: string;
    created: boolean;
    deferCommit?: boolean;
    message: string;
  },
  extraWarning?: string
): Promise<WriteResult> {
  const { diff, warning: diffWarning } = safeDiff(opts.before, opts.after, opts.relPath);
  try {
    // `exclusive` exactly when the caller established there was no file here. `created` is read
    // off the read above, so this is the same fact the whole call is built on — and publishing
    // exclusively is what moves the guarantee from that check to the write itself. A replacement
    // is a different intent and still publishes with `rename`.
    await atomicWrite(opts.absPath, opts.after, { exclusive: opts.created });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WriteRaceError(
        `${opts.relPath} passou a existir enquanto a nota era escrita; nada foi sobrescrito`,
      );
    }
    throw err;
  }

  const base = {
    path: opts.relPath,
    absPath: opts.absPath,
    created: opts.created,
    diff,
  };

  if (opts.deferCommit === true) {
    const warning = joinWarnings([extraWarning, diffWarning]);
    return warning === undefined
      ? { ...base, committed: false }
      : { ...base, committed: false, warning };
  }

  const commit = await commitFiles(opts.vaultRoot, [opts.absPath], opts.message);
  const warning = joinWarnings([extraWarning, diffWarning, commit.warning]);
  const committed = { ...base, committed: commit.committed, ...(commit.pushed === undefined ? {} : { pushed: commit.pushed }) };
  return warning === undefined ? committed : { ...committed, warning };
}

/**
 * Refuses a path that holds something other than a note, BEFORE anything is opened.
 *
 * The three reads in this module — the note in `writeNote`, the note in `editNote` and the
 * template — are all `readFile` on a path `guardedPath` has approved, and `guardedPath`
 * answers about the path rather than about the node standing on it. `classifyNode` is that
 * second question, shared with `propagate.ts` and mirrored by `learn.ts`'s `pathState`.
 */
async function refuseForeign(absPath: string, relPath: string): Promise<NodeKind> {
  const kind = await classifyNode(absPath);
  if (kind === 'foreign') {
    throw new PathGuardError(
      `caminho não é uma nota (link, diretório ou dispositivo): ${forMessage(relPath)}`
    );
  }
  return kind;
}

/**
 * Creates or replaces a note.
 *
 * Flow: resolve and guard the path → apply the `_templates/` skeleton when the note is
 * new and its `tipo` has one → guarantee the frontmatter → write atomically → commit,
 * unless `deferCommit` says the caller will.
 *
 * `deferCommit` exists for `vault_learn`, which touches up to four files and needs ONE
 * commit covering the set rather than four partial ones. `absPath` comes back so the
 * caller can assemble that list and hand it to `commitFiles` itself.
 */
export async function writeNote(opts: WriteNoteOptions): Promise<WriteResult> {
  const absPath = await guardedPath(opts.vaultRoot, opts.path);
  // A FIFO here is `.md`, is inside the vault and is in no denied directory, so every check
  // above passes it — and the read below never returns. `created` still comes from the read,
  // which is the only thing that can distinguish "was not there" from "was there and is gone
  // by the time we look" without a second race.
  await refuseForeign(absPath, opts.path);

  let before = '';
  let created = true;
  try {
    before = await fs.readFile(absPath, 'utf8');
    created = false;
  } catch {
    created = true;
  }

  const now = new Date();
  let text = opts.content;
  let templateWarning: string | undefined;

  if (created && opts.tipo !== undefined && TEMPLATED_TIPOS.has(opts.tipo)) {
    // `opts.tipo` is compared against a closed set before it reaches the path, so no
    // caller-controlled segment ever enters this join.
    const templatePath = join(opts.vaultRoot, '_templates', `${opts.tipo}.md`);
    let templateText: string | undefined;
    const state = await classifyNode(templatePath);
    if (state === 'foreign') {
      templateWarning = `template ignorado: _templates/${opts.tipo}.md não é um arquivo comum`;
    } else {
      try {
        templateText = await fs.readFile(templatePath, 'utf8');
      } catch {
        templateWarning = `template não encontrado: _templates/${opts.tipo}.md`;
      }
    }
    if (templateText !== undefined) {
      // `applyTemplate` runs over the SKELETON, and the caller's content is spliced in
      // afterwards. The order is not incidental: the token scanner exists to catch an
      // unresolved Templater token in a template the user wrote, and running it over
      // model-supplied prose instead makes a note that legitimately discusses `<% %>`
      // syntax permanently unwritable — while adding nothing, since content is not a
      // template and its `<%` is just text.
      const skeleton = applyTemplate(templateText, {
        title: opts.title ?? titleFromPath(opts.path),
        now,
      });
      text = spliceBody(dropAnsweredSections(skeleton, opts.answeredSections ?? []), opts.content);
    }
  }

  const required: Frontmatter = {
    tipo: DEFAULT_TIPO,
    tags: [],
    criado: formatLocal(now, 'YYYY-MM-DD'),
    ...(opts.frontmatter ?? {}),
  };
  if (opts.tipo !== undefined) required.tipo = opts.tipo;

  const after = ensureFrontmatter(text, required);

  const missing = unfilledKeys(after, required);
  const frontmatterWarning =
    missing.length === 0
      ? undefined
      : `frontmatter não preenchido (bloco YAML não editável com segurança): ${missing.join(', ')}`;

  return writeAndCommit(
    {
      vaultRoot: opts.vaultRoot,
      relPath: opts.path,
      absPath,
      before,
      after,
      created,
      ...(opts.deferCommit === undefined ? {} : { deferCommit: opts.deferCommit }),
      message: `docs(vault): ${titleFromPath(opts.path)}`,
    },
    joinWarnings([templateWarning, frontmatterWarning])
  );
}

/**
 * Occurrences of `needle` in `haystack`, INCLUDING overlapping ones.
 *
 * Advancing by `needle.length` — the obvious way to count — asks "how many copies fit
 * side by side", which is a different question from the one `editNote` needs answered.
 * `aa` sits in `aaa` at offset 0 and at offset 1: two distinct places the edit could land,
 * and no way to know which the caller meant. Counting non-overlapping matches reported ONE
 * and silently replaced the first — precisely the "edited a line the caller never looked
 * at" outcome the exactly-one-occurrence rule exists to prevent. Advancing by 1 counts
 * every starting position, so ambiguity is refused wherever it actually exists.
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * O mesmo texto com CRLF colapsado para LF, mais o mapa que devolve cada posição normalizada
 * para o deslocamento original.
 *
 * `map[i]` é o deslocamento, no texto ORIGINAL, do caractere que virou a posição `i` do
 * normalizado; `map[normalizado.length]` é o fim do original. Com isso um casamento encontrado
 * no espaço normalizado vira uma fatia exata do original — inclusive quando o trecho começa ou
 * termina exatamente sobre um `\r\n`, que ocupa dois caracteres de um lado e um do outro.
 */
function foldLineEndings(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      map.push(i);
      folded += '\n';
      i += 1;
      continue;
    }
    map.push(i);
    folded += text[i];
  }
  map.push(text.length);
  return { folded, map };
}

/**
 * `newText` com o terminador que a nota já usa.
 *
 * A outra metade do problema que `matchFoldingLineEndings` resolve na ENTRADA: o trecho novo vem
 * do agente e vem com `\n`, e gravá-lo cru dentro de um arquivo CRLF deixa a nota com as duas
 * formas ao mesmo tempo. Quem paga não é este servidor — é o usuário, cujo editor reserializa o
 * arquivo, cujo git passa a marcar a nota inteira como alterada, e cujo próximo diff vira ruído
 * em cima de linhas que ninguém tocou.
 *
 * A regra é deliberadamente estreita: converte só quando a nota é INTEIRAMENTE CRLF. Um arquivo
 * já misto continua misto, porque não foi este servidor que o misturou e escolher um lado ali
 * seria reescrever linhas fora da edição pedida. Um arquivo LF não é tocado — é o caso de todo o
 * resto da suíte, e ele passa por aqui como identidade.
 */
function withLineEndingsOf(before: string, newText: string): string {
  const crlf = countOccurrences(before, '\r\n');
  if (crlf === 0) return newText;
  const loneLf = countOccurrences(before, '\n') - crlf;
  if (loneLf > 0) return newText;
  return newText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * Onde `oldText` está em `before` IGNORANDO a diferença entre `\r\n` e `\n`, e quantas vezes.
 *
 * Existe porque o trecho e o arquivo chegam por caminhos que não concordam sobre o terminador.
 * O arquivo tem o que o editor do usuário gravou — num vault de Windows, CRLF. O trecho vem do
 * agente, que quase sempre o copiou da resposta de `vault_search`, e essa resposta mostra o corpo
 * com o `\r` REMOVIDO de propósito, para o `\r` não aparecer no fim de cada linha na tela. O
 * resultado, com casamento por substring exata, é `trecho não encontrado` num texto que o usuário
 * está vendo na tela — o pior formato de erro que existe.
 *
 * Isto é um SEGUNDO passo, tentado só depois de o casamento exato falhar, e não uma substituição
 * dele: enquanto houver ocorrência exata, é ela que decide, e nenhuma nota LF muda de
 * comportamento por causa desta função.
 */
function matchFoldingLineEndings(
  before: string,
  oldText: string
): { at: number; end: number; occurrences: number } {
  const { folded, map } = foldLineEndings(before);
  const needle = foldLineEndings(oldText).folded;
  const occurrences = countOccurrences(folded, needle);
  if (occurrences !== 1) return { at: -1, end: -1, occurrences };
  const start = folded.indexOf(needle);
  return { at: map[start]!, end: map[start + needle.length]!, occurrences };
}

/**
 * Replaces one exact substring of an existing note.
 *
 * Exact-substring, and exactly ONE occurrence: zero is an error naming the file, two or
 * more is an error naming the count. Neither guesses. An edit that silently matched
 * nothing would report success on a note it never touched, and one that replaced the
 * first of several matches would edit a line the caller never looked at — in a vault the
 * user reads by hand, both are worse than being told to be more specific.
 *
 * No write happens in either error case. The occurrence count is taken before anything
 * is opened for writing, so a rejected edit leaves the file byte-identical and its mtime
 * untouched — which matters because Obsidian and T6's scanner both watch mtime.
 */
export async function editNote(opts: EditNoteOptions): Promise<WriteResult> {
  const absPath = await guardedPath(opts.vaultRoot, opts.path);

  if (opts.oldText === '') {
    // The empty string occurs between every pair of characters, so "exactly one
    // occurrence" is never true of it and counting it would not terminate.
    throw new EditError(`trecho vazio para edição em ${opts.path}`);
  }

  // Same question as `writeNote`'s, and it has to be asked here too: `editNote` is reached
  // directly by the tool layer, and a `missing` path keeps its raw ENOENT from the read below
  // rather than being turned into a different error for callers that already handle it.
  await refuseForeign(absPath, opts.path);

  const before = await fs.readFile(absPath, 'utf8');
  const occurrences = countOccurrences(before, opts.oldText);
  if (occurrences > 1) {
    throw new EditError(`trecho ambíguo em ${opts.path}: ${occurrences} ocorrências`);
  }

  // Exato primeiro, sempre. O passo tolerante a terminador só é alcançado quando o exato achou
  // ZERO, então uma nota LF segue decidida pelo casamento exato e nada nela muda de comportamento.
  let at = before.indexOf(opts.oldText);
  let end = at + opts.oldText.length;
  if (occurrences === 0) {
    const folded = matchFoldingLineEndings(before, opts.oldText);
    if (folded.occurrences === 0) throw new EditError(`trecho não encontrado em ${opts.path}`);
    if (folded.occurrences > 1) {
      throw new EditError(`trecho ambíguo em ${opts.path}: ${folded.occurrences} ocorrências`);
    }
    at = folded.at;
    end = folded.end;
  }

  const after = before.slice(0, at) + withLineEndingsOf(before, opts.newText) + before.slice(end);

  return writeAndCommit({
    vaultRoot: opts.vaultRoot,
    relPath: opts.path,
    absPath,
    before,
    after,
    created: false,
    ...(opts.deferCommit === undefined ? {} : { deferCommit: opts.deferCommit }),
    message: `docs(vault): atualizar ${titleFromPath(opts.path)}`,
  });
}
