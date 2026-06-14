export type SessionState = 'idle' | 'processing' | 'awaitingTool' | 'error';

// Mirrors proto Message; will be replaced by the generated type in P2.
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Session {
  sessionId: string;
  createdAt: number;
  lastActive: number;
  conversationHistory: Message[];
  state: SessionState;
}
