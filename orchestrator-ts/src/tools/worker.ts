/**
 * Worker thread: compiles and runs a single Wasm/WASI tool invocation.
 * Receives: { wasmBytes, argsJson, permissions, toolName }
 * Posts:    { output: string } | { error: string }
 */
import { WASI } from 'node:wasi';
import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Permissions } from './types.js';

interface WorkerInput {
  wasmBytes: Buffer;
  argsJson: string;
  permissions: Permissions;
  toolName: string;
}

const { wasmBytes, argsJson, permissions, toolName } = workerData as WorkerInput;

const tmpPath = path.join(os.tmpdir(), `tool-${toolName}-${randomUUID()}.out`);
let fd: number | null = null;

async function run(): Promise<void> {
  fd = fs.openSync(tmpPath, 'w');

  const preopens: Record<string, string> = {};
  if (permissions.fsRead || permissions.fsWrite) {
    preopens['/'] = '/';
  }

  const wasi = new WASI({
    version: 'preview1',
    args: [toolName, argsJson],
    env: { TOOL_ARGS: argsJson },
    preopens,
    stdout: fd,
    stderr: fd,
    returnOnExit: true,
  });

  const wasmModule = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(wasmModule, wasi.getImportObject());

  const exitCode = wasi.start(instance);

  fs.closeSync(fd);
  fd = null;

  const output = fs.readFileSync(tmpPath, 'utf-8');
  fs.unlinkSync(tmpPath);

  if (exitCode !== 0) {
    parentPort!.postMessage({ error: `exited with code ${exitCode}: ${output}` });
  } else {
    parentPort!.postMessage({ output });
  }
}

run().catch((err: unknown) => {
  if (fd !== null) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
});
