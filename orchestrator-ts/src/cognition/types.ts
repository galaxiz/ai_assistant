// TypeScript interfaces mirroring proto/cognition.proto.
// These will be replaced by ts-proto generated output when protoc is available.

export interface RequestContext {
  sessionId: string;
  authToken: string;
}

export interface Message {
  role: string; // 'system' | 'user' | 'assistant'
  content: string;
}

export interface CompleteRequest {
  context: RequestContext;
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompleteResponse {
  content: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface CountTokensRequest {
  context: RequestContext;
  messages: Message[];
  model?: string;
}

export interface CountTokensResponse {
  tokenCount: number;
  fitsBudget: boolean;
  remainingTokens: number;
}

export interface ParseOutputRequest {
  context: RequestContext;
  rawResponse: string;
  schemaJson?: string;
  contextMessages?: Message[];
}

export interface ParseOutputResponse {
  parsedJson: string;
  repaired: boolean;
  rePrompted: boolean;
}
