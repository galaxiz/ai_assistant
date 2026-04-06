import { App } from '@slack/bolt';
import type { OrchestratorClient } from '../../core/orchestrator-client.js';
import type { SessionMap, SessionKey } from '../../core/session-map.js';
import type { Logger } from '../../utils/logger.js';
import type { SlackSectionBlock } from './formatter.js';
import { SlackFormatter } from './formatter.js';
import { withRetry, isNotConnectedError } from '../../utils/retry.js';
import { OrchestratorError } from '../../core/orchestrator-client.js';

// ── Minimal event/say shapes used by handler logic (facilitates unit testing) ─

export interface AppMentionEvent {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  team?: string;
}

export interface DirectMessageEvent {
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  team?: string;
  /** Present when subtype === 'message_changed'. */
  message?: { text?: string; user?: string };
}

export interface ResetCommandArgs {
  channelId: string;
  teamId: string;
  ack: () => Promise<void>;
  respond: (args: { text: string; response_type: string }) => Promise<unknown>;
}

export type SayFn = (args: {
  text?: string;
  blocks?: SlackSectionBlock[];
  thread_ts?: string;
}) => Promise<unknown>;

export interface HandlerDeps {
  orchestratorClient: OrchestratorClient;
  sessionMap: SessionMap;
  formatter: SlackFormatter;
  logger: Logger;
}

// ── Session key helpers ───────────────────────────────────────────────────────

/**
 * Build the session key for a channel/thread message.
 * Each thread gets its own session; top-level messages start a new thread.
 */
function threadSessionKey(teamId: string, channel: string, threadTs: string): SessionKey {
  return { platform: 'slack', platformUserId: teamId, channelId: `${channel}:${threadTs}` };
}

/** Build the session key for a DM (no thread granularity). */
function dmSessionKey(teamId: string, channel: string): SessionKey {
  return { platform: 'slack', platformUserId: teamId, channelId: channel };
}

// ── Handler functions (exported for unit testing) ─────────────────────────────

