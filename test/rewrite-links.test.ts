import { describe, expect, it } from 'vitest';

import { buildVaultIndex, rewriteLinks } from '../src/write/rewrite-links.js';

/**
 * A invariante, em uma frase: **um edge que resolvia antes da operação resolve para a MESMA
 * nota depois**.
 *
 * Todo teste aqui é um caso dela, e é por isso que a regra é uma só em vez de uma pilha de
 * casos especiais. Os três cenários que regras separadas erram estão todos abaixo:
 *
 * - o slug mudou, e `[[antigo]]` nas outras notas tem de virar `[[novo]]`;
 * - o slug NÃO mudou e a nota só trocou de diretório: o link continua resolvendo pelo índice
 *   de basename e **nada é reescrito** — a regra ingênua "troque o slug em todo lugar"
 *   mexeria em arquivo à toa, e a regra ingênua oposta, "só reescreva quando o nome muda",
 *   erra o próximo item;
 * - o link resolvia pelo basename, a mudança criou um EMPATE de basename, e o alvo continua
 *   existindo com o mesmo nome: ninguém renomeou nada e mesmo assim o link tem de ser
 *   desambiguado, ou passa a resolver para outra nota.
 */

/** Índices de ANTES e DEPOIS a partir de duas listas de caminhos. */
function indexes(before: string[], after: string[]) {
  return { before: buildVaultIndex(before), after: buildVaultIndex(after) };
}

/** O caso comum: uma nota que não se moveu, olhando um vault em que UMA nota se moveu. */
function rewriteIn(
  text: string,
  notePath: string,
  paths: string[],
  from: string,
  to: string,
): { text: string; warnings: string[] } {
  const after = paths.map((path) => (path === from ? to : path));
  const moved = notePath === from ? to : notePath;
  return rewriteLinks({
    text,
    notePathBefore: notePath,
    notePathAfter: moved,
    ...indexes(paths, after),
    renames: new Map([[from, to]]),
  });
}

const VAULT = [
  '00-index/index-knowledge.md',
  '02-wiki/nestjs/auth-guard.md',
  '02-wiki/nestjs/bullmq-worker.md',
  '02-wiki/nestjs/nestjs-moc.md',
  '02-wiki/docker/multi-stage.md',
  '04-daily/2026-08-20.md',
];

