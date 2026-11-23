import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { coded } from '../i18n/errors.js';

/**
 * Where things live in a vault, and what its structural sections are called.
 *
 * This server was written for one vault, and its conventions were constants scattered over nine
 * files: `02-wiki/` for knowledge, `04-daily/` for the journal, `## Notas` for the list of a
 * domain's notes. Anyone else's vault had to be renamed to match before a single write tool would
 * do the right thing. A `Layout` is those conventions as data, with the original ones as the
 * default — so a vault that says nothing behaves exactly as it always did.
 *
 * It is read from a file INSIDE the vault (`.vault-mcp.json`), not from the environment, and that
 * is the point: every client that opens this vault has to agree on where the wiki is. A setting
 * per client would let two of them file the same learning in two different folders.
 *
 * What is NOT here, deliberately: the frontmatter keys (`tipo`, `criado`, `atualizado`) and the
 * file names inside a role (`<domain>-moc.md`, `index-knowledge.md`, `YYYY-MM-DD.md`). Those run
 * through the scanner, the chunker, the templates and the propagation, and nothing asked for them
 * to move.
 */
export interface Layout {
  folders: {
    /** Where the knowledge index lives. */
    index: string;
    /** Unvetted capture: indexed, but left out of an ordinary search. */
    raw: string;
    /** Knowledge by domain: `<wiki>/<domain>/<note>.md`. */
    wiki: string;
    projects: string;
    /** One note per day, `YYYY-MM-DD.md`. */
    daily: string;
    /** Retired notes: readable, demoted in ranking, and written to only by a move. */
    archive: string;
    /** Note templates: never indexed, never written. */
    templates: string;
  };
  /** Heading TEXT, without the `## `. They are looked up in the user's own files. */
  sections: {
    /** In a domain MOC: the list of its notes. */
    notes: string;
    /** In the knowledge index: the list of domains. */
    domains: string;
    /** In a daily note: the capture lines. */
    captures: string;
    /** In a learned note: the related links. */
    links: string;
    /** In a new MOC: the pointer back to the index. */
    related: string;
    /** In a learned note: the label of the line saying where the learning came from. */
    context: string;
  };
}

export const DEFAULT_LAYOUT: Layout = {
  folders: {
    index: '00-index',
    raw: '01-raw',
    wiki: '02-wiki',
    projects: '03-projects',
    daily: '04-daily',
    archive: '99-archive',
    templates: '_templates',
  },
  sections: {
    notes: 'Notas',
    domains: 'Domínios',
    captures: 'Capturas',
    links: 'Links',
    related: 'Relacionados',
    context: 'Contexto',
  },
};

/** The file, in the vault's root. A dotfile: the scanner skips it and no write tool can reach it. */
export const LAYOUT_FILE = '.vault-mcp.json';

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

/** Directories that are machine state in any vault, and so can never be given a role. */
const MACHINE_FOLDERS: ReadonlySet<string> = new Set(['.git', '.obsidian', 'node_modules']);

/**
 * One folder NAME: a single path segment that is not hidden and not machine state. A path with a
 * separator in it would make every "is this note under the wiki" test a question about depth
 * instead of about the first segment, which is what all of them ask.
 */
