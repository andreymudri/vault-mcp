import { describe, expect, it } from 'vitest';

import { createLogger, type LogEntry, type LogLevel } from '../src/server/logger.js';

function capture(level: LogLevel, redact?: (text: string) => string) {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date('2026-11-22T12:00:00.000Z'),
    ...(redact === undefined ? {} : { redact }),
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('createLogger', () => {
  it('writes one JSON object per event, with when, how serious and what', () => {
    const { logger, lines, parsed } = capture('info');
    logger.info('tool.call', { tool: 'vault_search', ms: 12, ok: true });

    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toEqual({
      ts: '2026-11-22T12:00:00.000Z',
      level: 'info',
      event: 'tool.call',
      tool: 'vault_search',
      ms: 12,
      ok: true,
    });
  });

  it.each([
    ['silent', []],
    ['error', ['error']],
    ['warn', ['error', 'warn']],
    ['info', ['error', 'warn', 'info']],
    ['debug', ['error', 'warn', 'info', 'debug']],
  ] as Array<[LogLevel, string[]]>)('at level %s lets through %j', (level, expected) => {
    const { logger, parsed } = capture(level);
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');

    expect(parsed().map((entry) => entry['level'])).toEqual(expected);
  });

  it('keeps an event on ONE line whatever its fields carry', () => {
    const { logger, lines } = capture('warn');
    logger.warn('git.failed', { detail: 'fatal: first line\nsecond line\r\nthird' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect((JSON.parse(lines[0] ?? '{}') as { detail: string }).detail).toContain('second line');
  });

  it('redacts every string, at any depth, and never the keys the logger owns', () => {
    const { logger, parsed } = capture('warn', (text) => text.split('/home/someone/vault').join('<vault>'));
    logger.warn('write.failed', {
      path: '/home/someone/vault/02-wiki/x.md',
      nested: { list: ['/home/someone/vault/a.md', 7] },
      // A field cannot pass itself off as the event name or the level.
      event: 'forged',
      level: 'debug',
    });

    expect(parsed()[0]).toMatchObject({
      level: 'warn',
      event: 'write.failed',
      path: '<vault>/02-wiki/x.md',
      nested: { list: ['<vault>/a.md', 7] },
    });
  });

  it('hands each entry it lets through to its sinks, redacted, and survives a sink that throws', () => {
    const { logger, lines } = capture('warn', (text) => text.replace('secret', '***'));
    const seen: LogEntry[] = [];
    logger.addSink(() => {
      throw new Error('sink down');
    });
    logger.addSink((entry) => seen.push(entry));

    logger.info('below.threshold');
    logger.warn('config.invalid', { value: 'secret' });

    expect(lines).toHaveLength(1);
    expect(seen).toEqual([
      { ts: '2026-11-22T12:00:00.000Z', level: 'warn', event: 'config.invalid', fields: { value: '***' } },
    ]);
  });

  it('does not throw when a field cannot be serialised or the stream is gone', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const { logger, lines } = capture('warn');
    expect(() => logger.warn('odd', { cyclic })).not.toThrow();
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', event: 'odd' });

    const broken = createLogger({
      level: 'warn',
      write: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => broken.warn('anything')).not.toThrow();
  });
});
