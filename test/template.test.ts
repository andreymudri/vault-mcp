import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
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

/** Absolute URL of the real `gray-matter`, resolved from THIS file's node_modules. */
const GRAY_MATTER_URL = pathToFileURL(
  createRequire(import.meta.url).resolve('gray-matter'),
).href;

/**
 * Runs `snippet` against the real `src/write/template.ts` in a child process
 * pinned to `tz`, and returns what it printed.
 *
 * A child process is the only honest way to assert this: vitest runs test files
 * in worker threads, where assigning `process.env.TZ` never reaches `tzset()`,
 * so the timezone of the runner cannot be changed from inside a test.
 *
 * The scratch directory goes under `os.tmpdir()`, NOT under the repo. An earlier
 * version put it in `<repo>/node_modules` so the module's bare `gray-matter`
 * import would resolve by directory position — but `teammates.gate.json`
 * SYMLINKS `node_modules` into the gate's preview tree, so that path is the one
 * real shared directory, not a private copy, and the test was writing into it.
 * The import is rewritten to an absolute file URL instead, which resolves from
 * anywhere on disk.
 */
function runInTimezone(tz: string, snippet: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-mcp-tz-'));
  try {
    const js = ts
      .transpileModule(readFileSync(MODULE_SRC, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      })
      .outputText.replace(
        /(\bfrom\s*)(['"])gray-matter\2/g,
        (_m, from: string) => `${from}${JSON.stringify(GRAY_MATTER_URL)}`,
      );
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

  // O TOKEN_RE é deliberadamente linear e, por isso, exclui `\n` de todas as
  // alternativas: ele NÃO casa um token multi-linha. Sem uma segunda checagem o
  // resultado seria devolver o texto cru — nem substituído, nem recusado —, que
  // é exatamente a falha que este módulo existe para impedir. T13 lê
  // `_templates/*.md` do vault REAL, onde a forma de bloco `<%* ... %>` do
  // Templater é comum; sem isto a nota nova nasceria com o bloco cru no corpo.
  it('lança TemplateError num token multi-linha em vez de devolvê-lo cru', () => {
    const multiline = '<%\ntp.file.title\n%>';
    expect(() => applyTemplate(multiline, ctx)).toThrow(TemplateError);
    expect(() => applyTemplate(multiline, ctx)).toThrow(/<%/);
  });

  it('lança TemplateError no bloco `<%* ... %>` de um template real do Obsidian', () => {
    const block = '# Nota\n\n<%*\nconst t = tp.file.title\n%>\n\ncorpo\n';
    expect(() => applyTemplate(block, ctx)).toThrow(TemplateError);
    // O erro precisa CITAR o fragmento que sobrou, senão é indepurável.
    expect(() => applyTemplate(block, ctx)).toThrow(/<%\*/);
  });

  it('lança quando sobra um `<%` sem fechamento em vez de gravá-lo na nota', () => {
    expect(() => applyTemplate('texto <% tp.file.title', ctx)).toThrow(TemplateError);
    expect(() => applyTemplate('<%', ctx)).toThrow(TemplateError);
  });

  it('não lança quando nenhum `<%` sobra no resultado', () => {
    expect(() => applyTemplate('# <% tp.file.title %>\n\n100% pronto\n', ctx)).not.toThrow();
    expect(applyTemplate('sem token algum\n', ctx)).toBe('sem token algum\n');
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

// Os valores que chegam aqui vêm de uma chamada `vault_write_note` — ou seja, de
// um modelo de linguagem — e o resultado é gravado no vault real do usuário. Um
// escape faltando não é cosmético: ou o js-yaml passa a RECUSAR a nota (e ela
// perde todos os metadados), ou o bloco fecha cedo e chaves caem no corpo.
// Cada teste abaixo assere a IDA E VOLTA: serializa e reparsa com `matter(out, {})`.
describe('ensureFrontmatter — escape de YAML', () => {
  const base = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  it('cita uma tag com `]` em vez de quebrar a lista de fluxo', () => {
    const out = ensureFrontmatter('corpo\n', { ...base, tags: ['nestjs', 'auth]'] });
    // Sem aspas isto vira `tags: [nestjs, auth]]`, que o js-yaml RECUSA.
    expect(() => matter(out, {})).not.toThrow();
    expect(matter(out, {}).data.tags).toEqual(['nestjs', 'auth]']);
  });

  it('cita tags com os demais metacaracteres de contexto de fluxo', () => {
    const tags = ['a[b', 'c{d', 'e}f', 'g,h', '#i', 'j: k', ' l', 'm '];
    const out = ensureFrontmatter('corpo\n', { ...base, tags });
    expect(() => matter(out, {})).not.toThrow();
    expect(matter(out, {}).data.tags).toEqual(tags);
  });

  it('mantém uma tag com vírgula como UMA tag, não três', () => {
    const out = ensureFrontmatter('corpo\n', { ...base, tags: ['a, b, c'] });
    expect(matter(out, {}).data.tags).toEqual(['a, b, c']);
  });

  it('cita um valor com quebra de linha em vez de fechar o bloco cedo', () => {
    const tipo = 'linha\n---\nfim';
    const out = ensureFrontmatter('corpo\n', { ...base, tipo });
    const parsed = matter(out, {});
    // A garantia declarada da função: TODAS as chaves ficam no frontmatter.
    expect(parsed.data.tipo).toBe(tipo);
    expect(parsed.data.tags).toEqual(['nestjs', 'auth']);
    expect(parsed.data.criado).toBeDefined();
    // ...e o corpo continua sendo só o corpo.
    expect(parsed.content).toBe('\ncorpo\n');
  });

  it('não altera a serialização simples que o vault já usa', () => {
    const out = ensureFrontmatter('corpo\n', base);
    expect(out).toContain('tipo: wiki');
    expect(out).toContain('tags: [nestjs, auth]');
    expect(out).toContain('criado: 2026-08-24');
  });
});

// `Frontmatter` tem index signature: as CHAVES são tão controladas pelo modelo
// quanto os valores. Endurecer só o valor de `${key}: ${serializeValue(value)}`
// deixa a metade esquerda da linha aberta — e é a metade que decide onde o
// bloco TERMINA.
describe('ensureFrontmatter — escape das CHAVES', () => {
  const base = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  it('não deixa uma chave com `\\n---\\n` fechar o bloco e injetar metadado', () => {
    const key = 'k\n---\ntipo: injetado';
    const out = ensureFrontmatter('corpo\n', { ...base, [key]: 'v' });
    const parsed = matter(out, {});

    expect(() => matter(out, {})).not.toThrow();
    // Sem escape, o segundo `---` fecha o bloco: `tipo` viraria `injetado` e o
    // resto da nota viraria corpo.
    expect(parsed.data.tipo).toBe('wiki');
    expect(parsed.data[key]).toBe('v');
    expect(parsed.content).toBe('\ncorpo\n');
  });

  it('mantém `a: 1\\nb` como UMA chave, sem injetar uma entrada extra', () => {
    const key = 'a: 1\nb';
    const out = ensureFrontmatter('corpo\n', { ...base, [key]: 'v' });
    const parsed = matter(out, {});

    expect(parsed.data[key]).toBe('v');
    expect(parsed.data.a).toBeUndefined();
    expect(Object.keys(parsed.data)).toEqual(['tipo', 'tags', 'criado', key]);
  });

  it('escapa caracteres de controle numa chave em vez de perder o bloco inteiro', () => {
    const key = 'a\x1bb\x7fc\x9dd';
    const out = ensureFrontmatter('corpo\n', { ...base, [key]: 'v' });

    // Um caractere não-imprimível CRU faz o js-yaml recusar o stream inteiro.
    expect(() => matter(out, {})).not.toThrow();
    expect(matter(out, {}).data[key]).toBe('v');
    expect(matter(out, {}).data.tipo).toBe('wiki');
  });

  it('não põe aspas nas chaves simples que o vault já usa', () => {
    const out = ensureFrontmatter('corpo\n', base);
    expect(out).toContain('\ntipo: wiki\n');
    expect(out).toContain('\ntags: [nestjs, auth]\n');
    expect(out).toContain('\ncriado: 2026-08-24\n');
  });
});

// Um caractere de controle cru faz o js-yaml recusar o documento INTEIRO com
// "the stream contains non-printable characters": a nota perde todos os
// metadados, de forma permanente. Sequências ANSI são conteúdo ordinário numa
// página clipada para `01-raw/clippings/`, então isto não é hipotético.
describe('ensureFrontmatter — caracteres de controle C0/C1 e DEL', () => {
  const base = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  /** Todo C0, DEL e todo C1 — a faixa exata que o js-yaml recusa. */
  const CONTROLS: string[] = [];
  for (let code = 0x00; code <= 0x1f; code += 1) CONTROLS.push(String.fromCharCode(code));
  for (let code = 0x7f; code <= 0x9f; code += 1) CONTROLS.push(String.fromCharCode(code));

  it('faz a ida e volta de cada caractere de controle num VALOR', () => {
    for (const ch of CONTROLS) {
      const tipo = `a${ch}b`;
      const out = ensureFrontmatter('corpo\n', { ...base, tipo });
      const code = ch.charCodeAt(0).toString(16);
      expect(() => matter(out, {}), `valor com U+${code}`).not.toThrow();
      expect(matter(out, {}).data.tipo, `valor com U+${code}`).toBe(tipo);
    }
  });

  it('faz a ida e volta de cada caractere de controle numa TAG', () => {
    for (const ch of CONTROLS) {
      const tags = ['nestjs', `a${ch}b`];
      const out = ensureFrontmatter('corpo\n', { ...base, tags });
      const code = ch.charCodeAt(0).toString(16);
      expect(() => matter(out, {}), `tag com U+${code}`).not.toThrow();
      expect(matter(out, {}).data.tags, `tag com U+${code}`).toEqual(tags);
    }
  });

  it('preserva uma sequência ANSI vinda de uma página clipada', () => {
    const tipo = '\x1b[31mvermelho\x1b[0m';
    const tags = ['\x1b[1mnegrito\x1b[0m', 'auth'];
    const out = ensureFrontmatter('corpo\n', { ...base, tipo, tags });
    const parsed = matter(out, {});

    expect(parsed.data.tipo).toBe(tipo);
    expect(parsed.data.tags).toEqual(tags);
    expect(parsed.content).toBe('\ncorpo\n');
  });

  it('não emite nenhum caractere não-imprimível cru no resultado', () => {
    const out = ensureFrontmatter('corpo\n', {
      ...base,
      tipo: 'a\x00b\x1bc\x7fd\x85e\x9ff',
      tags: ['g\x07h'],
    });
    expect(out).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
  });
});

describe('ensureFrontmatter — `---` no início do CORPO', () => {
  const required = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  it('não engole um `# Titulo` do corpo tratando o `---` inicial como abertura', () => {
    const out = ensureFrontmatter('---\n\n# Titulo\n\n---\n\ntexto\n', required);
    const parsed = matter(out, {});
    expect(parsed.data).toEqual({
      tipo: 'wiki',
      tags: ['nestjs', 'auth'],
      criado: new Date('2026-08-24T00:00:00.000Z'),
    });
    // `#` é comentário em YAML: sem o conserto o título some da nota.
    expect(parsed.content).toContain('# Titulo');
    expect(parsed.content).toContain('texto');
  });

  it('preserva verbatim um `---` de abertura sem fechamento', () => {
    const content = '---\n\n# Titulo\n';
    const out = ensureFrontmatter(content, required);
    const parsed = matter(out, {});
    expect(parsed.data).toEqual({
      tipo: 'wiki',
      tags: ['nestjs', 'auth'],
      criado: new Date('2026-08-24T00:00:00.000Z'),
    });
    // O `---` órfão é uma régua horizontal do usuário: nada dele é apagado.
    expect(parsed.content).toBe(`\n${content}`);
    expect(ensureFrontmatter(out, required)).toBe(out);
  });
});

describe('ensureFrontmatter — parsing sem o cache global do gray-matter', () => {
  it('parseia o mesmo bloco malformado duas vezes sem popular matter.cache', () => {
    const required = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };
    const malformed = '---\ntipo: "aberto\n---\n\ncorpo\n';

    matter.clearCache();
    const first = ensureFrontmatter(malformed, required);
    const second = ensureFrontmatter(malformed, required);

    expect(second).toBe(first);
    // Sem o `{}`, o gray-matter guarda o conteúdo num cache global ilimitado e
    // devolve o objeto meio-parseado da chamada que lançou.
    expect(Object.keys(matter.cache)).toHaveLength(0);
  });
});

/**
 * O tempo ABSOLUTO num único tamanho não é um guarda de complexidade, e a
 * versão anterior deste teste provou isso ao contrário: pedia < 2000ms sobre
 * 4.000 chars, e a forma QUADRÁTICA `/<%((?:[^%\n]|%(?!>))*)%>/g` — uma
 * "simplificação" plausível do `TOKEN_RE`, que perde só o `<(?!%)` — passava
 * com 370× de folga. O orçamento absoluto pegava apenas o caso ingênuo e
 * escondia exatamente a regressão mais provável.
 *
 * O protocolo aqui mede COMPLEXIDADE em vez de velocidade: em cada tamanho `n`
 * o teste executa `TOTAL/n` repetições, então TODAS as medições varrem o mesmo
 * número total de caracteres. Uma implementação linear gasta o mesmo tempo nas
 * quatro; uma quadrática gasta tempo ∝ n, dobrando a cada tamanho. A asserção
 * é a RAZÃO entre o maior e o menor tamanho, que é adimensional — independe da
 * velocidade da máquina, do JIT e da carga, coisas que um limite em ms não
 * consegue evitar.
 *
 * Medido nesta máquina (mínimo de 3 execuções, `TOTAL` = 96.000 chars):
 *   linear      4k:0,41ms  8k:0,41ms  16k:0,41ms  32k:0,40ms  → razão ~1,0
 *   quadrático  4k:244ms   8k:511ms   16k:1012ms  32k:1971ms  → razão ~8,0
 *   ingênuo     4k:427ms   8k:840ms   16k:1754ms  32k:3479ms  → razão ~7,9
 * O caminho VERDE custa ~5ms no total; o vermelho termina em ~11s, bem dentro
 * do timeout — uma regressão FALHA na asserção em vez de travar a suíte.
 */
describe('applyTemplate — custo do TOKEN_RE', () => {
  const TOTAL = 96_000;
  const SIZES = [4_000, 8_000, 16_000, 32_000];
  /** Linear mede ~1,0; quadrático ~8,0. 3 dá 3× de folga dos dois lados. */
  const MAX_RATIO = 3;

  /** Muitos `<%` e nenhum `%>`: a forma que força o rescan até o fim. */
  const adversarial = (n: number): string => '<% '.repeat(Math.floor(n / 3));

  it('cresce LINEARMENTE, não só "rápido o bastante", sobre entrada adversarial', () => {
    const ctx = { title: 'x', now: localDate(2026, 8, 24) };
    const run = (input: string): void => {
      try {
        applyTemplate(input, ctx);
      } catch {
        // Um token não resolvido é resposta legítima; o que se mede é o custo.
      }
    };

    const times = SIZES.map((n) => {
      const input = adversarial(n);
      const reps = Math.round(TOTAL / n);
      run(input); // aquece o JIT fora da medição
      let best = Infinity;
      // O MÍNIMO de várias tentativas, não a média: ruído só ADICIONA tempo, e
      // o mínimo é o estimador robusto do custo real.
      for (let trial = 0; trial < 3; trial += 1) {
        const t0 = performance.now();
        for (let i = 0; i < reps; i += 1) run(input);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    });

    const ratio = times[times.length - 1]! / times[0]!;
    expect(
      ratio,
      `trabalho total constante deveria custar o mesmo em todo tamanho; medido ` +
        `${SIZES.map((n, i) => `${n}:${times[i]!.toFixed(2)}ms`).join(' ')}`,
    ).toBeLessThan(MAX_RATIO);
  }, 60_000);
});

// `ensureFrontmatter` só é idempotente se reconhecer a chave existente em
// QUALQUER grafia YAML que a denote. A grafia com aspas SIMPLES é YAML comum e
// pode já estar no vault do usuário; sem reconhecê-la, a segunda passada APENDA
// uma segunda `tipo:`, o `parseBlock` da terceira passada morre na chave
// duplicada, o `splitFrontmatter` devolve undefined e o bloco ORIGINAL do
// usuário é rebaixado para dentro do CORPO da nota. Destrutivo, não cosmético.
describe('ensureFrontmatter — idempotência em todas as grafias da chave', () => {
  const CASES: Array<{ key: string; spellings: string[] }> = [
    { key: 'tipo', spellings: ['tipo', '"tipo"', "'tipo'"] },
    // Chave que o `serializeKey` PRECISA citar (espaços) — o caso que nada
    // fixava: estreitar o índice para a grafia simples passava nos 42 testes.
    { key: 'tipo do doc', spellings: ['tipo do doc', '"tipo do doc"', "'tipo do doc'"] },
    // Aspas simples escapadas por duplicação, a regra do YAML.
    { key: "o'brien", spellings: ["o'brien", '"o\'brien"', "'o''brien'"] },
  ];

  for (const { key, spellings } of CASES) {
    for (const spelling of spellings) {
      it(`substitui em vez de apendar quando a chave já existe como ${spelling}`, () => {
        const content = `---\n${spelling}: \n---\ncorpo\n`;
        const once = ensureFrontmatter(content, { [key]: 'wiki' });
        const twice = ensureFrontmatter(once, { [key]: 'wiki' });
        const thrice = ensureFrontmatter(twice, { [key]: 'wiki' });

        // Uma única linha de chave, não duas.
        expect(once.split('\n').filter((line) => line.includes(':')).length).toBe(1);
        expect(twice).toBe(once);
        expect(thrice).toBe(once);

        // E o resultado continua sendo UM bloco, com o corpo intacto.
        expect(thrice.match(/^---$/gm)?.length).toBe(2);
        const parsed = matter(thrice, {});
        expect((parsed.data as Record<string, unknown>)[key]).toBe('wiki');
        expect(parsed.content).toBe('corpo\n');
      });
    }
  }
});

// O portão real do js-yaml (loader.js:26) é
// `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F￾￿]` MAIS os
// surrogates desemparelhados. U+FFFE, U+FFFF e um surrogate solto ficavam de
// fora da regra de citação: saíam CRUS, o `matter()` recusava o documento
// inteiro e a `ensureFrontmatter` seguinte prefixava um SEGUNDO bloco,
// empurrando os metadados originais para o corpo.
//
// Isto é alcançável por uso ordinário, não por ataque: o plano trunca `resumo`
// num comprimento fixo, e cortar texto com emoji no meio do par produz
// exatamente um surrogate desemparelhado.
describe('ensureFrontmatter — U+FFFE, U+FFFF e surrogates desemparelhados', () => {
  const base = { tipo: 'wiki', tags: ['nestjs', 'auth'], criado: '2026-08-24' };

  /** Exatamente o que o portão do js-yaml recusa e a regra antiga ignorava. */
  const NASTY: Array<[string, string]> = [
    ['U+FFFE', '￾'],
    ['U+FFFF', '￿'],
    ['high surrogate solto', '\ud83d'],
    ['low surrogate solto', '\ude00'],
  ];

  const RAW_RE =
    /[￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  for (const [name, ch] of NASTY) {
    it(`faz a ida e volta de ${name} num VALOR`, () => {
      const tipo = `guia${ch}`;
      const out = ensureFrontmatter('corpo\n', { ...base, tipo });
      expect(() => matter(out, {}), name).not.toThrow();
      expect(matter(out, {}).data.tipo, name).toBe(tipo);
      expect(matter(out, {}).content, name).toBe('\ncorpo\n');
    });

    it(`faz a ida e volta de ${name} numa TAG`, () => {
      const tags = ['nestjs', `guia-${ch}`];
      const out = ensureFrontmatter('corpo\n', { ...base, tags });
      expect(() => matter(out, {}), name).not.toThrow();
      expect(matter(out, {}).data.tags, name).toEqual(tags);
    });

    it(`não emite ${name} cru e continua idempotente`, () => {
      const out = ensureFrontmatter('corpo\n', { ...base, tipo: `guia${ch}` });
      expect(RAW_RE.test(out), name).toBe(false);
      // Sem a citação, esta segunda passada prefixava um SEGUNDO bloco.
      expect(ensureFrontmatter(out, base), name).toBe(out);
      expect(out.match(/^---$/gm)?.length, name).toBe(2);
    });
  }

  it('um resumo truncado no meio de um emoji não destrói o frontmatter', () => {
    // `'guia 😀'.slice(0, 6)` — o corte por unidade de código.
    const resumo = 'guia 😀'.slice(0, 6);
    expect(resumo.endsWith('\ud83d')).toBe(true);

    const out = ensureFrontmatter('corpo\n', { ...base, resumo });
    expect(() => matter(out, {})).not.toThrow();
    expect(matter(out, {}).data.resumo).toBe(resumo);
    expect(ensureFrontmatter(out, base)).toBe(out);
  });

  it('um emoji COMPLETO continua sem aspas desnecessárias', () => {
    // O par bem formado é imprimível para o js-yaml: citar aqui seria ruído.
    const out = ensureFrontmatter('corpo\n', { ...base, tipo: 'guia 😀' });
    expect(out).toContain('\ntipo: guia 😀\n');
    expect(matter(out, {}).data.tipo).toBe('guia 😀');
  });
});

// A varredura residual precisa rodar sobre o TEXTO DE ENTRADA, não sobre a
// saída: só na ENTRADA é que um token não resolvido pode estar, e a entrada não
// pode ser envenenada por conteúdo substituído. Rodando na saída, um `<%`
// legítimo chegado por `ctx.title` era acusado de ser um token Templater
// pendente — e como o título é escolhido pelo modelo a partir do conteúdo
// clipado, isso fixava uma falha de escrita PERMANENTE numa nota.
describe('applyTemplate — a varredura residual olha a ENTRADA, não a saída', () => {
  const now = localDate(2026, 8, 24, 9, 5);

  it('não acusa um `<%` que veio de ctx.title', () => {
    const out = applyTemplate('# <% tp.file.title %>\n\ncorpo\n', {
      title: 'Sintaxe <% %> do Templater',
      now,
    });
    expect(out).toBe('# Sintaxe <% %> do Templater\n\ncorpo\n');
  });

  it('não acusa um `<%` do título mesmo com outros tokens resolvidos ao lado', () => {
    const out = applyTemplate('# <% tp.file.title %> — <% tp.date.now("YYYY-MM") %>\n', {
      title: 'Sintaxe <% %> do Templater',
      now,
    });
    expect(out).toBe('# Sintaxe <% %> do Templater — 2026-08\n');
  });

  // Este caso substitui um teste do rascunho que pedia
  // `applyTemplate('<% tp.date.now("[<%] YYYY") %>')` === '[<%] 2026'.
  // Ele não testava a distinção entrada/saída: um `<%` na SAÍDA vindo do
  // `tp.date.now` só existe se estiver LITERALMENTE dentro do token na entrada
  // — o `formatLocal` apenas substitui, nunca inventa `<%`. O que o teste pedia
  // de fato era que o `TOKEN_RE` atravessasse um `<%` ANINHADO, exatamente o que
  // ele proíbe (`<(?!%)`) para manter o custo linear. Atendê-lo devolve a forma
  // QUADRÁTICA — `/<%((?:[^%\n]|%(?!>))*)%>/g`, o `TOKEN_RE` sem o `<(?!%)` —
  // que é o que o guarda de custo mede: 10,8ms em 4KB, 712ms em 32KB, ~20s em
  // 240KB. Não é o número que este comentário já citou (65s): quem custa isso é
  // a forma ingênua `/<%\s*(.+?)\s*%>/g`, e a diferença importa porque o
  // quadrático é barato o bastante para atravessar um orçamento absoluto sem
  // ser notado. O contrato defensável é o oposto de atender o pedido: essa
  // forma é RECUSADA em voz alta, nunca emitida em silêncio.
  // A recusa chega pelo caminho da expressão não suportada, não pela varredura
  // residual: o `TOKEN_RE` casa primeiro o `<%` INTERNO, cuja expressão
  // (`] YYYY") `) não é nem `tp.file.title` nem `tp.date.now`. Os dois caminhos
  // são igualmente altos — o que importa é que nada sai em silêncio.
  it('recusa (sem emitir em silêncio) um `<%` aninhado dentro do token', () => {
    const tpl = '<% tp.date.now("[<%] YYYY") %>\n';
    const ctx = { title: 'x', now };
    expect(() => applyTemplate(tpl, ctx)).toThrow(TemplateError);
    expect(() => applyTemplate(tpl, ctx)).toThrow(/não suportada/);
  });

  it('continua recusando um token não resolvido mesmo com `<%` no título', () => {
    const tpl = '# <% tp.file.title %>\n\n<%*\nconst t = 1\n%>\n';
    const ctx = { title: 'a <% b', now };
    expect(() => applyTemplate(tpl, ctx)).toThrow(TemplateError);
    expect(() => applyTemplate(tpl, ctx)).toThrow(/<%\*/);
  });
});

// `SAFE_KEY_RE` admitia chaves com forma de número ou de data: `2026-08-24: v`
// sai sem aspas e volta como uma chave `Date`, então `data['2026-08-24']` é
// undefined. O bloco nunca quebra — só a IDENTIDADE da chave.
describe('ensureFrontmatter — chaves que o YAML resolveria como não-string', () => {
  const NON_STRING = ['2026-08-24', '0x1f', '1e5', '1_000', '012', '12:30', '.inf', '.nan'];

  for (const key of NON_STRING) {
    it(`preserva a identidade da chave \`${key}\``, () => {
      const out = ensureFrontmatter('corpo\n', { tipo: 'wiki', [key]: 'v' });
      const data = matter(out, {}).data as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(data, key), key).toBe(true);
      expect(data[key], key).toBe('v');
      expect(ensureFrontmatter(out, { tipo: 'wiki', [key]: 'v' }), key).toBe(out);
    });
  }

  it('não cita as chaves que já round-trippam como string', () => {
    const out = ensureFrontmatter('corpo\n', {
      tipo: 'wiki',
      criado: '2026-08-24',
      'v1.0': 'x',
      'a.b': 'y',
      '1.5': 'z',
    });
    expect(out).toContain('\ntipo: wiki\n');
    expect(out).toContain('\ncriado: 2026-08-24\n');
    expect(out).toContain('\nv1.0: x\n');
    expect(out).toContain('\na.b: y\n');
    expect(out).toContain('\n1.5: z\n');
  });
});

// `topLevelKeyIndex` lia cada linha ISOLADA, e uma linha do bloco não carrega
// sozinha a informação de se o PARSER a lê como uma entrada de topo. Uma
// continuação de escalar multi-linha ou de coleção em fluxo pode começar na
// coluna 0 e ter a forma exata de `chave: valor` — e a leitura isolada casava
// com ela, SOBRESCREVENDO a continuação. O destino é sempre o mesmo lugar
// destrutivo: aspa não terminada / coleção sem fechar, o `parseBlock` da
// passada seguinte morre, o `splitFrontmatter` devolve undefined e o bloco
// ORIGINAL do usuário é rebaixado para dentro do CORPO da nota.
describe('ensureFrontmatter — continuação na coluna 0 não é chave de topo', () => {
  const CASES: Array<{ nome: string; entrada: string }> = [
    {
      nome: 'escalar entre aspas DUPLAS dobrado em duas linhas',
      entrada: '---\ntitulo: "resumo do artigo\ntipo: nota"\ncriado: 2026-01-01\n---\ncorpo\n',
    },
    {
      nome: 'escalar entre aspas SIMPLES dobrado em duas linhas',
      entrada: "---\ntitulo: 'resumo do artigo\ntipo: nota'\ncriado: 2026-01-01\n---\ncorpo\n",
    },
    {
      nome: 'mapeamento em fluxo aberto em duas linhas',
      entrada: '---\nmeta: {a: 1,\ntipo: 2}\ncriado: 2026-01-01\n---\ncorpo\n',
    },
    {
      nome: 'sequência em fluxo aberta em duas linhas',
      entrada: '---\nlista: [a,\ntipo: b]\ncriado: 2026-01-01\n---\ncorpo\n',
    },
  ];

  for (const { nome, entrada } of CASES) {
    it(`preserva a ${nome}`, () => {
      const antes = matter(entrada, {}).data as Record<string, unknown>;
      const out = ensureFrontmatter(entrada, { tipo: 'wiki' });

      // O bloco continua parseável — a condição que o modo de falha destrói.
      const depois = matter(out, {}).data as Record<string, unknown>;
      expect(depois.tipo).toBe('wiki');
      // E toda chave que o usuário tinha continua com o MESMO valor.
      for (const [k, v] of Object.entries(antes)) {
        if (k === 'tipo') continue;
        expect(JSON.stringify(depois[k]), k).toBe(JSON.stringify(v));
      }
      // Idempotente: sem isso a passada seguinte é a que rebaixa o bloco.
      expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
    });
  }

  // O caso que um cheque "a chave está no `data`?" sozinho NÃO cobre: `tipo`
  // EXISTE no mapeamento (vazia) e há uma linha de continuação anterior com a
  // forma `tipo: …`. Sem rastrear a estrutura, a substituição acerta a
  // continuação em vez da entrada real.
  it('substitui a entrada REAL, não a continuação de mesma forma acima dela', () => {
    const entrada = '---\ntitulo: "resumo\ntipo: nota"\ntipo:\n---\ncorpo\n';
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
    const depois = matter(out, {}).data as Record<string, unknown>;
    expect(depois.tipo).toBe('wiki');
    expect(depois.titulo).toBe('resumo tipo: nota');
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });
});

// A direção oposta do mesmo erro: uma grafia de chave que o módulo não LÊ era
// tratada como "não existe", e o preenchimento APENDAVA uma segunda `tipo:`.
// A duplicata não é o dano — o js-yaml RECUSA um mapeamento com chave
// duplicada, e a passada seguinte rebaixa o bloco do usuário para o corpo.
// O contrato é: preencher quando a edição VERIFICA contra o parser, e não
// tocar em nada quando não verifica. Nunca corromper.
describe('ensureFrontmatter — grafias exóticas de chave nunca duplicam', () => {
  const CASES: Array<{ nome: string; entrada: string; preenche: boolean }> = [
    {
      nome: 'chave entre aspas duplas com escape só-YAML (`"\\x74ipo"` = `tipo`)',
      entrada: '---\n"\\x74ipo":\ncriado: 2026-01-01\n---\ncorpo\n',
      preenche: true,
    },
    {
      nome: 'chave explícita (`? tipo` em linha própria)',
      entrada: '---\n? tipo\n:\ncriado: 2026-01-01\n---\ncorpo\n',
      preenche: false,
    },
  ];

  for (const { nome, entrada, preenche } of CASES) {
    it(`não duplica com ${nome}`, () => {
      const out = ensureFrontmatter(entrada, { tipo: 'wiki' });

      // O invariante que importa: o bloco continua parseável, SEMPRE.
      const depois = matter(out, {}).data as Record<string, unknown>;
      expect(depois.criado).toBeInstanceOf(Date);
      expect(Object.prototype.hasOwnProperty.call(depois, 'tipo')).toBe(true);

      if (preenche) expect(depois.tipo).toBe('wiki');
      // Recusar é resposta legítima: devolve o conteúdo intacto.
      else expect(out).toBe(entrada);

      expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
    });
  }

  // Uma linha de grafia ILEGÍVEL é tentada às cegas — o módulo não sabe qual
  // chave ela declara, e quem decide é o parser. O cheque que faz essa tentativa
  // ser segura é o do CONJUNTO de chaves: substituir `"\x63riado":` por
  // `tipo: wiki` produz um bloco perfeitamente parseável cuja única diferença é
  // que a chave `criado` do usuário DESAPARECEU. Sem comparar os conjuntos, a
  // edição passa e a nota perde uma chave em silêncio.
  it('não apaga uma chave de grafia ilegível ao preencher outra', () => {
    const entrada = '---\n"\\x63riado": 2026-01-01\n---\ncorpo\n';
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
    const depois = matter(out, {}).data as Record<string, unknown>;

    expect(depois.tipo).toBe('wiki');
    expect(depois.criado).toBeInstanceOf(Date);
    expect(out).toContain('"\\x63riado": 2026-01-01');
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });

  // O rastreamento de estrutura não é redundante com a verificação, e este é o
  // caso que separa os dois. A verificação REJEITA uma edição ruim, mas cada
  // rejeição consome uma das tentativas do orçamento `MAX_OPAQUE_CANDIDATES` —
  // que existe porque tentar toda linha ilegível é O(linhas²). Sem o scanner,
  // TODA linha de continuação vira candidata ilegível, o orçamento se esgota nas
  // continuações e a linha que realmente declara a chave nunca é tentada: a
  // chave fica por preencher para sempre. Um `resumo` dobrado em muitas linhas é
  // conteúdo comum numa nota clipada, não um caso construído.
  const CONTINUACOES: Array<{ nome: string; bloco: string }> = [
    {
      nome: 'escalar multi-linha entre aspas',
      bloco: `resumo: "linha 1\n${Array.from({ length: 12 }, (_, i) => `linha ${i + 2}`).join('\n')}\nfim"`,
    },
    {
      nome: 'coleção em fluxo aberta',
      bloco: `lista: [a1,\n${Array.from({ length: 12 }, (_, i) => `a${i + 2},`).join('\n')}\nfim]`,
    },
  ];

  for (const { nome, bloco } of CONTINUACOES) {
    it(`alcança a chave real além de uma ${nome} longa`, () => {
      const entrada = `---\n${bloco}\n"\\x74ipo":\n---\ncorpo\n`;
      const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
      const depois = matter(out, {}).data as Record<string, unknown>;

      expect(depois.tipo).toBe('wiki');
      // E sem duplicar: uma segunda `tipo:` faria o js-yaml recusar o bloco.
      expect(out.match(/^tipo: wiki$/gm) ?? []).toHaveLength(1);
      expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
    });
  }

  // Um bloco cujo topo é uma SEQUÊNCIA não é frontmatter: `Object.keys` de um
  // array tem comprimento > 0, então o cheque de "mapeamento não vazio" o
  // aceitava e o preenchimento apendava `tipo:` DENTRO da sequência — YAML
  // inválido. O conteúdo do usuário é preservado como CORPO, nunca apagado.
  it('não trata uma sequência de topo como frontmatter', () => {
    const entrada = '---\n- a\n- b\n---\ncorpo\n';
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
    expect(out).toBe('---\ntipo: wiki\n---\n\n---\n- a\n- b\n---\ncorpo\n');
    expect(matter(out, {}).data).toEqual({ tipo: 'wiki' });
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });
});

// O `shapeOf` da rodada anterior comparava valores com `JSON.stringify`, e o
// js-yaml resolve um alias por REFERÊNCIA: `a0: &a0 [q ×10]` seguido de
// `a1: &a1 [*a0 ×10]` até `a7` parseia em milissegundos e ocupa alguns
// kilobytes, mas a serialização MATERIALIZA a expansão de 10^8 elementos.
// Medido através do `ensureFrontmatter`: 394 bytes de entrada custavam 4055ms e
// ~1GB; com a comparação estrutural limitada, ~2ms.
//
// Isso não é "uma função lenta". O servidor MCP é um único event loop e o
// `ensureFrontmatter` é SÍNCRONO — não há timeout na camada da ferramenta capaz
// de interromper. O servidor inteiro para. E o `catch` do `shapeOf` ainda
// engolia o `RangeError` do fim, então o custo era pago para não relatar nada.
//
// `src/vault/frontmatter.ts:47` documenta essa obrigação e a entrega ao
// consumidor: quem serializa chaves arbitrárias de frontmatter impõe o próprio
// limite. Este é o limite.
describe('ensureFrontmatter — comparação de valores com custo limitado', () => {
  /** `a0 … aN`, cada nível referenciando o anterior dez vezes. */
  function bombaDeAliases(niveis: number): string {
    const linhas = [`a0: &a0 [${Array.from({ length: 10 }, () => 'q').join(',')}]`];
    for (let n = 1; n <= niveis; n += 1) {
      const itens = Array.from({ length: 10 }, () => `*a${n - 1}`).join(',');
      linhas.push(`a${n}: &a${n} [${itens}]`);
    }
    return `---\n${linhas.join('\n')}\n---\ncorpo\n`;
  }

  it('não expande uma bomba de aliases do YAML ao comparar valores', () => {
    const entrada = bombaDeAliases(7);
    // O tamanho é o ponto: nada nesta entrada parece caro.
    expect(entrada.length).toBeLessThan(500);

    const inicio = Date.now();
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
    const gasto = Date.now() - inicio;

    expect(out).toContain('\ntipo: wiki\n');
    // A DAG de aliases continua COMPARÁVEL — o que muda é o custo. Comparar
    // referência a referência colapsa a DAG em vez de expandi-la.
    expect(matter(out, {}).data).toHaveProperty('a7');
    // 1500ms: a versão sem limite gasta 4055ms nesta máquina e só piora numa
    // mais lenta; a limitada gasta ~2ms. São três ordens de grandeza entre as
    // duas, então o limite absoluto não é frágil nas duas direções.
    expect(gasto).toBeLessThan(1500);
  });

  // O outro lado do mesmo defeito. Todo valor que o `JSON.stringify` recusava
  // virava o MESMO sentinela, então `sentinela === sentinela` e o cheque de
  // valores passava VAZIO — justamente o cheque cujo único trabalho é recusar.
  // Aqui `notas` é auto-referente, e a consequência era a linha do usuário
  // `- "revisar antes de publicar"` ser SUBSTITUÍDA por `tipo: wiki` e sumir do
  // vault, com o `verifiedEdit` certificando a edição.
  it('preserva o item que uma lista auto-referente escondia da comparação', () => {
    const entrada =
      '---\ntitulo: Guia de Deploy\nnotas: &n\n- *n\n- "chave-api: sk-prod-1234"\n' +
      '- "revisar antes de publicar"\n---\nCorpo da nota.\n';
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });

    // A chave é APENDADA; nenhuma linha do usuário é tocada.
    expect(out).toBe(
      '---\ntitulo: Guia de Deploy\nnotas: &n\n- *n\n- "chave-api: sk-prod-1234"\n' +
        '- "revisar antes de publicar"\ntipo: wiki\n---\nCorpo da nota.\n',
    );

    const depois = matter(out, {}).data as Record<string, unknown>;
    const notas = depois.notas as unknown[];
    expect(notas).toHaveLength(3);
    expect(notas[0]).toBe(notas);
    expect(notas[1]).toBe('chave-api: sk-prod-1234');
    expect(notas[2]).toBe('revisar antes de publicar');
    expect(depois.tipo).toBe('wiki');
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });

  // O limite tem de ser um limite de verdade, e "não consegui comparar" tem de
  // significar RECUSAR. Tratar incomparável como igual é o defeito acima escrito
  // de outro jeito.
  it('recusa a edição quando a PROFUNDIDADE estoura o limite', () => {
    const fundo = `${'['.repeat(200)}${']'.repeat(200)}`;
    const entrada = `---\nfundo: ${fundo}\ncriado: 2026-01-01\n---\ncorpo\n`;

    // O bloco é válido: o js-yaml o lê sem reclamar.
    expect(matter(entrada, {}).data).toHaveProperty('fundo');

    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });
    // Recusa = conteúdo intacto. Uma chave por preencher é visível e reparável
    // num toque; uma edição certificada às cegas não é.
    expect(out).toBe(entrada);
    expect(matter(out, {}).data).not.toHaveProperty('tipo');
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });

  // O outro limite. A profundidade sozinha não cobre uma estrutura LARGA, e o
  // orçamento de nós é o que mantém a caminhada total mesmo se a memoização de
  // pares um dia deixar de colapsar uma DAG. Sem ele o `MAX_COMPARE_DEPTH` é o
  // único freio, e um grafo raso e enorme passa por baixo dele.
  it('recusa a edição quando o número de NÓS estoura o orçamento', () => {
    const itens = Array.from({ length: 25000 }, (_, i) => `t${i}`).join(',');
    const entrada = `---\ntags: [${itens}]\ncriado: 2026-01-01\n---\ncorpo\n`;
    expect(ensureFrontmatter(entrada, { tipo: 'wiki' })).toBe(entrada);

    // E a MESMA forma dentro do orçamento continua sendo preenchida: o limite é
    // um limite, não uma recusa de listas.
    const pequena = '---\ntags: [t0,t1,t2]\ncriado: 2026-01-01\n---\ncorpo\n';
    expect(ensureFrontmatter(pequena, { tipo: 'wiki' })).toBe(
      '---\ntags: [t0,t1,t2]\ncriado: 2026-01-01\ntipo: wiki\n---\ncorpo\n',
    );
  });

  // O sentinela anterior era um byte NUL LITERAL no fonte. Como sentinela era
  // sólido — nada o forja —, mas ele torna o arquivo BINÁRIO para as ferramentas
  // de busca por conteúdo: `grep`, `ugrep -I` (o grep configurado deste repo) e
  // `file` passam a tratar `src/write/template.ts` como dados, e um `grep` no
  // repositório inteiro devolve silenciosamente NADA para este arquivo.
  it('não deixa byte NUL no fonte — o módulo tem de continuar pesquisável', () => {
    expect(readFileSync(MODULE_SRC).includes(0)).toBe(false);
  });
});

// O comentário do `advance` afirmava que todo construto multi-linha que não é
// aspa nem coleção em fluxo continua INDENTADO. É falso para a sequência em
// bloco sob uma chave de mapeamento — os itens ficam na COLUNA 0:
//
//     tags:
//     - projeto
//     - vault
//
// que é a forma mais comum de frontmatter no Obsidian. Cada `- item` virava
// candidato ILEGÍVEL, e o `verifiedEdit` só rejeitava a substituição por causa
// do cheque de VALORES: removidos os DOIS — o rastreamento e o cheque de
// valores —, a saída vira `tags:\n- projeto\ntipo: wiki` e a nota perde uma tag
// em silêncio, com o cheque de conjunto de chaves passando limpo, porque `tags`
// continua lá. Ou seja: os dois cheques do `verifiedEdit` NÃO são redundantes, e
// esta é a forma que os separa.
//
// Com o rastreamento corrigido esses itens deixam de ser candidatos, então o
// primeiro teste abaixo é uma TRAVA DE REGRESSÃO na saída (falha no tip anterior
// e sob a dupla mutação acima), e o segundo é o que prende o rastreamento
// sozinho, pelo orçamento de candidatos.
describe('ensureFrontmatter — item de sequência em bloco não é chave de topo', () => {
  it('preserva os dois itens de uma `tags` em bloco', () => {
    const entrada = '---\ntags:\n- projeto\n- vault\n---\ncorpo\n';
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });

    expect(out).toBe('---\ntags:\n- projeto\n- vault\ntipo: wiki\n---\ncorpo\n');
    const depois = matter(out, {}).data as Record<string, unknown>;
    expect(depois.tags).toEqual(['projeto', 'vault']);
    expect(depois.tipo).toBe('wiki');
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });

  // O caso que prende o rastreamento independentemente do cheque de valores:
  // cada item de sequência consumia uma vaga do orçamento
  // `MAX_OPAQUE_CANDIDATES`, e uma lista mais longa que o orçamento esgota as
  // tentativas ANTES da linha que de fato declara a chave. A chave então fica
  // por preencher para sempre — o mesmo modo de falha que as continuações
  // longas já exercitam, por uma porta que ninguém tinha fechado.
  it('alcança a chave real além de uma sequência em bloco mais longa que o orçamento', () => {
    const itens = Array.from({ length: 12 }, (_, i) => `- t${i + 1}`).join('\n');
    const entrada = `---\ntags:\n${itens}\n"\\x74ipo":\n---\ncorpo\n`;
    const out = ensureFrontmatter(entrada, { tipo: 'wiki' });

    const depois = matter(out, {}).data as Record<string, unknown>;
    expect(depois.tipo).toBe('wiki');
    expect(depois.tags).toHaveLength(12);
    // E sem duplicar: uma segunda `tipo` faria o js-yaml recusar o bloco.
    expect(out.match(/^tipo: wiki$/gm) ?? []).toHaveLength(1);
    expect(ensureFrontmatter(out, { tipo: 'wiki' })).toBe(out);
  });
});