const folderName = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => !/[\\/]/.test(name), 'must be a single folder name, without a path separator')
  .refine((name) => !name.startsWith('.'), 'must not be a hidden folder')
  .refine((name) => !MACHINE_FOLDERS.has(name), 'is machine state, not vault content')
  .refine((name) => !/[\x00-\x1f\x7f*?[\]:"<>|]/.test(name), 'has a character a folder name cannot carry');

/** One heading text: a single line, and not a heading marker of its own. */
const sectionName = z
  .string()
  .min(1)
  .max(80)
  .refine((name) => name.trim() === name, 'must not start or end with a space')
  .refine((name) => !/[\r\n#]/.test(name), 'must be one line of text, without the `#` of the heading');

const layoutFile = z
  .object({
    folders: z
      .object({
        index: folderName,
        raw: folderName,
        wiki: folderName,
        projects: folderName,
        daily: folderName,
        archive: folderName,
        templates: folderName,
      })
      .partial()
      .strict()
      .optional(),
    sections: z
      .object({
        notes: sectionName,
        domains: sectionName,
        captures: sectionName,
        links: sectionName,
        related: sectionName,
        context: sectionName,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

function invalid(detail: string): LayoutError {
  return coded(new LayoutError(`${LAYOUT_FILE} inválido: ${detail}`), 'layout.invalid', { detail });
}

/**
 * The layout of the vault at `vaultRoot`: the default, with whatever `.vault-mcp.json` overrides.
 *
 * A file that is wrong is an ERROR, and the server does not start. Falling back to the default
 * would be the worst reading of a typo: the owner believes their wiki is `knowledge/`, and the
 * server starts filing notes under a `02-wiki/` it creates on the spot.
 */
export function loadLayout(vaultRoot: string): Layout {
  let raw: string;
  try {
    raw = readFileSync(join(vaultRoot, LAYOUT_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_LAYOUT;
    throw invalid(err instanceof Error ? err.message : String(err));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw invalid(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('the top level must be an object');
  }

  const checked = layoutFile.safeParse(parsed);
  if (!checked.success) {
    const detail = checked.error.issues
      .map((issue) => {
        const where = issue.path.join('.');
        const what = issue.code === 'unrecognized_keys' ? `unknown key(s): ${issue.keys.join(', ')}` : issue.message;
        return where === '' ? what : `${where}: ${what}`;
      })
      .join('; ');
    throw invalid(detail);
  }

  const layout: Layout = {
    folders: { ...DEFAULT_LAYOUT.folders, ...definedOnly(checked.data.folders) },
    sections: { ...DEFAULT_LAYOUT.sections, ...definedOnly(checked.data.sections) },
  };

  // Two roles on one folder make every question about that folder ambiguous: is a note under it
  // raw capture to be left out of the search, or knowledge to be ranked?
  const byFolder = new Map<string, string>();
  for (const [role, name] of Object.entries(layout.folders)) {
    const other = byFolder.get(name);
    if (other !== undefined) throw invalid(`folders.${other} and folders.${role} are both '${name}'`);
    byFolder.set(name, role);
  }
  return layout;
}

/** `value` without the keys whose value is `undefined`, so a spread of it overrides nothing by accident. */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `## Notas`, from `Notas`. */
export function heading(section: string): string {
  return `## ${section}`;
}

/**
 * `text` with every DEFAULT folder name replaced by this layout's name for the same role.
 *
 * The catalog of tool descriptions and error messages names folders — "a domain under
 * `02-wiki/`" — and a model reads those to decide what to pass. In a vault whose wiki is
 * `knowledge/`, a description that still says `02-wiki/` is an instruction to use a folder that
 * does not exist. One pass with an alternation, so a layout that reuses one role's default name
 * for another role is not renamed twice.
 */
export function withFolderNames(text: string, layout: Layout): string {
  if (layout === DEFAULT_LAYOUT) return text;
  const renames = new Map<string, string>();
  for (const role of Object.keys(DEFAULT_LAYOUT.folders) as Array<keyof Layout['folders']>) {
    if (DEFAULT_LAYOUT.folders[role] !== layout.folders[role]) {
      renames.set(DEFAULT_LAYOUT.folders[role], layout.folders[role]);
    }
  }
  if (renames.size === 0) return text;
  const escaped = [...renames.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(escaped.join('|'), 'g'), (name) => renames.get(name) ?? name);
}

/** A catalog — any nesting of objects and strings — with `withFolderNames` applied to every string. */
export function withLayoutNames<T>(catalog: T, layout: Layout): T {
  if (layout === DEFAULT_LAYOUT) return catalog;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return withFolderNames(value, layout);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return walk(catalog) as T;
}
