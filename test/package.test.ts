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

  it('ainda declara o bin pelo nome curto', () => {
    // O escopo está no NOME DO PACOTE, não no comando: `npx @andreymudri/vault-mcp` resolve este
    // `bin` de dentro do pacote, e um clone continua fazendo `npm link` do mesmo jeito.
    expect(pkg.bin).toEqual({ 'vault-mcp': './dist/server/index.js' });
  });

  it('a versão que o servidor anuncia é a do package.json', () => {
    // As duas eram literais separados, iguais por coincidência. Este teste é o que transforma
    // "lembrar de trocar nos dois lugares" em uma falha de suíte.
    expect(VERSION).toBe(pkg.version);
  });
});
