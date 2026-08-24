import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseFile } from '../src/vault/frontmatter.js';
import { extractLinkTargets, resolveLinks } from '../src/vault/links.js';

const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

function listMarkdown(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listMarkdown(join(dir, entry.name), relative));
    else if (entry.name.endsWith('.md')) out.push(relative);
  }
  return out.sort();
}

const ALL_PATHS_LIST = listMarkdown(VAULT);
const ALL_PATHS = new Set(ALL_PATHS_LIST);

const BY_BASENAME = new Map<string, string[]>();
for (const path of ALL_PATHS_LIST) {
  const base = posix.basename(path, '.md');
  const bucket = BY_BASENAME.get(base);
  if (bucket === undefined) BY_BASENAME.set(base, [path]);
  else bucket.push(path);
}

function body(path: string): string {
  return parseFile(path, readFileSync(join(VAULT, path), 'utf8')).body;
}

function linksOf(path: string): { links: string[]; brokenLinks: string[] } {
  return resolveLinks(extractLinkTargets(body(path)), path, BY_BASENAME, ALL_PATHS);
}

describe('extractLinkTargets', () => {
  it('ignora wiki-link dentro de bloco de código cercado', () => {
    const targets = extractLinkTargets(body('02-wiki/nestjs/bullmq-worker.md'));

    expect(targets).not.toContain('link-dentro-de-codigo');
    expect(targets).toContain('auth-guard');
  });

  it('desduplica o mesmo alvo repetido, preservando a ordem de aparição', () => {
    const targets = extractLinkTargets(body('02-wiki/nestjs/bullmq-worker.md'));

    expect(targets.filter((t) => t === 'auth-guard')).toHaveLength(1);
  });

  it('preserva a ordem de aparição de alvos distintos', () => {
    const targets = extractLinkTargets(body('02-wiki/nestjs/nestjs-moc.md'));

    expect(targets).toEqual(['auth-guard', 'bullmq-worker', '../../00-index/index-knowledge']);
  });

  it('devolve o alvo antes do pipe na forma com alias, e ignora a âncora', () => {
    const targets = extractLinkTargets(
      'veja [[02-wiki/nestjs/auth-guard|o guard]] e [[multi-stage#Solução]] e [[a#b|c]]',
    );

    expect(targets).toEqual(['02-wiki/nestjs/auth-guard', 'multi-stage', 'a']);
  });
});

describe('resolveLinks — fixture', () => {
  it('resolve [[bullmq-worker]] para 02-wiki/nestjs/bullmq-worker.md', () => {
    const { links, brokenLinks } = linksOf('02-wiki/nestjs/nestjs-moc.md');

    expect(links).toContain('02-wiki/nestjs/bullmq-worker.md');
    expect(brokenLinks).toEqual([]);
  });

  it('coloca [[nota-que-nao-existe]] em brokenLinks e não em links', () => {
    const { links, brokenLinks } = linksOf('02-wiki/nestjs/auth-guard.md');

    expect(brokenLinks).toEqual(['nota-que-nao-existe']);
    expect(links).toEqual(['02-wiki/nestjs/bullmq-worker.md']);
  });

  it('resolve a forma com alias pelo alvo antes do pipe, a partir de 00-index', () => {
    const { links, brokenLinks } = linksOf('00-index/index-knowledge.md');

    expect(links).toEqual(['02-wiki/nestjs/nestjs-moc.md', '02-wiki/docker/docker-moc.md']);
    expect(brokenLinks).toEqual([]);
  });

  it('resolve o alias de nestjs-moc.md de volta para o índice de conhecimento', () => {
    const { links } = linksOf('02-wiki/nestjs/nestjs-moc.md');

    expect(links).toContain('00-index/index-knowledge.md');
  });

  it('resolve alias com caminho vault-relativo a partir da raiz do vault', () => {
    const { links, brokenLinks } = linksOf('CLAUDE.md');

    expect(links).toEqual(['02-wiki/nestjs/nestjs-moc.md', '02-wiki/docker/docker-moc.md']);
    expect(brokenLinks).toEqual([]);
  });

  it('resolve por basename um alvo em outra pasta', () => {
    const { links, brokenLinks } = linksOf('03-projects/potentia/README.md');

    expect(links).toEqual(['02-wiki/patterns/cache-wrapper.md', '02-wiki/nestjs/auth-guard.md']);
    expect(brokenLinks).toEqual([]);
  });
});

describe('resolveLinks — ambiguidade de basename', () => {
  it('resolve pelo candidato de menor profundidade de diretório', () => {
    const candidates = ['02-wiki/a/b/nota.md', '02-wiki/a/nota.md'];
    const byBasename = new Map([['nota', candidates]]);
    const { links, brokenLinks } = resolveLinks(
      ['nota'],
      '99-archive/antigo.md',
      byBasename,
      new Set(candidates),
    );

    expect(links).toEqual(['02-wiki/a/nota.md']);
    expect(brokenLinks).toEqual([]);
  });

  it('conta como quebrado quando dois candidatos empatam na profundidade', () => {
    const candidates = ['02-wiki/a/nota.md', '02-wiki/b/nota.md'];
    const byBasename = new Map([['nota', candidates]]);
    const { links, brokenLinks } = resolveLinks(
      ['nota'],
      '99-archive/antigo.md',
      byBasename,
      new Set(candidates),
    );

    expect(links).toEqual([]);
    expect(brokenLinks).toEqual(['nota']);
  });
});
