import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      runtimeHint?: string;
      environmentVariables: Array<{ name: string; isRequired?: boolean; format?: string }>;
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

  it('declara o runtime, para o cliente não ter de adivinhar no Windows', () => {
    // Sem `runtimeHint` o cliente adivinha — e a adivinhação que quebra é a do Windows: `npx`
    // resolve para `npx.cmd`, arquivo de lote que o CreateProcess não executa, então um cliente
    // que faça spawn com shell:false morre com ENOENT antes de o servidor subir. É a MESMA falha
    // que `scripts/test.mjs` já documenta sobre o `vitest.CMD`.
    expect(server.packages[0]?.runtimeHint).toBe('npx');
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

  it('documenta toda variável de ambiente que o servidor lê, e nenhuma que ele não lê', () => {
    // Lido do FONTE: uma variável nova que entra no código sem entrar aqui é uma opção que existe
    // e que nenhum cliente consegue oferecer, e uma que saiu do código e ficou aqui é uma promessa
    // que o servidor não cumpre.
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const read = new Set<string>();
    for (const entry of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(join(srcDir, entry), 'utf8');
      for (const match of text.matchAll(/(?:env\[['"]|process\.env\.|env, ')(VAULT_[A-Z_]+)/g)) {
        read.add(match[1] ?? '');
      }
    }
    const declared = (server.packages[0]?.environmentVariables ?? []).map((v) => v.name);
    expect([...declared].sort()).toEqual([...read].sort());
  });

  it('declara VAULT_PATH como obrigatória e as outras como opcionais', () => {
    const vars = server.packages[0]?.environmentVariables ?? [];
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get('VAULT_PATH')?.isRequired).toBe(true);
    // `filepath`, não `string`: é o único input cuja FORMA muda por sistema. O schema define o
    // enum [string, number, boolean, filepath], e `string` manda todo cliente desenhar caixa de
    // texto livre — no Windows a pessoa digita `C:\\Users\\me\\vault` ali, o cliente grava isso num
    // JSON de configuração, e `\\U` não é escape JSON válido: o próprio arquivo deixa de parsear.
    expect(byName.get('VAULT_PATH')?.format).toBe('filepath');
    expect(byName.get('VAULT_LANG')?.isRequired).toBe(false);
    expect(byName.get('VAULT_AUTO_PUSH')?.isRequired).toBe(false);
  });
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * O que decide se uma versão pode ser publicada, antes de qualquer coisa sair da máquina.
 *
 * O release é automático: dar merge em `main` de uma versão que ainda não tem tag publica no npm,
 * cria a tag e o Release e publica no MCP Registry. Nada disso se desfaz — uma versão no npm é
 * para sempre — então o que tem de estar certo é conferido por um script com saída de erro, e não
 * por alguém lembrando de olhar.
 */
describe('scripts/release-check.mjs', () => {
  const SCRIPT = join(ROOT, 'scripts', 'release-check.mjs');
  const FILES = ['package.json', 'package-lock.json', 'server.json', 'CHANGELOG.md'] as const;

  /** Uma cópia dos quatro arquivos que o script lê, com `change` aplicada a um deles. */
  function check(
    change?: { file: (typeof FILES)[number]; edit: (text: string) => string },
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vault-mcp-release-check-'));
    try {
      for (const file of FILES) cpSync(join(ROOT, file), join(dir, file));
      if (change !== undefined) {
        const target = join(dir, change.file);
        writeFileSync(target, change.edit(readFileSync(target, 'utf8')), 'utf8');
      }
      const { GITHUB_REPOSITORY: _unset, ...clean } = process.env;
      const run = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8', env: { ...clean, ...env } });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** What these tests change in `server.json` and `package-lock.json`: nothing else is read. */
  interface Versioned {
    version: string;
    name: string;
    /** An array in `server.json`, a map keyed by path in the lockfile. */
    packages: Record<string | number, { version: string }>;
  }
  const json = (edit: (data: Versioned) => void) => (text: string): string => {
    const data = JSON.parse(text) as Versioned;
    edit(data);
    return JSON.stringify(data, null, 2);
  };

  it('no repositório como está, responde a versão e mais nada', () => {
    const run = check();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${String(pkg.version)}\n`);
  });

  it('recusa quando a versão do server.json ficou para trás, e diz qual das duas', () => {
    const topo = check({
      file: 'server.json',
      edit: json((data) => {
        data.version = '0.0.1';
      }),
    });
    expect(topo.status).toBe(1);
    expect(topo.stdout).toBe('');
    expect(topo.stderr).toContain('server.json');
    expect(topo.stderr).toContain('0.0.1');

    const pacote = check({
      file: 'server.json',
      edit: json((data) => {
        data.packages[0]!.version = '0.0.2';
      }),
    });
    expect(pacote.status).toBe(1);
    expect(pacote.stderr).toContain('packages[0].version');
  });

  it('recusa quando o package-lock.json ficou para trás', () => {
    const run = check({
      file: 'package-lock.json',
      edit: json((data) => {
        data.packages['']!.version = '0.0.1';
      }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('package-lock.json');
  });

  it('recusa uma versão que não tem seção no CHANGELOG, ou cuja seção está vazia', () => {
    const version = String(pkg.version);
    const semSecao = check({ file: 'CHANGELOG.md', edit: (text) => text.replace(`## [${version}]`, '## [0.0.0]') });
    expect(semSecao.status).toBe(1);
    expect(semSecao.stderr).toContain('CHANGELOG.md');

    const vazia = check({
      file: 'CHANGELOG.md',
      edit: (text) => {
        const start = text.indexOf(`## [${version}]`);
        const next = text.indexOf('\n## [', start + 1);
        return `${text.slice(0, start)}## [${version}] - 2026-01-01\n${text.slice(next)}`;
      },
    });
    expect(vazia.status).toBe(1);
    expect(vazia.stderr).toContain('CHANGELOG.md');
  });

  it('recusa quando o nome no MCP Registry não é o mcpName que vai dentro do pacote', () => {
    // O registry lê o `mcpName` de DENTRO do tarball do npm para provar a posse do nome: com os
    // dois diferentes o npm publica, e o registry recusa depois — com a versão já gasta.
    const run = check({
      file: 'server.json',
      edit: json((data) => {
        data.name = 'io.github.outro/vault-mcp';
      }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('mcpName');
  });

  it('recusa quando o repositório do package.json não é o que está publicando', () => {
    // A publicação por OIDC confere o `repository.url` do pacote contra o repositório do workflow.
    expect(check(undefined, { GITHUB_REPOSITORY: 'andreymudri/vault-mcp' }).status).toBe(0);
    const outro = check(undefined, { GITHUB_REPOSITORY: 'outra-conta/vault-mcp' });
    expect(outro.status).toBe(1);
    expect(outro.stderr).toContain('repository');
  });

  it('diz tudo o que está errado de uma vez, e não só o primeiro', () => {
    const run = check({
      file: 'server.json',
      edit: json((data) => {
        data.version = '0.0.1';
        data.name = 'io.github.outro/vault-mcp';
      }),
    });
    expect(run.stderr).toContain('0.0.1');
    expect(run.stderr).toContain('mcpName');
  });
});

/**
 * O que os workflows prometem sobre a cadeia de suprimentos, lido do próprio arquivo.
 *
 * Um workflow de release não tem como rodar num teste. O que dá para fixar é a FORMA que o torna
 * seguro: quem tem a identidade de publicação, em que ordem as coisas saem, e que nada é baixado
 * sem versão.
 */
describe('os workflows do GitHub', () => {
  const read = (name: string): string => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
  const release = read('release.yml');
  /** O texto de cada job de um workflow, pelo nome. */
  const jobsOf = (workflow: string): Map<string, string> => {
    const body = workflow.slice(workflow.search(/^jobs:\s*$/m));
    const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)];
    return new Map(
      starts.map((match, i) => [match[1] ?? '', body.slice(match.index, starts[i + 1]?.index ?? body.length)]),
    );
  };
  /** Só o que executa: sem as linhas de comentário, que falam do que o job NÃO faz. */
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

  it('toda action é fixada pelo SHA de um commit', () => {
    for (const name of ['ci.yml', 'release.yml']) {
      const uses = read(name).split('\n').filter((line) => /^\s*(- )?uses:/.test(line));
      expect(uses.length, name).toBeGreaterThan(0);
      for (const line of uses) expect(line, name).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/);
    }
  });

  it('o release dispara no merge em main e à mão, e o token padrão só lê', () => {
    expect(release).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n(?: {2}#.*\n)* {2}workflow_dispatch:/m);
    expect(release).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('só o job que publica tem a identidade de publicação, e ele não instala dependência nem roda teste', () => {
    const jobs = jobsOf(release);
    expect([...jobs.keys()]).toEqual(['plan', 'verify', 'publish']);
    for (const [name, text] of jobs) {
      const privileged = /id-token: write/.test(code(text)) || /contents: write/.test(code(text));
      expect(privileged, name).toBe(name === 'publish');
    }
    const publish = code(jobs.get('publish') ?? '');
    // Quem roda com `id-token: write` pode pedir um token e publicar. O código de terceiros —
    // dependências, o que os testes executam — roda todo no job `verify`, que não tem nenhum.
    expect(publish).not.toMatch(/npm (ci|install|test|run|exec)\b/);
    expect(publish).not.toMatch(/actions\/checkout/);
    expect(publish).toContain('needs: [plan, verify]');
    const verify = code(jobs.get('verify') ?? '');
    for (const step of ['npm ci', 'npm run lint', 'npm audit --omit=dev --audit-level=high', 'npm test', 'npm run build', 'npm pack']) {
      expect(verify, step).toContain(step);
    }
  });

  it('publica no npm primeiro, cria a tag e o Release depois, e o MCP Registry por último', () => {
    const publish = code(jobsOf(release).get('publish') ?? '');
    const at = (needle: string): number => {
      const index = publish.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(at('npm publish')).toBeLessThan(at('gh release create'));
    expect(at('gh release create')).toBeLessThan(at('mcp-publisher publish'));
    // A tag nasce no commit que foi verificado, pelo SHA inteiro.
    expect(publish).toContain('--target "$GITHUB_SHA"');
  });

  it('cada passo de publicação confere antes se já foi feito', () => {
    const publish = code(jobsOf(release).get('publish') ?? '');
    expect(publish).toContain('npm view');
    expect(publish).toContain('gh release view');
    expect(publish).toMatch(/registry\.modelcontextprotocol\.io\/v0\.1\/servers\/.+\/versions\//);
  });

  it('o tarball é passado ao npm por caminho absoluto', () => {
    // `npm install --prefix <dir> release/pacote.tgz` procura o arquivo a partir do PREFIXO, não o
    // acha, e trata `release/pacote.tgz` como o atalho `usuario/repo` do GitHub. Visto ao simular
    // o job numa árvore limpa: "Refusing to fetch github:release/andreymudri-vault-mcp-0.6.0.tgz".
    const text = code(release);
    const npmWithTarball = text.split('\n').filter((line) => /npm (install|publish)\b/.test(line));
    expect(npmWithTarball).toHaveLength(2);
    expect(text).toContain('npm install --prefix "$prefix" --no-audit --no-fund "$PWD"/release/*.tgz');
    expect(text).toContain('tarball="$PWD/$(ls release/*.tgz)"');
    expect(text).toContain('npm publish "$tarball"');
  });

  it('o mcp-publisher vem numa versão fixa e é verificado antes de rodar', () => {
    expect(release).toMatch(/MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+/);
    expect(code(release)).toContain('cosign verify-blob');
    expect(code(release)).not.toContain('releases/latest');
  });
});
