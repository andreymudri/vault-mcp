import { LANGS, resolveLang, type Lang } from '../i18n/lang.js';

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

  const maxNoteBytes = positiveInt(env, 'VAULT_MAX_NOTE_BYTES', warnings);
  const lockTimeoutMs = positiveInt(env, 'VAULT_LOCK_TIMEOUT_MS', warnings);

  return {
    lang,
    ...(maxNoteBytes === undefined ? {} : { maxNoteBytes }),
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    warnings,
  };
}
