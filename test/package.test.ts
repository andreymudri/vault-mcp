import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../src/server/index.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

/**
 * O pacote é PUBLICÁVEL, e sob escopo.
 *
 * A versão anterior destes testes fixava `"private": true`, para um `npm publish` acidental falhar
 * aqui e não no registry. O motivo era o nome: `vault-mcp` já existe no npm — `vault-mcp@0.0.1`,
 * 443 bytes, um placeholder de namespace de outro autor — então publicar sob ele era impossível e
 * `npx vault-mcp` rodava código alheio.
 *
 * Sob `@andreymudri/` não há colisão nenhuma, e o guard muda de lado: em vez de impedir a
 * publicação, estes testes fixam o que uma publicação precisa acertar. Cada um deles falha por uma
 * coisa que, sem ele, só apareceria depois de o pacote estar no registry — onde não dá para
 * desfazer.
 */
describe('package.json', () => {
  it('é publicável sob o escopo, sem o guard de `private` que existia antes', () => {
    expect(pkg.name).toBe('@andreymudri/vault-mcp');
    expect(pkg.private).toBeUndefined();
  });

  it('publica como público: pacote escopado nasce restrito', () => {
    // Sem isto o primeiro `npm publish` falha pedindo `--access public`, ou — pior, numa conta que
    // permita — publica um pacote que ninguém consegue instalar.
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('manda só o `dist/` no tarball', () => {
    // Sem `files`, o npm cai no `.gitignore` e o tarball leva `src/`, `test/` inteiro (fixtures
    // incluídas), os tsconfigs e o workflow do CI: 122 arquivos e 1,8 MB medidos, para servir um
    // runtime que são 25.
    expect(pkg.files).toEqual(['dist']);
  });

  it('constrói e faz o smoke antes de publicar', () => {
    // `dist/` está no `.gitignore`: num clone limpo ele não existe, e sem este script o `npm
    // publish` mandaria um pacote cujo `bin` aponta para um arquivo que não foi junto.
    expect(pkg.scripts).toMatchObject({
      prepublishOnly: 'npm run build && npm run smoke',
    });
  });

  it('ainda declara o bin pelo nome curto, sem o `./` que o npm reescreveria', () => {
    // O escopo está no NOME DO PACOTE, não no comando: `npx @andreymudri/vault-mcp` resolve este
    // `bin` de dentro do pacote, e um clone continua fazendo `npm link` do mesmo jeito. O caminho
    // vai SEM `./` porque o `npm publish` normaliza o prefixo de qualquer jeito — escrito com ele,
    // o package.json que chega no registro deixa de ser o que está aqui, e o publish avisa disso.
    expect(pkg.bin).toEqual({ 'vault-mcp': 'dist/server/index.js' });
  });

  it('a versão que o servidor anuncia é a do package.json', () => {
    // As duas eram literais separados, iguais por coincidência. Este teste é o que transforma
    // "lembrar de trocar nos dois lugares" em uma falha de suíte.
    expect(VERSION).toBe(pkg.version);
  });
});

describe('server.json — o contrato do MCP Registry', () => {
  const server = JSON.parse(
    readFileSync(fileURLToPath(new URL('../server.json', import.meta.url)), 'utf8')
  ) as {
    name: string;
    description: string;
    version: string;
    repository: { url: string; source: string };
    packages: Array<{
      registryType: string;
      identifier: string;
      version: string;
      environmentVariables: Array<{ name: string; isRequired?: boolean }>;
    }>;
  };

  it('o nome do registry é o mesmo `mcpName` que vai DENTRO do pacote publicado', () => {
    // É assim que o registry prova que quem publica é dono do pacote: ele lê o `mcpName` do
    // tarball no npm e exige que bata com o `name` daqui. Os dois moram em arquivos diferentes,
    // então divergem sem ninguém notar — até o publish recusar, com o pacote já no npm.
    expect(server.name).toBe(pkg.mcpName);
  });

  it('o nome está sob o namespace que a autenticação do GitHub concede', () => {
    // Autenticando por GitHub, o registry só aceita `io.github.<usuário>/…`. Qualquer outro
    // prefixo é recusado no publish, e o erro fala de namespace e não do que está errado aqui.
    expect(server.name).toBe('io.github.andreymudri/vault-mcp');
  });

  it('as TRÊS versões andam juntas', () => {
    // `package.json`, o topo do server.json, e a versão do pacote dentro dele. Uma release que
    // esquece qualquer uma publica metadado apontando para um tarball que não é o dela.
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]?.version).toBe(pkg.version);
  });

  it('aponta para o pacote npm deste repositório', () => {
    expect(server.packages[0]?.registryType).toBe('npm');
    expect(server.packages[0]?.identifier).toBe(pkg.name);
    expect(server.repository.url).toBe('https://github.com/andreymudri/vault-mcp');
  });

  it('a descrição cabe no limite de 100 caracteres do registry', () => {
    // Aprendido pelo caminho caro: o `validate` do mcp-publisher recusa com 422
    // `expected length <= 100` — e recusa DEPOIS de o pacote já estar no npm, porque a ordem da
    // release é npm primeiro, registry depois. Um teste aqui move a descoberta para o `npm test`.
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description.trim()).not.toBe('');
  });

  it('declara VAULT_PATH como obrigatória e as outras como opcionais', () => {
    const vars = server.packages[0]?.environmentVariables ?? [];
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get('VAULT_PATH')?.isRequired).toBe(true);
    expect(byName.get('VAULT_LANG')?.isRequired).toBe(false);
    expect(byName.get('VAULT_AUTO_PUSH')?.isRequired).toBe(false);
  });
});
