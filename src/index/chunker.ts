import type { Chunk } from '../types.js';

// CommonMark fenced code block rule (matches src/vault/links.ts): the opening
// fence may be indented at most 3 spaces, and needs 3-or-more backticks or
// tildes. Deeper indentation (4+ spaces) is an indented code block, not a
// fence, and must not toggle fence state.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING_RE = /^(#{2,3})\s+(.*)$/;

/**
 * `FENCE_RE`/`HEADING_RE` use `.` and anchor with `$`, and `.` does not match
 * `\r` in JavaScript. A CRLF-terminated line (common in notes authored on
 * Windows, or content clipped into `01-raw/clippings/`) therefore fails to
 * match either regex even though it is, semantically, an ordinary fence or
 * heading line followed by a line ending. Strip a trailing `\r` before
 * matching so CRLF and LF lines are treated identically; the `\r` itself is
 * left untouched in the line as stored in chunks/output, only the matching
 * is affected.
 */
function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Tracks the state of a fenced code block across a sequence of lines: which
 * delimiter character opened it (if any) and how long the opening run was.
 * `char === null` means "not currently inside a fence".
 */
interface FenceTracker {
  char: string | null;
  length: number;
}

/**
 * Feeds one line into a fence tracker, mutating it in place when the line
 * opens or closes a fence per the CommonMark rule:
 *  - opening: 0-3 leading spaces, then 3+ of the same delimiter char
 *    (backtick or tilde); an info string after it is allowed.
 *  - closing: same delimiter char as the opener, a run at least as long,
 *    and nothing but whitespace after it (no info string).
 * A line that merely looks fence-like (e.g. a shorter run, the wrong
 * character, or a trailing info string) while already inside a fence does
 * not close it — it is just content.
 */
function feedFenceTracker(line: string, tracker: FenceTracker): void {
  const match = FENCE_RE.exec(stripTrailingCR(line));
  if (!match) {
    return;
  }
  const marker = match[1] ?? '';
  const info = match[2] ?? '';
  const char = marker[0] ?? '';
  const length = marker.length;

  if (tracker.char === null) {
    tracker.char = char;
    tracker.length = length;
    return;
  }

  // CommonMark: a closing fence permits nothing but whitespace after the
  // delimiter run — no info string. "Whitespace" here means spaces and tabs
  // only (this is what makes a fence a *closing* fence rather than content),
  // matching src/vault/links.ts. `String.trim()` is too lenient: it also
  // strips NBSP, form feed, vertical tab and other Unicode space
  // separators, which would wrongly let e.g. "```  " close a fence.
  if (char === tracker.char && length >= tracker.length && /^[ \t]*$/.test(info)) {
    tracker.char = null;
    tracker.length = 0;
  }
}

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
  // `body.split('\n')` leaves a phantom trailing empty element whenever
  // `body` ends in a newline — there is no real line of text after that
  // final newline. Cap the loop before it so that element is never treated
  // as content (never toggles a fence, never opens a heading, never gets
  // pushed into a chunk's text) and never counted toward `lineEnd`.
  const realLineCount = body.endsWith('\n') ? lines.length - 1 : lines.length;
  const chunks: Chunk[] = [];

  const fence: FenceTracker = { char: null, length: 0 };
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

  for (let i = 0; i < realLineCount; i++) {
    const line = lines[i] ?? '';
    const originalLine = bodyStartLine + i;

    feedFenceTracker(line, fence);

    if (fence.char === null) {
      const match = HEADING_RE.exec(stripTrailingCR(line));
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

  flush(bodyStartLine + realLineCount - 1);

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

  const fence: FenceTracker = { char: null, length: 0 };
  for (const line of lines) {
    const wasInFence = fence.char !== null;
    feedFenceTracker(line, fence);
    const isInFence = fence.char !== null;

    if (wasInFence || isInFence) {
      // The fence delimiter line itself (open or close) is code, and so is
      // everything between them.
      code.push(line);
    } else {
      prose.push(line);
    }
  }

  return { prose: prose.join('\n'), code: code.join('\n') };
}
