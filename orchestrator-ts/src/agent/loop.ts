import type { Logger } from 'pino';
import type { CognitionClient } from '../cognition/client.js';
import type { RequestContext } from '../cognition/types.js';
import type { Session } from '../session/types.js';
import type { SessionStore } from '../session/store.js';
import { parseToolCalls, formatToolResults } from './protocol.js';
import type { AgentConfig } from './config.js';
import { MaxIterationsError } from './types.js';
import type { AgentRequest, AgentResponse, ToolExecutor } from './types.js';

export async function runTurn(
  request: AgentRequest,
  sessions: SessionStore,
  cognition: CognitionClient,
  tools: ToolExecutor,
  config: AgentConfig,
  logger: Logger,
): Promise<AgentResponse> {
  // Resolve or create session.
  let sessionId = request.sessionId;
  if (!sessionId || !sessions.get(sessionId)) {
    const session = sessions.create();
    sessionId = session.sessionId;
    logger.info({ sessionId }, 'created new session');
  }

  return sessions.withSession(sessionId, async (session) => {
    const context: RequestContext = { sessionId, authToken: request.authToken ?? '' };

    session.conversationHistory.push({ role: 'user', content: request.message });
    session.state = 'processing';

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsMade = 0;

    try {
      for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
        await trimHistoryIfNeeded(session, cognition, context, logger);

        const completion = await cognition.complete({
          context,
          messages: session.conversationHistory,
          model: request.model,
        });
        totalInputTokens += completion.inputTokens;
        totalOutputTokens += completion.outputTokens;

        const toolCalls = parseToolCalls(completion.content);

        if (toolCalls.length === 0) {
          session.conversationHistory.push({ role: 'assistant', content: completion.content });
          session.state = 'idle';
          logger.info({ sessionId, iteration, toolCallsMade }, 'turn complete');
          return {
            sessionId,
            content: completion.content,
            toolCallsMade,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
          };
        }

        // Append assistant message (contains tool_call blocks), then execute tools.
        session.conversationHistory.push({ role: 'assistant', content: completion.content });
        session.state = 'awaitingTool';
        logger.debug({ sessionId, iteration, toolCount: toolCalls.length }, 'executing tools');

        const results = await Promise.all(
          toolCalls.map(async (call) => {
            try {
              return await tools.execute(call);
            } catch (err) {
              logger.warn({ callId: call.callId, tool: call.tool, err }, 'tool execution failed');
              return {
                callId: call.callId,
                status: 'error' as const,
                output: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );

        toolCallsMade += results.length;
        session.conversationHistory.push({ role: 'user', content: formatToolResults(results) });
        session.state = 'processing';
      }

      throw new MaxIterationsError(sessionId, config.maxToolIterations);
    } catch (err) {
      session.state = 'error';
      throw err;
    }
  });
}

async function trimHistoryIfNeeded(
  session: Session,
  cognition: CognitionClient,
  context: RequestContext,
  logger: Logger,
): Promise<void> {
  const { fitsBudget } = await cognition.countTokens({
    context,
    messages: session.conversationHistory,
  });
  if (fitsBudget) return;

  logger.warn({ sessionId: context.sessionId }, 'token budget exceeded, trimming history');

  const history = session.conversationHistory;
  while (history.length > 1) {
    // Remove the oldest non-system message.
    const idx = history.findIndex((m) => m.role !== 'system');
    if (idx === -1) break;
    history.splice(idx, 1);

    const recheck = await cognition.countTokens({ context, messages: history });
    if (recheck.fitsBudget) break;
  }
}
