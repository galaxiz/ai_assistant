import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { OrchestratorClient } from '../../core/orchestrator-client.js';
import type { SessionMap, SessionKey } from '../../core/session-map.js';
import type { Logger } from '../../utils/logger.js';
import { TelegramFormatter } from './formatter.js';
import { withRetry, isNotConnectedError } from '../../utils/retry.js';

/** Minimal subset of Context used by handlers — makes unit testing easy. */
export interface HandlerCtx {
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  botInfo: { id: number; username: string };
  message: {
    text: string;
    reply_to_message?: { from?: { id: number } };
  };
  reply(text: string, extra?: Record<string, unknown>): Promise<unknown>;
  sendChatAction(action: string): Promise<unknown>;
}

function sessionKey(chatId: string): SessionKey {
  return { platform: 'telegram', platformUserId: chatId, channelId: chatId };
}

export async function handleStart(
  ctx: Pick<HandlerCtx, 'chat' | 'reply'>,
  sessionMap: SessionMap,
): Promise<void> {
  const chatId = String(ctx.chat.id);
  sessionMap.delete(sessionKey(chatId));
  await ctx.reply(
    'Hello\\! I\'m your AI assistant\\. Send me a message to get started\\.\nUse /reset to start a new conversation\\.',
    { parse_mode: 'MarkdownV2' },
  );
}

export async function handleHelp(
  ctx: Pick<HandlerCtx, 'reply'>,
): Promise<void> {
  await ctx.reply(
    '*Available commands*\n' +
    '/start \\— greet the bot and begin a new conversation\n' +
    '/reset \\— clear the current session and start fresh\n' +
    '/help \\— show this message\n\n' +
    'In group chats, @mention me or reply to one of my messages to talk to me\\.',
    { parse_mode: 'MarkdownV2' },
  );
}

export async function handleReset(
  ctx: Pick<HandlerCtx, 'chat' | 'reply'>,
  sessionMap: SessionMap,
): Promise<void> {
  const chatId = String(ctx.chat.id);
  sessionMap.delete(sessionKey(chatId));
  await ctx.reply('Session reset\\. Starting a new conversation\\.', {
    parse_mode: 'MarkdownV2',
  });
}

export async function handleText(
  ctx: HandlerCtx,
  sessionMap: SessionMap,
  orchestratorClient: OrchestratorClient,
  formatter: TelegramFormatter,
  logger: Logger,
): Promise<void> {
  let text = ctx.message.text;
  const chatType = ctx.chat.type;

  // In group chats, only respond when @mentioned or directly replied to.
  if (chatType === 'group' || chatType === 'supergroup') {
    const mention = `@${ctx.botInfo.username}`;
    const isMentioned = text.includes(mention);
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;

    if (!isMentioned && !isReplyToBot) return;

    text = text.replaceAll(mention, '').trim();
  }

  if (!text) return;

  const chatId = String(ctx.chat.id);
  const key = sessionKey(chatId);
  const sessionId = sessionMap.get(key);

  try {
    await ctx.sendChatAction('typing');

    const response = await withRetry(
      () => orchestratorClient.sendMessage({ ...(sessionId !== undefined && { session_id: sessionId }), message: text }),
      {
        maxAttempts: 3,
        delayMs: 1_000,
        retryable: isNotConnectedError,
        onRetry: (_, attempt) => logger.warn({ attempt }, 'Orchestrator not connected, retrying'),
      },
    );

    sessionMap.set(key, response.session_id);

    const chunks = formatter.formatAndSplit(response.content);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        // MarkdownV2 parse errors can happen with edge-case content — fall back to plain text.
        logger.warn({ err }, 'MarkdownV2 reply failed, falling back to plain text');
        await ctx.reply(response.content.slice(0, 4096));
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to process Telegram message');
    await ctx
      .reply('Sorry, I encountered an error\\. Please try again\\.', { parse_mode: 'MarkdownV2' })
      .catch(() => undefined);
  }
}

export function createBot(
  token: string,
  orchestratorClient: OrchestratorClient,
  sessionMap: SessionMap,
  logger: Logger,
): Telegraf {
  const bot = new Telegraf(token);
  const formatter = new TelegramFormatter();

  bot.command('start', (ctx: Context) =>
    handleStart(ctx as unknown as HandlerCtx, sessionMap),
  );

  bot.command('help', (ctx: Context) =>
    handleHelp(ctx as unknown as HandlerCtx),
  );

  bot.command('reset', (ctx: Context) =>
    handleReset(ctx as unknown as HandlerCtx, sessionMap),
  );

  bot.on('text', (ctx: Context) =>
    handleText(ctx as unknown as HandlerCtx, sessionMap, orchestratorClient, formatter, logger),
  );

  // Re-process edited messages through the same text handler.
  bot.on('edited_message', (ctx: Context) => {
    const editedMsg = (ctx.update as unknown as Record<string, unknown>)['edited_message'] as
      | { text?: string; chat: HandlerCtx['chat']; reply_to_message?: HandlerCtx['message']['reply_to_message'] }
      | undefined;
    if (!editedMsg?.text) return;

    const syntheticCtx: HandlerCtx = {
      chat: editedMsg.chat,
      botInfo: ctx.botInfo,
      message: { text: editedMsg.text, ...(editedMsg.reply_to_message !== undefined && { reply_to_message: editedMsg.reply_to_message }) },
      reply: ctx.reply.bind(ctx),
      sendChatAction: ctx.sendChatAction.bind(ctx),
    };
    return handleText(syntheticCtx, sessionMap, orchestratorClient, formatter, logger);
  });

  return bot;
}
