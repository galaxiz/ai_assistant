export interface CognitionConfig {
  address: string;
  timeoutMs: number;
  maxRetries: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CognitionConfig {
  return {
    address: env.ORCH_COGNITION_ENGINE_ADDRESS ?? 'http://localhost:50051',
    timeoutMs: Number(env.ORCH_COGNITION_TIMEOUT_MS ?? 30_000),
    maxRetries: Number(env.ORCH_COGNITION_MAX_RETRIES ?? 3),
    retryInitialDelayMs: Number(env.ORCH_COGNITION_RETRY_INITIAL_DELAY_MS ?? 100),
    retryMaxDelayMs: Number(env.ORCH_COGNITION_RETRY_MAX_DELAY_MS ?? 5_000),
  };
}
