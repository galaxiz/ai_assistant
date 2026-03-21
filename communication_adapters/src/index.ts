import 'dotenv/config';

import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { startHealthServer } from './utils/health.js';
import { OrchestratorClient } from './core/orchestrator-client.js';
import { SessionMap } from './core/session-map.js';
import { TelegramAdapter } from './adapters/telegram/index.js';
import { SlackAdapter } from './adapters/slack/index.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info({ version: '0.1.0' }, 'communication-adapters starting');

  const sessionMap = new SessionMap(
    { idleTtlMs: config.SESSION_IDLE_TTL_MINUTES * 60 * 1000 },
    logger.child({ module: 'session-map' }),
  );

  const orchestratorClient = new OrchestratorClient(
    {
      url: config.ORCHESTRATOR_URL,
      ...(config.ORCH_AUTH_TOKEN !== undefined && { authToken: config.ORCH_AUTH_TOKEN }),
    },
    logger.child({ module: 'orchestrator-client' }),
  );

  await orchestratorClient.connect();

  const startedAt = Date.now();
  const healthServer = startHealthServer(
    config.HEALTH_PORT,
    () => {
      const connected = orchestratorClient.isConnected;
      return {
        status: connected ? 'ok' : 'degraded',
        orchestrator_connected: connected,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        active_sessions: sessionMap.size,
      };
    },
    logger.child({ module: 'health' }),
  );

  // P1 — Telegram adapter
  let telegramAdapter: TelegramAdapter | undefined;
  if (config.TELEGRAM_ENABLED) {
    telegramAdapter = new TelegramAdapter(
      {
        token: config.TELEGRAM_BOT_TOKEN!,
        ...(config.TELEGRAM_WEBHOOK_URL !== undefined && { webhookUrl: config.TELEGRAM_WEBHOOK_URL }),
        webhookPort: config.TELEGRAM_WEBHOOK_PORT,
      },
      orchestratorClient,
      sessionMap,
      logger,
    );
    await telegramAdapter.start();
  }

  // P2 — Slack adapter
  let slackAdapter: SlackAdapter | undefined;
  if (config.SLACK_ENABLED) {
    slackAdapter = new SlackAdapter(
      {
        botToken: config.SLACK_BOT_TOKEN!,
        signingSecret: config.SLACK_SIGNING_SECRET!,
        ...(config.SLACK_APP_TOKEN !== undefined && { appToken: config.SLACK_APP_TOKEN }),
        port: config.SLACK_PORT,
      },
      orchestratorClient,
      sessionMap,
      logger,
    );
    await slackAdapter.start();
  }

  logger.info('communication-adapters ready');

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutdown signal received');
    telegramAdapter?.stop();
    await slackAdapter?.stop();
    healthServer.close();
    sessionMap.destroy();
    await orchestratorClient.disconnect();
    logger.info('communication-adapters stopped');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
