import 'dotenv/config';
import pino from 'pino';

const logger = pino({
  name: 'orchestrator',
  level: process.env.ORCH_LOG_LEVEL ?? 'info',
});

logger.info('Orchestrator starting...');
