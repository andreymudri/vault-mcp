import matter from 'gray-matter';

import type { Frontmatter } from '../types.js';

/** Thrown when a template carries a Templater expression this module cannot resolve. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface TemplateContext {
  title: string;
  now: Date;
}

/** `<% ... %>`, tolerating any amount of whitespace inside the delimiters. */
const TOKEN_RE = /<%\s*(.+?)\s*%>/g;

/** `tp.date.now("FMT")`, single or double quoted. */
const DATE_NOW_RE = /^tp\.date\.now\(\s*(['"])([\s\S]*?)\1\s*\)$/;

const FORMAT_TOKEN_RE = /YYYY|MM|DD|HH|mm/g;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Formats `d` in the machine's LOCAL timezone, supporting `YYYY`, `MM`, `DD`,
 * `HH` and `mm`.
 *
 * Local, deliberately — and the opposite of what `vault/frontmatter.ts` does.
 * The two date conversions in this system are asymmetric because their inputs
 * are: a YAML frontmatter date is built by js-yaml at UTC midnight and carries
 * no timezone, so it is read back with `toISOString()`; the `Date` reaching this
 * function is a real wall-clock instant. Formatting it in UTC would make a
 * `vault_learn` at 22:00 in São Paulo (UTC−3) write its capture into the NEXT
 * day's daily note, carrying a 22:00 timestamp inside it.
 *
 * `write/propagate.ts` and `write/learn.ts` must reuse this rather than
 * reimplementing date formatting.
 */
export function formatLocal(d: Date, fmt: string): string {
  const values: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  };
  return fmt.replace(FORMAT_TOKEN_RE, (token) => values[token] ?? token);
}

/**
 * Replaces the Templater tokens of `templateText`.
 *
 * Supports `tp.file.title` and `tp.date.now("FMT")`. Any other expression throws
 * `TemplateError` naming it: failing loud is the point, since an unsubstituted
 * `<% %>` token written into the vault is exactly the bug this module exists to
 * prevent.
 */
export function applyTemplate(templateText: string, ctx: TemplateContext): string {
  return templateText.replace(TOKEN_RE, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();

    if (expr === 'tp.file.title') return ctx.title;

    const dateMatch = DATE_NOW_RE.exec(expr);
    if (dateMatch) return formatLocal(ctx.now, dateMatch[2] ?? '');

    throw new TemplateError(`expressão Templater não suportada: <% ${expr} %>`);
  });
}

/** True when the parsed YAML value counts as "not filled in". */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const NEEDS_QUOTES_RE =
  /^$|^\s|\s$|:\s|:$|^[-?:,[\]{}#&*!|>'"%@`]|\s#|^(?:true|false|null|yes|no|on|off|~)$/i;

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return "''";
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (NEEDS_QUOTES_RE.test(text)) return JSON.stringify(text);
  return text;
}

/** `tags` and any other list serialise in flow style, matching the vault's style. */
function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeScalar(item)).join(', ')}]`;
  }
  return serializeScalar(value);
}

function serializeEntry(key: string, value: unknown): string {
  return `${key}: ${serializeValue(value)}`;
}

interface SplitContent {
  /** Raw lines of the frontmatter block, delimiters excluded. */
  block: string[];
  /** Everything after the closing delimiter, verbatim. */
  body: string;
}

function splitFrontmatter(content: string): SplitContent | undefined {
  const lines = content.split('\n');
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') return undefined;

  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      return { block: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
    }
  }
  return undefined;
}

function parseBlock(block: string[]): Frontmatter {
  try {
    const parsed = matter(`---\n${block.join('\n')}\n---\n`);
    return parsed.data as Frontmatter;
  } catch {
    // Malformed YAML: treat every required key as missing rather than crashing.
    return {};
  }
}

function topLevelKeyIndex(block: string[], key: string): number {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return block.findIndex((line) => re.test(line));
}

/**
 * Guarantees `content` starts with a frontmatter block carrying at least the
 * keys of `required`. An existing block is merged into: existing keys are kept
 * verbatim, and only the missing (or blank) ones are filled in. Without a block,
 * a new one is prefixed.
 */
export function ensureFrontmatter(content: string, required: Frontmatter): string {
  const entries = Object.entries(required);
  const split = splitFrontmatter(content);

  if (!split) {
    const block = entries.map(([key, value]) => serializeEntry(key, value));
    const body = content.replace(/^\n+/, '');
    const suffix = body === '' ? '' : `\n${body}`;
    return `---\n${block.join('\n')}\n---\n${suffix}`;
  }

  const block = [...split.block];
  const data = parseBlock(block);

  for (const [key, value] of entries) {
    if (!isEmptyValue(data[key])) continue;

    const line = serializeEntry(key, value);
    const index = topLevelKeyIndex(block, key);
    if (index >= 0) block[index] = line;
    else block.push(line);
  }

  return `---\n${block.join('\n')}\n---\n${split.body}`;
}
