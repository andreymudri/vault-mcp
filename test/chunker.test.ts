import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkNote, splitFields } from '../src/index/chunker.js';

const FIXTURE_ROOT = join(__dirname, 'fixtures/vault');

/**
 * Divide um arquivo bruto em frontmatter + corpo por linha, sem depender do
 * parser de frontmatter (isso é responsabilidade de outra tarefa). Devolve o
 * corpo e a linha (1-based) do arquivo original onde ele começa, exatamente
 * como `chunkNote` espera receber.
 */
function splitFrontmatter(raw: string): { body: string; bodyStartLine: number } {
  const lines = raw.split('\n');
  if (lines[0] !== '---') {
    return { body: raw, bodyStartLine: 1 };
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return { body: raw, bodyStartLine: 1 };
  }
  const bodyStartLine = closeIndex + 2;
  const body = lines.slice(bodyStartLine - 1).join('\n');
  return { body, bodyStartLine };
}

function loadFixture(relPath: string): { raw: string; body: string; bodyStartLine: number } {
  const raw = readFileSync(join(FIXTURE_ROOT, relPath), 'utf-8');
  const { body, bodyStartLine } = splitFrontmatter(raw);
  return { raw, body, bodyStartLine };
}

/**
 * Conta as linhas reais de um arquivo SEM o elemento fantasma que
 * `raw.split('\n')` produz quando o arquivo termina em newline. Contamos as
 * ocorrências de `\n` e só somamos 1 quando o arquivo NÃO termina em
 * newline (a última linha, sem terminador, ainda conta como linha).
 * Deliberadamente não usa `raw.split('\n').length`, que reproduziria o
 * próprio bug que este teste existe para detectar.
 */
function trueLineCount(raw: string): number {
  const newlineCount = (raw.match(/\n/g) ?? []).length;
  return raw.endsWith('\n') ? newlineCount : newlineCount + 1;
}

// Todas as notas da fixture, exceto `_templates/`, que não é varrida em
// produção (ver scanner). Chunkar todas confirma a contagem total medida de
// 33 chunks e dá cobertura de fidelidade de linha além de um único arquivo.
const ALL_FIXTURE_NOTES = [
  '00-index/index-knowledge.md',
  '01-raw/inbox/rascunho.md',
  '02-wiki/docker/docker-moc.md',
  '02-wiki/docker/multi-stage.md',
  '02-wiki/nestjs/auth-guard.md',
  '02-wiki/nestjs/bullmq-worker.md',
  '02-wiki/nestjs/nestjs-moc.md',
  '02-wiki/patterns/cache-wrapper.md',
  '03-projects/potentia/README.md',
  '04-daily/2026-08-20.md',
  '99-archive/antigo.md',
  'CLAUDE.md',
  'quebrada.md',
];

const BULLMQ_PATH = '02-wiki/nestjs/bullmq-worker.md';

