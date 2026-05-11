/**
 * Logger — lightweight structured logging for the healing agent.
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

function normalizeLogLevel(value: string | undefined): LogLevel {
  const normalized = (value || 'INFO').toUpperCase();
  if (normalized === LogLevel.DEBUG) return LogLevel.DEBUG;
  if (normalized === LogLevel.WARN) return LogLevel.WARN;
  if (normalized === LogLevel.ERROR) return LogLevel.ERROR;
  return LogLevel.INFO;
}

const minLevel: LogLevel = normalizeLogLevel(process.env['LOG_LEVEL']);

function log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...(data ? { data } : {}),
  }));
}

export const logger = {
  debug: (module: string, message: string, data?: Record<string, unknown>) => log(LogLevel.DEBUG, module, message, data),
  info: (module: string, message: string, data?: Record<string, unknown>) => log(LogLevel.INFO, module, message, data),
  warn: (module: string, message: string, data?: Record<string, unknown>) => log(LogLevel.WARN, module, message, data),
  error: (module: string, message: string, data?: Record<string, unknown>) => log(LogLevel.ERROR, module, message, data),
};
