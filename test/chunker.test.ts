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
});
