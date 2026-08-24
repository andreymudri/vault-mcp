import { describe, expect, it } from 'vitest';
import { fold, tokenize } from '../src/index/tokenizer.js';

describe('fold', () => {
  it('collapses accented and unaccented forms to the same string', () => {
    expect(fold('decisão')).toBe(fold('decisao'));
    expect(fold('decisão')).toBe('decisao');
  });
});

describe('tokenize', () => {
  it('drops Portuguese stopwords', () => {
    const tokens = tokenize('A decisão de autenticação');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('de');
  });

  it('keeps technical vocabulary intact, without stemming', () => {
    const tokens = tokenize('NestJS e BullMQ');
    expect(tokens).toContain('nestjs');
    expect(tokens).toContain('bullmq');
  });

  it('keeps hyphenated compounds and alphanumeric tokens as single terms', () => {
    const tokens = tokenize('build multi-stage v6');
    expect(tokens).toContain('multi-stage');
    expect(tokens).toContain('v6');
  });

  it('drops English stopwords', () => {
    const tokens = tokenize('the queue is running');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
  });

  it('discards tokens shorter than 2 characters', () => {
    const tokens = tokenize('a b cc');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('cc');
  });

  it('trims leading and trailing hyphens from a token', () => {
    const tokens = tokenize('-worker-');
    expect(tokens).toContain('worker');
  });

  it('does not stem: filas and fila remain distinct terms', () => {
    const tokens = tokenize('filas fila workers worker');
    expect(tokens).toContain('filas');
    expect(tokens).toContain('fila');
    expect(tokens).toContain('workers');
    expect(tokens).toContain('worker');
  });
});
