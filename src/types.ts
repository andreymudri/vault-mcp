/** Parsed frontmatter of a note. Unknown keys are preserved. */
export interface Frontmatter {
  tipo?: string;
  tags?: string[];
  status?: string;
  criado?: string;
  [key: string]: unknown;
}

/** A note as read from disk. `path` is always vault-relative, POSIX separators. */
export interface Note {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  /** Body with the frontmatter block stripped. */
  body: string;
  /** Vault-relative paths this note links to, resolved and existing. */
  links: string[];
  /** Raw link targets that resolved to nothing. */
  brokenLinks: string[];
  /**
   * The 1-based line of the ORIGINAL FILE where `body` starts — i.e. the line right after the
   * closing `---` of the frontmatter block, and `1` for a note without frontmatter.
   *
   * It exists so that `chunkNote` (src/index/chunker.ts) can number chunks against the file the
   * user will open, not against the body it was handed: a citation `caminho:lineStart` that is
   * short by the height of the frontmatter points at the wrong text. CRLF counts the same as LF,
   * a line being what a newline terminates.
   *
   * Required rather than optional on purpose: an optional field would be silently absent at the
   * one call site that matters and the defect it fixes would come back as `?? 1`.
   */
  bodyStartLine: number;
  mtimeMs: number;
}

/** A retrievable unit of a note. */
export interface Chunk {
  /** Stable id: `${path}#${lineStart}`. */
  id: string;
  path: string;
  /** Heading trail, e.g. ['Payload do JWT']. Empty for the pre-heading chunk. */
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  text: string;
  tipo?: string;
  tags: string[];
}

/** One field of a chunk, carrying its BM25 weight. */
export type FieldName = 'heading' | 'tags' | 'prose' | 'code';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  /** True when the chunk entered the result set through graph expansion. */
  viaGraph: boolean;
  /**
   * True when `chunk.text` was cut to fit the character budget, so what is carried here is a
   * prefix of the chunk and not the chunk.
   *
   * Absent means "not cut" — nothing sets it to `false`. It is the structured half of the signal
   * whose visible half is `TRUNCATION_MARKER` (src/retrieval/budget.ts): that marker is ordinary
   * text, so a note whose body contains it verbatim reads as truncated to any consumer matching
   * on it, and a genuine cut is indistinguishable from that. This flag is set by comparing the
   * budgeted chunk against the chunk the index holds, never by looking at the text.
   */
  truncated?: boolean;
}

export interface SearchResult {
  results: ScoredChunk[];
  /** Populated only when `results` is empty. */
  suggestions?: string[];
}

export interface Diagnostic {
  path: string;
  message: string;
  /**
   * Chave em `messages.errorCodes`, e o mesmo mecanismo que `src/i18n/errors.ts` dá aos erros da
   * escrita, pela mesma razão: um diagnóstico NASCE no scanner e no parser de frontmatter, que
   * não têm catálogo de idioma nenhum e não deveriam ter. Ausente = relatado como veio.
   */
  code?: string;
  /** Valores para os `{placeholders}` do template. */
  params?: Readonly<Record<string, string | number>>;
}
