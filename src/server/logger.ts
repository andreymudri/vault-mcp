/**
 * The server's log: one JSON object per line, on stderr.
 *
 * stderr and not stdout, because stdout IS the protocol channel and one stray line there
 * desynchronises the client's JSON-RPC stream. A line per event and JSON, because whatever
 * collects an MCP server's stderr — the client's own log file, a supervisor, a terminal — reads it
 * by line, and an operator filtering for `"level":"warn"` should not need a parser for prose.
 *
 * Until this existed the server wrote to stderr twice in its whole life, both times while failing
 * to start. Everything after that was invisible: a setting it could not honour, a write that was
 * saved and never committed, a call that took seconds. The default level is `warn`, which keeps a
 * healthy server exactly as quiet as before.
 *
 * Every string that goes out is REDACTED first, with the same redactor the tools use: the vault's
 * absolute root spells out the OS username on a personal machine, and a log is the part of a
 * system most often pasted somewhere else.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** From quietest to most talkative. A message is let through when its level is at or below the logger's. */
export const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogEntry {
  ts: string;
  level: Exclude<LogLevel, 'silent'>;
  event: string;
  /** Already redacted. */
  fields: Record<string, unknown>;
}

export interface Logger {
  readonly level: LogLevel;
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /**
   * A second destination for every entry the level lets through. The server uses it to forward
   * the log to the MCP client as `notifications/message`.
   */
  addSink(sink: (entry: LogEntry) => void): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives one line, without the terminator. */
  write: (line: string) => void;
  redact?: (text: string) => string;
  now?: () => Date;
}

/** Every string inside `value` through `redact`, at any depth; a cycle is cut rather than followed. */
function redactDeep(value: unknown, redact: (text: string) => string, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact, seen));
  if (value instanceof Error) return redact(value.message);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact, seen)]),
  );
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const threshold = LOG_LEVELS.indexOf(level);
  const redact = options.redact ?? ((text: string) => text);
  const now = options.now ?? (() => new Date());
  const sinks: Array<(entry: LogEntry) => void> = [];

  const emit = (entryLevel: LogEntry['level'], event: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(entryLevel) > threshold) return;
    // Logging must never be the thing that fails: a field that cannot be serialised, a stream
    // that was closed under the process, a sink whose client went away — each is swallowed here,
    // because the alternative is a write tool that throws after its write succeeded.
    try {
      const entry: LogEntry = {
        ts: now().toISOString(),
        level: entryLevel,
        event,
        fields: redactDeep(fields, redact, new WeakSet()) as Record<string, unknown>,
      };
      // The logger's own three keys go LAST, so a field named `event` or `level` cannot pass
      // itself off as them.
      const line = JSON.stringify({ ...entry.fields, ts: entry.ts, level: entry.level, event: entry.event });
      try {
        options.write(line);
      } catch {
        // stderr is gone; the sinks may still be reachable.
      }
      for (const sink of sinks) {
        try {
          sink(entry);
        } catch {
          // One sink failing says nothing about the next.
        }
      }
    } catch {
      // Nothing useful can be done with a failure to log.
    }
  };

  return {
    level,
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    addSink: (sink) => {
      sinks.push(sink);
    },
  };
}

/** A logger that says nothing, for callers that were not handed one. */
export const NULL_LOGGER: Logger = createLogger({ level: 'silent', write: () => undefined });
