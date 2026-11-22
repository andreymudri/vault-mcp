import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { DEFAULT_LAYOUT, LAYOUT_FILE, loadLayout } from '../src/config/layout.js';
import { errorContext } from '../src/i18n/errors.js';
import { createVaultServer } from '../src/server/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-mcp-layout-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const put = (relative: string, text: string): void => {
  mkdirSync(join(root, relative, '..'), { recursive: true });
  writeFileSync(join(root, relative), text);
};
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

describe('loadLayout', () => {
  it('is the layout this server always had when the vault says nothing', () => {
    expect(loadLayout(root)).toEqual(DEFAULT_LAYOUT);
    expect(DEFAULT_LAYOUT.folders).toEqual({
      index: '00-index',
      raw: '01-raw',
      wiki: '02-wiki',
      projects: '03-projects',
      daily: '04-daily',
      archive: '99-archive',
      templates: '_templates',
    });
    expect(DEFAULT_LAYOUT.sections).toEqual({
      notes: 'Notas',
      domains: 'Domínios',
      captures: 'Capturas',
      links: 'Links',
      related: 'Relacionados',
      context: 'Contexto',
    });
  });

  it('takes what the file names and keeps the default for the rest', () => {
    put(LAYOUT_FILE, JSON.stringify({ folders: { wiki: 'knowledge', daily: 'journal' }, sections: { notes: 'Notes' } }));
    const layout = loadLayout(root);

    expect(layout.folders).toMatchObject({ wiki: 'knowledge', daily: 'journal', archive: '99-archive' });
    expect(layout.sections).toMatchObject({ notes: 'Notes', captures: 'Capturas' });
  });

  it.each([
    ['is not JSON', '{ folders: ', /JSON/],
    ['has a key it does not know', JSON.stringify({ folders: { wikis: 'x' } }), /wikis/],
    ['names a folder with a path in it', JSON.stringify({ folders: { wiki: 'a/b' } }), /folders\.wiki/],
    ['names a hidden folder', JSON.stringify({ folders: { wiki: '.wiki' } }), /folders\.wiki/],
    ['points a folder at machine state', JSON.stringify({ folders: { raw: 'node_modules' } }), /folders\.raw/],
    ['gives two roles the same folder', JSON.stringify({ folders: { wiki: 'notes', daily: 'notes' } }), /notes/],
    ['puts a heading marker in a section name', JSON.stringify({ sections: { notes: '## Notes' } }), /sections\.notes/],
    ['is not an object', '[]', /object/],
  ])('refuses a file that %s, naming what is wrong', (_what, content, detail) => {
    put(LAYOUT_FILE, content);
    let thrown: unknown;
    try {
      loadLayout(root);
    } catch (err) {
      thrown = err;
    }
    expect(errorContext(thrown).code).toBe('layout.invalid');
    expect(String((thrown as Error).message)).toMatch(detail);
  });
});

/**
 * A vault laid out its own way: English folder names, English section headings. Nothing in it is
 * where the default layout puts it, so anything still hard-coded writes to — or reads from — a
 * folder this vault does not have.
 */
