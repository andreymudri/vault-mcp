import type { Chunk } from '../types.js';

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{2,3})\s+(.*)$/;

/**
 * Divide o corpo de uma nota em chunks delimitados por headings `##`/`###`,
 * respeitando blocos de código cercados (fenced code blocks): um heading que
 * aparece dentro de uma cerca não abre um novo chunk.
 *
 * `bodyStartLine` é a linha (1-based) do arquivo original onde `body` começa,
 * de forma que `lineStart`/`lineEnd` de cada chunk apontem para o arquivo
 * original e não para o início de `body`.
 */
export function chunkNote(
  path: string,
  body: string,
  tipo: string | undefined,
  tags: string[],
  bodyStartLine: number,
): Chunk[] {
  const lines = body.split('\n');
  const chunks: Chunk[] = [];

  let inFence = false;
  let headingPath: string[] = [];
  let currentLines: string[] = [];
  let currentStartLine = bodyStartLine;

  const flush = (endLine: number): void => {
    const text = currentLines.join('\n');
    if (text.trim().length === 0) {
      return;
    }
    chunks.push({
      id: `${path}#${currentStartLine}`,
      path,
      headingPath: [...headingPath],
      lineStart: currentStartLine,
      lineEnd: endLine,
      text,
      tipo,
      tags,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const originalLine = bodyStartLine + i;

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    }

    if (!inFence) {
      const match = HEADING_RE.exec(line);
      if (match) {
        // Close the chunk that was accumulating before this heading.
        flush(originalLine - 1);

        const marker = match[1] ?? '';
        const headingText = (match[2] ?? '').trim();
        if (marker.length === 2) {
          // `##` replaces level 1 and clears level 2.
          headingPath = [headingText];
        } else {
          // `###` pushes onto level 2, keeping level 1 if present.
          headingPath = [...headingPath.slice(0, 1), headingText];
        }

        currentLines = [line];
        currentStartLine = originalLine;
        continue;
      }
    }

    currentLines.push(line);
  }

  flush(bodyStartLine + lines.length - 1);

  return chunks;
}

/**
 * Separa o texto de um chunk em prosa e código: linhas dentro de blocos
 * cercados vão para `code`, o resto para `prose`. Não preenche `heading` nem
 * `tags` — quem chama é responsável por isso, a partir de `headingPath` e das
 * tags da nota.
 */
export function splitFields(text: string): { prose: string; code: string } {
  const lines = text.split('\n');
  const prose: string[] = [];
  const code: string[] = [];

  let inFence = false;
  for (const line of lines) {
    const isFenceMarker = FENCE_RE.test(line);
    if (isFenceMarker) {
      inFence = !inFence;
      code.push(line);
      continue;
    }
    if (inFence) {
      code.push(line);
    } else {
      prose.push(line);
    }
  }

  return { prose: prose.join('\n'), code: code.join('\n') };
}
