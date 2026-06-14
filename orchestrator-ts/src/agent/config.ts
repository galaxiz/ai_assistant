export interface AgentConfig {
  maxToolIterations: number;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    maxToolIterations: Number(env.ORCH_AGENT_MAX_TOOL_ITERATIONS ?? 10),
  };
}
