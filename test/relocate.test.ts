import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VaultScanner } from '../src/vault/scanner.js';
import { RelocateError, deleteNote, moveNote } from '../src/write/relocate.js';

const execFileAsync = promisify(execFile);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

/** Um relógio fixo: nada aqui depende da hora, e um MOC novo nasce com data estável. */
const NOW = new Date('2026-08-26T10:00:00');

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

/**
 * Uma CÓPIA da fixture, com repositório git próprio.
 *
 * Nunca a fixture em si: este módulo escreve, apaga e commita, e a suíte inteira lê aquele
 * diretório em paralelo. É a mesma regra que `writer.test.ts` e `learn.test.ts` seguem.
 */
async function makeVault(): Promise<{ root: string; scanner: VaultScanner }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-relocate-'));
  await fs.cp(FIXTURE, root, { recursive: true });
  await git(root, ['init']);
  await git(root, ['config', 'gc.auto', '0']);
  await git(root, ['config', 'user.name', 'Vault MCP Test']);
  await git(root, ['config', 'user.email', 'vault-mcp-test@example.com']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'chore: vault inicial']);
  const scanner = new VaultScanner({ vaultRoot: root });
  scanner.refresh();
  return { root, scanner };
}

async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function read(root: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8');
}

async function exists(root: string, relPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Quantos commits existem além do inicial. */
async function commitsSince(root: string): Promise<number> {
  const log = await git(root, ['log', '--oneline']);
  return log.split('\n').length - 1;
}

describe('moveNote', () => {
  let root: string;
  let scanner: VaultScanner;

  beforeEach(async () => {
    ({ root, scanner } = await makeVault());
  });

  afterEach(async () => {
    await removeTree(root);
  });

  const move = (from: string, to: string, extra: Record<string, unknown> = {}) =>
    moveNote({ vaultRoot: root, scanner, from, to, now: NOW, ...extra });

  it('renomeia dentro do mesmo domínio e reescreve quem apontava para o nome antigo', async () => {
    const result = await move('02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/guard-jwt.md');

    expect(await exists(root, '02-wiki/nestjs/auth-guard.md')).toBe(false);
    expect(await read(root, '02-wiki/nestjs/guard-jwt.md')).toContain('# Auth Guard');

    // O MOC do domínio é uma nota como outra qualquer: o link dentro dele é corrigido pela
    // MESMA reescrita que corrige o resto do vault, não por um caso especial de MOC.
    const moc = await read(root, '02-wiki/nestjs/nestjs-moc.md');
    expect(moc).toContain('- [[guard-jwt]] — guard de autenticação JWT');
    expect(moc).not.toContain('[[auth-guard]]');

    expect(result.to).toBe('02-wiki/nestjs/guard-jwt.md');
    expect(result.rewritten).toContain('02-wiki/nestjs/nestjs-moc.md');
    expect(result.committed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('publica tudo num commit só, que o git lê como rename', async () => {
    await move('02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/guard-jwt.md');

    expect(await commitsSince(root)).toBe(1);
    const status = await git(root, ['show', '--name-status', '--format=', 'HEAD']);
    // `git add` nos DOIS caminhos é o que registra o delete mais o add; a detecção de rename
    // é do git, e ela só acontece porque os dois lados entraram no mesmo commit.
    expect(status).toContain('R');
    expect(status).toContain('02-wiki/nestjs/guard-jwt.md');
  });

  it('migra o pertencimento ao MOC entre domínios, preservando o resumo', async () => {
    const result = await move('02-wiki/nestjs/auth-guard.md', '02-wiki/docker/auth-guard.md');

    const origem = await read(root, '02-wiki/nestjs/nestjs-moc.md');
    const destino = await read(root, '02-wiki/docker/docker-moc.md');

    expect(origem).not.toContain('auth-guard');
    // O resumo é do usuário, e ele atravessa a mudança de domínio inteiro.
    expect(destino).toContain('- [[auth-guard]] — guard de autenticação JWT');
    expect(result.propagated).toEqual(
      expect.arrayContaining(['02-wiki/nestjs/nestjs-moc.md', '02-wiki/docker/docker-moc.md']),
    );
  });

  it('promove uma nota de 01-raw/ para um domínio', async () => {
    await move('01-raw/inbox/rascunho.md', '02-wiki/docker/rascunho.md');

    expect(await exists(root, '01-raw/inbox/rascunho.md')).toBe(false);
    const destino = await read(root, '02-wiki/docker/docker-moc.md');
    // Sem linha de origem não há resumo para carregar, e a entrada sai sem ele. Inventar uma
    // frase para o MOC do usuário seria pior do que a entrada curta.
    expect(destino).toContain('- [[rascunho]]');
    expect(destino).not.toContain('- [[rascunho]] —');
  });

  it('exige confirm_novo_dominio quando o MOC de destino não existe', async () => {
    // `02-wiki/patterns/` EXISTE e não tem MOC. É o domínio pela metade, e criar o MOC dele
    // sem pedir seria o servidor decidindo que aquilo é um domínio.
    await expect(move('02-wiki/nestjs/auth-guard.md', '02-wiki/patterns/auth-guard.md')).rejects.toBeInstanceOf(
      RelocateError,
    );
    // E nada foi publicado: a nota continua onde estava.
    expect(await exists(root, '02-wiki/nestjs/auth-guard.md')).toBe(true);
    expect(await commitsSince(root)).toBe(0);
  });

  it('cria o MOC e a linha do índice quando o domínio novo é confirmado', async () => {
    const result = await move('02-wiki/nestjs/auth-guard.md', '02-wiki/patterns/auth-guard.md', {
      confirmNovoDominio: true,
    });

    const moc = await read(root, '02-wiki/patterns/patterns-moc.md');
    expect(moc).toContain('tipo: moc');
    expect(moc).toContain('- [[auth-guard]] — guard de autenticação JWT');

    const indice = await read(root, '00-index/index-knowledge.md');
    expect(indice).toContain('[[../02-wiki/patterns/patterns-moc|patterns]]');
    expect(result.propagated).toContain('00-index/index-knowledge.md');
  });

  it('arquiva e desarquiva com a mesma operação', async () => {
    await move('02-wiki/nestjs/auth-guard.md', '99-archive/auth-guard.md');
    expect(await exists(root, '99-archive/auth-guard.md')).toBe(true);
    // Arquivar tira a nota do MOC: o MOC indexa o que o domínio TEM.
    expect(await read(root, '02-wiki/nestjs/nestjs-moc.md')).not.toContain('auth-guard');

    scanner.refresh();
    await moveNote({
      vaultRoot: root,
      scanner,
      from: '99-archive/auth-guard.md',
      to: '02-wiki/nestjs/auth-guard.md',
      now: NOW,
    });
    expect(await exists(root, '02-wiki/nestjs/auth-guard.md')).toBe(true);
    expect(await read(root, '02-wiki/nestjs/nestjs-moc.md')).toContain('[[auth-guard]]');
  });

  it('desambigua um link que o move faria resolver para outra nota', async () => {
    // Duas `auth-guard.md`: a de `02-wiki/nestjs/` e uma na raiz, que é a mais rasa e por isso
    // a que `[[auth-guard]]` resolve a partir da daily. Movê-la para dentro de `02-wiki/`
    // cria um empate de profundidade, e o link curto deixa de resolver para qualquer uma.
    await fs.writeFile(
      path.join(root, 'auth-guard.md'),
      '---\ntipo: nota\n---\n\n# Guard solto\n\nUma nota solta.\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '04-daily', '2026-08-21.md'),
      '---\ntipo: daily\ncriado: 2026-08-21\n---\n\n# 2026-08-21\n\n## Capturas\n\n- 10:00 [[auth-guard]] (aprendizado)\n',
      'utf8',
    );
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'chore: colisão']);
    scanner.refresh();

    await moveNote({
      vaultRoot: root,
      scanner,
      from: 'auth-guard.md',
      to: '02-wiki/docker/auth-guard.md',
      now: NOW,
    });

    const daily = await read(root, '04-daily/2026-08-21.md');
    expect(daily).toContain('[[02-wiki/docker/auth-guard]]');
  });

  it('deixa os links de saída da nota movida resolvendo depois do move', async () => {
    // `auth-guard.md` linka `[[bullmq-worker]]`, que era irmã. Depois do move ela não é mais,
    // e o teste pergunta ao próprio scanner — não à intuição — se o link ainda resolve.
    await move('02-wiki/nestjs/auth-guard.md', '02-wiki/docker/auth-guard.md');

    const fresh = new VaultScanner({ vaultRoot: root });
    fresh.refresh();
    const movida = fresh.getNote('02-wiki/docker/auth-guard.md');
    expect(movida).toBeDefined();
    expect(movida?.links).toContain('02-wiki/nestjs/bullmq-worker.md');
    // O link que já estava quebrado continua quebrado, e continua sendo o mesmo alvo.
    expect(movida?.brokenLinks).toEqual(['nota-que-nao-existe']);
  });

  it('não toca na nota diária', async () => {
    // O MOC indexa o que EXISTE; a daily registra o que ACONTECEU naquele dia. Reescrever uma
    // captura de 20 de agosto porque a nota mudou de nome hoje é falsificar o diário.
    const antes = await read(root, '04-daily/2026-08-20.md');
    await move('02-wiki/nestjs/auth-guard.md', '02-wiki/docker/auth-guard.md');
    expect(await read(root, '04-daily/2026-08-20.md')).toBe(antes);
  });

  it('recusa um destino que já existe, sem tocar em nada', async () => {
    const antes = await read(root, '02-wiki/nestjs/bullmq-worker.md');
    let message = '';
    try {
      await move('02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/bullmq-worker.md');
    } catch (err) {
      expect(err).toBeInstanceOf(RelocateError);
      message = (err as Error).message;
    }
    // A nota de destino não foi sobrescrita, e a de origem não saiu do lugar. Isto é garantido
    // DUAS vezes — pela checagem aqui e pelo `fs.link`, que falha com EEXIST — e as duas são
    // necessárias por motivos diferentes.
    expect(await read(root, '02-wiki/nestjs/bullmq-worker.md')).toBe(antes);
    expect(await exists(root, '02-wiki/nestjs/auth-guard.md')).toBe(true);
    // A MENSAGEM é o que só a checagem entrega: "o destino já existe" é um engano do chamador,
    // enquanto "passou a existir enquanto a nota era movida" é uma corrida com outro escritor.
    // Confundir as duas manda o usuário investigar um concorrente que não existe.
    expect(message).toContain('destino já existe');
    expect(message).not.toContain('passou a existir');
  });

  it('recusa from igual a to', async () => {
    await expect(
      move('02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/auth-guard.md'),
    ).rejects.toBeInstanceOf(RelocateError);
  });

  it('recusa uma origem que não é nota', async () => {
    await expect(move('02-wiki/nestjs/nao-existe.md', '02-wiki/docker/x.md')).rejects.toBeInstanceOf(
      RelocateError,
    );
    // Um diretório também não é nota.
    await expect(move('02-wiki/nestjs.md', '02-wiki/docker/x.md')).rejects.toBeInstanceOf(
      RelocateError,
    );
  });

  it.each([
    ['_templates como destino', '02-wiki/nestjs/auth-guard.md', '_templates/wiki-novo.md'],
    ['_templates como origem', '_templates/wiki.md', '02-wiki/nestjs/wiki.md'],
    ['.git como destino', '02-wiki/nestjs/auth-guard.md', '.git/refs/heads/pwn.md'],
    ['fora do vault', '02-wiki/nestjs/auth-guard.md', '../fora.md'],
  ])('recusa %s mesmo com a porta do arquivo aberta', async (_label, from, to) => {
    // `allowArchive` isenta `99-archive/` e só ele. As áreas de MÁQUINA continuam fechadas, e
    // `_templates/` — que está nas duas listas — é o teste que prova que a isenção é por nome.
    await expect(move(from, to)).rejects.toBeInstanceOf(Error);
    expect(await exists(root, '02-wiki/nestjs/auth-guard.md')).toBe(true);
  });

  it('não publica nada quando o destino é inválido', async () => {
    await expect(move('02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/sem-extensao')).rejects.toBeInstanceOf(
      Error,
    );
    expect(await commitsSince(root)).toBe(0);
  });
});

describe('deleteNote', () => {
  let root: string;
  let scanner: VaultScanner;

  beforeEach(async () => {
    ({ root, scanner } = await makeVault());
  });

  afterEach(async () => {
    await removeTree(root);
  });

  const del = (relPath: string, extra: Record<string, unknown> = {}) =>
    deleteNote({ vaultRoot: root, scanner, path: relPath, now: NOW, ...extra });

  /**
   * Uma nota que ninguém aponta, com entrada no MOC do domínio, commitada.
   *
   * A fixture inteira é apontada por alguém — `cache-wrapper` pelo README do potentia,
   * `bullmq-worker` pelo `auth-guard` — que é justamente o que ela existe para exercitar. O
   * caminho feliz do delete precisa da nota que ela não tem, e semeá-la é mais honesto do que
   * apagar com `confirm` e chamar isso de "sem backlinks".
   */
  const DESCARTAVEL = '02-wiki/docker/descartavel.md';

  async function seedDeletable(): Promise<void> {
    await fs.writeFile(
      path.join(root, DESCARTAVEL),
      '---\ntipo: wiki\ntags: [docker]\ncriado: 2026-08-25\n---\n\n# Descartável\n\nUma nota que não interessa a ninguém.\n',
      'utf8',
    );
    // `## Notas` é a última seção do `docker-moc` da fixture, então a entrada nova vai no fim.
    await fs.appendFile(
      path.join(root, '02-wiki/docker/docker-moc.md'),
      '- [[descartavel]] — nota descartável\n',
      'utf8',
    );
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'chore: nota descartável']);
    scanner.refresh();
  }

  it('apaga uma nota sem backlinks, tirando a linha do MOC', async () => {
    await seedDeletable();
    const result = await del(DESCARTAVEL);

    expect(await exists(root, DESCARTAVEL)).toBe(false);
    expect(await read(root, '02-wiki/docker/docker-moc.md')).not.toContain('descartavel');
    expect(result.propagated).toContain('02-wiki/docker/docker-moc.md');
    expect(result.committed).toBe(true);
    expect(await commitsSince(root)).toBe(2);
  });

  it('nomeia o comando exato que desfaz, com o sha do commit recém-feito', async () => {
    await seedDeletable();
    const result = await del(DESCARTAVEL);
    const sha = await git(root, ['rev-parse', 'HEAD']);

    expect(result.undo).toBeDefined();
    expect(result.undo).toContain(sha);
    expect(result.undo).toContain(DESCARTAVEL);

    // E o comando funciona de verdade — é a única forma honesta de afirmar isso.
    await execFileAsync('bash', ['-lc', `${result.undo ?? 'false'}`], { cwd: root });
    expect(await exists(root, DESCARTAVEL)).toBe(true);
  });

  it('recusa uma nota sem blob no HEAD', async () => {
    await fs.writeFile(
      path.join(root, '02-wiki', 'docker', 'nova.md'),
      '---\ntipo: wiki\n---\n\n# Nova\n',
      'utf8',
    );
    scanner.refresh();

    await expect(del('02-wiki/docker/nova.md')).rejects.toBeInstanceOf(RelocateError);
    // A recusa é o valor todo: a nota continua lá.
    expect(await exists(root, '02-wiki/docker/nova.md')).toBe(true);
  });

  it('avisa, sem recusar, quando a nota tem edição não commitada', async () => {
    await seedDeletable();
    await fs.appendFile(path.join(root, DESCARTAVEL), '\nLinha nova ainda não commitada.\n', 'utf8');

    const result = await del(DESCARTAVEL);
    expect(await exists(root, DESCARTAVEL)).toBe(false);
    // A restauração existe e traz a versão COMMITADA — é isso que o aviso diz, e é o que o
    // usuário precisa saber antes de decidir, não depois.
    expect(result.warnings.join(' ')).toMatch(/não commitada/i);
  });

  it.each([
    ['um MOC', '02-wiki/nestjs/nestjs-moc.md'],
    ['a nota diária', '04-daily/2026-08-20.md'],
    ['o índice de conhecimento', '00-index/index-knowledge.md'],
  ])('recusa apagar %s, sem escape', async (_label, relPath) => {
    await expect(del(relPath, { confirm: true })).rejects.toBeInstanceOf(RelocateError);
    expect(await exists(root, relPath)).toBe(true);
  });

  it('o MOC do domínio, sozinho, não obriga a confirmar', async () => {
    // Todo MOC linka toda nota do seu domínio. Contá-lo como backlink tornaria `confirm`
    // obrigatório para QUALQUER nota de `02-wiki/` — uma flag sempre exigida é uma flag que não
    // quer dizer nada, e o usuário aprende a passá-la no automático. E ele não é um link que
    // quebra: esta operação é justamente a que o remove.
    await seedDeletable();
    await del(DESCARTAVEL);
    expect(await exists(root, DESCARTAVEL)).toBe(false);
  });

  it('o MOC volta a obrigar a confirmar quando aponta para a nota fora de ## Notas', async () => {
    // A isenção é medida, não presumida: ela vale só quando o texto resultante do MOC não
    // resolve mais para a nota. Um segundo link, em `## Relacionados`, sobrevive à remoção da
    // entrada — e esse sim vai quebrar.
    await seedDeletable();
    await fs.appendFile(
      path.join(root, '02-wiki/docker/docker-moc.md'),
      '\n## Relacionados\n\n- [[descartavel]] — citada de novo aqui\n',
      'utf8',
    );
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'chore: segundo link']);
    scanner.refresh();

    await expect(del(DESCARTAVEL)).rejects.toBeInstanceOf(RelocateError);
    expect(await exists(root, DESCARTAVEL)).toBe(true);
  });

  it('recusa apagar uma nota com backlinks, listando quem aponta', async () => {
    // `bullmq-worker` é apontada por `auth-guard` e pelo MOC do domínio.
    let message = '';
    try {
      await del('02-wiki/nestjs/bullmq-worker.md');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('02-wiki/nestjs/auth-guard.md');
    expect(await exists(root, '02-wiki/nestjs/bullmq-worker.md')).toBe(true);
  });

  it('apaga com backlinks quando confirmado, deixando os links quebrados', async () => {
    await del('02-wiki/nestjs/bullmq-worker.md', { confirm: true });

    expect(await exists(root, '02-wiki/nestjs/bullmq-worker.md')).toBe(false);
    // Não há para onde reescrever, e o vault já modela link quebrado como cidadão de primeira
    // classe — `vault_get_note` reporta `brokenLinks`. Inventar um destino seria pior.
    const fresh = new VaultScanner({ vaultRoot: root });
    fresh.refresh();
    expect(fresh.getNote('02-wiki/nestjs/auth-guard.md')?.brokenLinks).toContain('bullmq-worker');
  });

  it('recusa apagar dentro de 99-archive/', async () => {
    // A porta que o move abre NÃO é aberta aqui, e é isso que faz `99-archive/` significar
    // "nada é destruído aqui, só entra e sai".
    await expect(del('99-archive/antigo.md', { confirm: true })).rejects.toBeInstanceOf(Error);
    expect(await exists(root, '99-archive/antigo.md')).toBe(true);
  });

  it('não toca na nota diária', async () => {
    await seedDeletable();
    const antes = await read(root, '04-daily/2026-08-20.md');
    await del(DESCARTAVEL);
    expect(await read(root, '04-daily/2026-08-20.md')).toBe(antes);
  });

  it('recusa uma nota que não existe', async () => {
    await expect(del('02-wiki/docker/nao-existe.md')).rejects.toBeInstanceOf(RelocateError);
  });
});
