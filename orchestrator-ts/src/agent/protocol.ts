import type { ToolCall, ToolResult } from './types.js';

// Matches ```tool_call\n...\n``` blocks (non-greedy).
const TOOL_CALL_RE = /```tool_call\r?\n([\s\S]*?)\r?\n```/g;

export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  TOOL_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      calls.push({
        tool: String(raw['tool'] ?? ''),
        callId: String(raw['call_id'] ?? raw['callId'] ?? ''),
        args:
          raw['args'] != null && typeof raw['args'] === 'object' && !Array.isArray(raw['args'])
            ? (raw['args'] as Record<string, unknown>)
            : {},
      });
    } catch {
      // skip malformed blocks
    }
  }
  return calls;
}

export function formatToolResults(results: ToolResult[]): string {
  return results
    .map(
      (r) =>
        '```tool_result\n' +
        JSON.stringify({ call_id: r.callId, status: r.status, output: r.output }) +
        '\n```',
    )
    .join('\n');
}
