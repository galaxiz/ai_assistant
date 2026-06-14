import { describe, it, expect } from 'vitest';
import { parseToolCalls, formatToolResults } from './protocol.js';

describe('parseToolCalls', () => {
  it('returns empty array when there are no tool_call blocks', () => {
    expect(parseToolCalls('Just a plain response.')).toEqual([]);
  });

  it('parses a single tool_call block', () => {
    const content = [
      'Some reasoning...',
      '```tool_call',
      '{"tool": "read_file", "call_id": "c1", "args": {"path": "/tmp/x"}}',
      '```',
    ].join('\n');
    expect(parseToolCalls(content)).toEqual([
      { tool: 'read_file', callId: 'c1', args: { path: '/tmp/x' } },
    ]);
  });

  it('parses multiple tool_call blocks in one response', () => {
    const content = [
      '```tool_call',
      '{"tool": "read_file", "call_id": "c1", "args": {"path": "/a"}}',
      '```',
      'Some text in between.',
      '```tool_call',
      '{"tool": "write_file", "call_id": "c2", "args": {"path": "/b", "content": "hi"}}',
      '```',
    ].join('\n');
    const calls = parseToolCalls(content);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ tool: 'read_file', callId: 'c1', args: { path: '/a' } });
    expect(calls[1]).toEqual({
      tool: 'write_file',
      callId: 'c2',
      args: { path: '/b', content: 'hi' },
    });
  });

  it('accepts camelCase callId as well as snake_case call_id', () => {
    const content = '```tool_call\n{"tool":"t","callId":"x","args":{}}\n```';
    expect(parseToolCalls(content)).toEqual([{ tool: 't', callId: 'x', args: {} }]);
  });

  it('defaults args to {} when args field is missing', () => {
    const content = '```tool_call\n{"tool":"t","call_id":"c"}\n```';
    expect(parseToolCalls(content)).toEqual([{ tool: 't', callId: 'c', args: {} }]);
  });

  it('skips malformed JSON blocks without throwing', () => {
    const content = '```tool_call\nnot json\n```';
    expect(parseToolCalls(content)).toEqual([]);
  });

  it('skips malformed block but parses subsequent valid block', () => {
    const content = [
      '```tool_call',
      'bad json',
      '```',
      '```tool_call',
      '{"tool":"ok","call_id":"c1","args":{}}',
      '```',
    ].join('\n');
    expect(parseToolCalls(content)).toEqual([{ tool: 'ok', callId: 'c1', args: {} }]);
  });

  it('handles Windows-style CRLF line endings', () => {
    const content = '```tool_call\r\n{"tool":"t","call_id":"c","args":{}}\r\n```';
    expect(parseToolCalls(content)).toEqual([{ tool: 't', callId: 'c', args: {} }]);
  });

  it('is safe to call multiple times on the same input (regex lastIndex reset)', () => {
    const content = '```tool_call\n{"tool":"t","call_id":"c","args":{}}\n```';
    expect(parseToolCalls(content)).toHaveLength(1);
    expect(parseToolCalls(content)).toHaveLength(1);
  });
});

describe('formatToolResults', () => {
  it('formats a single ok result', () => {
    const formatted = formatToolResults([
      { callId: 'c1', status: 'ok', output: 'file contents' },
    ]);
    expect(formatted).toBe(
      '```tool_result\n{"call_id":"c1","status":"ok","output":"file contents"}\n```',
    );
  });

  it('formats a single error result', () => {
    const formatted = formatToolResults([{ callId: 'c2', status: 'error', output: 'not found' }]);
    expect(formatted).toContain('"status":"error"');
    expect(formatted).toContain('"call_id":"c2"');
  });

  it('joins multiple results with a newline', () => {
    const formatted = formatToolResults([
      { callId: 'c1', status: 'ok', output: 'a' },
      { callId: 'c2', status: 'ok', output: 'b' },
    ]);
    const blocks = formatted.split('\n```\n```tool_result\n');
    expect(blocks).toHaveLength(2);
  });

  it('round-trips through parseToolCalls — results are not mistaken for tool calls', () => {
    const formatted = formatToolResults([{ callId: 'c1', status: 'ok', output: 'x' }]);
    expect(parseToolCalls(formatted)).toEqual([]);
  });
});
