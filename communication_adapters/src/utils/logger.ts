import pino from 'pino';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

let _logger: Logger | undefined;

export function createLogger(config: Pick<Config, 'LOG_LEVEL'>): Logger {
  _logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'communication-adapters', version: '0.1.0' },
  });
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) throw new Error('Logger not initialised — call createLogger() first');
  return _logger;
}

export type { Logger };
