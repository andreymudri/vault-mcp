import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_LENGTH, fold, tokenize } from '../src/index/tokenizer.js';

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

/**
 * Edge-hyphen trimming used to be `raw.replace(/^-+/, '').replace(/-+$/, '')`. The trailing
 * replace is anchor-less at its start, so on a token shaped `[alnum][hyphen run][alnum]` the
 * greedy `-+` is retried from every position inside the run and `$` fails at each one: measured
 * on this tree, 10.000 hyphens 73,9ms, 20.000 284,2ms, 40.000 1.165ms, 80.000 4.514ms, 160.000
 * 20.421ms — a clean 4x per doubling. `retrieval.ts` clamps the raw QUERY at 1024 characters, but
 * `InvertedIndex.addChunk` tokenizes note BODIES on every scan, so a clipping in `01-raw/` with a
 * long hyphen run stalled every search without anyone sending a query at all.
 *
 * These assertions are deliberately DETERMINISTIC — never a wall-clock bound. A clock assertion
 * on CPU-bound synchronous code is both flaky under load and, worse, unable to fail the way it
 * claims to: vitest cannot preempt a synchronous call, so a test whose body blocks for 30s still
 * reports as passed (verified). What is asserted here instead is output identity at pathological
 * scale plus, below, the absence of the per-token regex itself.
 */
describe('tokenize — linear edge-hyphen trim', () => {
  it('a 200.000-hyphen token yields exactly what its short equivalent yields', () => {
    const long = `${'-'.repeat(200_000)}worker${'-'.repeat(200_000)}`;

    expect(tokenize(long)).toEqual(tokenize('-worker-'));
    expect(tokenize(long)).toEqual(['worker']);
  });

  it('an interior hyphen run inside a note leaves the surrounding real terms untouched', () => {
    // This is the quadratic shape proper: the run is INTERIOR (`a`…`b`), so the trailing trim
    // never matches and the old regex backtracked across the whole run from every start position.
    const blob = `a${'-'.repeat(200_000)}b`;

    expect(tokenize(`jwt guard ${blob} nestjs worker`)).toEqual(tokenize('jwt guard nestjs worker'));
    expect(tokenize(`jwt guard ${blob} nestjs worker`)).toEqual(['jwt', 'guard', 'nestjs', 'worker']);
  });

  it('performs no per-token regex replace, whatever the token count', () => {
    // The deterministic mutation detector for the trim. Output identity alone cannot distinguish
    // the linear scan from the quadratic regex — both produce the same terms — and, as noted
    // above, a timeout cannot fail on synchronous code. What separates them is observable
    // without a clock: the old implementation ran `String.prototype.replace` ONCE PER RAW TOKEN,
    // so the call count grew with the number of tokens. `fold` legitimately calls `replace` a
    // fixed number of times per `tokenize` call, so the assertion compares counts between a
    // one-token input and a many-token input instead of fixing an absolute number.
    const original = String.prototype.replace;
    const counted: number[] = [];
    const inputs = ['worker', Array.from({ length: 50 }, (_, i) => `term${i}-x`).join(' ')];

    for (const input of inputs) {
      let calls = 0;
      String.prototype.replace = function (this: string, ...args: unknown[]): string {
        calls += 1;
        return (original as unknown as (...rest: unknown[]) => string).apply(this, args);
      } as typeof String.prototype.replace;
      try {
        tokenize(input);
      } finally {
        String.prototype.replace = original;
      }
      counted.push(calls);
    }

    expect(tokenize(inputs[1]!)).toHaveLength(50);
    expect(counted[1]).toBe(counted[0]);
  });
});

/**
 * Nothing capped the LENGTH of a token entering the index: `MAX_TERM_LENGTH` in `bm25.ts` only
 * ever guarded the Levenshtein pair, so a 20MB base64 blob in a clipping became a posting-list
 * key. The cap DISCARDS rather than truncates: truncation would fuse distinct terms sharing a
 * 64-character prefix into one posting list — silently wrong frequencies and ranking — and would
 * manufacture exactly the equal-length, prefix-sharing vocabulary that defeats `levenshtein`'s
 * early exits in `suggestTerms`. A term nobody can type is worth nothing as a search key anyway.
 */
describe('tokenize — per-token length cap', () => {
  it('keeps a token of exactly MAX_TOKEN_LENGTH characters', () => {
    const atCap = 'a'.repeat(MAX_TOKEN_LENGTH);
    expect(atCap).toHaveLength(64);
    expect(tokenize(atCap)).toEqual([atCap]);
  });

  it('discards a token one character past the cap, keeping its neighbours', () => {
    const beyond = 'a'.repeat(MAX_TOKEN_LENGTH + 1);
    expect(tokenize(`jwt ${beyond} worker`)).toEqual(['jwt', 'worker']);
  });

  it('measures the cap AFTER trimming edge hyphens, not before', () => {
    // `----------…----worker` is a pasted separator glued to a real word: the raw token is far
    // past the cap, the trimmed term is not, and the real word must survive.
    expect(tokenize(`${'-'.repeat(500)}worker`)).toEqual(['worker']);
  });

  it('does not truncate: two long tokens sharing a 64-character prefix do not collapse', () => {
    // The justification for discarding. Under truncation both tokens would become the same
    // 64-character key and share one posting list.
    const prefix = 'x'.repeat(MAX_TOKEN_LENGTH);
    expect(tokenize(`${prefix}aaaa ${prefix}bbbb`)).toEqual([]);
  });
});