describe('a vault with its own layout', () => {
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    put(
      LAYOUT_FILE,
      JSON.stringify({
        folders: { index: 'index', raw: 'inbox', wiki: 'knowledge', projects: 'projects', daily: 'journal', archive: 'old', templates: 'tpl' },
        sections: { notes: 'Notes', domains: 'Domains', captures: 'Captures', links: 'See also', related: 'Related', context: 'Context' },
      }),
    );
    put('index/index-knowledge.md', '---\ntipo: moc\n---\n\n# Index\n\n## Domains\n\n- [[../knowledge/docker/docker-moc|docker]]\n');
    put('knowledge/docker/docker-moc.md', '---\ntipo: moc\ntags: [docker]\n---\n\n# Docker\n\n## Notes\n\n- [[multi-stage]] — smaller images\n');
    put('knowledge/docker/multi-stage.md', '---\ntipo: wiki\ntags: [docker]\n---\n\n# Multi-stage\n\nzzbuildstage keeps the final image small.\n');
    put('inbox/clip.md', '# Clip\n\nzzrawonly clipped from the web.\n');
    put('old/retired.md', '---\ntipo: wiki\n---\n\n# Retired\n\nzzretired knowledge.\n');
    put('tpl/wiki.md', '---\ntipo: wiki\ntags: \ncriado: <% tp.date.now("YYYY-MM-DD") %>\n---\n\n# <% tp.file.title %>\n\n## Context\n\n## From the template\n');
    git('init', '-q', '-b', 'main');
    git('config', 'gc.auto', '0');
    git('config', 'user.name', 'Vault MCP Test');
    git('config', 'user.email', 'vault-mcp-test@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  async function connected() {
    const server = createVaultServer(root, 'en');
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text: string }>).map((part) => part.text).join('\n'),
      };
    };
    return {
      call,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('vault_learn files the note, the MOC entry and the daily capture in THIS vault\'s folders and sections', async () => {
    const { call, close } = await connected();
    const learned = await call('vault_learn', {
      title: 'Layer caching order',
      insight: 'zzlayercache: copy the lockfile before the sources so the install layer is reused.',
      context: 'slow CI builds',
      domain: 'docker',
      links: ['multi-stage'],
    });
    expect(learned.isError, learned.text).toBe(false);

    const note = read('knowledge/docker/layer-caching-order.md');
    expect(note).toContain('zzlayercache');
    // The two labels the server writes into the note itself are this vault's, too.
    expect(note).toContain('**Context:** slow CI builds');
    expect(note).toContain('## See also\n\n- [[multi-stage]]');
    expect(note).not.toContain('Contexto');
    // The template came from `tpl/`, and the related-links section took the configured name.
    expect(note).toContain('## From the template');
    expect(read('knowledge/docker/docker-moc.md')).toMatch(/## Notes\n[\s\S]*\[\[layer-caching-order\]\]/);
    const journal = readdirSync(join(root, 'journal'));
    expect(journal).toHaveLength(1);
    expect(read(`journal/${journal[0]}`)).toMatch(/## Captures\n[\s\S]*\[\[layer-caching-order\]\]/);

    // Nothing was written where the DEFAULT layout would have put it.
    for (const folder of ['02-wiki', '04-daily', '00-index', '_templates']) {
      expect(existsSync(join(root, folder)), folder).toBe(false);
    }
    expect(git('status', '--porcelain')).toBe('');
    await close();
  });

  it('a new domain is added to the index, under the configured heading and with the configured path', async () => {
    const { call, close } = await connected();
    const refused = await call('vault_learn', { title: 'First k8s note', insight: 'zzk8s: readiness is not liveness.', context: 'c', domain: 'k8s' });
    expect(refused.isError).toBe(true);
    // The refusal names the folder this vault has, not the default one.
    expect(refused.text).toContain('knowledge/');
    expect(refused.text).not.toContain('02-wiki');

    const learned = await call('vault_learn', { title: 'First k8s note', insight: 'zzk8s: readiness is not liveness.', context: 'c', domain: 'k8s', confirm_new_domain: true });
    expect(learned.isError, learned.text).toBe(false);
    expect(read('knowledge/k8s/k8s-moc.md')).toContain('## Notes');
    expect(read('index/index-knowledge.md')).toMatch(/## Domains\n[\s\S]*\[\[\.\.\/knowledge\/k8s\/k8s-moc\|k8s\]\]/);
    await close();
  });

  it('the scanner, the search and the list follow the configured roles', async () => {
    const { call, close } = await connected();

    // Templates are not notes, wherever the templates folder is.
    const listed = await call('vault_list', {});
    expect(listed.text).not.toContain('tpl/wiki.md');
    expect(listed.text).toContain('knowledge/docker/multi-stage.md');

    // The raw folder stays out of an ordinary search and comes back when asked for.
    expect((await call('vault_search', { query: 'zzrawonly' })).text).toContain('No results');
    expect((await call('vault_search', { query: 'zzrawonly', include_raw: true })).text).toContain('inbox/clip.md');

    // The archive is findable.
    expect((await call('vault_search', { query: 'zzretired' })).text).toContain('old/retired.md');
    await close();
  });

  it('the write guard protects the configured archive and templates, and not the default names', async () => {
    const { call, close } = await connected();

    expect((await call('vault_write_note', { path: 'old/new.md', content: '# x\n' })).isError).toBe(true);
    expect((await call('vault_write_note', { path: 'tpl/new.md', content: '# x\n' })).isError).toBe(true);
    // `99-archive` is just a folder name here.
    const ordinary = await call('vault_write_note', { path: '99-archive/note.md', content: '# x\n' });
    expect(ordinary.isError, ordinary.text).toBe(false);

    // Archiving is a MOVE into the archive, which the configured folder allows.
    const archived = await call('vault_move', { from: 'knowledge/docker/multi-stage.md', to: 'old/multi-stage.md' });
    expect(archived.isError, archived.text).toBe(false);
    expect(existsSync(join(root, 'old/multi-stage.md'))).toBe(true);
    expect(read('knowledge/docker/docker-moc.md')).not.toContain('[[multi-stage]]');
    await close();
  });

  it('a layout file that is wrong stops the server from starting, saying why', () => {
    put(LAYOUT_FILE, JSON.stringify({ folders: { wiki: 'a/b' } }));
    expect(() => createVaultServer(root, 'en')).toThrow(/folders\.wiki/);
  });
});
