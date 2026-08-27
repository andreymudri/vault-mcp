import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveLang, LANGS, type Lang } from '../src/i18n/lang.js';
import { messagesFor } from '../src/i18n/messages.js';
import { createTools } from '../src/server/tools.js';
import { Retriever } from '../src/retrieval/retrieval.js';
import { VaultScanner } from '../src/vault/scanner.js';

async function tools(lang: Lang) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-i18n-'));
  const scanner = new VaultScanner({ vaultRoot });
  const retriever = new Retriever({ scanner });
  return createTools({ retriever, scanner, vaultRoot, messages: messagesFor(lang) });
}

describe('resolveLang', () => {
  it('é inglês por padrão, e não o português de origem', () => {
    expect(resolveLang({})).toBe('en');
  });

  it('aceita os idiomas que existem, em qualquer caixa e com espaço em volta', () => {
    expect(resolveLang({ VAULT_LANG: 'pt' })).toBe('pt');
    expect(resolveLang({ VAULT_LANG: '  PT  ' })).toBe('pt');
    expect(resolveLang({ VAULT_LANG: 'en' })).toBe('en');
  });

  it('cai no inglês para qualquer coisa que não seja um idioma, em vez de explodir', () => {
    // Um servidor MCP que morre no start por causa de uma variável de ambiente escrita errada é
    // um cliente que fica esperando `initialize` para sempre. Degradar é a direção certa aqui.
    for (const bad of ['', '   ', 'pt-BR', 'português', 'fr', '../../etc/passwd']) {
      expect(resolveLang({ VAULT_LANG: bad })).toBe('en');
    }
  });
});

describe('catálogos', () => {
  it('nenhuma string é vazia em nenhum idioma', () => {
    const walk = (node: unknown, trail: string): void => {
      if (typeof node === 'string') {
        expect(node.trim(), trail).not.toBe('');
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, `${trail}.${key}`);
      }
    };
    for (const lang of LANGS) walk(messagesFor(lang), lang);
  });

  it('as nove tools têm descrição nos dois idiomas', () => {
    for (const lang of LANGS) {
      const { tools: t } = messagesFor(lang);
      expect(Object.keys(t)).toHaveLength(9);
    }
  });
});

describe('as tools falam o idioma pedido', () => {
  it('em inglês, a descrição de vault_search é inglesa', async () => {
    const search = (await tools('en')).find((t) => t.name === 'vault_search');
    expect(search?.description).toContain('Lexical-semantic search');
    expect(search?.description).not.toContain('Busca semântica-lexical');
  });

  it('em português, a descrição de vault_search é portuguesa', async () => {
    const search = (await tools('pt')).find((t) => t.name === 'vault_search');
    expect(search?.description).toContain('Busca semântica-lexical');
  });

  it('a descrição dos CAMPOS também acompanha o idioma', async () => {
    // O campo é lido pelo modelo junto com a descrição da tool: um deles em português dentro de
    // uma tool descrita em inglês é pior que os dois em português, porque parece um erro.
    const learn = (await tools('en')).find((t) => t.name === 'vault_learn');
    const shape = learn?.inputSchema.shape as Record<string, { description?: string }>;
    expect(shape['titulo']?.description).toContain('Short title');
    expect(shape['insight']?.description).toContain('markdown');
  });
});

describe('o catálogo inglês não é cidadão de segunda classe', () => {
  // A tradução que ninguém verifica apodrece: uma descrição encurtada em inglês custa exatamente
  // o que a tool em português custava — o modelo decide pior quando chamar. As mesmas quatro
  // coisas que `tools.test.ts` exige da descrição de vault_learn em português, exigidas aqui nos
  // DOIS idiomas.
  const cobertura: Record<Lang, string[]> = {
    pt: ['reutilizável', 'propaga', 'diff', 'commit'],
    en: ['reusable', 'propagates', 'diff', 'commit'],
  };

  it.each(LANGS)('a descrição de vault_learn em %s cobre quando chamar, propagação e diff', (lang) => {
    const description = messagesFor(lang).tools.vault_learn.description.toLowerCase();
    for (const termo of cobertura[lang]) expect(description, `${lang}: ${termo}`).toContain(termo);
  });

  it.each(LANGS)('nenhuma descrição de tool em %s é curta a ponto de não orientar', (lang) => {
    // A mais curta hoje tem ~200 caracteres. O piso existe para pegar a tradução que virou
    // rótulo — "Search the vault." — e não para medir prosa.
    for (const [nome, texto] of Object.entries(messagesFor(lang).tools)) {
      expect(texto.description.length, `${lang}.${nome}`).toBeGreaterThan(120);
    }
  });
});
