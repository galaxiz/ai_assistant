import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { toMrkdwn, toSlackBlocks, SlackFormatter } from '../../src/adapters/slack/formatter.js';
import {
  handleAppMention,
  handleDirectMessage,
  handleResetCommand,
  type AppMentionEvent,
  type DirectMessageEvent,
  type SayFn,
  type HandlerDeps,
  type ResetCommandArgs,
} from '../../src/adapters/slack/app.js';
import { SessionMap } from '../../src/core/session-map.js';
import type { OrchestratorClient } from '../../src/core/orchestrator-client.js';
import type { AgentResponse } from '../../src/core/types.js';

const logger = pino({ level: 'silent' });

// ── Formatter ─────────────────────────────────────────────────────────────────

describe('toMrkdwn', () => {
  it('converts bold **text** to *text*', () => {
    expect(toMrkdwn('**bold**')).toBe('*bold*');
  });

  it('converts italic *text* to _text_', () => {
    expect(toMrkdwn('*italic*')).toBe('_italic_');
  });

  it('leaves _italic_ unchanged', () => {
    expect(toMrkdwn('_italic_')).toBe('_italic_');
  });

  it('does not convert bold to italic', () => {
    // **bold** should become *bold*, not _bold_
    const result = toMrkdwn('**bold**');
    expect(result).toBe('*bold*');
    expect(result).not.toBe('_bold_');
  });

  it('converts strikethrough ~~text~~ to ~text~', () => {
    expect(toMrkdwn('~~strike~~')).toBe('~strike~');
  });

  it('converts headings to bold lines', () => {
    expect(toMrkdwn('# Heading')).toBe('*Heading*');
    expect(toMrkdwn('### H3')).toBe('*H3*');
  });

  it('converts links [text](url) to <url|text>', () => {
    expect(toMrkdwn('[Click](https://example.com)')).toBe('<https://example.com|Click>');
  });

  it('preserves inline code unchanged', () => {
    expect(toMrkdwn('Use `foo.bar()` here')).toContain('`foo.bar()`');
  });

  it('strips language hint from fenced code blocks', () => {
    const result = toMrkdwn('```python\nprint("hello")\n```');
    expect(result).toContain('```');
    expect(result).toContain('print("hello")');
    expect(result).not.toContain('```python');
  });

  it('handles mixed content correctly', () => {
    const input = '**Bold**, `code`, and [link](https://x.com)';
    const result = toMrkdwn(input);
    expect(result).toContain('*Bold*');
    expect(result).toContain('`code`');
    expect(result).toContain('<https://x.com|link>');
  });

  it('does not process bold inside code blocks', () => {
    const result = toMrkdwn('`**not bold**`');
    expect(result).toBe('`**not bold**`');
  });
});

