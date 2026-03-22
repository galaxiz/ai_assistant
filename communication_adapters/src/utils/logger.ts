import pino from 'pino';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

let _logger: Logger | undefined;

/** ISO 8601 timestamp with local timezone offset, e.g. 2026-03-22T10:04:20.800-07:00 */
function localISOTimestamp(): string {
  const now = new Date();
  const offsetMin = now.getTimezoneOffset();  // negative west of UTC
  const sign = offsetMin <= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  const local = new Date(now.getTime() - offsetMin * 60_000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

export function createLogger(config: Pick<Config, 'LOG_LEVEL'>): Logger {
  _logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'communication-adapters', version: '0.1.0' },
    timestamp: () => `,"time":"${localISOTimestamp()}"`,
  });
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) throw new Error('Logger not initialised — call createLogger() first');
  return _logger;
}

export type { Logger };
