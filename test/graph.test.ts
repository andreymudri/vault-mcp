import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LinkGraph } from '../src/graph/graph.js';
import type { Note } from '../src/types.js';
import { VaultScanner } from '../src/vault/scanner.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

/**
 * One test in this file mutates a note's links to prove the graph is rebuilt correctly. Vitest
 * runs test files in parallel, so mutating `test/fixtures/vault/` itself would corrupt the reads
 * of every other test file. Work happens on a throwaway copy under `os.tmpdir()`, and nothing
 * here writes inside the fixture.
 */
let root: string;
let scanner: VaultScanner;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-graph-'));
  cpSync(FIXTURE, root, { recursive: true });
  scanner = new VaultScanner({ vaultRoot: root });
  scanner.refresh();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Sets mtime to a fixed later instant, so the change is visible whatever the clock resolution. */
function touch(relativePath: string): void {
  const absolute = join(root, relativePath);
  const when = new Date(Date.now() + 60_000);
  utimesSync(absolute, when, when);
}

const AUTH_GUARD = '02-wiki/nestjs/auth-guard.md';
const CACHE_WRAPPER = '02-wiki/patterns/cache-wrapper.md';
const POTENTIA_README = '03-projects/potentia/README.md';

describe('LinkGraph.build', () => {
  it('backlinks de auth-guard.md inclui cache-wrapper.md e potentia/README.md', () => {
    const graph = new LinkGraph();
    graph.build(scanner.allNotes());

    const back = graph.backlinks(AUTH_GUARD);
    expect(back).toContain(CACHE_WRAPPER);
    expect(back).toContain(POTENTIA_README);
  });

  it('neighbors une links de saída e backlinks sem duplicar', () => {
    const graph = new LinkGraph();
    graph.build(scanner.allNotes());

    const out = graph.outLinks(AUTH_GUARD);
    const back = graph.backlinks(AUTH_GUARD);
    const neighbors = graph.neighbors(AUTH_GUARD);

    // auth-guard.md linka bullmq-worker.md, e bullmq-worker.md linka de volta auth-guard.md
    // (duas vezes no corpo) — union precisa deduplicar essa aresta mútua.
    expect(out).toContain('02-wiki/nestjs/bullmq-worker.md');
    expect(back).toContain('02-wiki/nestjs/bullmq-worker.md');

    for (const path of out) expect(neighbors).toContain(path);
    for (const path of back) expect(neighbors).toContain(path);
    expect(new Set(neighbors).size).toBe(neighbors.length);
    expect(neighbors).not.toContain(AUTH_GUARD);
  });

  it('o wiki-link quebrado de auth-guard.md não aparece em lugar nenhum da adjacência', () => {
    const graph = new LinkGraph();
    graph.build(scanner.allNotes());

    const note = scanner.getNote(AUTH_GUARD);
    expect(note?.brokenLinks).toContain('nota-que-nao-existe');

    for (const path of scanner.allNotes().map((n) => n.path)) {
      expect(graph.outLinks(path)).not.toContain('nota-que-nao-existe');
      expect(graph.outLinks(path).some((p) => p.includes('nota-que-nao-existe'))).toBe(false);
      expect(graph.backlinks(path)).not.toContain('nota-que-nao-existe');
      expect(graph.backlinks(path).some((p) => p.includes('nota-que-nao-existe'))).toBe(false);
    }
  });

  it('uma nota sem links tem neighbors vazio', () => {
    const graph = new LinkGraph();
    graph.build(scanner.allNotes());

    const note = scanner.getNote('01-raw/inbox/rascunho.md');
    expect(note?.links).toEqual([]);
    expect(graph.neighbors('01-raw/inbox/rascunho.md')).toEqual([]);
    expect(graph.outLinks('01-raw/inbox/rascunho.md')).toEqual([]);
    expect(graph.backlinks('01-raw/inbox/rascunho.md')).toEqual([]);
  });

  it('o grafo é reconstruído corretamente após uma nota mudar seus links', () => {
    const graph = new LinkGraph();
    graph.build(scanner.allNotes());
    expect(graph.backlinks(CACHE_WRAPPER)).toContain(POTENTIA_README);

    const absolute = join(root, POTENTIA_README);
    const original = readFileSync(absolute, 'utf8');
    const updated = original.replace(/\[\[cache-wrapper\]\]/g, 'cache wrapper (link removido)');
    expect(updated).not.toBe(original);
    writeFileSync(absolute, updated);
    touch(POTENTIA_README);

    scanner.refresh();
    graph.build(scanner.allNotes());

    expect(graph.backlinks(CACHE_WRAPPER)).not.toContain(POTENTIA_README);
    // O link para auth-guard.md permanece intacto na mesma nota.
    expect(graph.backlinks(AUTH_GUARD)).toContain(POTENTIA_README);
  });

  it('neighbors exclui o próprio caminho quando a nota linka para si mesma', () => {
    // Cenário real: 02-wiki/docker/multi-stage.md menciona "[[multi-stage]]" na própria
    // prosa. Nenhuma nota da fixture faz isso hoje, então esse Note é construído em memória
    // para exercitar de fato o ramo de auto-exclusão de `neighbors` — sem essa nota,
    // `neighbors(path) !== path` nunca é realmente testado, porque `path` nunca aparece como
    // seu próprio alvo de link em `test/fixtures/vault/`.
    const selfLinking: Note = {
      path: '02-wiki/docker/multi-stage.md',
      title: 'multi-stage',
      frontmatter: {},
      body: '',
      links: ['02-wiki/docker/multi-stage.md'],
      brokenLinks: [],
      mtimeMs: 0,
    };

    const graph = new LinkGraph();
    graph.build([selfLinking]);

    expect(graph.outLinks(selfLinking.path)).toEqual([selfLinking.path]);
    expect(graph.backlinks(selfLinking.path)).toEqual([selfLinking.path]);
    expect(graph.neighbors(selfLinking.path)).not.toContain(selfLinking.path);
    expect(graph.neighbors(selfLinking.path)).toEqual([]);
  });
});
