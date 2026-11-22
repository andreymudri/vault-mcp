import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../src/server/config.js';

describe('resolveConfig', () => {
  it('answers the defaults for an empty environment, with nothing to warn about', () => {
    expect(resolveConfig({})).toEqual({ lang: 'en', warnings: [] });
  });

  it('reads the numeric limits', () => {
    const config = resolveConfig({ VAULT_MAX_NOTE_BYTES: '1048576', VAULT_LOCK_TIMEOUT_MS: ' 5000 ' });
    expect(config.maxNoteBytes).toBe(1_048_576);
    expect(config.lockTimeoutMs).toBe(5_000);
    expect(config.warnings).toEqual([]);
  });

  it.each([['abc'], ['-1'], ['1.5'], ['0'], ['1e3'], ['12 MB']])(
    'ignores VAULT_MAX_NOTE_BYTES=%s and says so, instead of running with a limit nobody chose',
    (value) => {
      const config = resolveConfig({ VAULT_MAX_NOTE_BYTES: value });
      expect(config.maxNoteBytes).toBeUndefined();
      expect(config.warnings).toEqual([
        { variable: 'VAULT_MAX_NOTE_BYTES', value, expected: 'a positive integer' },
      ]);
    },
  );

  it.each([['silent'], ['error'], ['warn'], ['info'], ['debug'], ['INFO'], [' debug ']])(
    'reads VAULT_LOG_LEVEL=%s',
    (value) => {
      const config = resolveConfig({ VAULT_LOG_LEVEL: value });
      expect(config.logLevel).toBe(value.trim().toLowerCase());
      expect(config.warnings).toEqual([]);
    },
  );

  it('warns about a log level it does not know and keeps the default', () => {
    const config = resolveConfig({ VAULT_LOG_LEVEL: 'verbose' });
    expect(config.logLevel).toBeUndefined();
    expect(config.warnings).toEqual([
      { variable: 'VAULT_LOG_LEVEL', value: 'verbose', expected: 'silent, error, warn, info or debug' },
    ]);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
  ])('reads VAULT_READ_ONLY=%s as %s', (value, expected) => {
    const config = resolveConfig({ VAULT_READ_ONLY: value });
    expect(config.readOnly).toBe(expected);
    expect(config.warnings).toEqual([]);
  });

  it('fails CLOSED on a VAULT_READ_ONLY it cannot read: read-only, and it says so', () => {
    // Whoever set the variable meant to restrict the server. Falling back to the default here would
    // hand them a server that writes while they believe it cannot.
    const config = resolveConfig({ VAULT_READ_ONLY: 'maybe' });
    expect(config.readOnly).toBe(true);
    expect(config.warnings).toEqual([
      { variable: 'VAULT_READ_ONLY', value: 'maybe', expected: '1 or 0' },
    ]);
  });

  it('warns about a VAULT_AUTO_PUSH that turns nothing on', () => {
    expect(resolveConfig({ VAULT_AUTO_PUSH: 'sim' }).warnings).toEqual([
      { variable: 'VAULT_AUTO_PUSH', value: 'sim', expected: '1 or 0' },
    ]);
    expect(resolveConfig({ VAULT_AUTO_PUSH: 'yes' }).warnings).toEqual([]);
  });

  it('reads VAULT_DISABLED_TOOLS as a list, by comma or by space', () => {
    expect(resolveConfig({ VAULT_DISABLED_TOOLS: 'vault_delete, vault_move  vault_graph' }).disabledTools).toEqual([
      'vault_delete',
      'vault_move',
      'vault_graph',
    ]);
    expect(resolveConfig({ VAULT_DISABLED_TOOLS: ' , ' }).disabledTools).toBeUndefined();
  });

  it('treats a blank variable as unset', () => {
    expect(resolveConfig({ VAULT_MAX_NOTE_BYTES: '  ' })).toEqual({ lang: 'en', warnings: [] });
  });

  it('warns about a VAULT_LANG it does not speak and falls back to English', () => {
    const config = resolveConfig({ VAULT_LANG: 'klingon' });
    expect(config.lang).toBe('en');
    expect(config.warnings).toEqual([{ variable: 'VAULT_LANG', value: 'klingon', expected: 'en or pt' }]);
    expect(resolveConfig({ VAULT_LANG: 'pt-BR' })).toEqual({ lang: 'pt', warnings: [] });
  });
});