describe('chunkNote', () => {
  it('produz exatamente 4 chunks para bullmq-worker.md, respeitando a cerca de código', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    expect(chunks).toHaveLength(4);
  });

  it('não abre chunk para um heading cercado dentro de bloco de código', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    for (const chunk of chunks) {
      expect(chunk.headingPath).not.toContain('nao e um heading');
    }
    expect(chunks.some((c) => c.text.includes('## nao e um heading'))).toBe(true);
  });

  it('regride para 5 chunks bogus se o rastreio de inFence for removido (documentação da propriedade)', () => {
    // Este teste não pode exercitar diretamente uma versão "quebrada" do
    // chunker (ele testa o módulo real), mas registra o comportamento
    // esperado da versão correta para servir de contraste: comentar a linha
    // `inFence = !inFence;` em src/index/chunker.ts e rodar esta suíte faz
    // o teste anterior ("produz exatamente 4 chunks...") falhar, porque a
    // cerca deixa de ser rastreada e "## nao e um heading" (dentro do bloco
    // de código, linha 54) passa a abrir um 5º chunk bogus com
    // headingPath: ["nao e um heading"]. Isso foi verificado manualmente
    // durante o desenvolvimento deste teste, comentando a linha e observando
    // o teste anterior falhar pela razão certa.
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);
    expect(chunks).toHaveLength(4);
  });

  it('nenhum chunk começa ou termina dentro do bloco de código cercado', () => {
    const { raw, body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const rawLines = raw.split('\n');
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    // A cerca do exemplo de código ocupa as linhas 20 a 60 do arquivo
    // original (```typescript ... ```), incluindo o heading falso na 54.
    const fenceStart = rawLines.findIndex((l) => l.trim().startsWith('```typescript')) + 1;
    const fenceEnd =
      rawLines.findIndex((l, i) => i + 1 > fenceStart && l.trim() === '```') + 1;
    expect(fenceStart).toBeGreaterThan(0);
    expect(fenceEnd).toBeGreaterThan(fenceStart);

    for (const chunk of chunks) {
      const startsInsideFence = chunk.lineStart > fenceStart && chunk.lineStart < fenceEnd;
      const endsInsideFence = chunk.lineEnd > fenceStart && chunk.lineEnd < fenceEnd;
      expect(startsInsideFence).toBe(false);
      expect(endsInsideFence).toBe(false);
    }
  });

  it('lineStart/lineEnd de todo chunk correspondem às linhas reais do arquivo original', () => {
    const { raw, body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const rawLines = raw.split('\n');
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const resliced = rawLines.slice(chunk.lineStart - 1, chunk.lineEnd).join('\n');
      expect(resliced).toBe(chunk.text);
    }
  });

  it('linha de fidelidade vale para todos os 33 chunks da fixture inteira (exceto _templates/)', () => {
    let total = 0;
    for (const relPath of ALL_FIXTURE_NOTES) {
      const { raw, body, bodyStartLine } = loadFixture(relPath);
      const rawLines = raw.split('\n');
      const chunks = chunkNote(relPath, body, undefined, [], bodyStartLine);
      total += chunks.length;

      for (const chunk of chunks) {
        const resliced = rawLines.slice(chunk.lineStart - 1, chunk.lineEnd).join('\n');
        expect(resliced).toBe(chunk.text);
      }
    }
    expect(total).toBe(33);
  });

  it('lineEnd de nenhum chunk ultrapassa a última linha real do arquivo (mesmo quando o corpo termina em newline)', () => {
    // `body.split('\n')` deixa um elemento fantasma quando `body` termina em
    // newline; se o chunker o contar como linha real, o último chunk aponta
    // para uma linha que não existe no arquivo (ex.: lineEnd 63 num arquivo
    // de 62 linhas). `trueLineCount` deriva o total sem esse fantasma, então
    // esta asserção não pode "passar por acidente" como a de fidelidade
    // acima (que resliça com o mesmo `split('\n')` e por isso carrega o
    // mesmo fantasma dos dois lados da comparação).
    for (const relPath of ALL_FIXTURE_NOTES) {
      const { raw, body, bodyStartLine } = loadFixture(relPath);
      const chunks = chunkNote(relPath, body, undefined, [], bodyStartLine);
      const maxLine = trueLineCount(raw);

      for (const chunk of chunks) {
        expect(chunk.lineEnd).toBeLessThanOrEqual(maxLine);
      }
    }
  });

  it('corpo anterior ao primeiro heading vira um chunk com headingPath vazio', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    expect(chunks[0]?.headingPath).toEqual([]);
    expect(chunks[0]?.text).toContain('# BullMQ Worker');
  });

  it('um heading ### aninhado sob um ## produz headingPath de dois elementos', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    const nested = chunks.find((c) => c.headingPath.length === 2);
    expect(nested?.headingPath).toEqual(['Contexto', 'Retry e backoff']);
  });

  it('## substitui o nível 1 e limpa o nível 2', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    const exemplo = chunks.find((c) => c.text.startsWith('## Exemplo'));
    expect(exemplo?.headingPath).toEqual(['Exemplo']);
  });

  it('detecta heading mesmo com terminador de linha CRLF', () => {
    // `HEADING_RE` usa `.` e ancora com `$`; `.` não casa `\r` em
    // JavaScript, então uma linha terminada em CRLF (comum em notas
    // escritas no Windows, ou conteúdo colado em `01-raw/clippings/`) falha
    // o match inteiro se o `\r` não for removido antes. Esse defeito já
    // existia antes da adoção da regra CommonMark de cerca — não é uma
    // regressão desta rodada, mas ficou sem teste até agora.
    const body = '## Titulo\r\n\r\nConteudo da secao.\r\n';
    const chunks = chunkNote('crlf-heading.md', body, undefined, [], 1);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(['Titulo']);
  });

  it('id tem a forma ${path}#${lineStart}', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    for (const chunk of chunks) {
      expect(chunk.id).toBe(`${BULLMQ_PATH}#${chunk.lineStart}`);
    }
  });

  it('descarta chunks cujo texto é só espaço em branco', () => {
    // Uma nota cujo corpo é inteiramente headings seguidos de nada (sem
    // conteúdo entre eles) não deve produzir chunks vazios.
    const body = '## Vazio\n\n## OutroVazio\n   \n';
    const chunks = chunkNote('sintetico.md', body, undefined, [], 1);

    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('um heading dentro de uma cerca de til não abre um novo chunk', () => {
    // Cerca de til é o que uma nota usa quando o próprio exemplo contém
    // crases — plausível num vault sobre ferramentas de desenvolvedor.
    // Deletar `~{3,}` de FENCE_RE passa em todos os outros testes; só este
    // caso concreto (heading disfarçado dentro da cerca de til) expõe a
    // falta de cobertura.
    const body = [
      '## Real',
      '',
      '~~~ts',
      'const a = 1;',
      '## nao e heading',
      'const b = 2;',
      '~~~',
      '',
      'fim',
      '',
    ].join('\n');
    const chunks = chunkNote('tilde-fence.md', body, undefined, [], 1);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(['Real']);
    expect(chunks.some((c) => c.headingPath.includes('nao e heading'))).toBe(false);
  });

  it('propaga tipo e tags para cada chunk gerado', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);

    for (const chunk of chunks) {
      expect(chunk.tipo).toBe('wiki');
      expect(chunk.tags).toEqual(['nestjs', 'bullmq', 'filas']);
    }
  });
});

