import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { editNote } from '../src/write/writer.js';
import { Retriever } from '../src/retrieval/retrieval.js';
import { VaultScanner } from '../src/vault/scanner.js';
import { insertUnderSection } from '../src/write/propagate.js';

/**
 * Um vault com terminadores CRLF é uma forma SUPORTADA, não um acidente a tolerar.
 *
 * O Obsidian é majoritariamente Windows, e um vault criado ou editado lá tem notas com `\r\n`.
 * Nada aqui depende de um arquivo de fixture: o conteúdo é construído em memória com `\r\n`
 * explícito, porque um fixture no disco tem o terminador que a configuração de git de quem
 * clonou resolveu dar a ele (é exatamente o que `.gitattributes` existe para fixar) e um teste
 * de terminador não pode ter o terminador como variável de ambiente.
 */

const trash: string[] = [];

afterEach(async () => {
  for (const dir of trash.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function makeVaultWith(rel: string, content: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-crlf-'));
  trash.push(tmp);
  const vaultRoot = path.join(tmp, 'vault');
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return vaultRoot;
}

describe('vault_edit_note sobre uma nota CRLF', () => {
  const REL = '02-wiki/docker/multi-stage.md';
  const CRLF = ['---', 'tipo: wiki', '---', '', '# Multi-stage', '', 'Primeira linha.', 'Segunda linha.', ''].join('\r\n');

  it('casa um trecho de várias linhas escrito com LF', async () => {
    // O trecho chega assim na vida real: o agente copia o que `vault_search` mostrou, e o
    // snippet da busca tem o `\r` REMOVIDO (é o que o teste "o trecho de uma nota com CRLF não
    // mostra \r no fim de cada linha" garante). Com casamento por substring exata, esse trecho
    // não existe no arquivo, e a edição morre com "trecho não encontrado" numa nota que o
    // usuário está VENDO na tela.
    const vaultRoot = await makeVaultWith(REL, CRLF);

    const result = await editNote({
      vaultRoot,
      path: REL,
      oldText: 'Primeira linha.\nSegunda linha.',
      newText: 'Primeira linha.\nLinha do meio.\nSegunda linha.',
      deferCommit: true,
    });

    expect(result.created).toBe(false);
    const after = await fs.readFile(path.join(vaultRoot, REL), 'utf8');
    expect(after).toContain('Linha do meio.');
  });
});

describe('vault_edit_note preserva o terminador da nota', () => {
  const REL = '02-wiki/docker/multi-stage.md';
  const CRLF = ['---', 'tipo: wiki', '---', '', '# Multi-stage', '', 'Primeira linha.', 'Segunda linha.', ''].join('\r\n');

  it('grava a linha inserida com CRLF, e não deixa a nota com terminador misto', async () => {
    // Casar ignorando o terminador resolve a ENTRADA. A saída é a outra metade: escrever o
    // `newText` do agente com `\n` cru dentro de um arquivo CRLF deixa a nota com as duas
    // formas ao mesmo tempo. Quem paga isso é o usuário, e não este servidor — o Obsidian
    // reserializa, o git marca o arquivo inteiro como alterado, e o diff da próxima escrita
    // vira ruído em cima de uma nota que ninguém tocou.
    const vaultRoot = await makeVaultWith(REL, CRLF);

    await editNote({
      vaultRoot,
      path: REL,
      oldText: 'Primeira linha.\nSegunda linha.',
      newText: 'Primeira linha.\nLinha do meio.\nSegunda linha.',
      deferCommit: true,
    });

    const after = await fs.readFile(path.join(vaultRoot, REL), 'utf8');
    expect(after).toContain('Primeira linha.\r\nLinha do meio.\r\nSegunda linha.');
    // Nenhum `\n` solto: todo `\n` do arquivo tem um `\r` na frente.
    const soltos = [...after.matchAll(/(^|[^\r])\n/g)];
    expect(soltos).toEqual([]);
  });
});

describe('leitura de uma nota CRLF', () => {
  const REL = '02-wiki/docker/crlf-nota.md';
  /** Frontmatter, um H1, um H2 e prosa — tudo com `\r\n`, como o editor de Windows grava. */
  const CRLF = [
    '---',
    'tipo: wiki',
    'tags: [docker]',
    '---',
    '',
    '# Crlf Nota',
    '',
    'Prosa de abertura com zzalvocrlf dentro.',
    '',
    '## Detalhe',
    '',
    'Aponta para [[multi-stage]].',
    '',
  ].join('\r\n');

  async function harness(): Promise<{ vaultRoot: string; scanner: VaultScanner; retriever: Retriever }> {
    const vaultRoot = await makeVaultWith(REL, CRLF);
    await fs.writeFile(path.join(path.dirname(path.join(vaultRoot, REL)), 'multi-stage.md'),
      '---\ntipo: wiki\n---\n\n# Multi Stage\n\nCorpo.\n', 'utf8');
    const scanner = new VaultScanner({ vaultRoot });
    const retriever = new Retriever({ scanner });
    return { vaultRoot, scanner, retriever };
  }

  it('o intervalo anunciado reslicia exatamente o arquivo bruto', async () => {
    const { vaultRoot, retriever } = await harness();
    const { results } = retriever.search({ query: 'zzalvocrlf' });
    expect(results.length).toBeGreaterThan(0);
    const hit = results[0]!.chunk;

    // O mesmo invariante que a suíte já exige da fixture LF, agora sobre um arquivo CRLF: o
    // intervalo `[lineStart, lineEnd]` tem de reslicir BYTE A BYTE o texto do chunk. É a única
    // checagem que um deslocamento consistente-porém-errado não consegue satisfazer, e é o que
    // sustenta a promessa de `caminho:linha` na resposta da busca.
    const raw = await fs.readFile(path.join(vaultRoot, REL), 'utf8');
    const linhas = raw.split('\n');
    expect(linhas.slice(hit.lineStart - 1, hit.lineEnd).join('\n')).toBe(hit.text);
    expect(hit.text).toContain('zzalvocrlf');
  });

  it('a trilha de headings não carrega o \\r do terminador', async () => {
    const { retriever } = await harness();
    // `## Detalhe` é a seção; o H1 fica FORA da trilha por desenho (`HEADING_RE` começa em `##`,
    // porque o H1 é o título da nota). O que este teste vigia é o `\r`: sem removê-lo, a trilha
    // vira `Detalhe\r` e vaza um caractere de controle para dentro da resposta da tool.
    const { results } = retriever.search({ query: 'multi-stage aponta' });
    const comTrilha = results.map((r) => r.chunk).filter((c) => c.headingPath.length > 0);
    expect(comTrilha.length).toBeGreaterThan(0);
    for (const chunk of comTrilha) {
      for (const heading of chunk.headingPath) expect(heading).not.toContain('\r');
    }
    expect(comTrilha.some((c) => c.headingPath.includes('Detalhe'))).toBe(true);
  });

  it('o wiki-link é extraído e resolvido', async () => {
    const { scanner } = await harness();
    scanner.refresh();
    const nota = scanner.getNote(REL);
    expect(nota?.links).toContain('02-wiki/docker/multi-stage.md');
    expect(nota?.brokenLinks).toEqual([]);
  });

  it('o frontmatter é lido igual ao de uma nota LF', async () => {
    const { scanner } = await harness();
    scanner.refresh();
    const nota = scanner.getNote(REL);
    expect(nota?.frontmatter['tipo']).toBe('wiki');
    expect(nota?.frontmatter['tags']).toEqual(['docker']);
  });
});

describe('propagação para um MOC CRLF', () => {
  const MOC = ['# Docker MOC', '', '## Notas', '', '- [[multi-stage]] — build em estágios', '', '## Links', '', ''].join('\r\n');

  it('insere o item com CRLF, sem deixar a nota mista', () => {
    const depois = insertUnderSection(MOC, '## Notas', '- [[crlf-nota]] — uma nota de Windows');

    expect(depois).toContain('- [[crlf-nota]] — uma nota de Windows\r\n');
    const soltos = [...depois.matchAll(/(^|[^\r])\n/g)];
    expect(soltos).toEqual([]);
  });

  it('é idempotente byte a byte: capturar de novo não duplica a entrada', () => {
    // A promessa que impede o MOC de crescer uma linha repetida a cada `vault_learn` do mesmo
    // assunto. Num arquivo CRLF ela só vale se a comparação enxergar a linha JÁ inserida como
    // igual à que está sendo inserida — o `\r` é exatamente o que faria as duas divergirem.
    const uma = insertUnderSection(MOC, '## Notas', '- [[crlf-nota]] — uma nota de Windows');
    const duas = insertUnderSection(uma, '## Notas', '- [[crlf-nota]] — uma nota de Windows');
    expect(duas).toBe(uma);
  });

  it('cria a seção ausente já com o terminador do arquivo', () => {
    const depois = insertUnderSection(MOC, '## Inexistente', '- [[crlf-nota]] — item novo');
    expect(depois).toContain('## Inexistente\r\n');
    const soltos = [...depois.matchAll(/(^|[^\r])\n/g)];
    expect(soltos).toEqual([]);
  });
});