describe('toSlackBlocks', () => {
  it('returns a single section block for short text', () => {
    const blocks = toSlackBlocks('hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('section');
    expect(blocks[0]?.text.type).toBe('mrkdwn');
  });

  it('splits into multiple blocks when text exceeds 3000 chars', () => {
    const para = 'A'.repeat(2000);
    const blocks = toSlackBlocks(`${para}\n\n${para}\n\n${para}`);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});

describe('SlackFormatter', () => {
  const formatter = new SlackFormatter();

  it('format() returns mrkdwn string', () => {
    expect(formatter.format('**bold**')).toBe('*bold*');
  });

  it('formatAsBlocks() returns Block Kit section blocks', () => {
    const blocks = formatter.formatAsBlocks('hello');
    expect(blocks[0]?.type).toBe('section');
  });
});

// ── App handlers ──────────────────────────────────────────────────────────────

function makeSessionMap() {
  return new SessionMap({ idleTtlMs: 60_000 }, logger);
}

function makeSay(): SayFn {
  return vi.fn().mockResolvedValue(undefined);
}

function makeClient(response: Partial<AgentResponse> = {}): OrchestratorClient {
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

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    orchestratorClient: makeClient(),
    sessionMap: makeSessionMap(),
    formatter: new SlackFormatter(),
    logger,
    ...overrides,
  };
}

describe('handleAppMention', () => {
  const baseEvent: AppMentionEvent = {
    text: '<@U12345> hello bot',
    user: 'U99999',
    channel: 'C11111',
    ts: '1700000000.000001',
    team: 'T11111',
  };

  it('strips bot mention and sends to orchestrator', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleAppMention(baseEvent, say, deps);

    expect(deps.orchestratorClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hello bot', session_id: undefined }),
    );
    expect(say).toHaveBeenCalledOnce();
  });

  it('replies in the existing thread when thread_ts is set', async () => {
    const deps = makeDeps();
    const say = makeSay();
    const event = { ...baseEvent, thread_ts: '1700000000.000000' };

    await handleAppMention(event, say, deps);

    const sayArgs = (say as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { thread_ts?: string };
    expect(sayArgs.thread_ts).toBe('1700000000.000000');
  });

  it('uses event.ts as thread root for top-level mentions', async () => {
    const deps = makeDeps();
    const say = makeSay();

    await handleAppMention(baseEvent, say, deps); // no thread_ts

    const sayArgs = (say as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { thread_ts?: string };
    expect(sayArgs.thread_ts).toBe(baseEvent.ts);
  });

  it('stores session_id after response', async () => {
    const deps = makeDeps({ orchestratorClient: makeClient({ session_id: 'new-sess' }) });
    const say = makeSay();
    await handleAppMention(baseEvent, say, deps);

    const key = { platform: 'slack', platformUserId: 'T11111', channelId: `C11111:${baseEvent.ts}` };
    expect(deps.sessionMap.get(key)).toBe('new-sess');
  });

  it('includes existing session_id on subsequent mentions in the same thread', async () => {
    const deps = makeDeps();
    const say = makeSay();
    const threadTs = '1700000000.000000';
    const event = { ...baseEvent, thread_ts: threadTs };
    const key = { platform: 'slack', platformUserId: 'T11111', channelId: `C11111:${threadTs}` };

    deps.sessionMap.set(key, 'existing-sess');
    await handleAppMention(event, say, deps);

    expect(deps.orchestratorClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'existing-sess' }),
    );
  });

  it('ignores empty text after stripping the mention', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleAppMention({ ...baseEvent, text: '<@U12345>' }, say, deps);

    expect(deps.orchestratorClient.sendMessage).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('replies with an error message if orchestrator fails', async () => {
    const client = { sendMessage: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as OrchestratorClient;
    const deps = makeDeps({ orchestratorClient: client });
    const say = makeSay();

    await handleAppMention(baseEvent, say, deps);

    expect(say).toHaveBeenCalledOnce();
    const args = (say as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { text: string };
    expect(args.text).toContain('error');
  });
});

describe('handleDirectMessage', () => {
  const baseEvent: DirectMessageEvent = {
    text: 'Hello bot',
    user: 'U99999',
    channel: 'D11111',
    ts: '1700000000.000001',
    team: 'T11111',
  };

  it('sends the message to the orchestrator and replies', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleDirectMessage(baseEvent, say, deps);

    expect(deps.orchestratorClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hello bot' }),
    );
    expect(say).toHaveBeenCalledOnce();
  });

  it('ignores messages with a subtype (bot messages, etc.)', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleDirectMessage({ ...baseEvent, subtype: 'bot_message' }, say, deps);

    expect(deps.orchestratorClient.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores messages with no text', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleDirectMessage({ ...baseEvent, text: undefined }, say, deps);

    expect(deps.orchestratorClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not add thread_ts for DM replies', async () => {
    const deps = makeDeps();
    const say = makeSay();
    await handleDirectMessage(baseEvent, say, deps);

    const args = (say as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['thread_ts']).toBeUndefined();
  });

  it('stores session_id and uses it for subsequent DMs', async () => {
    const deps = makeDeps({ orchestratorClient: makeClient({ session_id: 'dm-sess' }) });
    const say = makeSay();
    await handleDirectMessage(baseEvent, say, deps);

    const key = { platform: 'slack', platformUserId: 'T11111', channelId: 'D11111' };
    expect(deps.sessionMap.get(key)).toBe('dm-sess');

    // Second message should include the session_id
    const client2 = makeClient({ session_id: 'dm-sess' });
    deps.sessionMap.set(key, 'dm-sess');
    await handleDirectMessage({ ...baseEvent, text: 'follow-up' }, say, { ...deps, orchestratorClient: client2 });
    expect(client2.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'dm-sess' }),
    );
  });

  it('replies with an error message if orchestrator fails', async () => {
    const client = { sendMessage: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as OrchestratorClient;
    const deps = makeDeps({ orchestratorClient: client });
    const say = makeSay();

    await handleDirectMessage(baseEvent, say, deps);

    expect(say).toHaveBeenCalledOnce();
    const args = (say as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { text: string };
    expect(args.text).toContain('error');
  });

  it('re-processes message_changed (edited DMs) as new turns', async () => {
    const deps = makeDeps();
    const say = makeSay();
    const editedEvent: DirectMessageEvent = {
      ...baseEvent,
      subtype: 'message_changed',
      text: undefined,
      message: { text: 'Edited text', user: 'U99999' },
    };

    await handleDirectMessage(editedEvent, say, deps);

    expect(deps.orchestratorClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Edited text' }),
    );
  });

  it('ignores message_changed when edited text is absent', async () => {
    const deps = makeDeps();
    const say = makeSay();
    const event: DirectMessageEvent = {
      ...baseEvent,
      subtype: 'message_changed',
      text: undefined,
      message: { user: 'U99999' }, // no text
    };

    await handleDirectMessage(event, say, deps);
    expect(deps.orchestratorClient.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handleResetCommand', () => {
  function makeResetArgs(overrides: Partial<ResetCommandArgs> = {}): ResetCommandArgs {
    return {
      channelId: 'C11111',
      teamId: 'T11111',
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('acknowledges the command', async () => {
    const map = makeSessionMap();
    const args = makeResetArgs();
    await handleResetCommand(args, map);
    expect(args.ack).toHaveBeenCalledOnce();
  });

  it('deletes the DM session and all thread sessions for the channel', async () => {
    const map = makeSessionMap();
    map.set({ platform: 'slack', platformUserId: 'T11111', channelId: 'C11111' }, 'dm-sess');
    map.set({ platform: 'slack', platformUserId: 'T11111', channelId: 'C11111:ts1' }, 'thread-1');
    map.set({ platform: 'slack', platformUserId: 'T11111', channelId: 'C22222' }, 'other');

    const args = makeResetArgs();
    await handleResetCommand(args, map);

    expect(map.size).toBe(1); // only the C22222 session survives
    expect(args.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('reset') }),
    );
  });

  it('responds with "no active session" when nothing to delete', async () => {
    const map = makeSessionMap();
    const args = makeResetArgs();
    await handleResetCommand(args, map);
    expect(args.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('No active session') }),
    );
  });

  it('responds ephemerally', async () => {
    const map = makeSessionMap();
    const args = makeResetArgs();
    await handleResetCommand(args, map);
    const respondArg = (args.respond as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { response_type: string };
    expect(respondArg.response_type).toBe('ephemeral');
  });
});
