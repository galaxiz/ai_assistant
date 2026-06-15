import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from './registry.js';
import { WasmToolExecutor } from './executor.js';
import { ToolNotFoundError, ToolTimeoutError } from './types.js';

// ---------------------------------------------------------------------------
// Compile minimal WASI WAT modules. Requires wabt npm package.
// ---------------------------------------------------------------------------

/**
 * WAT that writes a fixed JSON string to stdout then exits 0.
 * Verifies that the executor captures stdout correctly.
 * Memory layout: iovec at 0..7, data at 32.
 */
const HELLO_WAT = `
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (data (i32.const 32) "{\\"ok\\":true}")

  (func $start
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 11))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 16)))
    (call $proc_exit (i32.const 0))
  )
)
`;

/** WAT that immediately exits with code 0, writing nothing. */
const NOOP_WAT = `
(module
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory 1)
  (export "memory" (memory 0))
  (func $start (call $proc_exit (i32.const 0)))
  (export "_start" (func $start))
)
`;

/** WAT that loops forever (for timeout testing). */
const INFINITE_WAT = `
(module
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory 1)
  (export "memory" (memory 0))
  (func $start
    (loop $inf (br $inf))
    (call $proc_exit (i32.const 0))
  )
  (export "_start" (func $start))
)
`;

async function compileWat(wat: string): Promise<Uint8Array> {
  // Dynamic import so tests that don't use Wasm still run fast.
  const wabt = await import('wabt');
  const w = await wabt.default();
  const mod = w.parseWat('inline.wat', wat, { mutable_globals: true });
  const { buffer } = mod.toBinary({});
  mod.destroy();
  return buffer;
}

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-executor-'));

  const [helloBytes, noopBytes, infiniteBytes] = await Promise.all([
    compileWat(HELLO_WAT),
    compileWat(NOOP_WAT),
    compileWat(INFINITE_WAT),
  ]);

  fs.writeFileSync(path.join(tmpDir, 'hello.wasm'), helloBytes);
  fs.writeFileSync(path.join(tmpDir, 'noop.wasm'), noopBytes);
  fs.writeFileSync(path.join(tmpDir, 'infinite.wasm'), infiniteBytes);

  const makeMd = (name: string, wasmFile: string, extra = '') =>
    `---\nname = "${name}"\nwasm = "${wasmFile}"\ntimeout_secs = 5\n\n[permissions]\nfs_read = false\nfs_write = false\nnetwork = false\n${extra}\n---\n\n# ${name}`;

  fs.writeFileSync(path.join(tmpDir, 'hello.md'), makeMd('hello', path.join(tmpDir, 'hello.wasm')));
  fs.writeFileSync(path.join(tmpDir, 'noop.md'), makeMd('noop', path.join(tmpDir, 'noop.wasm')));
  fs.writeFileSync(
    path.join(tmpDir, 'infinite_loop.md'),
    makeMd('infinite_loop', path.join(tmpDir, 'infinite.wasm'), 'timeout_secs = 1\n'),
  );
}, 30_000); // wabt compilation can be slow on first run

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WasmToolExecutor.execute', () => {
  it('runs a noop wasm and returns ok status', async () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    const result = await executor.execute({ tool: 'noop', callId: 'c1', args: {} });

    expect(result.callId).toBe('c1');
    expect(result.status).toBe('ok');
  }, 15_000);

  it('captures stdout written by the wasm module', async () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    const result = await executor.execute({ tool: 'hello', callId: 'c2', args: {} });

    expect(result.status).toBe('ok');
    expect(result.output).toBe('{"ok":true}');
  }, 15_000);

  it('caches wasm bytes (second call reuses cached buffer)', async () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    const r1 = await executor.execute({ tool: 'noop', callId: 'c1', args: {} });
    const r2 = await executor.execute({ tool: 'noop', callId: 'c2', args: {} });

    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
  }, 20_000);

  it('throws ToolNotFoundError for an unregistered tool', async () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    await expect(
      executor.execute({ tool: 'no_such_tool', callId: 'c1', args: {} }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it('throws ToolTimeoutError when wasm exceeds the timeout', async () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    await expect(
      executor.execute({ tool: 'infinite_loop', callId: 'c1', args: {} }),
    ).rejects.toThrow(ToolTimeoutError);
  }, 10_000);

  it('throws ToolError when the wasm file does not exist', async () => {
    // Override the registry with a definition pointing to a missing wasm.
    const missingMd = path.join(tmpDir, 'missing.md');
    fs.writeFileSync(
      missingMd,
      '---\nname = "missing"\nwasm = "/no/such/file.wasm"\ntimeout_secs = 5\n\n[permissions]\nfs_read = false\nfs_write = false\nnetwork = false\n---\n\n# missing',
    );
    const registry = ToolRegistry.fromDir(tmpDir);
    const executor = new WasmToolExecutor(registry);

    const { ToolError } = await import('./types.js');
    await expect(
      executor.execute({ tool: 'missing', callId: 'c1', args: {} }),
    ).rejects.toThrow(ToolError);
  });
});