describe('splitFields', () => {
  it('separa linhas de prosa e de código de acordo com a cerca', () => {
    const text = ['Uma frase de prosa.', '```ts', 'const x = 1;', '```', 'Outra frase.'].join(
      '\n',
    );

    const { prose, code } = splitFields(text);

    expect(prose).toContain('Uma frase de prosa.');
    expect(prose).toContain('Outra frase.');
    expect(prose).not.toContain('const x = 1;');
    expect(code).toContain('const x = 1;');
    expect(code).not.toContain('Uma frase de prosa.');
  });

  it('não preenche heading nem tags — devolve apenas prose e code', () => {
    const { prose, code } = splitFields('texto qualquer');
    const result = { prose, code };
    expect(Object.keys(result).sort()).toEqual(['code', 'prose']);
  });

  it('texto sem cerca vai inteiro para prose e code fica vazio', () => {
    const { prose, code } = splitFields('linha 1\nlinha 2');
    expect(prose).toBe('linha 1\nlinha 2');
    expect(code).toBe('');
  });

  it('extrai corretamente o bloco de código real do exemplo de bullmq-worker.md', () => {
    const { body, bodyStartLine } = loadFixture(BULLMQ_PATH);
    const chunks = chunkNote(BULLMQ_PATH, body, 'wiki', ['nestjs', 'bullmq', 'filas'], bodyStartLine);
    const exemplo = chunks.find((c) => c.text.startsWith('## Exemplo'));
    expect(exemplo).toBeDefined();

    const { prose, code } = splitFields(exemplo!.text);

    expect(code).toContain("import { Worker, Queue, Job } from 'bullmq';");
    expect(code).toContain('## nao e um heading');
    expect(prose).not.toContain("import { Worker, Queue, Job } from 'bullmq';");
    expect(prose).toContain('Depois da cerca');
  });

  // As quatro provas abaixo travam a regra CommonMark que src/vault/links.ts
  // já seguia (`/^ {0,3}(`{3,}|~{3,})/`): indentação de até 3 espaços abre
  // cerca, 4+ é bloco indentado comum; e o fechamento exige o mesmo
  // caractere, um comprimento >= o de abertura, e nenhuma info string.

  it('``` indentado com 4 espaços NÃO é tratado como cerca', () => {
    const text = ['Prosa antes.', '    ```', 'Prosa depois.'].join('\n');

    const { prose, code } = splitFields(text);

    // Se a linha indentada abrisse (erradamente) uma cerca, tudo depois dela
    // — sem um fechamento real — cairia em `code`.
    expect(code).toBe('');
    expect(prose).toContain('    ```');
    expect(prose).toContain('Prosa depois.');
  });

  it('``` indentado com 3 espaços É tratado como cerca', () => {
    const text = ['Prosa antes.', '   ```', 'codigo aqui', '   ```', 'Prosa depois.'].join('\n');

    const { prose, code } = splitFields(text);

    expect(code).toContain('codigo aqui');
    expect(prose).not.toContain('codigo aqui');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('cerca de 4 crases não é fechada por apenas 3', () => {
    const text = [
      'Prosa antes.',
      '````',
      'conteudo linha 1',
      '```',
      'conteudo linha 2',
      '````',
      'Prosa depois.',
    ].join('\n');

    const { prose, code } = splitFields(text);

    // A linha de 3 crases no meio não fecha a cerca de 4: continua dentro
    // do bloco, junto com o conteúdo em volta dela.
    expect(code).toContain('conteudo linha 1');
    expect(code).toContain('conteudo linha 2');
    expect(code).toContain('```');
    expect(prose).not.toContain('conteudo linha 1');
    expect(prose).not.toContain('conteudo linha 2');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('cerca de crases não é fechada por til', () => {
    const text = ['Prosa antes.', '```', 'conteudo', '~~~', 'mais conteudo', '```', 'Prosa depois.'].join(
      '\n',
    );

    const { prose, code } = splitFields(text);

    // `~~~` não fecha uma cerca aberta com crase: permanece dentro do
    // bloco como conteúdo comum, e só o `` ``` `` seguinte fecha a cerca.
    expect(code).toContain('conteudo');
    expect(code).toContain('~~~');
    expect(code).toContain('mais conteudo');
    expect(prose).not.toContain('conteudo');
    expect(prose).not.toContain('mais conteudo');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('detecta cerca de crase mesmo com terminador de linha CRLF', () => {
    // Verificado: antes da correção, isto caía inteiro em `prose` com
    // `code` vazio; `FENCE_RE` usa `.` e ancora com `$`, e `.` não casa
    // `\r`. Notas escritas no Windows e conteúdo colado em
    // `01-raw/clippings/` costumam ter CRLF; sem isso, o campo `code`
    // (usado pela Task 7 para peso de busca) nunca dispara nessas notas.
    const text = '```bash\r\ndocker build .\r\n```\r\n';

    const { prose, code } = splitFields(text);

    expect(code).toContain('docker build .');
    expect(prose).not.toContain('docker build .');
  });

  it('cerca de til abre e fecha corretamente', () => {
    const text = ['Prosa antes.', '~~~ts', 'const a = 1;', '~~~', 'Prosa depois.'].join('\n');

    const { prose, code } = splitFields(text);

    expect(code).toContain('const a = 1;');
    expect(prose).not.toContain('const a = 1;');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('cerca de til não é fechada por crase', () => {
    const text = ['Prosa antes.', '~~~', 'conteudo', '```', 'mais conteudo', '~~~', 'Prosa depois.'].join(
      '\n',
    );

    const { prose, code } = splitFields(text);

    // Espelho do teste "cerca de crases não é fechada por til": o
    // caractere de fechamento tem que casar com o de abertura.
    expect(code).toContain('conteudo');
    expect(code).toContain('```');
    expect(code).toContain('mais conteudo');
    expect(prose).not.toContain('conteudo');
    expect(prose).not.toContain('mais conteudo');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('uma linha de cerca com info string não fecha a cerca aberta', () => {
    // Verificado: remover a cláusula `info === ''` do fechamento passa em
    // todos os outros testes. Sob a mutação, a linha "``` bash" (que tem
    // uma info string, então não é um fechamento válido) fecha a cerca de
    // qualquer forma: código vaza para `prose` e prosa vaza para `code`.
    const text = ['Prosa antes.', '```', 'exemplo:', '``` bash', 'npm test', '```', 'Prosa depois.'].join(
      '\n',
    );

    const { prose, code } = splitFields(text);

    expect(code).toContain('exemplo:');
    expect(code).toContain('``` bash');
    expect(code).toContain('npm test');
    expect(prose).not.toContain('exemplo:');
    expect(prose).not.toContain('npm test');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });

  it('só espaço e tab podem seguir a cerca de fechamento — NBSP não fecha', () => {
    // CommonMark exige que só espaços e tabs sigam a cerca de fechamento;
    // `links.ts` compara a info string a `''` exatamente. Usar
    // `String.trim()` diverge disso porque também remove NBSP, form feed e
    // vertical tab, tratando-os (erradamente) como fechamento válido.
    const text = [
      'Prosa antes.',
      '```',
      'conteudo',
      '``` ',
      'ainda dentro da cerca',
      '```',
      'Prosa depois.',
    ].join('\n');

    const { prose, code } = splitFields(text);

    expect(code).toContain('conteudo');
    expect(code).toContain('ainda dentro da cerca');
    expect(prose).not.toContain('ainda dentro da cerca');
    expect(prose).toContain('Prosa antes.');
    expect(prose).toContain('Prosa depois.');
  });
});
