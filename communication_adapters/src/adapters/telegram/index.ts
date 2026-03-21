import { Telegraf } from 'telegraf';
import type { OrchestratorClient } from '../../core/orchestrator-client.js';
import type { SessionMap } from '../../core/session-map.js';
import type { Logger } from '../../utils/logger.js';
import { createBot } from './bot.js';

export interface TelegramAdapterOptions {
  token: string;
  webhookUrl?: string;
  /** Port Telegraf listens on for webhook requests (must be one Telegram allows: 443, 80, 88, 8443). */
  webhookPort?: number;
}

export class TelegramAdapter {
  private readonly bot: Telegraf;
  private readonly opts: TelegramAdapterOptions;
  private readonly logger: Logger;

  constructor(
    opts: TelegramAdapterOptions,
    orchestratorClient: OrchestratorClient,
    sessionMap: SessionMap,
    logger: Logger,
  ) {
    this.opts = opts;
    this.logger = logger.child({ adapter: 'telegram' });
    this.bot = createBot(opts.token, orchestratorClient, sessionMap, this.logger);
  }

  async start(): Promise<void> {
    if (this.opts.webhookUrl) {
      const port = this.opts.webhookPort ?? 8443;
      await this.bot.launch({ webhook: { domain: this.opts.webhookUrl, port } });
      this.logger.info({ webhookUrl: this.opts.webhookUrl, port }, 'Telegram adapter started (webhook)');
    } else {
      await this.bot.launch();
      this.logger.info('Telegram adapter started (long-polling)');
    }
  }

  stop(): void {
    this.bot.stop('SIGTERM');
    this.logger.info('Telegram adapter stopped');
  }
}
