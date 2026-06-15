import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-registry-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeToolMd(name: string, frontmatter: string): string {
  const content = `---\n${frontmatter}\n---\n\n# ${name}\n\nDescription body.`;
  const filePath = path.join(tmpDir, `${name}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const MINIMAL_FRONTMATTER = `
name = "echo"
wasm = "tools/echo.wasm"
description = "Echo args back."
timeout_secs = 5

[permissions]
fs_read = false
fs_write = false
network = false
`.trim();

const FULL_FRONTMATTER = `
name = "read_file"
version = "1.2.3"
wasm = "tools/read_file.wasm"
description = "Read a file."
timeout_secs = 10

[permissions]
fs_read = true
fs_write = false
network = false

[[args]]
name = "path"
type = "string"
required = true
description = "File path."

[[args]]
name = "max_bytes"
type = "integer"
required = false
default = 4096
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolRegistry.fromDir', () => {
  it('returns empty registry for non-existent directory', () => {
    const registry = ToolRegistry.fromDir('/no/such/dir');
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('returns empty registry for empty directory', () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.size()).toBe(0);
  });

  it('ignores non-.md files', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a tool');
    fs.writeFileSync(path.join(tmpDir, 'echo.wasm'), 'binary');
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.size()).toBe(0);
  });

  it('loads a minimal tool definition', () => {
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);

    expect(registry.size()).toBe(1);
    const def = registry.get('echo')!;
    expect(def.name).toBe('echo');
    expect(def.version).toBe('1.0.0'); // default
    expect(def.timeoutSecs).toBe(5);
    expect(def.permissions).toEqual({ fsRead: false, fsWrite: false, network: false });
    expect(def.args).toEqual([]);
  });

  it('loads a full tool definition with args', () => {
    writeToolMd('read_file', FULL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);

    const def = registry.get('read_file')!;
    expect(def.name).toBe('read_file');
    expect(def.version).toBe('1.2.3');
    expect(def.description).toBe('Read a file.');
    expect(def.timeoutSecs).toBe(10);
    expect(def.permissions).toEqual({ fsRead: true, fsWrite: false, network: false });
    expect(def.args).toHaveLength(2);
    expect(def.args[0]).toEqual({
      name: 'path',
      type: 'string',
      required: true,
      description: 'File path.',
      default: undefined,
    });
    expect(def.args[1]).toMatchObject({ name: 'max_bytes', type: 'integer', required: false });
  });

  it('resolves wasm path relative to the tools directory', () => {
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);
    const def = registry.get('echo')!;
    expect(path.isAbsolute(def.wasmPath)).toBe(true);
    expect(def.wasmPath).toContain('echo.wasm');
  });

  it('loads multiple tools from the same directory', () => {
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    writeToolMd('read_file', FULL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.size()).toBe(2);
    expect(registry.list().map((d) => d.name).sort()).toEqual(['echo', 'read_file']);
  });

  it('skips .md files with no frontmatter without crashing', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Just a README\n\nNo frontmatter.');
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.size()).toBe(1);
    expect(registry.get('echo')).toBeDefined();
  });

  it('skips .md files with invalid TOML without crashing', () => {
    const bad = path.join(tmpDir, 'bad.md');
    fs.writeFileSync(bad, '---\n[invalid toml\n---\n\nbody');
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.size()).toBe(1);
  });
});

describe('ToolRegistry.get', () => {
  it('returns undefined for unknown tool name', () => {
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.get('no-such-tool')).toBeUndefined();
  });

  it('returns the definition for a known tool', () => {
    writeToolMd('echo', MINIMAL_FRONTMATTER);
    const registry = ToolRegistry.fromDir(tmpDir);
    expect(registry.get('echo')).toBeDefined();
    expect(registry.get('echo')?.name).toBe('echo');
  });
});
