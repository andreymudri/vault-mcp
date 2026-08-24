import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { parseFile } from '../src/vault/frontmatter.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VAULT = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

function readFixture(relativePath: string): string {
  return readFileSync(join(VAULT, relativePath), 'utf8');
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'vault-mcp-tz-'));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/**
 * Parses a fixture in a child process pinned to `tz`, and returns its frontmatter. The child
 * runs the real TypeScript source through vite-node, the transpiler vitest itself uses.
 */
function parseInChildProcess(tz: string, fixture: string): Record<string, unknown> {
  const entry = join(SCRATCH, `parse-${tz.replace(/\W/g, '-')}.ts`);
  writeFileSync(
    entry,
    [
      `import { readFileSync } from 'node:fs';`,
      `import { parseFile } from ${JSON.stringify(join(REPO_ROOT, 'src/vault/frontmatter.ts'))};`,
      `const raw = readFileSync(${JSON.stringify(join(VAULT, fixture))}, 'utf8');`,
      `process.stdout.write(JSON.stringify(parseFile(${JSON.stringify(fixture)}, raw).frontmatter));`,
    ].join('\n'),
    'utf8',
  );

  const stdout = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'node_modules/vite-node/vite-node.mjs'), entry],
    { cwd: REPO_ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  );

  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('parseFile — frontmatter válido', () => {
  it('devolve tipo, tags e criado, com criado como string ISO e não Date', () => {
    const parsed = parseFile(
      '02-wiki/nestjs/auth-guard.md',
      readFixture('02-wiki/nestjs/auth-guard.md'),
    );

    expect(parsed.diagnostic).toBeUndefined();
    expect(parsed.frontmatter.tipo).toBe('wiki');
    expect(parsed.frontmatter.tags).toEqual(['nestjs', 'auth', 'jwt']);
    expect(parsed.frontmatter.criado).toBe('2026-01-10');
    expect(parsed.frontmatter.criado).not.toBeInstanceOf(Date);
  });

  it('converte também atualizado de nestjs-moc.md para string ISO', () => {
    const parsed = parseFile(
      '02-wiki/nestjs/nestjs-moc.md',
      readFixture('02-wiki/nestjs/nestjs-moc.md'),
    );

    expect(parsed.frontmatter.criado).toBe('2026-01-08');
    expect(parsed.frontmatter['atualizado']).toBe('2026-01-12');
    expect(parsed.frontmatter['atualizado']).not.toBeInstanceOf(Date);
  });

  // Uma data de frontmatter é um dia de calendário, não um instante de relógio: o js-yaml a
  // constrói à meia-noite UTC, então getters locais leriam 2026-01-10 como 2026-01-09 a oeste
  // de Greenwich. O mesmo conteúdo tem de dar a mesma string nos dois fusos.
  //
  // O fuso precisa mudar de verdade, e atribuir `process.env.TZ` dentro do vitest não muda: os
  // testes rodam em worker threads onde a atribuição não invalida o fuso cacheado pela V8 (o
  // valor muda em `process.env`, o `Date` continua no fuso do processo). Por isso o parse roda
  // num processo filho, um por fuso.
  it.each(['UTC', 'America/Sao_Paulo'])('lê a data igual sob TZ=%s', (tz) => {
    const frontmatter = parseInChildProcess(tz, '02-wiki/nestjs/auth-guard.md');
    const moc = parseInChildProcess(tz, '02-wiki/nestjs/nestjs-moc.md');

    expect(frontmatter['criado']).toBe('2026-01-10');
    expect(moc['criado']).toBe('2026-01-08');
    expect(moc['atualizado']).toBe('2026-01-12');
  }, 120_000);

  it('normaliza tags escrito como string única para array', () => {
    const parsed = parseFile('inline.md', '---\ntipo: wiki\ntags: nestjs\n---\n\n# Título\n');

    expect(parsed.frontmatter.tags).toEqual(['nestjs']);
  });

  it('normaliza tags escrito como string separada por vírgula para array', () => {
    const parsed = parseFile(
      'inline.md',
      '---\ntipo: wiki\ntags: nestjs, bullmq , filas\n---\n\ncorpo\n',
    );

    expect(parsed.frontmatter.tags).toEqual(['nestjs', 'bullmq', 'filas']);
  });
});

describe('parseFile — arquivo sem frontmatter', () => {
  it('devolve frontmatter sem chaves de dados e corpo intacto', () => {
    const raw = readFixture('01-raw/inbox/rascunho.md');
    const parsed = parseFile('01-raw/inbox/rascunho.md', raw);

    expect(parsed.diagnostic).toBeUndefined();
    expect(parsed.frontmatter.tipo).toBeUndefined();
    expect(parsed.frontmatter.criado).toBeUndefined();
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.body).toBe(raw);
    expect(parsed.body).toContain('rascunhoexclusivo');
  });
});

describe('parseFile — frontmatter malformado', () => {
  it('não lança, devolve frontmatter vazio, corpo preservado e um diagnostic', () => {
    const raw = readFixture('quebrada.md');

    let parsed!: ReturnType<typeof parseFile>;
    expect(() => {
      parsed = parseFile('quebrada.md', raw);
    }).not.toThrow();

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toContain('frontmatterpodre');
    expect(parsed.diagnostic).toBeDefined();
    expect(parsed.diagnostic?.path).toBe('quebrada.md');
    expect(parsed.diagnostic?.message).toContain('frontmatter inválido');
  });

  it('não deixa o bloco de frontmatter cru vazar para o corpo indexado', () => {
    const parsed = parseFile('quebrada.md', readFixture('quebrada.md'));

    expect(parsed.body).not.toContain('tipo: wiki');
    expect(parsed.body.trimStart().startsWith('---')).toBe(false);
  });

  // gray-matter memoiza por conteúdo quando chamado sem objeto de opções: a primeira chamada
  // lança e a segunda devolve o resultado cacheado, sem diagnostic e com o frontmatter cru
  // ainda dentro do corpo. O reindex incremental reparsa o mesmo arquivo várias vezes.
  it('produz o mesmo diagnostic ao parsear o mesmo conteúdo duas vezes seguidas', () => {
    const raw = readFixture('quebrada.md');

    const first = parseFile('quebrada.md', raw);
    const second = parseFile('quebrada.md', raw);

    expect(first.diagnostic).toBeDefined();
    expect(second.diagnostic).toBeDefined();
    expect(second.diagnostic).toEqual(first.diagnostic);
    expect(second.frontmatter).toEqual(first.frontmatter);
    expect(second.body).toBe(first.body);
    expect(second.body).not.toContain('tipo: wiki');
  });
});
