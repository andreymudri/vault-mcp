import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { VaultScanner } from '../src/vault/scanner.js';
import { Retriever } from '../src/retrieval/retrieval.js';
import { learn } from '../src/write/learn.js';
import { createTools } from '../src/server/tools.js';
import { messagesFor } from '../src/i18n/messages.js';

const at = new Date('2026-10-05T12:00:00.000Z');
const input = { titulo: 'Synthetic research', insight: 'Reviewed evidence. [1]\n\n## Sources\n1. https://example.org/', contexto: 'Synthetic research run', dominio: 'new-domain', tags: ['research'], links: ['existing-note'], confirmNovoDominio: true, forceNew: true, now: at };
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) { result[key + '/'] = ''; await walk(join(dir, entry.name), key + '/'); }
      else result[key] = (await fs.readFile(join(dir, entry.name))).toString('base64');
    }
  }
  await walk(root, ''); return result;
}
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'vault-preview-'));
  await fs.mkdir(join(root, '_templates'));
  await fs.writeFile(join(root, '_templates/wiki.md'), '# <% tp.file.title %>\n\n## Contexto\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.org'); git('config', 'commit.gpgsign', 'false'); git('config', 'gc.auto', '0'); git('add', '.'); git('commit', '-m', 'Initial fixture');
  const scanner = new VaultScanner({ vaultRoot: root });
  const retriever = new Retriever({ scanner });
  return { root, git, scanner, retriever };
}

it('learn preview changes no vault or git bytes; approved save writes exactly the preview files in one commit', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.root);
    const preview = await learn({ ...input, vaultRoot: f.root, retriever: f.retriever, preview: true });
    expect(preview.preview).toBe(true);
    expect(preview.committed).toBe(false);
    expect(preview.files?.length).toBe(4);
    expect(await snapshot(f.root)).toEqual(before);
    const saved = await learn({ ...input, vaultRoot: f.root, retriever: f.retriever, expectedRevision: preview.revision! });
    expect(saved.committed).toBe(true);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort()).toEqual(preview.files!.map(file => file.path).sort());
    for (const file of preview.files!) expect(await fs.readFile(join(f.root, file.path), 'utf8')).toBe(file.after);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('stale preview and changed template refuse before any write, and force_new preserves an existing note', async () => {
  const f = await fixture();
  try {
    const args = { ...input, vaultRoot: f.root, retriever: f.retriever };
    const preview = await learn({ ...args, preview: true });
    await fs.writeFile(join(f.root, '_templates/wiki.md'), '# Changed skeleton\n');
    const changed = await snapshot(f.root);
    await expect(learn({ ...args, expectedRevision: preview.revision! })).rejects.toThrow('preview_stale');
    expect(await snapshot(f.root)).toEqual(changed);
    await learn(args);
    const note = join(f.root, '02-wiki/new-domain/synthetic-research.md');
    const before = await fs.readFile(note, 'utf8');
    const next = await learn({ ...args, preview: true });
    expect(next.action).toBe('created');
    expect(next.path).not.toBe('02-wiki/new-domain/synthetic-research.md');
    await learn({ ...args, expectedRevision: next.revision! });
    expect(await fs.readFile(note, 'utf8')).toBe(before);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('MCP learn exposes structured previews and accepts their timestamp and revision for approval', async () => {
  const f = await fixture();
  try {
    const tool = createTools({ vaultRoot: f.root, scanner: f.scanner, retriever: f.retriever, messages: messagesFor('en') }).find(tool => tool.name === 'vault_learn')!;
    const args = { titulo: input.titulo, insight: input.insight, contexto: input.contexto, dominio: input.dominio, tags: input.tags, links: input.links, confirm_novo_dominio: true, force_new: true, preview_time: at.toISOString() };
    const before = await snapshot(f.root);
    const preview = await tool.handler({ ...args, preview: true });
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent?.preview).toBe(true);
    expect(preview.structuredContent?.previewTime).toBe(at.toISOString());
    expect(await snapshot(f.root)).toEqual(before);
    expect(tool.outputSchema?.safeParse(preview.structuredContent).success).toBe(true);
    const refused = await tool.handler({ ...args, expected_revision: 'b'.repeat(64) });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.error).toEqual({ code: 'preview_stale' });
    expect(await snapshot(f.root)).toEqual(before);
    const saved = await tool.handler({ ...args, expected_revision: preview.structuredContent!.revision });
    expect(saved.structuredContent?.committed).toBe(true);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
