import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyTipo,
  bumpAtualizado,
  insertUnderSection,
  buildMoc,
  buildDaily,
  propagate,
} from '../src/write/propagate.js';
import { formatLocal } from '../src/write/template.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

/**
 * A throwaway copy of `test/fixtures/vault` under `os.tmpdir()`.
 *
 * The fixture is read-only shared state across test files that vitest runs in PARALLEL,
 * so every test that mutates the vault works on its own copy. Mutating it in place makes
 * one file corrupt another file's reads intermittently and unreproducibly.
 */
async function makeVault(): Promise<{ tmp: string; vaultRoot: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-propagate-test-'));
  const vaultRoot = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultRoot, { recursive: true });
  return { tmp, vaultRoot };
}

async function read(vaultRoot: string, rel: string): Promise<string> {
  return fs.readFile(path.join(vaultRoot, rel), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock instant every I/O test propagates at: the day of the fixture's daily note. */
const NOW = new Date(2026, 7, 20, 14, 5, 0);
const NOW_DATE = formatLocal(NOW, 'YYYY-MM-DD');
const NOW_TIME = formatLocal(NOW, 'HH:mm');

const DAILY_REL = `04-daily/${NOW_DATE}.md`;
const INDEX_REL = '00-index/index-knowledge.md';

describe('classifyTipo', () => {
  it('maps each tag family to its daily-capture kind', () => {
    expect(classifyTipo(['gotcha'])).toBe('gotcha');
    expect(classifyTipo(['pattern'])).toBe('pattern');
    expect(classifyTipo(['padrao'])).toBe('pattern');
    expect(classifyTipo(['padrão'])).toBe('pattern');
    expect(classifyTipo(['decisao'])).toBe('decisão');
    expect(classifyTipo(['decisão'])).toBe('decisão');
    expect(classifyTipo(['adr'])).toBe('decisão');
    expect(classifyTipo(['estado'])).toBe('estado');
    expect(classifyTipo(['status'])).toBe('estado');
  });

  it('falls back to a generic learning for unknown tags and for no tags at all', () => {
    expect(classifyTipo([])).toBe('aprendizado');
    expect(classifyTipo(['nestjs', 'bullmq'])).toBe('aprendizado');
  });

  it('is case-insensitive', () => {
    expect(classifyTipo(['GOTCHA'])).toBe('gotcha');
    expect(classifyTipo(['Padrão'])).toBe('pattern');
    expect(classifyTipo(['ADR'])).toBe('decisão');
  });

  it('prefers the more specific kind when several tags match', () => {
    // A note tagged both is a gotcha first: the table is ordered, not a set lookup.
    expect(classifyTipo(['pattern', 'gotcha'])).toBe('gotcha');
  });
});

describe('bumpAtualizado', () => {
  it('rewrites an existing atualizado field without touching the rest', () => {
    const before = '---\ntipo: moc\ncriado: 2026-01-08\natualizado: 2026-01-12\n---\n\n# X\n';
    const after = bumpAtualizado(before, '2026-08-20');
    expect(after).toContain('atualizado: 2026-08-20');
    expect(after).not.toContain('2026-01-12');
    expect(after).toContain('criado: 2026-01-08');
    expect(after).toContain('# X');
  });

  it('inserts atualizado right after criado when it is absent', () => {
    const before = '---\ntipo: daily\ncriado: 2026-08-20\n---\n\n# X\n';
    const after = bumpAtualizado(before, '2026-08-25');
    expect(after).toContain('criado: 2026-08-20\natualizado: 2026-08-25\n');
  });

  it('appends atualizado when there is neither field', () => {
    const before = '---\ntipo: moc\n---\n\n# X\n';
    const after = bumpAtualizado(before, '2026-08-25');
    expect(after).toContain('atualizado: 2026-08-25');
    expect(after.startsWith('---\ntipo: moc\n')).toBe(true);
    expect(after).toContain('# X');
  });

  it('keeps CRLF endings intact in a file synced from Windows', () => {
    const before = '---\r\ntipo: moc\r\ncriado: 2026-01-08\r\natualizado: 2026-01-12\r\n---\r\n\r\n# X\r\n';
    const after = bumpAtualizado(before, '2026-08-20');
    expect(after).toContain('atualizado: 2026-08-20\r\n');
    // No line may end in a bare LF: a single mixed ending shows up as a whole-line change
    // in git and as a stray character in Obsidian's YAML parser.
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it('keeps CRLF endings intact when it has to insert the field', () => {
    const before = '---\r\ntipo: daily\r\ncriado: 2026-08-20\r\n---\r\n\r\n# X\r\n';
    const after = bumpAtualizado(before, '2026-08-25');
    expect(after).toContain('criado: 2026-08-20\r\natualizado: 2026-08-25\r\n');
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it('leaves content without a frontmatter block completely alone', () => {
    const before = '# Sem frontmatter\n\natualizado: 2020-01-01 no corpo\n';
    expect(bumpAtualizado(before, '2026-08-25')).toBe(before);
    expect(bumpAtualizado('---\nsem fechamento\n', '2026-08-25')).toBe('---\nsem fechamento\n');
  });
});

describe('insertUnderSection', () => {
  it('inserts after the LAST item of the section, not at the end of the file', () => {
    const before = [
      '## Domínios',
      '',
      '- [[a]] — um',
      '- [[b]] — dois',
      '',
      '## Convenções',
      '',
      '- alguma convenção',
      '',
    ].join('\n');

    const after = insertUnderSection(before, '## Domínios', '- [[c]] — três');
    const lines = after.split('\n');

    expect(lines.indexOf('- [[c]] — três')).toBe(lines.indexOf('- [[b]] — dois') + 1);
    expect(lines.indexOf('- [[c]] — três')).toBeLessThan(lines.indexOf('## Convenções'));
    expect(after).toContain('- alguma convenção');
  });

  it('inserts as the first item when the section exists but is empty', () => {
    const before = ['# T', '', '## Notas', '', '## Relacionados', '', '- [[x]]', ''].join('\n');
    const after = insertUnderSection(before, '## Notas', '- [[novo]] — resumo');
    const lines = after.split('\n');

    expect(lines.indexOf('- [[novo]] — resumo')).toBeGreaterThan(lines.indexOf('## Notas'));
    expect(lines.indexOf('- [[novo]] — resumo')).toBeLessThan(lines.indexOf('## Relacionados'));
    // The following heading keeps a blank line above it.
    expect(after).toContain('- [[novo]] — resumo\n\n## Relacionados');
  });

  it('appends the whole section when it does not exist', () => {
    const before = '---\ntipo: daily\n---\n\n# 2026-08-20\n';
    const after = insertUnderSection(before, '## Capturas', '- 09:00 [[x]] (gotcha)');
    expect(after).toContain('## Capturas');
    expect(after.indexOf('## Capturas')).toBeGreaterThan(after.indexOf('# 2026-08-20'));
    expect(after).toContain('- 09:00 [[x]] (gotcha)');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('never inserts the same line twice', () => {
    const before = ['## Notas', '', '- [[a]] — um', '', '## Fim', ''].join('\n');
    const once = insertUnderSection(before, '## Notas', '- [[b]] — dois');
    const twice = insertUnderSection(once, '## Notas', '- [[b]] — dois');
    expect(twice).toBe(once);
  });

  it('ignores headings and list items inside fenced code blocks', () => {
    const before = [
      '## Notas',
      '',
      '```md',
      '## Notas',
      '- [[falso]] — dentro do código',
      '```',
      '',
      '- [[a]] — um',
      '',
      '## Fim',
      '',
    ].join('\n');
    const after = insertUnderSection(before, '## Notas', '- [[b]] — dois');
    const lines = after.split('\n');
    expect(lines.indexOf('- [[b]] — dois')).toBe(lines.indexOf('- [[a]] — um') + 1);
    expect(lines.filter((l) => l === '- [[falso]] — dentro do código')).toHaveLength(1);
  });

  it('preserves a file that does not end in a newline', () => {
    const before = '## Notas\n\n- [[a]] — um';
    const after = insertUnderSection(before, '## Notas', '- [[b]] — dois');
    expect(after).toBe('## Notas\n\n- [[a]] — um\n- [[b]] — dois');
  });

  it('still inserts when an identical line exists only inside a code fence', () => {
    // A MOC that documents its own entry format contains a line byte-identical to a real
    // entry. Counting it as "already present" makes the propagation a silent no-op: the
    // caller is told the MOC is up to date and the entry is never added.
    const entry = '- [[auth-guard]] — guard de autenticação JWT';
    const before = ['## Notas', '', '```md', entry, '```', '', '- [[outra]] — outra nota', '', '## Fim', ''].join(
      '\n',
    );

    const after = insertUnderSection(before, '## Notas', entry);
    expect(after).not.toBe(before);

    const lines = after.split('\n');
    expect(lines.filter((l) => l === entry)).toHaveLength(2);
    // The real entry goes after the last real item, not next to the fenced example.
    expect(lines.lastIndexOf(entry)).toBe(lines.indexOf('- [[outra]] — outra nota') + 1);

    // And it is still idempotent against the line it just added.
    expect(insertUnderSection(after, '## Notas', entry)).toBe(after);
  });

  it('keeps a fenced block owned by the last item attached to that item', () => {
    const before = [
      '## Notas',
      '',
      '- [[a]] — um',
      '',
      '  ```ts',
      '  const x = 1;',
      '  ```',
      '',
      '## Fim',
      '',
    ].join('\n');

    const after = insertUnderSection(before, '## Notas', '- [[b]] — dois');
    const lines = after.split('\n');

    // Inserting between `- [[a]]` and its own example re-parents the block to the entry
    // that was just added.
    expect(lines.indexOf('- [[b]] — dois')).toBeGreaterThan(lines.lastIndexOf('  ```'));
    expect(lines.indexOf('- [[b]] — dois')).toBeLessThan(lines.indexOf('## Fim'));
  });
});

describe('buildMoc', () => {
  it('produces a MOC in the format of the existing ones', () => {
    const moc = buildMoc('patterns', '2026-08-20');
    expect(moc).toContain('tipo: moc');
    expect(moc).toContain('tags: [patterns]');
    expect(moc).toContain('criado: 2026-08-20');
    expect(moc).toContain('atualizado: 2026-08-20');
    expect(moc).toContain('# Patterns — Mapa de Conteúdo');
    expect(moc).toContain('## Notas');
    expect(moc).toContain('## Relacionados');
    expect(moc).toContain('- [[../../00-index/index-knowledge|índice de conhecimento]]');
    // The Notas section is born EMPTY: insertUnderSection fills it in the same flow.
    expect(moc).toContain('## Notas\n\n## Relacionados');
  });
});

describe('buildDaily', () => {
  it('produces a daily note with tipo daily and an empty Capturas section', () => {
    const daily = buildDaily('2026-08-25');
    expect(daily).toContain('tipo: daily');
    expect(daily).toContain('criado: 2026-08-25');
    expect(daily).toContain('# 2026-08-25');
    expect(daily).toContain('## Capturas');
    expect(daily).not.toContain('## Próximo');
  });
});

describe('propagate', () => {
  let tmp = '';
  let vaultRoot = '';

  beforeEach(async () => {
    const made = await makeVault();
    tmp = made.tmp;
    vaultRoot = made.vaultRoot;
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('adds the note to the domain MOC and bumps atualizado when the note is new', async () => {
    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo da nova nota',
      tags: ['nestjs'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc).toContain('- [[nova-nota]] — resumo da nova nota');
    // Existing entries survive, in order, with the new line after the last of them.
    expect(moc).toContain('- [[auth-guard]] — guard de autenticação JWT');
    expect(moc).toContain(
      '- [[bullmq-worker]] — worker de fila separado do API\n- [[nova-nota]] — resumo da nova nota',
    );
    expect(moc).toContain(`atualizado: ${NOW_DATE}`);
    expect(moc).not.toContain('atualizado: 2026-01-12');
    expect(moc).toContain('criado: 2026-01-08');

    expect(res.warnings).toEqual([]);
    expect(res.written).toContain(path.join(vaultRoot, '02-wiki/nestjs/nestjs-moc.md'));
    expect(res.diffs.some((d) => d.includes('nestjs-moc.md'))).toBe(true);
  });

  it('bumps atualizado but adds no MOC line when an existing note was appended to', async () => {
    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'bullmq-worker',
      resumo: 'mais um detalhe sobre a fila',
      tags: ['nestjs'],
      created: false,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc).not.toContain('mais um detalhe sobre a fila');
    expect(moc).toContain('- [[bullmq-worker]] — worker de fila separado do API');
    expect(moc.match(/- \[\[bullmq-worker\]\]/g)).toHaveLength(1);
    expect(moc).toContain(`atualizado: ${NOW_DATE}`);
    expect(res.written).toContain(path.join(vaultRoot, '02-wiki/nestjs/nestjs-moc.md'));
  });

  it('creates the MOC of a domain that has none, in the right format', async () => {
    const mocPath = path.join(vaultRoot, '02-wiki/patterns/patterns-moc.md');
    expect(await exists(mocPath)).toBe(false);

    const res = await propagate({
      vaultRoot,
      dominio: 'patterns',
      slug: 'nova-nota',
      resumo: 'um padrão novo',
      tags: ['pattern'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/patterns/patterns-moc.md');
    expect(moc).toContain('tipo: moc');
    expect(moc).toContain('tags: [patterns]');
    expect(moc).toContain(`criado: ${NOW_DATE}`);
    expect(moc).toContain(`atualizado: ${NOW_DATE}`);
    expect(moc).toContain('# Patterns — Mapa de Conteúdo');
    expect(moc).toContain('- [[nova-nota]] — um padrão novo');
    expect(moc).toContain('- [[../../00-index/index-knowledge|índice de conhecimento]]');
    expect(res.written).toContain(mocPath);
    expect(res.warnings).toEqual([]);
  });

  it('adds a line under Domínios of the knowledge index for a brand new domain', async () => {
    const before = await read(vaultRoot, INDEX_REL);

    await propagate({
      vaultRoot,
      dominio: 'rust',
      slug: 'ownership',
      resumo: 'ownership e borrow checker',
      tags: ['rust'],
      created: true,
      domainIsNew: true,
      now: NOW,
    });

    const after = await read(vaultRoot, INDEX_REL);
    expect(after).toContain('- [[../02-wiki/rust/rust-moc|rust]] — ownership e borrow checker');
    // The pre-existing domains stay put, and the new line lands under Domínios.
    expect(after).toContain(
      '- [[../02-wiki/nestjs/nestjs-moc|nestjs]] — NestJS, providers, guards, filas',
    );
    const lines = after.split('\n');
    expect(lines.findIndex((l) => l.includes('rust-moc'))).toBeGreaterThan(
      lines.indexOf('## Domínios'),
    );
    expect(lines.findIndex((l) => l.includes('rust-moc'))).toBeLessThan(
      lines.indexOf('## Convenções'),
    );
    expect(after).toContain(`atualizado: ${NOW_DATE}`);
    expect(before).not.toBe(after);
    // The MOC of the brand new domain is created too.
    expect(await exists(path.join(vaultRoot, '02-wiki/rust/rust-moc.md'))).toBe(true);
  });

  it('does not change the knowledge index by a single byte for a domain already listed', async () => {
    const before = await fs.readFile(path.join(vaultRoot, INDEX_REL));

    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['nestjs'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const after = await fs.readFile(path.join(vaultRoot, INDEX_REL));
    expect(after.equals(before)).toBe(true);
    expect(res.written).not.toContain(path.join(vaultRoot, INDEX_REL));
  });

  it('appends the daily capture under Capturas, keeping the pre-existing line', async () => {
    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      projeto: 'potentia',
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const daily = await read(vaultRoot, DAILY_REL);
    expect(daily).toContain('- 09:14 [[multi-stage]] (pattern, potentia)');
    expect(daily).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha, potentia)`);
    expect(daily).toContain(
      `- 09:14 [[multi-stage]] (pattern, potentia)\n- ${NOW_TIME} [[nova-nota]] (gotcha, potentia)`,
    );
    // The section that follows Capturas is untouched.
    expect(daily).toContain('## Próximo');
    expect(daily).toContain('- Revisar anotações soltas do inbox.');
    expect(res.written).toContain(path.join(vaultRoot, DAILY_REL));
  });

  it('creates the daily note when there is none for today', async () => {
    const now = new Date(2026, 7, 25, 8, 30, 0);
    const rel = `04-daily/${formatLocal(now, 'YYYY-MM-DD')}.md`;
    expect(await exists(path.join(vaultRoot, rel))).toBe(false);

    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['adr'],
      projeto: 'potentia',
      created: true,
      domainIsNew: false,
      now,
    });

    const daily = await read(vaultRoot, rel);
    expect(daily).toContain('tipo: daily');
    expect(daily).toContain('criado: 2026-08-25');
    expect(daily).toContain('# 2026-08-25');
    expect(daily).toContain('## Capturas');
    expect(daily).toContain('- 08:30 [[nova-nota]] (decisão, potentia)');
    expect(res.written).toContain(path.join(vaultRoot, rel));
    expect(res.warnings).toEqual([]);
  });

  it('omits the project from the capture suffix when there is none', async () => {
    await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const daily = await read(vaultRoot, DAILY_REL);
    expect(daily).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha)`);
    expect(daily).not.toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha,`);
  });

  it('does not duplicate lines when the same propagation runs twice', async () => {
    const opts = {
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      projeto: 'potentia',
      created: true,
      domainIsNew: false,
      now: NOW,
    };

    await propagate(opts);
    const first = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    const firstDaily = await read(vaultRoot, DAILY_REL);

    const second = await propagate(opts);

    expect(await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md')).toBe(first);
    expect(await read(vaultRoot, DAILY_REL)).toBe(firstDaily);
    // Nothing changed, so nothing was written and there is nothing to commit.
    expect(second.written).toEqual([]);
    expect(second.diffs).toEqual([]);
    expect(second.warnings).toEqual([]);
  });

  it('warns naming the failing target and still propagates to the others', async () => {
    // A directory where the MOC should be: every read and every write of that path fails,
    // without depending on file modes (a test run as root ignores a chmod).
    const mocPath = path.join(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    await fs.rm(mocPath);
    await fs.mkdir(mocPath);

    const res = await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      projeto: 'potentia',
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('02-wiki/nestjs/nestjs-moc.md');
    expect(res.written).not.toContain(mocPath);

    // The daily still got its capture: one failing target does not stop the rest.
    const daily = await read(vaultRoot, DAILY_REL);
    expect(daily).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha, potentia)`);
    expect(res.written).toContain(path.join(vaultRoot, DAILY_REL));
  });

  it('never throws and never commits', async () => {
    // A vault root that does not exist at all: every single target fails.
    const res = await propagate({
      vaultRoot: path.join(tmp, 'nao-existe', 'vault'),
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: [],
      created: true,
      domainIsNew: true,
      now: NOW,
    });

    expect(res.written).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(await exists(path.join(tmp, 'nao-existe'))).toBe(false);
  });

  it('refuses a domain that would escape the vault, as a warning', async () => {
    const res = await propagate({
      vaultRoot,
      dominio: '../../etc',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: [],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    expect(res.warnings.some((w) => w.includes('etc'))).toBe(true);
    // `startsWith(vaultRoot)` is NOT enough on its own: `<vault>/.git/...` satisfies it.
    // Only the daily may have been written.
    expect(res.written).toEqual([path.join(vaultRoot, DAILY_REL)]);
    expect(await exists(path.join(vaultRoot, 'etc-moc.md'))).toBe(false);
  });

  it('refuses a domain that traverses into the vault repository', async () => {
    // A real vault IS a git repository: `writeNote` already refuses this path, and a
    // malformed loose ref breaks `git log --all`, `git gc` and `git fsck` for every later
    // operation — including the commit vault_learn is about to make.
    await fs.mkdir(path.join(vaultRoot, '.git', 'refs', 'heads'), { recursive: true });

    const res = await propagate({
      vaultRoot,
      dominio: '../.git/refs/heads',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      created: true,
      domainIsNew: true,
      now: NOW,
    });

    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.written.some((p) => p.includes(`${path.sep}.git${path.sep}`))).toBe(false);
    expect(await fs.readdir(path.join(vaultRoot, '.git', 'refs', 'heads'))).toEqual([]);

    // The daily is a different target and still gets its capture.
    expect(await read(vaultRoot, DAILY_REL)).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha)`);
  });

  it('refuses a domain that reaches the repository through an in-vault symlink', async () => {
    // The link stays inside the vault, so containment and assertNoSymlinkEscape both pass;
    // only a check on the RESOLVED path catches it. A user or a sync client can create it.
    await fs.mkdir(path.join(vaultRoot, '.git', 'refs', 'heads'), { recursive: true });
    await fs.symlink('../.git/refs/heads', path.join(vaultRoot, '02-wiki', 'compartilhado'));

    const res = await propagate({
      vaultRoot,
      dominio: 'compartilhado',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    expect(res.warnings.some((w) => w.includes('compartilhado-moc.md'))).toBe(true);
    expect(await exists(path.join(vaultRoot, '.git', 'refs', 'heads', 'compartilhado-moc.md'))).toBe(
      false,
    );
    expect(await fs.readdir(path.join(vaultRoot, '.git', 'refs', 'heads'))).toEqual([]);
    expect(res.written).toEqual([path.join(vaultRoot, DAILY_REL)]);
  });

  it('refuses a domain carrying a line break and leaves the index untouched', async () => {
    const indexBefore = await fs.readFile(path.join(vaultRoot, INDEX_REL));

    const res = await propagate({
      vaultRoot,
      dominio: 'a\nb',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      created: true,
      domainIsNew: true,
      now: NOW,
    });

    expect(res.warnings).toHaveLength(1);
    // A domain in the index entry `- [[../02-wiki/a\nb/a\nb-moc|a\nb]] — r` turns one line
    // into four, three of which stay in the user's index forever.
    expect((await fs.readFile(path.join(vaultRoot, INDEX_REL))).equals(indexBefore)).toBe(true);
    expect(res.written).toEqual([path.join(vaultRoot, DAILY_REL)]);
    expect(await exists(path.join(vaultRoot, '02-wiki', 'a\nb'))).toBe(false);
  });

  it('escapes the refused domain in the warning so it cannot forge a line', async () => {
    // U+2028 is a forced line break in every HTML-rendering client even though
    // `split('\n')` sees one line: raw, the warning renders a standalone success line
    // attached to a message reporting a REFUSED write.
    const res = await propagate({
      vaultRoot,
      dominio: 'x\u2028tudo propagado com sucesso',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: [],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    expect(res.warnings).toHaveLength(1);
    const warning = res.warnings[0] ?? '';
    expect(warning).not.toContain('\u2028');
    expect(warning).not.toContain('\n');
    expect(warning).toContain('\\u2028');
  });

  it('folds a multi-line resumo into a single MOC entry', async () => {
    await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'primeira linha\nsegunda linha\tterceira',
      tags: ['gotcha'],
      projeto: 'poten\ntia',
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc).toContain('- [[nova-nota]] — primeira linha segunda linha terceira');
    expect(moc.split('\n').filter((l) => l.includes('segunda linha'))).toHaveLength(1);

    const daily = await read(vaultRoot, DAILY_REL);
    expect(daily).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha, poten tia)`);
    expect(daily.split('\n').filter((l) => l.includes('nova-nota'))).toHaveLength(1);
  });

  it('folds invisible and bidi characters out of the entry', async () => {
    await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      // U+0085 breaks the line in an HTML client while `\s` never matched it, and U+202E
      // reverses everything after it in any bidi-aware renderer.
      resumo: 'a\u0085b\u202ec',
      tags: ['gotcha'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc).toContain('- [[nova-nota]] — a b c');
    expect(moc).not.toContain('\u0085');
    expect(moc).not.toContain('\u202e');
  });

  it('rebuilds a zero-byte daily note instead of appending to nothing', async () => {
    // Obsidian's daily-note plugin with an empty template creates exactly this file.
    await fs.writeFile(path.join(vaultRoot, DAILY_REL), '');

    await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      projeto: 'potentia',
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const daily = await read(vaultRoot, DAILY_REL);
    // Without `tipo: daily` the scanner reads it as an ordinary note and the BM25 daily
    // damping never applies.
    expect(daily.startsWith('---\ntipo: daily\n')).toBe(true);
    expect(daily).toContain(`criado: ${NOW_DATE}`);
    expect(daily).toContain('## Capturas');
    expect(daily).toContain(`- ${NOW_TIME} [[nova-nota]] (gotcha, potentia)`);
  });

  it('rebuilds a zero-byte MOC instead of appending to nothing', async () => {
    await fs.writeFile(path.join(vaultRoot, '02-wiki/nestjs/nestjs-moc.md'), '');

    await propagate({
      vaultRoot,
      dominio: 'nestjs',
      slug: 'nova-nota',
      resumo: 'resumo qualquer',
      tags: ['gotcha'],
      created: true,
      domainIsNew: false,
      now: NOW,
    });

    const moc = await read(vaultRoot, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc.startsWith('---\ntipo: moc\n')).toBe(true);
    expect(moc).toContain(`atualizado: ${NOW_DATE}`);
    expect(moc).toContain('- [[nova-nota]] — resumo qualquer');
  });
});