describe('rewriteLinks — renomeação', () => {
  it('troca o alvo de um link que apontava para o nome antigo', () => {
    const { text } = rewriteIn(
      'Ver [[auth-guard]] antes de mexer.\n',
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[guard-jwt]] antes de mexer.\n');
  });

  it('preserva a âncora e o alias', () => {
    const { text } = rewriteIn(
      'Ver [[auth-guard#payload do jwt|o guard]] e [[auth-guard#payload]] e [[auth-guard|o guard]].\n',
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe(
      'Ver [[guard-jwt#payload do jwt|o guard]] e [[guard-jwt#payload]] e [[guard-jwt|o guard]].\n',
    );
  });

  it('atualiza o ALIAS quando ele é o nome antigo repetido', () => {
    // Achado na cópia do vault real: `[[../../02-wiki/nestjs/database-connection-singleton|
    // database-connection-singleton]]`. O alvo era corrigido e o alias ficava com o nome ANTIGO —
    // que é o texto que o leitor vê. Um link que EXIBE um nome e aponta para uma nota chamada
    // outra coisa é a classe de defeito "lê como uma coisa, é outra" que este projeto persegue.
    const { text } = rewriteIn(
      'Ver [[02-wiki/nestjs/auth-guard|auth-guard]] e [[auth-guard|auth-guard]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[02-wiki/nestjs/guard-jwt|guard-jwt]] e [[guard-jwt|guard-jwt]].\n');
  });

  it('atualiza o alias que repete o ALVO antigo inteiro', () => {
    const { text } = rewriteIn(
      'Ver [[02-wiki/nestjs/auth-guard|02-wiki/nestjs/auth-guard]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[02-wiki/nestjs/guard-jwt|02-wiki/nestjs/guard-jwt]].\n');
  });

  it('NÃO toca num alias que é prosa', () => {
    // A regra é estreita de propósito: um alias só é atualizado quando ele repete o nome antigo,
    // que é slug e não prosa. `[[auth-guard|o guard de JWT]]` é uma frase que o usuário escreveu
    // para o leitor, e trocá-la seria a ferramenta reescrevendo texto que não é dela.
    const { text } = rewriteIn(
      'Ver [[auth-guard|o guard de JWT]] e [[auth-guard#payload|o payload]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[guard-jwt|o guard de JWT]] e [[guard-jwt#payload|o payload]].\n');
  });

  it('atualiza o alias antigo preservando a âncora', () => {
    const { text } = rewriteIn(
      'Ver [[auth-guard#payload do jwt|auth-guard]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[guard-jwt#payload do jwt|guard-jwt]].\n');
  });

  it('reescreve todas as ocorrências, não só a primeira', () => {
    const { text } = rewriteIn(
      '[[auth-guard]] e de novo [[auth-guard]].\n',
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('[[guard-jwt]] e de novo [[guard-jwt]].\n');
  });

  it('preserva a FORMA do link ao reescrever um caminho relativo à raiz', () => {
    const { text } = rewriteIn(
      'Ver [[02-wiki/nestjs/auth-guard]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/patterns/guard-jwt.md',
    );
    // MEDIDO contra uma cópia do vault real: achatar para `[[guard-jwt]]` resolve certo e mesmo
    // assim está errado. Quem escreveu `[[02-wiki/nestjs/...]]` escolheu a forma longa, e os MOCs
    // deste vault a usam por convenção. Reescrever o ALVO é obrigação da invariante; reescrever o
    // ESTILO de quem escreveu não é, e ainda infla o diff que o usuário tem de revisar.
    expect(text).toBe('Ver [[02-wiki/patterns/guard-jwt]].\n');
  });

  it('preserva a forma relativa à nota, com os ../', () => {
    const paths = [...VAULT, '02-wiki/patterns/cache-wrapper.md'];
    const { text } = rewriteLinks({
      text: 'Ver [[../nestjs/auth-guard]] aqui.\n',
      notePathBefore: '02-wiki/docker/multi-stage.md',
      notePathAfter: '02-wiki/docker/multi-stage.md',
      ...indexes(
        paths,
        paths.map((p) => (p === '02-wiki/nestjs/auth-guard.md' ? '02-wiki/patterns/guard-jwt.md' : p)),
      ),
      renames: new Map([['02-wiki/nestjs/auth-guard.md', '02-wiki/patterns/guard-jwt.md']]),
    });
    expect(text).toBe('Ver [[../patterns/guard-jwt]] aqui.\n');
  });

  it('mantém o slug puro quando era slug puro', () => {
    const { text } = rewriteIn(
      'Ver [[auth-guard]].\n',
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe('Ver [[guard-jwt]].\n');
  });

  it('abandona a forma original quando ela não resolve mais', () => {
    // A preferência é por FORMA, nunca acima da correção: se a forma preservada não resolve para a
    // nota certa, ela é descartada e o candidato que resolve entra, seja qual for o formato.
    const COLIDINDO = [
      '00-index/index-knowledge.md',
      'auth-guard.md',
      '02-wiki/nestjs/auth-guard.md',
      '04-daily/2026-08-20.md',
    ];
    const { text } = rewriteIn(
      'Ver [[auth-guard]].\n',
      '04-daily/2026-08-20.md',
      COLIDINDO,
      'auth-guard.md',
      '02-wiki/patterns/auth-guard.md',
    );
    expect(text).toBe('Ver [[02-wiki/patterns/auth-guard]].\n');
  });

  it('deixa em paz um link que já não resolvia antes', () => {
    // Um edge que não resolvia não é um edge, e a invariante não promete nada sobre ele.
    // Reescrevê-lo seria adivinhar o que o usuário quis dizer.
    const antes = 'Ver [[nota-que-nao-existe]].\n';
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe(antes);
  });

  it('deixa em paz um link quebrado que o move faz PASSAR a resolver', () => {
    // O outro lado do mesmo guard, e o que de fato o sustenta. Aqui o alvo não resolvia antes
    // e resolve depois, porque o move deu à nota exatamente aquele nome. Isso é um edge NOVO,
    // não um edge que mudou de destino, e a invariante não fala sobre ele: o texto fica como
    // está — e agora aponta para a nota, que era o que o link já queria dizer.
    //
    // Sem o guard, `wasAt` é `undefined`, `nowAt` não é, os dois diferem, e a reescrita tenta
    // compor um alvo para um destino `undefined` — um `TypeError` no meio de um move, com o
    // rename já calculado. É por isso que o guard não é redundante, apesar de o caso do teste
    // acima passar sem ele.
    const antes = 'Ver [[nota-que-nao-existe]].\n';
    const { text, warnings } = rewriteIn(
      antes,
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/bullmq-worker.md',
      '02-wiki/nestjs/nota-que-nao-existe.md',
    );
    expect(text).toBe(antes);
    expect(warnings).toEqual([]);
  });
});

describe('rewriteLinks — move sem renomear', () => {
  it('não toca em nada quando o basename continua resolvendo', () => {
    // O caso que a regra ingênua "renomeie o slug em todo lugar" estraga: o arquivo mudou de
    // diretório, o nome não mudou, e `[[auth-guard]]` resolve pelo índice de basename tanto
    // antes quanto depois. Reescrever aqui é mexer em arquivo à toa e sujar o commit.
    const antes = 'Ver [[auth-guard]].\n';
    const { text } = rewriteIn(
      antes,
      '04-daily/2026-08-20.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/patterns/auth-guard.md',
    );
    expect(text).toBe(antes);
  });

  it('reescreve o link relativo de uma IRMÃ que perdeu a vizinhança', () => {
    // `[[auth-guard]]` de dentro de `02-wiki/nestjs/` resolvia pelo passo RELATIVO. Depois do
    // move o alvo não é mais irmão, e só o índice de basename o alcança — o que continua
    // resolvendo para a mesma nota. Nada a fazer, e é justamente isso que o teste fixa.
    const antes = 'Ver [[auth-guard]].\n';
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/patterns/auth-guard.md',
    );
    expect(text).toBe(antes);
  });

  it('deixa em paz um link relativo de saída que o índice de basename ainda alcança', () => {
    // MEDIDO, e contra a intuição: `buildMoc` escreve
    // `[[../../00-index/index-knowledge|índice de conhecimento]]`, relativo ao diretório
    // ANTIGO, e mover a nota para `01-raw/` faz os dois `..` escaparem da raiz — o passo
    // relativo E o passo relativo-à-raiz falham os dois. E o link continua resolvendo, porque
    // o TERCEIRO passo procura por basename e existe uma `index-knowledge.md` só.
    //
    // Ou seja: um `..` que quebra não é, sozinho, um link que quebra. A invariante já sabia
    // disso — ela pergunta para onde o alvo RESOLVE, não como ele está escrito — e é por isso
    // que ela é uma regra só. Uma regra escrita como "conserte os `..` da nota movida" teria
    // reescrito esta linha à toa.
    const antes = 'Ver [[../../00-index/index-knowledge|índice de conhecimento]].\n';
    const { text } = rewriteLinks({
      text: antes,
      notePathBefore: '02-wiki/nestjs/nestjs-moc.md',
      notePathAfter: '01-raw/nestjs-moc.md',
      ...indexes(
        VAULT,
        VAULT.map((p) => (p === '02-wiki/nestjs/nestjs-moc.md' ? '01-raw/nestjs-moc.md' : p)),
      ),
      renames: new Map([['02-wiki/nestjs/nestjs-moc.md', '01-raw/nestjs-moc.md']]),
    });
    expect(text).toBe(antes);
  });

  it('reescreve o link relativo de saída que passa a apontar para OUTRA nota', () => {
    // Este é o caso em que um link de saída realmente estraga, e ele não é sobre o `..`
    // escapar: é sobre o `..` CHEGAR em outro lugar. `[[../docker/multi-stage]]`, escrito de
    // `02-wiki/nestjs/`, nomeia a nota de `02-wiki/docker/`. Movida a nota para
    // `03-projects/`, o mesmo texto resolve — sem erro nenhum, sem link quebrado — para
    // `03-projects/docker/multi-stage.md`, que é outra nota. Um move que reporta sucesso e
    // deixa o usuário lendo o documento errado é pior do que um link quebrado, que pelo menos
    // se anuncia.
    const paths = [...VAULT, '03-projects/docker/multi-stage.md'];
    const { text } = rewriteLinks({
      text: 'Ver [[../docker/multi-stage|o multi-stage]].\n',
      notePathBefore: '02-wiki/nestjs/nestjs-moc.md',
      notePathAfter: '03-projects/nestjs-moc.md',
      ...indexes(
        paths,
        paths.map((p) => (p === '02-wiki/nestjs/nestjs-moc.md' ? '03-projects/nestjs-moc.md' : p)),
      ),
      renames: new Map([['02-wiki/nestjs/nestjs-moc.md', '03-projects/nestjs-moc.md']]),
    });
    expect(text).toBe('Ver [[../02-wiki/docker/multi-stage|o multi-stage]].\n');
  });
});

describe('rewriteLinks — colisão de basename', () => {
  const COLIDINDO = [
    '00-index/index-knowledge.md',
    'auth-guard.md',
    '02-wiki/nestjs/auth-guard.md',
    '02-wiki/nestjs/bullmq-worker.md',
    '04-daily/2026-08-20.md',
  ];

  it('desambigua o link quando o move cria um empate de profundidade', () => {
    // Antes: `auth-guard.md` na raiz é a mais rasa e ganha. Depois de movê-la para
    // `02-wiki/patterns/`, as duas estão a profundidade 2, o empate não resolve para
    // nenhuma, e `[[auth-guard]]` — que ninguém renomeou — passaria a ser um link quebrado.
    const { text, warnings } = rewriteIn(
      'Ver [[auth-guard]].\n',
      '04-daily/2026-08-20.md',
      COLIDINDO,
      'auth-guard.md',
      '02-wiki/patterns/auth-guard.md',
    );
    expect(text).toBe('Ver [[02-wiki/patterns/auth-guard]].\n');
    expect(warnings).toEqual([]);
  });

  it('cai para o caminho relativo quando o diretório da própria nota sombreia a raiz', () => {
    // O terceiro candidato, e o vault que o exige: um diretório literalmente chamado
    // `02-wiki` DENTRO de `02-wiki/`. Legal, absurdo, e suficiente para que o primeiro passo
    // do resolvedor — relativo à nota que linka — capture o caminho relativo à raiz e o
    // entregue a outra nota.
    //
    // É por isso que cada candidato é VERIFICADO com `resolveLinkTarget` em vez de composto e
    // confiado. Uma reescrita que fizesse a própria aritmética escreveria aqui
    // `[[02-wiki/nestjs/auth-guard]]`, que resolve para a nota errada, e reportaria sucesso.
    const paths = [
      '02-wiki/x.md',
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/02-wiki/nestjs/auth-guard.md',
      '02-wiki/docker/multi-stage.md',
    ];
    const { text, warnings } = rewriteIn(
      'Ver [[auth-guard]].\n',
      '02-wiki/x.md',
      paths,
      // O move em si não toca no alvo: ele só cria um terceiro `auth-guard.md` na mesma
      // profundidade do alvo, e o empate é o que tira o link curto de jogo.
      '02-wiki/docker/multi-stage.md',
      '02-wiki/docker/auth-guard.md',
    );
    expect(text).toBe('Ver [[nestjs/auth-guard]].\n');
    expect(warnings).toEqual([]);
  });

  it('não mexe no link que apontava para a OUTRA nota do empate', () => {
    // `[[auth-guard]]` de dentro de `02-wiki/nestjs/` resolve pelo passo relativo, para a
    // irmã, antes e depois. É a metade que uma regra por nome de arquivo destruiria.
    const antes = 'Ver [[auth-guard]].\n';
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      COLIDINDO,
      'auth-guard.md',
      '02-wiki/patterns/auth-guard.md',
    );
    expect(text).toBe(antes);
  });

  it('desambigua também quando é a nota que LINKA que se moveu', () => {
    // A nota sai de `02-wiki/nestjs/` (onde `[[auth-guard]]` resolvia para a irmã) e vai
    // para `04-daily/`, onde o mesmo alvo passa a resolver para a `auth-guard.md` da raiz —
    // outra nota. O texto não mudou de dono, mas o significado dele mudou.
    const { text } = rewriteIn(
      'Ver [[auth-guard]].\n',
      '02-wiki/nestjs/bullmq-worker.md',
      COLIDINDO,
      '02-wiki/nestjs/bullmq-worker.md',
      '04-daily/bullmq-worker.md',
    );
    expect(text).toBe('Ver [[02-wiki/nestjs/auth-guard]].\n');
  });
});

describe('rewriteLinks — cercas de código', () => {
  it('não toca em [[...]] dentro de cerca', () => {
    const antes = [
      'Ver [[auth-guard]].',
      '',
      '```md',
      'O formato de uma entrada: `- [[auth-guard]] — resumo`',
      '```',
      '',
      'Fim.',
      '',
    ].join('\n');
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe(antes.replace('Ver [[auth-guard]].', 'Ver [[guard-jwt]].'));
    // A linha de dentro da cerca continua byte a byte a que estava lá.
    expect(text).toContain('O formato de uma entrada: `- [[auth-guard]] — resumo`');
  });

  it('a cerca interna de um bloco ````md não reabre o externo', () => {
    const antes = ['````md', '```ts', '// [[auth-guard]]', '```', '````', '[[auth-guard]]', ''].join(
      '\n',
    );
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toContain('// [[auth-guard]]');
    expect(text).toContain('\n[[guard-jwt]]\n');
  });

  it('trata um arquivo CRLF como qualquer outro', () => {
    const antes = ['Ver [[auth-guard]].', '', '```md', '[[auth-guard]]', '```', ''].join('\r\n');
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe(
      ['Ver [[guard-jwt]].', '', '```md', '[[auth-guard]]', '```', ''].join('\r\n'),
    );
  });
});

describe('rewriteLinks — texto que não é link', () => {
  it('devolve o conteúdo byte a byte quando não há nada a fazer', () => {
    const antes = '# Título\n\nProsa sem link nenhum.\n';
    const { text, warnings } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    expect(text).toBe(antes);
    expect(warnings).toEqual([]);
  });

  it('não confunde um link markdown comum com um wiki-link', () => {
    const antes = 'Ver [auth-guard](02-wiki/nestjs/auth-guard.md).\n';
    const { text } = rewriteIn(
      antes,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    // Um link markdown NÃO é um wiki-link, e o resolvedor deste vault nunca o viu. Consertá-lo
    // aqui seria esta função inventando uma segunda sintaxe que o resto do servidor ignora.
    expect(text).toBe(antes);
  });
});

/**
 * As cargas de backtracking do docblock de `WIKI_LINK` (src/vault/links.ts), na função nova.
 *
 * O corpo de uma nota inclui página web recortada para `01-raw/clippings/`, então isto
 * parseia texto hostil — e `"[[a".repeat(n)` é exatamente a carga que fez a versão frouxa do
 * padrão ir a 18,7 s em 240 KB. Aqui o padrão é o MESMO objeto exportado, e o teste existe
 * para pegar uma reescrita futura que o troque por um mais permissivo.
 */
describe('rewriteLinks — custo linear em entrada hostil', () => {
  it('parseia 240 KB de [[ sem fechamento em tempo linear', () => {
    const payload = '[[a'.repeat(80_000);
    const started = process.hrtime.bigint();
    const { text } = rewriteIn(
      payload,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(text).toBe(payload);
    // O teto é folgado de propósito: o que ele pega é a volta do comportamento quadrático,
    // que na mesma carga media SEGUNDOS, não a variação de uma máquina carregada.
    expect(ms).toBeLessThan(2_000);
  });

  it('parseia 240 KB de uma linha só sem fechamento em tempo linear', () => {
    const payload = `[[${'a'.repeat(240_000)}`;
    const started = process.hrtime.bigint();
    rewriteIn(
      payload,
      '02-wiki/nestjs/bullmq-worker.md',
      VAULT,
      '02-wiki/nestjs/auth-guard.md',
      '02-wiki/nestjs/guard-jwt.md',
    );
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(2_000);
  });
});

describe('buildVaultIndex', () => {
  it('indexa por caminho e por basename sem extensão', () => {
    const index = buildVaultIndex(['02-wiki/nestjs/auth-guard.md', 'auth-guard.md']);
    expect(index.allPaths.has('02-wiki/nestjs/auth-guard.md')).toBe(true);
    expect(index.byBasename.get('auth-guard')).toEqual([
      '02-wiki/nestjs/auth-guard.md',
      'auth-guard.md',
    ]);
  });
});
