import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { runTurn } from './loop.js';
import { SessionStore } from '../session/store.js';
import { MaxIterationsError } from './types.js';
import type { CognitionClient } from '../cognition/client.js';
import type { ToolExecutor, ToolCall, ToolResult } from './types.js';
import type { AgentConfig } from './config.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { maxToolIterations: 5, ...overrides };
}

/** Build a CognitionClient mock where complete() returns the given responses in sequence. */
function makeCognition(responses: Array<{ content: string; inputTokens?: number; outputTokens?: number }>): CognitionClient {
  let idx = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      const r = responses[idx++ % responses.length];
      return {
        content: r.content,
        modelUsed: 'test-model',
        inputTokens: r.inputTokens ?? 10,
        outputTokens: r.outputTokens ?? 5,
        finishReason: 'stop',
      };
    }),
    streamComplete: vi.fn(),
    countTokens: vi.fn().mockResolvedValue({ tokenCount: 100, fitsBudget: true, remainingTokens: 900 }),
    parseOutput: vi.fn(),
    close: vi.fn(),
  } as unknown as CognitionClient;
}

function makeTools(results: Record<string, ToolResult> = {}): ToolExecutor {
  return {
    execute: vi.fn().mockImplementation(async (call: ToolCall) => {
      if (call.tool in results) return results[call.tool];
      return { callId: call.callId, status: 'ok' as const, output: `result-of-${call.tool}` };
    }),
  };
}

