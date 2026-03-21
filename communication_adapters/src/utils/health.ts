import http from 'node:http';
import type { Logger } from './logger.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  orchestrator_connected: boolean;
  uptime_seconds: number;
  active_sessions: number;
}

export type HealthProvider = () => HealthStatus;

export function startHealthServer(
  port: number,
  getHealth: HealthProvider,
  logger: Logger,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const status = getHealth();
      const code = status.status === 'down' ? 503 : 200;
      const body = JSON.stringify(status);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Health server error');
  });

  return server;
}