export async function handleAppMention(
  event: AppMentionEvent,
  say: SayFn,
  deps: HandlerDeps,
): Promise<void> {
  const { orchestratorClient, sessionMap, formatter, logger } = deps;

  // Strip the @mention prefix that Slack prepends (e.g. "<@U12345> hello" → "hello")
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return;

  // Thread: if message is already in a thread, continue it; else start one at event.ts
  const threadTs = event.thread_ts ?? event.ts;
  const teamId = event.team ?? 'unknown';
  const key = threadSessionKey(teamId, event.channel, threadTs);
  const sessionId = sessionMap.get(key);

  try {
    const response = await withRetry(
      () => orchestratorClient.sendMessage({ ...(sessionId !== undefined && { session_id: sessionId }), message: text }),
      {
        maxAttempts: 3,
        delayMs: 1_000,
        retryable: isNotConnectedError,
        onAttempt: (attempt) => logger.info({ attempt, channel: event.channel, sessionId }, 'sendMessage attempt'),
        onFailure: (err, attempt, willRetry) => logger.warn(
          { attempt, willRetry, error: err instanceof Error ? err.message : String(err) },
          'sendMessage failed',
        ),
        onRetry: (_, attempt) => logger.warn({ attempt }, 'Orchestrator not connected, retrying'),
      },
    );

    sessionMap.set(key, response.session_id);

    const blocks = formatter.formatAsBlocks(response.content);
    await say({ blocks, text: response.content, thread_ts: threadTs });
  } catch (err) {
    logger.error({ err, channel: event.channel }, 'Failed to process app_mention');
    if (err instanceof OrchestratorError && err.session_id !== undefined) {
      sessionMap.set(key, err.session_id);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await say({ text: `Error: ${msg}`, thread_ts: threadTs });
  }
}

export async function handleDirectMessage(
  event: DirectMessageEvent,
  say: SayFn,
  deps: HandlerDeps,
): Promise<void> {
  const { orchestratorClient, sessionMap, formatter, logger } = deps;

  // Re-process edited DMs — treat the updated text as a new user turn.
  if (event.subtype === 'message_changed') {
    const edited = event.message;
    if (!edited?.text || !edited.user) return;
    return handleDirectMessage(
      (({ subtype: _subtype, ...rest }) => ({ ...rest, text: edited.text, user: edited.user }))(event),
      say,
      deps,
    );
  }

  // Ignore all other subtypes (bot messages, file uploads, etc.)
  if (event.subtype) return;
  if (!event.text || !event.user) return;

  const teamId = event.team ?? 'unknown';
  const key = dmSessionKey(teamId, event.channel);
  const sessionId = sessionMap.get(key);

  try {
    const response = await withRetry(
      () => orchestratorClient.sendMessage({ ...(sessionId !== undefined && { session_id: sessionId }), message: event.text! }),
      {
        maxAttempts: 3,
        delayMs: 1_000,
        retryable: isNotConnectedError,
        onAttempt: (attempt) => logger.info({ attempt, channel: event.channel, sessionId }, 'sendMessage attempt'),
        onFailure: (err, attempt, willRetry) => logger.warn(
          { attempt, willRetry, error: err instanceof Error ? err.message : String(err) },
          'sendMessage failed',
        ),
        onRetry: (_, attempt) => logger.warn({ attempt }, 'Orchestrator not connected, retrying'),
      },
    );

    sessionMap.set(key, response.session_id);

    const blocks = formatter.formatAsBlocks(response.content);
    // DMs: don't thread — just reply in the channel
    await say({ blocks, text: response.content });
  } catch (err) {
    logger.error({ err, channel: event.channel }, 'Failed to process DM');
    if (err instanceof OrchestratorError && err.session_id !== undefined) {
      sessionMap.set(key, err.session_id);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await say({ text: `Error: ${msg}` });
  }
}

// ── /reset slash command ──────────────────────────────────────────────────────

/**
 * Handle the Slack /reset slash command.
 * Clears the DM session AND all thread sessions for the channel so the next
 * message starts a completely fresh orchestrator session.
 */
export async function handleResetCommand(
  args: ResetCommandArgs,
  sessionMap: SessionMap,
): Promise<void> {
  await args.ack();
  // Key prefix covers both the bare DM key and all thread keys:
  //   "slack:teamId:channelId"           — DM session
  //   "slack:teamId:channelId:threadTs"  — thread sessions
  const prefix = `slack:${args.teamId}:${args.channelId}`;
  const deleted = sessionMap.deleteByKeyPrefix(prefix);
  await args.respond({
    text: deleted > 0
      ? 'Session reset. Starting a new conversation.'
      : 'No active session to reset.',
    response_type: 'ephemeral',
  });
}

// ── App factory ───────────────────────────────────────────────────────────────

export interface SlackAppOptions {
  botToken: string;
  signingSecret: string;
  appToken?: string;
  socketMode?: boolean;
}

export function createSlackApp(
  opts: SlackAppOptions,
  orchestratorClient: OrchestratorClient,
  sessionMap: SessionMap,
  logger: Logger,
): App {
  const app = new App({
    token: opts.botToken,
    signingSecret: opts.signingSecret,
    ...(opts.socketMode && opts.appToken
      ? { socketMode: true, appToken: opts.appToken }
      : {}),
  });

  const formatter = new SlackFormatter();
  const deps: HandlerDeps = { orchestratorClient, sessionMap, formatter, logger };

  // app_mention: bot is @mentioned in a channel
  app.event('app_mention', async ({ event, say }) => {
    await handleAppMention(
      event as AppMentionEvent,
      say as unknown as SayFn,
      deps,
    );
  });

  // message: direct messages (and edited DMs via message_changed subtype)
  app.message(async ({ message, say }) => {
    await handleDirectMessage(
      message as unknown as DirectMessageEvent,
      say as unknown as SayFn,
      deps,
    );
  });

  // /reset slash command
  app.command('/reset', async ({ command, ack, respond }) => {
    await handleResetCommand(
      {
        channelId: command.channel_id,
        teamId: command.team_id,
        ack,
        respond: respond as ResetCommandArgs['respond'],
      },
      sessionMap,
    );
  });

  return app;
}
