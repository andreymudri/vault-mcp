import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveLang, LANGS, type Lang } from '../src/i18n/lang.js';
import { messagesFor } from '../src/i18n/messages.js';
import { createTools } from '../src/server/tools.js';
import { Retriever } from '../src/retrieval/retrieval.js';
import { VaultScanner } from '../src/vault/scanner.js';

const trash: string[] = [];

afterEach(async () => {
  // O resto da suíte limpa o que cria (relocate.test.ts:45 até com maxRetries, porque o rmdir do
  // Windows bate em EBUSY enquanto um indexador segura o handle). Este arquivo não limpava, e
  // vazava um diretório por chamada: /tmp e /var/folders são varridos pelo sistema, mas o
  // %LOCALAPPDATA%\Temp do Windows não tem varredor e acumula para sempre.
  for (const dir of trash.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function tools(lang: Lang) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-i18n-'));
  trash.push(vaultRoot);
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

  it('aceita a grafia de locale, que é a que a pessoa digita primeiro', () => {
    // Este repositório chama o próprio README português de `README.pt-BR.md`: `pt-BR` é
    // literalmente a forma que o usuário vê antes de configurar qualquer coisa. Casar só a tag
    // inteira devolvia um servidor em inglês, calado, para quem pediu português.
    for (const tag of ['pt-BR', 'pt_BR', 'pt_BR.UTF-8', 'PT-br', 'pt-PT']) {
      expect(resolveLang({ VAULT_LANG: tag }), tag).toBe('pt');
    }
    expect(resolveLang({ VAULT_LANG: 'en-US' })).toBe('en');
  });

  it('cai no inglês para qualquer coisa que não seja um idioma, em vez de explodir', () => {
    // Um servidor MCP que morre no start por causa de uma variável de ambiente escrita errada é
    // um cliente que fica esperando `initialize` para sempre. Degradar é a direção certa aqui.
    for (const bad of ['', '   ', 'português', 'fr', 'de-DE', '../../etc/passwd']) {
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

describe('a recusa de entrada fala o idioma do catálogo inteira', () => {
  // O invólucro da mensagem ficou em português enquanto o conteúdo já vinha traduzido, e o
  // resultado era "entrada inválida para vault_search: query: query cannot be empty" — uma frase
  // em dois idiomas no caminho de erro MAIS COMUM que existe (argumento inválido). Para quem
  // ligou VAULT_LANG=en isso derruba a promessa inteira da opção: continua chegando texto que a
  // pessoa não lê, agora com a agravante de parecer defeito.
  it('em inglês, nem o invólucro nem o conteúdo vêm em português', async () => {
    const search = (await tools('en')).find((t) => t.name === 'vault_search');
    const result = await search!.handler({ query: '' });
    const texto = result.content[0]!.text;

    expect(result.isError).toBe(true);
    expect(texto).toContain('query cannot be empty');
    expect(texto).not.toContain('entrada inválida');
    expect(texto).toMatch(/invalid input/i);
  });

  it('em português segue inteiramente em português', async () => {
    const search = (await tools('pt')).find((t) => t.name === 'vault_search');
    const result = await search!.handler({ query: '' });
    const texto = result.content[0]!.text;

    expect(result.isError).toBe(true);
    expect(texto).toContain('entrada inválida para vault_search');
    expect(texto).toContain('query não pode ser vazia');
  });
});

describe('o CONTEÚDO da recusa também fala o idioma, não só o invólucro', () => {
  // O invólucro foi traduzido primeiro e o payload ficou para trás, o que produziu a pior das
  // três combinações possíveis: uma frase que TROCA de idioma no meio. E o caso afetado é o mais
  // comum que existe — campo ausente —, porque `.min(1, …)` só dispara quando o campo veio e veio
  // vazio; quando ele simplesmente não veio, quem responde é o `invalid_type` do zod.
  it('campo ausente em inglês não devolve "campo obrigatório"', async () => {
    const search = (await tools('en')).find((t) => t.name === 'vault_search');
    const texto = (await search!.handler({})).content[0]!.text;
    expect(texto).not.toContain('campo obrigatório');
    expect(texto).toMatch(/required/i);
  });

  it('tipo errado em inglês não devolve "esperado ... recebido ..."', async () => {
    const search = (await tools('en')).find((t) => t.name === 'vault_search');
    const texto = (await search!.handler({ query: 'x', limit: 'abc' })).content[0]!.text;
    expect(texto).not.toContain('esperado');
    expect(texto).not.toContain('recebido');
    expect(texto).toMatch(/expected number/i);
  });

  it('a recusa em português continua inteiramente em português', async () => {
    const search = (await tools('pt')).find((t) => t.name === 'vault_search');
    expect((await search!.handler({})).content[0]!.text).toContain('campo obrigatório');
    expect((await search!.handler({ query: 'x', limit: 'abc' })).content[0]!.text)
      .toContain('esperado number, recebido string');
  });

  it('nenhuma recusa mistura os dois idiomas, e nenhuma é igual nos dois', async () => {
    // A primeira versão deste teste comparava contra uma LISTA de palavras portuguesas — as sete
    // que me ocorreram — e por isso passava com `vault_list` devolvendo "Nenhuma nota com os
    // filtros informados." em modo inglês. Uma lista de palavras é um teste que só acha o que
    // quem o escreveu já sabia.
    //
    // O invariante de verdade não precisa de vocabulário: a MESMA chamada nos DOIS idiomas tem
    // de devolver textos DIFERENTES. Se saem idênticos, aquele texto não passa pelo catálogo —
    // qualquer que seja a palavra, e sem eu precisar tê-la previsto.
    const en = await tools('en');
    const pt = await tools('pt');

    for (const [i, tool] of en.entries()) {
      const rEn = await tool.handler({});
      const rPt = await pt[i]!.handler({});
      // Sem exceção para o caminho feliz. A versão anterior pulava as respostas de SUCESSO
      // ('caminho feliz: fora do escopo declarado'), e era justamente ali que o `vault_list`
      // devolvia 'Nenhuma nota com os filtros informados.' em modo inglês. Uma exceção que
      // esconde o único caso que falhava não é escopo, é ponto cego.

      const textoEn = rEn.content[0]!.text;
      const textoPt = rPt.content[0]!.text;
      expect(textoEn, `${tool.name} devolveu texto idêntico nos dois idiomas`).not.toBe(textoPt);
      expect(textoEn, `${tool.name}: ${textoEn}`).not.toMatch(
        /campo obrigatório|esperado |recebido |não pode|vazia/i,
      );
    }
  });
});
