import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import {
  applyTemplate,
  ensureFrontmatter,
  formatLocal,
  TemplateError,
} from '../src/write/template.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(here);
const TEMPLATES = join(here, 'fixtures', 'vault', '_templates');
const MODULE_SRC = join(ROOT, 'src', 'write', 'template.ts');

/**
 * Runs `snippet` against the real `src/write/template.ts` in a child process
 * pinned to `tz`, and returns what it printed.
 *
 * A child process is the only honest way to assert this: vitest runs test files
 * in worker threads, where assigning `process.env.TZ` never reaches `tzset()`,
 * so the timezone of the runner cannot be changed from inside a test. The
 * transpiled module lands under `node_modules/` so that its `gray-matter`
 * import still resolves.
 */
function runInTimezone(tz: string, snippet: string): string {
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.vault-mcp-tz-'));
  try {
    const js = ts.transpileModule(readFileSync(MODULE_SRC, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const entry = join(dir, 'probe.mjs');
    writeFileSync(entry, `${js}\n${snippet}\n`);
    return execFileSync(process.execPath, [entry], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATES, name), 'utf8');
}

/** Local wall-clock date: independent of the machine timezone. */
function localDate(
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe('applyTemplate', () => {
  const ctx = { title: 'Cache Wrapper', now: localDate(2026, 8, 24, 9, 5) };

  it('aplica o template wiki real sem deixar nenhum token <% no resultado', () => {
    const out = applyTemplate(readTemplate('wiki.md'), ctx);
    expect(out).not.toContain('<%');
    expect(out).not.toContain('%>');
  });

  it('aplica o template projeto real sem deixar nenhum token <% no resultado', () => {
    const out = applyTemplate(readTemplate('projeto.md'), ctx);
    expect(out).not.toContain('<%');
    expect(out).not.toContain('%>');
  });

  it('substitui tp.file.title pelo título do contexto', () => {
    expect(applyTemplate('# <% tp.file.title %>', ctx)).toBe('# Cache Wrapper');
  });

  it('substitui tp.date.now("YYYY-MM-DD")', () => {
    expect(applyTemplate('criado: <% tp.date.now("YYYY-MM-DD") %>', ctx)).toBe(
      'criado: 2026-08-24',
    );
  });

  it('substitui tp.date.now("DD/MM/YYYY")', () => {
    expect(applyTemplate('<% tp.date.now("DD/MM/YYYY") %>', ctx)).toBe('24/08/2026');
  });

  it('aceita espaçamento variável dentro dos delimitadores', () => {
    expect(applyTemplate('# <%tp.file.title%>', ctx)).toBe('# Cache Wrapper');
    expect(applyTemplate('# <%   tp.file.title   %>', ctx)).toBe('# Cache Wrapper');
    expect(applyTemplate('<%tp.date.now("YYYY-MM-DD")%>', ctx)).toBe('2026-08-24');
    expect(applyTemplate("<% tp.date.now('YYYY') %>", ctx)).toBe('2026');
  });

  it('substitui múltiplos tokens na mesma linha', () => {
    expect(
      applyTemplate('<% tp.file.title %> — <% tp.date.now("YYYY-MM-DD") %>', ctx),
    ).toBe('Cache Wrapper — 2026-08-24');
  });

  it('suporta os tokens HH e mm', () => {
    expect(applyTemplate('<% tp.date.now("HH:mm") %>', ctx)).toBe('09:05');
  });

  it('lança TemplateError citando a expressão desconhecida em vez de gravá-la literalmente', () => {
    expect(() => applyTemplate('<% tp.file.cursor() %>', ctx)).toThrow(TemplateError);
    expect(() => applyTemplate('<% tp.file.cursor() %>', ctx)).toThrow(
      /tp\.file\.cursor\(\)/,
    );
    expect(() => applyTemplate('<% tp.system.prompt("x") %>', ctx)).toThrow(
      /tp\.system\.prompt\("x"\)/,
    );
  });
});

// Estes são os testes que travam a DIREÇÃO da conversão de data deste módulo,
// oposta à de `vault/frontmatter.ts`. `ctx.now` é um instante real de relógio de
// parede: formatá-lo em UTC faria uma captura às 22:30 em São Paulo cair na nota
// diária do dia seguinte, carregando um 01:30 dentro dela.
describe('formatação em horário LOCAL (não UTC)', () => {
  // 2026-08-25T01:30:00Z é 2026-08-24 22:30 em São Paulo (UTC−3).
  const INSTANT = '2026-08-25T01:30:00Z';

  it('às 22:30 de 2026-08-24 em America/Sao_Paulo produz 2026-08-24 22:30, não 2026-08-25 01:30', () => {
    const out = runInTimezone(
      'America/Sao_Paulo',
      `const now = new Date(${JSON.stringify(INSTANT)});
       console.log(JSON.stringify([
         formatLocal(now, 'YYYY-MM-DD HH:mm'),
         formatLocal(now, 'YYYY-MM-DD'),
         formatLocal(now, 'HH:mm'),
         applyTemplate('<% tp.date.now("YYYY-MM-DD HH:mm") %>', { title: 'x', now }),
       ]));`,
    );
    expect(JSON.parse(out)).toEqual([
      '2026-08-24 22:30',
      '2026-08-24',
      '22:30',
      '2026-08-24 22:30',
    ]);
  });

  it('em Asia/Tokyo o mesmo instante é 2026-08-25 10:30', () => {
    const out = runInTimezone(
      'Asia/Tokyo',
      `console.log(formatLocal(new Date(${JSON.stringify(INSTANT)}), 'YYYY-MM-DD HH:mm'));`,
    );
    expect(out).toBe('2026-08-25 10:30');
  });

  it('lê os getters locais do Date, nunca os getUTC*', () => {
    // Um Date cujos getters locais dizem 22:30 de 24/08 e cujos getUTC* dizem
    // 01:30 de 25/08: uma implementação em UTC devolveria a data errada aqui,
    // qualquer que seja o fuso da máquina que roda a suíte.
    const now = new Date(INSTANT);
    Object.defineProperties(now, {
      getFullYear: { value: () => 2026 },
      getMonth: { value: () => 7 },
      getDate: { value: () => 24 },
      getHours: { value: () => 22 },
      getMinutes: { value: () => 30 },
    });

    expect(now.getUTCDate()).toBe(25);
    expect(now.getUTCHours()).toBe(1);
    expect(formatLocal(now, 'YYYY-MM-DD HH:mm')).toBe('2026-08-24 22:30');
    expect(
      applyTemplate('<% tp.date.now("YYYY-MM-DD HH:mm") %>', { title: 'x', now }),
    ).toBe('2026-08-24 22:30');
  });
});

describe('formatLocal', () => {
  it('preenche mês, dia, hora e minuto com zero à esquerda', () => {
    expect(formatLocal(localDate(2026, 1, 2, 3, 4), 'YYYY-MM-DD HH:mm')).toBe(
      '2026-01-02 03:04',
    );
  });

  it('preserva os literais do formato', () => {
    expect(formatLocal(localDate(2026, 8, 24, 22, 30), 'DD/MM/YYYY às HH:mm')).toBe(
      '24/08/2026 às 22:30',
    );
  });
});

describe('ensureFrontmatter', () => {
  const required = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  it('prefixa um bloco novo quando o conteúdo não tem frontmatter', () => {
    const out = ensureFrontmatter('# Cache Wrapper\n\ntexto\n', required);
    expect(out).toBe(
      '---\ntipo: wiki\ntags: [nestjs, auth]\ncriado: 2026-08-24\n---\n\n# Cache Wrapper\n\ntexto\n',
    );
  });

  it('serializa tags em estilo de fluxo', () => {
    const out = ensureFrontmatter('corpo\n', required);
    expect(out).toContain('tags: [nestjs, auth]');
  });

  it('preserva as chaves já existentes e preenche só as ausentes', () => {
    const content = '---\ntipo: projeto\nstatus: ativo\n---\n\n# Potentia\n';
    const out = ensureFrontmatter(content, required);
    expect(out).toContain('tipo: projeto');
    expect(out).toContain('status: ativo');
    expect(out).toContain('tags: [nestjs, auth]');
    expect(out).toContain('criado: 2026-08-24');
    expect(out).toContain('# Potentia');
    // Não duplica a chave preservada.
    expect(out.match(/^tipo:/gm)).toHaveLength(1);
  });

  it('preenche chaves declaradas com valor vazio, sem duplicar a linha', () => {
    const content = '---\ntipo: wiki\ntags: \ncriado: 2026-08-24\n---\n\n# X\n';
    const out = ensureFrontmatter(content, required);
    expect(out).toContain('tags: [nestjs, auth]');
    expect(out.match(/^tags:/gm)).toHaveLength(1);
  });

  it('é idempotente', () => {
    const once = ensureFrontmatter('# X\n', required);
    expect(ensureFrontmatter(once, required)).toBe(once);
  });

  it('mantém o corpo intacto quando o frontmatter já está completo', () => {
    const content =
      '---\ntipo: wiki\ntags: [docker]\ncriado: 2026-01-10\n---\n\n# Multi Stage\n\ncorpo\n';
    expect(ensureFrontmatter(content, required)).toBe(content);
  });

  it('encadeia depois de applyTemplate sem deixar tokens no resultado', () => {
    const applied = applyTemplate(readTemplate('wiki.md'), {
      title: 'Cache Wrapper',
      now: localDate(2026, 8, 24, 22, 30),
    });
    const out = ensureFrontmatter(applied, required);
    expect(out).not.toContain('<%');
    expect(out).toContain('tags: [nestjs, auth]');
    expect(out).toContain('criado: 2026-08-24');
    expect(out).toContain('# Cache Wrapper');
  });
});
