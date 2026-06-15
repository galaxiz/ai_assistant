export interface Permissions {
  fsRead: boolean;
  fsWrite: boolean;
  network: boolean; // reserved — not enforced at Wasm layer yet
}

export interface ArgDef {
  name: string;
  type: 'string' | 'integer' | 'boolean';
  required: boolean;
  description?: string;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  /** Absolute path to the .wasm file. */
  wasmPath: string;
  timeoutSecs: number;
  permissions: Permissions;
  args: ArgDef[];
}

export class ToolError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`[${toolName}] ${message}`);
    this.name = 'ToolError';
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(toolName, 'not found in registry');
    this.name = 'ToolNotFoundError';
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(toolName, `timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}
