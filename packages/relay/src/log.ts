import type { LogLevel } from './config'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
  level: LogLevel
}

/** JSON-lines logger (one object per line on stdout). */
export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  base: Record<string, unknown> = {},
): Logger {
  const logger: Logger = {
    level,
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(logger.level, sink, { ...base, ...fields }),
  }
  function write(l: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[l] < ORDER[logger.level]) return
    const rec: Record<string, unknown> = { ts: new Date().toISOString(), level: l, msg, ...base }
    if (fields) {
      for (const [k, v] of Object.entries(fields)) rec[k] = v instanceof Error ? v.message : v
    }
    sink(JSON.stringify(rec))
  }
  return logger
}

export const silentLogger = (): Logger => createLogger('error', () => {})
