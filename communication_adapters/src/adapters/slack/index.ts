import type { App } from '@slack/bolt';
import type { OrchestratorClient } from '../../core/orchestrator-client.js';
import type { SessionMap } from '../../core/session-map.js';
import type { Logger } from '../../utils/logger.js';
import { createSlackApp } from './app.js';

export interface SlackAdapterOptions {
  botToken: string;
  signingSecret: string;
  /** Required for Socket Mode. Omit to use HTTP mode. */
  appToken?: string;
  /** HTTP port when not using Socket Mode. Defaults to 3001. */
  port?: number;
}

export class SlackAdapter {
  private readonly app: App;
  private readonly opts: SlackAdapterOptions;
  private readonly logger: Logger;

  constructor(
    opts: SlackAdapterOptions,
    orchestratorClient: OrchestratorClient,
    sessionMap: SessionMap,
    logger: Logger,
  ) {
    this.opts = opts;
    this.logger = logger.child({ adapter: 'slack' });
    this.app = createSlackApp(
      {
        botToken: opts.botToken,
        signingSecret: opts.signingSecret,
        ...(opts.appToken !== undefined && { appToken: opts.appToken }),
        socketMode: Boolean(opts.appToken),
      },
      orchestratorClient,
      sessionMap,
      this.logger,
    );
  }

  async start(): Promise<void> {
    const useSocketMode = Boolean(this.opts.appToken);
    if (useSocketMode) {
      await this.app.start();
      this.logger.info('Slack adapter started (Socket Mode)');
    } else {
      const port = this.opts.port ?? 3001;
      await this.app.start(port);
      this.logger.info({ port }, 'Slack adapter started (HTTP)');
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.logger.info('Slack adapter stopped');
  }
}
