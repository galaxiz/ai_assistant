export interface AgentRequest {
  /** Existing session to resume; if absent or not found a new session is created. */
  sessionId?: string;
  message: string;
  authToken?: string;
  model?: string;
}

export interface AgentResponse {
  sessionId: string;
  content: string;
  toolCallsMade: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  tool: string;
  callId: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  status: 'ok' | 'error';
  output: string;
}

/** Implemented by P4 (Wasm sandbox); use NoopToolExecutor in tests. */
export interface ToolExecutor {
  execute(call: ToolCall): Promise<ToolResult>;
}

export class MaxIterationsError extends Error {
  constructor(sessionId: string, max: number) {
    super(`Max tool iterations (${max}) exceeded for session ${sessionId}`);
    this.name = 'MaxIterationsError';
  }
}
