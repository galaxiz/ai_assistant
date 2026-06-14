import type { Logger } from 'pino';
import type { CognitionClient } from '../cognition/client.js';
import type { SessionStore } from '../session/store.js';
import type { AgentConfig } from './config.js';
import { runTurn } from './loop.js';
import type { AgentRequest, AgentResponse, ToolExecutor } from './types.js';

/**
 * Routes inbound AgentRequests to handlers.
 * Currently wraps the single agent loop; designed to be extended in P6 for
 * WebSocket and webhook adapters.
 */
export class AgentRouter {
  constructor(
    private readonly sessions: SessionStore,
    private readonly cognition: CognitionClient,
    private readonly tools: ToolExecutor,
    private readonly config: AgentConfig,
    private readonly logger: Logger,
  ) {}

  async handle(request: AgentRequest): Promise<AgentResponse> {
    return runTurn(request, this.sessions, this.cognition, this.tools, this.config, this.logger);
  }
}
