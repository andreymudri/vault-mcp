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

/**
 * Um vault com CONTEÚDO, e essa é a correção que importa aqui.
 *
 * A versão anterior criava um diretório vazio, então TODA tool respondia pelo ramo de vault
 * vazio — e era exatamente por isso que a manchete povoada do `vault_list` ('5 nota(s):') e a do
 * `vault_backlinks` sobreviviam a um teste cujo próprio comentário dizia ter fechado esse ponto
 * cego. Um varredor que só visita o caso vazio não varre nada.
 */
async function makeVault(): Promise<string> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-i18n-'));
  trash.push(vaultRoot);
  const write = async (rel: string, body: string) => {
    const abs = path.join(vaultRoot, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  };
  await write('02-wiki/nestjs/auth-guard.md', '---\ntipo: wiki\ntags: [jwt]\n---\n\n# Auth Guard\n\nGuarda de autenticação com jwt token.\n');
  await write('02-wiki/nestjs/nestjs-moc.md', '---\ntipo: moc\n---\n\n# NestJS MOC\n\n## Notas\n\n- [[auth-guard]] — guarda\n');
  await write('02-wiki/docker/multi-stage.md', '---\ntipo: wiki\ntags: [docker]\n---\n\n# Multi Stage\n\nBuild em camadas, aponta para [[auth-guard]].\n');
  return vaultRoot;
}

async function tools(lang: Lang) {
  const vaultRoot = await makeVault();
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

  it('nenhuma RESPOSTA POVOADA é igual nos dois idiomas', async () => {
    // O varredor de recusas não bastava: um vault vazio faz toda tool cair no ramo vazio, e as
    // manchetes povoadas ('5 nota(s):', 'N nota(s) apontam para') nunca eram exercitadas.
    const en = await tools('en');
    const pt = await tools('pt');
    const chamadas: Array<[string, Record<string, unknown>]> = [
      ['vault_search', { query: 'jwt' }],
      ['vault_list', { tipo: 'wiki' }],
      ['vault_backlinks', { path: '02-wiki/nestjs/auth-guard.md' }],
      ['vault_get_note', { path: '02-wiki/nestjs/auth-guard.md' }],
    ];
    for (const [nome, args] of chamadas) {
      const a = await en.find((t) => t.name === nome)!.handler(args);
      const b = await pt.find((t) => t.name === nome)!.handler(args);
      expect(a.content[0]!.text, `${nome} respondeu idêntico nos dois idiomas`).not.toBe(
        b.content[0]!.text,
      );
      expect(a.content[0]!.text, `${nome}: ${a.content[0]!.text.slice(0, 120)}`).not.toMatch(
        /nota\(s\)|Sugestões|via grafo|trecho truncado|nota cortada|\(nenhum\)|\(nada\)|Propagado para/i,
      );
    }
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

describe('erros da camada de escrita também falam o idioma', () => {
  // Estes nascem fundo em paths.ts / relocate.ts / learn.ts, que não têm catálogo nenhum e nem
  // deveriam ter. Eles carregam um CÓDIGO, e quem resolve é a fronteira da tool. São os erros que
  // um operador de fato tem de agir sobre — caminho errado, nota inexistente, domínio inválido —
  // e eram os últimos a sair em português dentro de um invólucro inglês.
  const casos: Array<[string, string, Record<string, unknown>, RegExp, RegExp]> = [
    ['nota inexistente', 'vault_get_note', { path: 'nope.md' }, /note not found/i, /nota não encontrada/i],
    ['extensão errada', 'vault_write_note', { path: 'x.txt', content: 'a' }, /must end in \.md/i, /deve terminar em \.md/i],
    ['fora do vault', 'vault_write_note', { path: '../fora.md', content: 'a' }, /outside the vault/i, /fora do vault/i],
    // `vault_delete` num caminho que não existe: chega em relocate.noteNotFound, que É um erro
    // com código. Editar um arquivo inexistente NÃO serve aqui — o `readFile` estoura ENOENT cru
    // do Node antes de qualquer erro nosso, e um ENOENT não é texto que este servidor escreveu.
    ['nota a apagar não existe', 'vault_delete', { path: 'nada.md' }, /not found/i, /não encontrad/i],
  ];

  it.each(casos)('%s: inglês', async (_l, tool, args, esperado) => {
    const t = (await tools('en')).find((x) => x.name === tool);
    expect((await t!.handler(args)).content[0]!.text).toMatch(esperado);
  });

  it.each(casos)('%s: português', async (_l, tool, args, _en, esperado) => {
    const t = (await tools('pt')).find((x) => x.name === tool);
    expect((await t!.handler(args)).content[0]!.text).toMatch(esperado);
  });

  it('resolve um parâmetro que é ELE PRÓPRIO um código', async () => {
    // `learn.badDomain` recebe o motivo apurado por `dominioProblem`, que devolve um código e não
    // prosa. Sem resolver o parâmetro, saía 'invalid domain: domínio não pode conter espaço' —
    // o defeito de invólucro-traduzido-sobre-miolo-português, um nível mais fundo.
    const args = { titulo: 't', insight: 'i', contexto: 'c', dominio: 'a b' };
    const en = (await tools('en')).find((x) => x.name === 'vault_learn');
    const pt = (await tools('pt')).find((x) => x.name === 'vault_learn');
    const textoEn = (await en!.handler(args)).content[0]!.text;
    expect(textoEn).toContain('domain cannot contain a space');
    expect(textoEn).not.toContain('domínio');
    expect((await pt!.handler(args)).content[0]!.text).toContain('domínio não pode conter espaço');
  });
});
