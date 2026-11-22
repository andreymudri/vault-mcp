import { realpathSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { coded, errorContext, renderTemplate } from '../../i18n/errors.js';
import { translatePhrases } from '../../i18n/phrases.js';
import { LearnError, learn } from '../../write/learn.js';
import { deleteNote, moveNote } from '../../write/relocate.js';
import { EditError, editNote, writeNote } from '../../write/writer.js';
import { ToolError, define, defineStructured, messageOf, refreshVault } from './define.js';
import { MAX_CONTEXT_CHARS, MAX_INSIGHT_CHARS, MAX_WRITE_CHARS } from './limits.js';
import { recoveryLines, renderRelocate, renderWrite } from './render.js';
import { forMessage, relayDiff } from './sanitize.js';
import { coerceTags, toFrontmatter } from './tag-guard.js';
import type { ToolContext, ToolDefinition } from './types.js';
import type { Committed, DeferredPush } from './write-queue.js';

/**
 * The five tools that write: write_note, edit_note, learn, move and delete.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/**
 * Why a REFUSED write may have been refused, when the target turns out to be hardlinked.
 *
 * The write layer refuses a hardlinked target — a note whose inode a second name shares, which
 * `cp -al` snapshots and some backup tools create legitimately — and its message names the path
 * without naming the link count, so the user cannot tell a hostile link from their own backup.
 * The refusal is not this module's to change; the ANSWER is, and this is the number that explains
 * it. It is added only to a write that already failed, so an ordinary refusal gains no noise.
 *
 * `stat` is confined to a path that stays inside the vault: this runs on caller-supplied input and
 * must not report on files outside it, not even a link count.
 */
async function hardLinkHint(
  vaultRoot: string,
  relPath: string,
): Promise<{ nlink: number } | undefined> {
  try {
    // REAL paths on both sides, never the lexical ones. `resolve(root, relPath)` keeps the string
    // inside the vault while `lstat` follows every symlink on the way: with `02-wiki/fora` linked
    // outside, a lexically-inside path answered "o arquivo tem 3 hard links" about a file the vault
    // does not contain. Containment is a question about the filesystem, so it is asked of the
    // filesystem.
    const root = realpathSync(resolve(vaultRoot));
    const target = realpathSync(resolve(root, relPath));
    if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;

    const stat = await fs.lstat(target);
    if (stat.nlink > 1) return { nlink: stat.nlink };
  } catch {
    // Sem alvo legível não há o que explicar; o erro original já é a resposta.
  }
  return undefined;
}

/**
 * Runs a write and, if it is refused for a reason that is about the FILE rather than about the
 * caller's text, adds the link count that explains the refusal.
 *
 * `EditError` and `LearnError` are refusals of the ARGUMENTS — an anchor that matches nothing, a
 * domain that does not exist — and adding a link count to those would be noise.
 *
 * That exemption is DELIBERATELY UNPINNED, and this note exists so the next reader does not spend
 * the afternoon I spent trying to pin it. Reaching it needs an argument refusal ON a hardlinked
 * file, and the write guard in `src/write/paths.ts` classifies `nlink > 1` as `foreign` and refuses
 * it BEFORE any anchor is compared — correctly, since a shared inode must not be read or written
 * through. So that combination cannot occur, and on a file with a single link `hardLinkHint`
 * returns `undefined` anyway. The branch stays because this module should not lean on another
 * module's guard for a property it states itself; what IS reachable — a file-level refusal carrying
 * the count, an argument refusal carrying nothing about the file — is asserted as a pair in
 * `test/tools.test.ts`.
 */
async function withWriteDetail<T>(
  vaultRoot: string,
  relPath: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EditError || err instanceof LearnError || err instanceof ToolError) throw err;
    const hint = await hardLinkHint(vaultRoot, relPath);
    if (hint === undefined) throw err;
    // O português fica no `message` como sempre ficou; a versão traduzível vai pelo canal de
    // dica, com código próprio.
    const hintPt =
      `o arquivo tem ${hint.nlink} hard links apontando para o mesmo inode ` +
      '(uma cópia `cp -al` ou um snapshot de backup faz isso), então escrever nele mudaria ' +
      'todas as cópias de uma vez';
    // O código do erro ORIGINAL vem junto. Reconstruir com `new ToolError(messageOf(err))` o
    // descartava, então um sítio corretamente anotado — `path.notANote`, por exemplo — voltava a
    // sair em português sempre que a dica de hard link se anexava. Não era um vazamento a mais:
    // era um vetor que desfazia a tradução de qualquer erro que passasse por aqui.
    const { code, params } = errorContext(err);
    const wrapped = new ToolError(`${messageOf(err)}; ${hintPt}`);
    const hintCtx = { code: 'hint.hardLinks', params: { nlink: hint.nlink } };
    throw code === undefined
      ? coded(wrapped, 'hint.hardLinks', { nlink: hint.nlink })
      : coded(wrapped, code, params, hintCtx);
  }
}

