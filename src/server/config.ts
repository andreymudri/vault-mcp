import { LANGS, resolveLang, type Lang } from '../i18n/lang.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

/**
 * Everything the server reads from the environment besides `VAULT_PATH`, parsed in one place.
 *
 * The rule for a value that cannot be honoured is the same for every variable: the default is
 * used AND the fact is recorded in `warnings`, which the start-up log prints. The alternative was
 * what `VAULT_LANG` did on its own — `VAULT_LANG=klingon` gave an English server and not one word
 * anywhere about why — and a limit that silently falls back to its default is worse than that:
 * the operator believes a ceiling is in force that is not.
 *
 * It takes the environment as an argument, like `resolveVaultPath` and `resolveLang`, so every
 * branch is testable without touching `process.env` in a parallel test runner.
 */
export interface ConfigWarning {
  variable: string;
  /** What was found there, as written. */
  value: string;
  /** What would have been accepted, in a few words. */
  expected: string;
}

export interface ServerConfig {
  lang: Lang;
  /** `VAULT_MAX_NOTE_BYTES`: files above this are left out of the index. */
  maxNoteBytes?: number;
  /** `VAULT_LOCK_TIMEOUT_MS`: how long a write waits for another process's write. */
  lockTimeoutMs?: number;
  /** `VAULT_LOG_LEVEL`: how much the server writes to stderr. Default `warn`. */
  logLevel?: LogLevel;
  /** `VAULT_READ_ONLY`: publish no tool that writes. */
  readOnly?: boolean;
  /** `VAULT_DISABLED_TOOLS`: tools not to publish, by name. */
  disabledTools?: string[];
  warnings: ConfigWarning[];
}

/** A variable holding a whole number greater than zero, or nothing when it is unset or blank. */
function positiveInt(
  env: NodeJS.ProcessEnv,
  variable: string,
  warnings: ConfigWarning[],
): number | undefined {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === '') return undefined;
  // Digits only: `Number` would also take `1e3`, `0x10` and `1.5`, and a limit written one of
  // those ways is more likely a mistake than an intention.
  if (/^\d+$/.test(raw) && Number(raw) > 0 && Number.isSafeInteger(Number(raw))) return Number(raw);
  warnings.push({ variable, value: raw, expected: 'a positive integer' });
  return undefined;
}

/** The spellings of yes and of no a flag variable takes. The same set `git.ts` reads `VAULT_AUTO_PUSH` with. */
const YES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const NO: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * A flag variable: `undefined` when unset or blank, the boolean when it is a known spelling, and
 * `whenUnreadable` — with a warning — when it is something else.
 */
function flag(
  env: NodeJS.ProcessEnv,
  variable: string,
  warnings: ConfigWarning[],
  whenUnreadable: boolean | undefined,
): boolean | undefined {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  warnings.push({ variable, value: raw, expected: '1 or 0' });
  return whenUnreadable;
}

export function resolveConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const warnings: ConfigWarning[] = [];

  const lang = resolveLang(env);
  const rawLang = env['VAULT_LANG']?.trim();
  // `resolveLang` matches on the primary subtag, so `pt-BR` is Portuguese and not a mistake. What
  // is reported is a value that names no language this server speaks.
  if (rawLang !== undefined && rawLang !== '') {
    const primary = rawLang.toLowerCase().split(/[-_.]/)[0];
    if (!LANGS.includes(primary as Lang)) {
      warnings.push({ variable: 'VAULT_LANG', value: rawLang, expected: LANGS.join(' or ') });
    }
  }

  let logLevel: LogLevel | undefined;
  const rawLevel = env['VAULT_LOG_LEVEL']?.trim();
  if (rawLevel !== undefined && rawLevel !== '') {
    const candidate = rawLevel.toLowerCase();
    if (LOG_LEVELS.includes(candidate as LogLevel)) logLevel = candidate as LogLevel;
    else {
      warnings.push({
        variable: 'VAULT_LOG_LEVEL',
        value: rawLevel,
        expected: `${LOG_LEVELS.slice(0, -1).join(', ')} or ${LOG_LEVELS.at(-1)}`,
      });
    }
  }

  // Fails CLOSED: whoever set this meant to restrict the server, and a typo that silently left it
  // able to write would be the opposite of what they asked for.
  const readOnly = flag(env, 'VAULT_READ_ONLY', warnings, true);
  // Read by `git.ts` itself, at each commit; here only so that a value that turns nothing on is
  // said out loud at start-up instead of being discovered when a note never reaches the remote.
  flag(env, 'VAULT_AUTO_PUSH', warnings, undefined);

  const disabled = (env['VAULT_DISABLED_TOOLS'] ?? '').split(/[\s,]+/).filter((name) => name !== '');

  const maxNoteBytes = positiveInt(env, 'VAULT_MAX_NOTE_BYTES', warnings);
  const lockTimeoutMs = positiveInt(env, 'VAULT_LOCK_TIMEOUT_MS', warnings);

  return {
    lang,
    ...(maxNoteBytes === undefined ? {} : { maxNoteBytes }),
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(disabled.length === 0 ? {} : { disabledTools: disabled }),
    warnings,
  };
}
