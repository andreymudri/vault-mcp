import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { editNote } from '../src/write/writer.js';

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
