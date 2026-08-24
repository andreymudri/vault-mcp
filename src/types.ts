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
}

export interface SearchResult {
  results: ScoredChunk[];
  /** Populated only when `results` is empty. */
  suggestions?: string[];
}

export interface Diagnostic {
  path: string;
  message: string;
}
