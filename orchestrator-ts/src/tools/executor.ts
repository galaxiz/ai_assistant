import * as fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ToolCall, ToolExecutor, ToolResult } from '../agent/types.js';
import type { ToolRegistry } from './registry.js';
import { ToolError, ToolNotFoundError, ToolTimeoutError } from './types.js';

/**
 * Resolves the correct worker script path for both dev (tsx) and prod (compiled js).
 * In dev, import.meta.url ends in .ts, so we pass --import tsx/esm to the worker.
 */
function workerUrl(): URL {
  const isDev = import.meta.url.endsWith('.ts');
  return new URL(isDev ? './worker.ts' : './worker.js', import.meta.url);
}

function workerExecArgv(): string[] {
  if (import.meta.url.endsWith('.ts')) {
    return ['--import', 'tsx/esm'];
  }
  return [];
}

interface WorkerResult {
  output?: string;
  error?: string;
}

function runInWorker(
  wasmBytes: Buffer,
  argsJson: string,
  toolDef: { name: string; permissions: { fsRead: boolean; fsWrite: boolean; network: boolean } },
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), {
      execArgv: workerExecArgv(),
      workerData: {
        wasmBytes,
        argsJson,
        permissions: toolDef.permissions,
        toolName: toolDef.name,
      },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new ToolTimeoutError(toolDef.name, timeoutMs));
    }, timeoutMs);

    worker.once('message', (msg: WorkerResult) => {
      clearTimeout(timer);
      if (msg.error != null) {
        reject(new ToolError(toolDef.name, msg.error));
      } else {
        resolve(msg.output ?? '');
      }
    });

    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(new ToolError(toolDef.name, err.message));
    });
  });
}

/**
 * Implements ToolExecutor using the WASI Wasm sandbox.
 * Compiled WebAssembly.Module instances are cached per tool name;
 * each invocation gets a fresh worker thread for isolation.
 */
export class WasmToolExecutor implements ToolExecutor {
  private readonly wasmBytesCache = new Map<string, Buffer>();

  constructor(private readonly registry: ToolRegistry) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const def = this.registry.get(call.tool);
    if (!def) throw new ToolNotFoundError(call.tool);

    // Lazy-load .wasm bytes on first invocation; cache for reuse.
    let wasmBytes = this.wasmBytesCache.get(call.tool);
    if (!wasmBytes) {
      try {
        wasmBytes = fs.readFileSync(def.wasmPath);
      } catch (err) {
        throw new ToolError(call.tool, `failed to read wasm: ${err instanceof Error ? err.message : err}`);
      }
      this.wasmBytesCache.set(call.tool, wasmBytes);
    }

    const argsJson = JSON.stringify(call.args);
    const timeoutMs = def.timeoutSecs * 1000;

    try {
      const output = await runInWorker(wasmBytes, argsJson, def, timeoutMs);
      return { callId: call.callId, status: 'ok', output };
    } catch (err) {
      if (err instanceof ToolTimeoutError || err instanceof ToolNotFoundError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { callId: call.callId, status: 'error', output: message };
    }
  }
}
