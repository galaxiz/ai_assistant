/** Sent to the Orchestrator over WebSocket. */
export interface UserMessage {
  /** Omit on the first message; include for subsequent turns in the same session. */
  session_id?: string;
  message: string;
  /** Optional model override forwarded to the Cognition Engine. */
  model?: string;
}

/** Received from the Orchestrator over WebSocket. */
export interface AgentResponse {
  session_id: string;
  content: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
}

/** Error envelope (mirrors Orchestrator ErrorResponse). */
export interface ErrorResponse {
  error: string;
  code: string;
}

export type OrchestratorMessage = AgentResponse | ErrorResponse;

export function isErrorResponse(m: OrchestratorMessage): m is ErrorResponse {
  return 'code' in m && 'error' in m && !('session_id' in m);
}
