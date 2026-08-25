import { STOPWORDS_EN, STOPWORDS_PT } from './stopwords.js';

/** Lowercase + accent folding, so `decisão` and `decisao` collapse to one term. */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Splits on anything that is not a letter, digit or hyphen, then trims edge hyphens.
 * No stemming: technical vocabulary (`nestjs`, `bullmq`) must survive intact.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const raw of fold(input).split(/[^a-z0-9-]+/)) {
    const term = raw.replace(/^-+/, '').replace(/-+$/, '');
    if (term.length < 2) continue;
    if (STOPWORDS_PT.has(term) || STOPWORDS_EN.has(term)) continue;
    out.push(term);
  }
  return out;
}
