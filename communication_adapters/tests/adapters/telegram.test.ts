import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { toMarkdownV2, TelegramFormatter } from '../../src/adapters/telegram/formatter.js';
import { handleStart, handleReset, handleHelp, handleText, type HandlerCtx } from '../../src/adapters/telegram/bot.js';
import { SessionMap } from '../../src/core/session-map.js';
import type { OrchestratorClient } from '../../src/core/orchestrator-client.js';
import type { AgentResponse } from '../../src/core/types.js';

const logger = pino({ level: 'silent' });

// ── Formatter ─────────────────────────────────────────────────────────────────

describe('toMarkdownV2', () => {
  it('escapes reserved characters in plain text', () => {
    expect(toMarkdownV2('hello.world')).toBe('hello\\.world');
    expect(toMarkdownV2('1+1=2')).toBe('1\\+1\\=2');
    expect(toMarkdownV2('a-b')).toBe('a\\-b');
  });

  it('converts bold **text** to *text*', () => {
    expect(toMarkdownV2('**bold**')).toBe('*bold*');
  });

  it('converts italic _text_ to _text_ (MarkdownV2 italic)', () => {
    expect(toMarkdownV2('_italic_')).toBe('_italic_');
  });

  it('converts strikethrough ~~text~~ to ~text~', () => {
    expect(toMarkdownV2('~~strike~~')).toBe('~strike~');
  });

  it('converts headings to bold lines', () => {
    expect(toMarkdownV2('# Heading 1')).toBe('*Heading 1*');
    expect(toMarkdownV2('## Heading 2')).toBe('*Heading 2*');
  });

  it('converts links to MarkdownV2 link format', () => {
    const result = toMarkdownV2('[Click here](https://example.com/path)');
    expect(result).toContain('[Click here]');
    expect(result).toContain('https://example');
  });

  it('preserves inline code without escaping content', () => {
    const result = toMarkdownV2('Use `foo.bar()` here');
    expect(result).toContain('`foo.bar()`');
    // The dot inside code should NOT be escaped
    expect(result).not.toContain('`foo\\.bar\\(\\)`');
  });

  it('preserves fenced code blocks', () => {
    const input = '```python\nprint("hello")\n```';
    const result = toMarkdownV2(input);
    expect(result).toContain('```python');
    expect(result).toContain('print("hello")');
  });

  it('escapes reserved chars inside bold/italic text', () => {
    const result = toMarkdownV2('**hello.world**');
    expect(result).toBe('*hello\\.world*');
  });

  it('handles mixed content', () => {
    const input = '**Bold** and `code` and plain.text';
    const result = toMarkdownV2(input);
    expect(result).toContain('*Bold*');
    expect(result).toContain('`code`');
    expect(result).toContain('plain\\.text');
  });
});

describe('TelegramFormatter.formatAndSplit', () => {
  const formatter = new TelegramFormatter();

  it('returns a single chunk for short messages', () => {
    const chunks = formatter.formatAndSplit('hello world');
    expect(chunks).toHaveLength(1);
  });

  it('splits messages exceeding 4096 chars', () => {
    // Build a message with clear paragraph breaks so splitting is predictable
    const para = 'A'.repeat(2000);
    const input = `${para}\n\n${para}\n\n${para}`;
    const chunks = formatter.formatAndSplit(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ── Bot handlers ──────────────────────────────────────────────────────────────

function makeSessionMap() {
  return new SessionMap({ idleTtlMs: 60_000 }, logger);
}

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    chat: { id: 12345, type: 'private' },
    botInfo: { id: 99, username: 'TestBot' },
    message: { text: 'Hello' },
    reply: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeOrchestratorClient(response: Partial<AgentResponse> = {}): OrchestratorClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      session_id: 'sess-1',
      content: 'Agent reply',
      model_used: 'test',
      input_tokens: 1,
      output_tokens: 1,
      ...response,
    }),
  } as unknown as OrchestratorClient;
}

describe('handleStart', () => {
  it('deletes the session and sends a greeting', async () => {
    const map = makeSessionMap();
    map.set({ platform: 'telegram', platformUserId: '12345', channelId: '12345' }, 'old-session');
    const ctx = makeCtx();

    await handleStart(ctx, map);

    expect(map.get({ platform: 'telegram', platformUserId: '12345', channelId: '12345' })).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledOnce();
  });
});

describe('handleReset', () => {
  it('deletes the session and confirms reset', async () => {
    const map = makeSessionMap();
    map.set({ platform: 'telegram', platformUserId: '12345', channelId: '12345' }, 'old-session');
    const ctx = makeCtx();

    await handleReset(ctx, map);

    expect(map.get({ platform: 'telegram', platformUserId: '12345', channelId: '12345' })).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledOnce();
  });
});

describe('handleText', () => {
  const formatter = new TelegramFormatter();

  it('sends message to orchestrator and replies', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient();
    const ctx = makeCtx();

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hello', session_id: undefined }),
    );
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it('stores session_id after first response', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient({ session_id: 'new-sess' });
    const ctx = makeCtx();

    await handleText(ctx, map, client, formatter, logger);

    expect(
      map.get({ platform: 'telegram', platformUserId: '12345', channelId: '12345' }),
    ).toBe('new-sess');
  });

  it('includes existing session_id on subsequent messages', async () => {
    const map = makeSessionMap();
    map.set({ platform: 'telegram', platformUserId: '12345', channelId: '12345' }, 'existing-sess');
    const client = makeOrchestratorClient({ session_id: 'existing-sess' });
    const ctx = makeCtx();

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'existing-sess' }),
    );
  });

  it('ignores group messages that do not mention the bot or reply to it', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient();
    const ctx = makeCtx({
      chat: { id: 99999, type: 'group' },
      message: { text: 'Just chatting' },
    });

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('responds to group messages that @mention the bot', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient();
    const ctx = makeCtx({
      chat: { id: 99999, type: 'group' },
      message: { text: '@TestBot what is 2+2?' },
    });

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'what is 2+2?' }),
    );
  });

  it('responds to group messages that are replies to the bot', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient();
    const ctx = makeCtx({
      chat: { id: 99999, type: 'group' },
      message: {
        text: 'Follow-up question',
        reply_to_message: { from: { id: 99 } }, // botInfo.id = 99
      },
    });

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Follow-up question' }),
    );
  });

  it('replies with an error message if orchestrator fails', async () => {
    const map = makeSessionMap();
    const client = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as OrchestratorClient;
    const ctx = makeCtx();

    await handleText(ctx, map, client, formatter, logger);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [replyText] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(replyText).toContain('error');
  });

  it('re-processes edited messages identically to new messages', async () => {
    const map = makeSessionMap();
    const client = makeOrchestratorClient();
    // Simulate an edited message by calling handleText with updated text
    const ctx = makeCtx({ message: { text: 'Edited text' } });

    await handleText(ctx, map, client, formatter, logger);

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Edited text' }),
    );
  });
});

describe('handleHelp', () => {
  it('replies with help text', async () => {
    const ctx = makeCtx();
    await handleHelp(ctx);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(text).toContain('/start');
    expect(text).toContain('/reset');
    expect(text).toContain('/help');
  });
});