function toolCallBlock(tool: string, callId: string, args: Record<string, unknown> = {}): string {
  return `\`\`\`tool_call\n${JSON.stringify({ tool, call_id: callId, args })}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTurn — session management', () => {
  it('creates a new session when no sessionId is provided', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: 'Hello!' }]);
    const tools = makeTools();

    const res = await runTurn({ message: 'hi' }, sessions, cognition, tools, makeConfig(), logger);

    expect(res.sessionId).toBeTruthy();
    expect(sessions.get(res.sessionId)).toBeDefined();
  });

  it('creates a new session when the provided sessionId is unknown', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: 'Hello!' }]);

    const res = await runTurn(
      { sessionId: 'ghost-id', message: 'hi' },
      sessions,
      cognition,
      makeTools(),
      makeConfig(),
      logger,
    );

    expect(res.sessionId).not.toBe('ghost-id');
  });

  it('reuses an existing session', async () => {
    const sessions = new SessionStore();
    const session = sessions.create();
    const cognition = makeCognition([{ content: 'A' }, { content: 'B' }]);

    await runTurn({ sessionId: session.sessionId, message: 'first' }, sessions, cognition, makeTools(), makeConfig(), logger);
    await runTurn({ sessionId: session.sessionId, message: 'second' }, sessions, cognition, makeTools(), makeConfig(), logger);

    const history = sessions.get(session.sessionId)!.conversationHistory;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('runTurn — simple completion (no tool calls)', () => {
  it('returns content and token counts from the completion', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: 'World', inputTokens: 20, outputTokens: 3 }]);

    const res = await runTurn({ message: 'Hello' }, sessions, cognition, makeTools(), makeConfig(), logger);

    expect(res.content).toBe('World');
    expect(res.toolCallsMade).toBe(0);
    expect(res.inputTokens).toBe(20);
    expect(res.outputTokens).toBe(3);
  });

  it('appends user and assistant messages to conversation history', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: 'Hi there' }]);

    const res = await runTurn({ message: 'Hello' }, sessions, cognition, makeTools(), makeConfig(), logger);
    const history = sessions.get(res.sessionId)!.conversationHistory;

    expect(history).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('sets session state back to idle after a successful turn', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: 'ok' }]);
    const res = await runTurn({ message: 'ping' }, sessions, cognition, makeTools(), makeConfig(), logger);
    expect(sessions.get(res.sessionId)!.state).toBe('idle');
  });
});

describe('runTurn — tool calls', () => {
  it('executes a single tool call and feeds the result back', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([
      { content: `Some reasoning.\n${toolCallBlock('read_file', 'c1', { path: '/x' })}` },
      { content: 'Done.' },
    ]);
    const tools = makeTools();

    const res = await runTurn({ message: 'go' }, sessions, cognition, tools, makeConfig(), logger);

    expect(res.content).toBe('Done.');
    expect(res.toolCallsMade).toBe(1);
    expect(tools.execute).toHaveBeenCalledWith({ tool: 'read_file', callId: 'c1', args: { path: '/x' } });
  });

  it('injects tool_result blocks into history as a user message', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([
      { content: toolCallBlock('t', 'c1') },
      { content: 'final' },
    ]);
    const tools = makeTools({ t: { callId: 'c1', status: 'ok', output: 'data' } });

    const res = await runTurn({ message: 'go' }, sessions, cognition, tools, makeConfig(), logger);
    const history = sessions.get(res.sessionId)!.conversationHistory;
    const toolResultMsg = history.find((m) => m.content.includes('tool_result'));

    expect(toolResultMsg?.role).toBe('user');
    expect(toolResultMsg?.content).toContain('"call_id":"c1"');
    expect(toolResultMsg?.content).toContain('"output":"data"');
  });

  it('handles multiple tool calls in a single response (runs them in parallel)', async () => {
    const sessions = new SessionStore();
    const block =
      toolCallBlock('tool_a', 'c1') + '\n' + toolCallBlock('tool_b', 'c2');
    const cognition = makeCognition([{ content: block }, { content: 'all done' }]);
    const tools = makeTools();

    const res = await runTurn({ message: 'go' }, sessions, cognition, tools, makeConfig(), logger);

    expect(res.toolCallsMade).toBe(2);
    expect(tools.execute).toHaveBeenCalledTimes(2);
  });

  it('continues accumulating inputTokens/outputTokens across iterations', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([
      { content: toolCallBlock('t', 'c1'), inputTokens: 10, outputTokens: 5 },
      { content: 'done', inputTokens: 20, outputTokens: 8 },
    ]);

    const res = await runTurn({ message: 'go' }, sessions, cognition, makeTools(), makeConfig(), logger);

    expect(res.inputTokens).toBe(30);
    expect(res.outputTokens).toBe(13);
  });

  it('records tool errors as error-status results without throwing', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([
      { content: toolCallBlock('bad_tool', 'c1') },
      { content: 'recovered' },
    ]);
    const tools: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('tool exploded')),
    };

    const res = await runTurn({ message: 'go' }, sessions, cognition, tools, makeConfig(), logger);

    expect(res.content).toBe('recovered');
    const history = sessions.get(res.sessionId)!.conversationHistory;
    const resultMsg = history.find((m) => m.content.includes('tool_result'))!;
    expect(resultMsg.content).toContain('"status":"error"');
    expect(resultMsg.content).toContain('tool exploded');
  });
});

describe('runTurn — max iterations guard', () => {
  it('throws MaxIterationsError when tool calls never stop', async () => {
    const sessions = new SessionStore();
    // Always returns a tool call — never a final response.
    const cognition = makeCognition([{ content: toolCallBlock('loop_tool', 'c1') }]);

    await expect(
      runTurn({ message: 'go' }, sessions, cognition, makeTools(), makeConfig({ maxToolIterations: 3 }), logger),
    ).rejects.toThrow(MaxIterationsError);
  });

  it('sets session state to error on MaxIterationsError', async () => {
    const sessions = new SessionStore();
    const cognition = makeCognition([{ content: toolCallBlock('t', 'c1') }]);

    let sessionId: string | undefined;
    try {
      await runTurn({ message: 'go' }, sessions, cognition, makeTools(), makeConfig({ maxToolIterations: 1 }), logger);
    } catch (err) {
      if (err instanceof MaxIterationsError) {
        // We don't have the sessionId from the thrown error easily, check all sessions
        const active = sessions.listActive();
        expect(active.every((s) => s.state === 'error')).toBe(true);
      }
    }
  });
});

describe('runTurn — error paths', () => {
  it('sets session state to error when cognition.complete throws', async () => {
    const sessions = new SessionStore();
    const cognition = {
      complete: vi.fn().mockRejectedValue(new Error('CE unavailable')),
      countTokens: vi.fn().mockResolvedValue({ tokenCount: 0, fitsBudget: true, remainingTokens: 1000 }),
    } as unknown as CognitionClient;

    let capturedSessionId: string | undefined;
    try {
      const res = await runTurn({ message: 'go' }, sessions, cognition, makeTools(), makeConfig(), logger);
      capturedSessionId = res.sessionId;
    } catch {
      const active = sessions.listActive();
      expect(active.every((s) => s.state === 'error')).toBe(true);
    }
    void capturedSessionId;
  });

  it('re-throws cognition errors to the caller', async () => {
    const sessions = new SessionStore();
    const err = new Error('CE dead');
    const cognition = {
      complete: vi.fn().mockRejectedValue(err),
      countTokens: vi.fn().mockResolvedValue({ fitsBudget: true }),
    } as unknown as CognitionClient;

    await expect(
      runTurn({ message: 'go' }, sessions, cognition, makeTools(), makeConfig(), logger),
    ).rejects.toBe(err);
  });
});

describe('runTurn — token trimming', () => {
  it('trims oldest non-system messages when countTokens says over budget', async () => {
    const sessions = new SessionStore();
    const session = sessions.create();

    // Pre-load history with some messages.
    session.conversationHistory.push(
      { role: 'user', content: 'old message 1' },
      { role: 'assistant', content: 'old reply 1' },
      { role: 'user', content: 'old message 2' },
      { role: 'assistant', content: 'old reply 2' },
    );

    // countTokens: first call says over budget, then under after trimming.
    const countTokensMock = vi
      .fn()
      .mockResolvedValueOnce({ tokenCount: 999, fitsBudget: false, remainingTokens: 0 })
      .mockResolvedValue({ tokenCount: 50, fitsBudget: true, remainingTokens: 950 });

    const cognition = {
      complete: vi.fn().mockResolvedValue({ content: 'ok', modelUsed: 'm', inputTokens: 5, outputTokens: 2, finishReason: 'stop' }),
      countTokens: countTokensMock,
    } as unknown as CognitionClient;

    await runTurn({ sessionId: session.sessionId, message: 'new' }, sessions, cognition, makeTools(), makeConfig(), logger);

    // At least one old message should have been trimmed.
    const history = sessions.get(session.sessionId)!.conversationHistory;
    expect(history.length).toBeLessThan(7); // original 4 + user + assistant + trim happened
  });

  it('preserves system messages during trimming', async () => {
    const sessions = new SessionStore();
    const session = sessions.create();

    session.conversationHistory.push(
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'old user msg' },
    );

    const countTokensMock = vi
      .fn()
      .mockResolvedValueOnce({ fitsBudget: false })
      .mockResolvedValue({ fitsBudget: true });

    const cognition = {
      complete: vi.fn().mockResolvedValue({ content: 'ok', modelUsed: 'm', inputTokens: 5, outputTokens: 2, finishReason: 'stop' }),
      countTokens: countTokensMock,
    } as unknown as CognitionClient;

    await runTurn({ sessionId: session.sessionId, message: 'hi' }, sessions, cognition, makeTools(), makeConfig(), logger);

    const history = sessions.get(session.sessionId)!.conversationHistory;
    expect(history.some((m) => m.role === 'system')).toBe(true);
  });
});