/** The write tools, in the order `tools/list` publishes them. */
export function writeTools(ctx: ToolContext): ToolDefinition[] {
  const { deps, m, redact, layout, writes, lockedWrite } = ctx;

  const vaultWriteNote = define(
    redact,
    m,
    'vault_write_note',
    m.tools.vault_write_note.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_write_note.path),
      content: z
        .string()
        .max(MAX_WRITE_CHARS, renderTemplate(m.validation.tooLong, { max: MAX_WRITE_CHARS }))
        .describe(m.tools.vault_write_note.content),
      frontmatter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(m.tools.vault_write_note.frontmatter),
    },
    async (input) => {
      const frontmatter = toFrontmatter(input.frontmatter);
      // `writeNote`'s `tipo` argument is deliberately NOT passed, even when the caller sends
      // `tipo: 'wiki'` in the frontmatter — which still lands in the block, since `writeNote`
      // merges `frontmatter` over its defaults. That argument is what selects a `_templates/`
      // skeleton, and splicing one under content the caller already authored gives the note two
      // `# H1`s and a set of empty sections nobody asked for. The skeleton belongs to `vault_learn`,
      // which composes the body itself; here the content is the note.
      const { value: result, warning } = await lockedWrite('vault_write_note', (git) =>
        withWriteDetail(deps.vaultRoot, input.path, () =>
          writeNote({
            vaultRoot: deps.vaultRoot,
            path: input.path,
            content: input.content,
            ...(frontmatter === undefined ? {} : { frontmatter }),
            layout,
            ...git,
          }),
        ),
      );
      return renderWrite(result, result.created ? m.results.noteCreated : m.results.noteReplaced, redact, m, warning);
    },
  );

  const vaultEditNote = define(
    redact,
    m,
    'vault_edit_note',
    m.tools.vault_edit_note.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_edit_note.path),
      old_text: z
        .string()
        .min(1, m.validation.oldTextEmpty)
        .max(MAX_WRITE_CHARS, renderTemplate(m.validation.tooLong, { max: MAX_WRITE_CHARS }))
        .describe(m.tools.vault_edit_note.old_text),
      new_text: z
        .string()
        .max(MAX_WRITE_CHARS, renderTemplate(m.validation.tooLong, { max: MAX_WRITE_CHARS }))
        .describe(m.tools.vault_edit_note.new_text),
    },
    async (input) => {
      const { value: result, warning } = await lockedWrite('vault_edit_note', (git) =>
        withWriteDetail(deps.vaultRoot, input.path, () =>
          editNote({
            vaultRoot: deps.vaultRoot,
            path: input.path,
            oldText: input.old_text,
            newText: input.new_text,
            layout,
            ...git,
          }),
        ),
      );
      return renderWrite(result, m.results.noteEdited, redact, m, warning);
    },
  );

  const vaultLearn = defineStructured(
    redact,
    m,
    'vault_learn',
    m.tools.vault_learn.description,
    {
      preview: z.boolean().optional().describe('Compute the exact diff without writing, committing or pushing.'),
      force_new: z.boolean().optional().describe('Create a linked sibling note even when this topic already exists.'),
      preview_time: z.string().datetime().optional().describe('Use the timestamp returned by the approved preview.'),
      expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Refuse a write if the approved preview is stale.'),
      title: z.string().min(1, m.validation.titleEmpty).describe(m.tools.vault_learn.title),
      insight: z
        .string()
        .min(1, m.validation.insightEmpty)
        .max(MAX_INSIGHT_CHARS, renderTemplate(m.validation.tooLong, { max: MAX_INSIGHT_CHARS }))
        .describe(m.tools.vault_learn.insight),
      context: z
        .string()
        .min(1, m.validation.contextEmpty)
        .max(MAX_CONTEXT_CHARS, renderTemplate(m.validation.tooLong, { max: MAX_CONTEXT_CHARS }))
        .describe(m.tools.vault_learn.context),
      domain: z
        .string()
        .min(1, m.validation.domainEmpty)
        .describe(m.tools.vault_learn.domain),
      project: z
        .string()
        .optional()
        .describe(m.tools.vault_learn.project),
      tags: z.array(z.string()).optional().describe(m.tools.vault_learn.tags),
      links: z.array(z.string()).optional().describe(m.tools.vault_learn.links),
      confirm_new_domain: z
        .boolean()
        .optional()
        .describe(m.tools.vault_learn.confirm_new_domain),
    },
    z.object({
      action: z.enum(['created', 'appended']), path: z.string(), reason: z.string(), diff: z.string(),
      propagated: z.array(z.string()), committed: z.boolean(), pushed: z.boolean().optional(), warning: z.string().optional(),
      pending: z.boolean().optional(), recovered: z.number().optional(), dropped: z.number().optional(),
      preview: z.boolean().optional(), revision: z.string().optional(), previewTime: z.string(),
      files: z.array(z.object({ path: z.string(), before: z.string(), after: z.string(), diff: z.string() })).optional(),
    }),
    async (input) => {
      const at = input.preview_time ? new Date(input.preview_time) : new Date();
      // A preview writes nothing, so it takes the queue's slot and not the vault lock: holding up
      // a question behind another process's write would buy no exclusion anybody needs.
      const run = (git: Partial<DeferredPush>): ReturnType<typeof learn> =>
        learn({
          vaultRoot: deps.vaultRoot,
          retriever: deps.retriever,
          titulo: input.title,
          insight: input.insight,
          contexto: input.context,
          dominio: input.domain,
          ...(input.project === undefined ? {} : { projeto: input.project }),
          // The same round-trip guard as `vault_write_note`: `learn` writes these into the very
          // same YAML block, so a tag that would not come back must be refused here too.
          ...(input.tags === undefined ? {} : { tags: coerceTags(input.tags) }),
          ...(input.links === undefined ? {} : { links: input.links }),
          ...(input.confirm_new_domain === undefined
            ? {}
            : { confirmNovoDominio: input.confirm_new_domain }),
          preview: input.preview,
          forceNew: input.force_new,
          expectedRevision: input.expected_revision,
          now: at,
          layout,
          ...git,
        });
      const { value: result, warning: queueWarning } =
        input.preview === true
          ? await writes.runExclusive(() => {
              // A preview is approved by revision, so it has to be computed from the vault as it is.
              deps.scanner.invalidate();
              return run({});
            })
          : await lockedWrite('vault_learn', run);

      const lines = [
        result.action === 'created'
          ? `${m.results.learnedNewNote}: ${forMessage(result.path)}`
          : `${m.results.learnedAppended}: ${forMessage(result.path)}`,
        // `reason` and `warning` name paths read off the vault index, so they carry whatever a
        // file name carries.
        `${m.results.reason}: ${forMessage(redact(translatePhrases(result.reason, m.phrases)))}`,
        `${m.results.propagatedTo}: ${
          result.propagated.length === 0 ? m.results.nothing : forMessage(result.propagated.join(', '))
        }`,
        `${m.results.commit}: ${result.committed ? m.results.yes : m.results.no}`,
        // Same rule as `renderWrite`: the line exists only when a push was attempted.
        ...(result.pushed === undefined ? [] : [`${m.results.push}: ${result.pushed ? m.results.yes : m.results.no}`]),
        ...recoveryLines(result, m),
      ];
      for (const aviso of [result.warning, queueWarning]) {
        if (aviso !== undefined) {
          lines.push(`${m.results.warning}: ${forMessage(redact(translatePhrases(aviso, m.phrases)))}`);
        }
      }
      lines.push('', `${m.results.diffShowUser}:`, result.diff === '' ? m.results.empty : relayDiff(result.diff, m));
      // The same two sentences as DATA speak the same language as the text.
      return {
        text: lines.join('\n'),
        structured: {
          ...result,
          reason: translatePhrases(result.reason, m.phrases),
          ...(result.warning === undefined ? {} : { warning: translatePhrases(result.warning, m.phrases) }),
          previewTime: at.toISOString(),
        },
      };
    },
  );

  /**
   * `refreshVault` INSIDE the exclusive slot, and only for these two.
   *
   * Every other write tool answers a question about one path, and `guardedPath` plus
   * `classifyNode` answer it from the filesystem. These two answer questions about the GRAPH —
   * which notes link here, where does `[[slug]]` resolve — and those come out of the scanner. A
   * stale scanner does not fail loudly here: it rewrites the wrong file, or reports a note as
   * unlinked and deletes it. So the refresh runs, and it runs after the queue has granted the
   * slot, so no write of this process can land between the refresh and the operation.
   */
  const refreshedWrite = <T extends Committed>(
    tool: string,
    run: (git: DeferredPush) => Promise<T>,
  ): Promise<{ value: T; warning?: string }> =>
    lockedWrite(tool, (git) => {
      refreshVault(deps);
      return run(git);
    });

  const vaultMove = define(
    redact,
    m,
    'vault_move',
    m.tools.vault_move.description,
    {
      from: z.string().min(1, m.validation.fromEmpty).describe(m.tools.vault_move.from),
      to: z
        .string()
        .min(1, m.validation.toEmpty)
        .describe(m.tools.vault_move.to),
      confirm_new_domain: z
        .boolean()
        .optional()
        .describe(m.tools.vault_move.confirm_new_domain),
    },
    async (input) => {
      const { value: result, warning } = await refreshedWrite('vault_move', (git) =>
        moveNote({
          vaultRoot: deps.vaultRoot,
          scanner: deps.scanner,
          from: input.from,
          to: input.to,
          ...(input.confirm_new_domain === undefined
            ? {}
            : { confirmNovoDominio: input.confirm_new_domain }),
          now: new Date(),
          layout,
          ...git,
        }),
      );
      return renderRelocate(
        `${m.results.noteMoved}: ${forMessage(result.from)} → ${forMessage(result.to)}`,
        result,
        redact,
        m,
        warning,
      );
    },
  );

  const vaultDelete = define(
    redact,
    m,
    'vault_delete',
    m.tools.vault_delete.description,
    {
      path: z.string().min(1, m.validation.pathEmpty).describe(m.tools.vault_delete.path),
      confirm: z
        .boolean()
        .optional()
        .describe(m.tools.vault_delete.confirm),
    },
    async (input) => {
      const { value: result, warning } = await refreshedWrite('vault_delete', (git) =>
        deleteNote({
          vaultRoot: deps.vaultRoot,
          scanner: deps.scanner,
          path: input.path,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
          now: new Date(),
          layout,
          ...git,
        }),
      );
      return renderRelocate(`${m.results.noteDeleted}: ${forMessage(result.path)}`, result, redact, m, warning);
    },
  );

  return [vaultWriteNote, vaultEditNote, vaultLearn, vaultMove, vaultDelete];
}
