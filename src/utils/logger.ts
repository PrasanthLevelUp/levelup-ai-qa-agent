/**
 * Logger — lightweight structured logging for the healing agent.
 * Writes to stdout (JSON lines) so the daemon can capture output.
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

const minLevel: LogLevel =
  (process.env['LOG_LEVEL'] as LogLevel) || LogLevel.INFO;

function log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...(data ? { data } : {}),
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (mod: string, msg: string, data?: Record<string, unknown>) => log(LogLevel.DEBUG, mod, msg, data),
  info:  (mod: string, msg: string, data?: Record<string, unknown>) => log(LogLevel.INFO, mod, msg, data),
  warn:  (mod: string, msg: string, data?: Record<string, unknown>) => log(LogLevel.WARN, mod, msg, data),
  error: (mod: string, msg: string, data?: Record<string, unknown>) => log(LogLevel.ERROR, mod, msg, data),
};
