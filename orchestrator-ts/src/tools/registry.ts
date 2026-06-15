import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ArgDef, Permissions, ToolDefinition } from './types.js';

/** Extracts the TOML frontmatter block from a tool.md file. */
function extractFrontmatter(source: string, filePath: string): string {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`No TOML frontmatter in ${filePath}`);
  return match[1];
}

function parseArgs(raw: unknown): ArgDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const arg = a as Record<string, unknown>;
    return {
      name: String(arg['name'] ?? ''),
      type: (['string', 'integer', 'boolean'].includes(String(arg['type']))
        ? arg['type']
        : 'string') as ArgDef['type'],
      required: Boolean(arg['required'] ?? false),
      description: arg['description'] != null ? String(arg['description']) : undefined,
      default: arg['default'],
    };
  });
}

function parsePermissions(raw: unknown): Permissions {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    fsRead: Boolean(p['fs_read'] ?? false),
    fsWrite: Boolean(p['fs_write'] ?? false),
    network: Boolean(p['network'] ?? false),
  };
}

function parseDefinition(tomlSource: string, mdPath: string, toolsDir: string): ToolDefinition {
  const raw = parseToml(tomlSource) as Record<string, unknown>;
  const wasmRelative = String(raw['wasm'] ?? '');
  const wasmPath = path.isAbsolute(wasmRelative)
    ? wasmRelative
    : path.resolve(toolsDir, wasmRelative);
  return {
    name: String(raw['name'] ?? path.basename(mdPath, '.md')),
    version: String(raw['version'] ?? '1.0.0'),
    description: String(raw['description'] ?? ''),
    wasmPath,
    timeoutSecs: Number(raw['timeout_secs'] ?? 10),
    permissions: parsePermissions(raw['permissions']),
    args: parseArgs(raw['args']),
  };
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  private constructor() {}

  /**
   * Scans `toolsDir` for `*.md` files, parses only the TOML frontmatter of
   * each, and builds an in-memory registry. No `.wasm` files are loaded yet.
   */
  static fromDir(toolsDir: string): ToolRegistry {
    const registry = new ToolRegistry();
    if (!fs.existsSync(toolsDir)) return registry;

    for (const entry of fs.readdirSync(toolsDir)) {
      if (!entry.endsWith('.md')) continue;
      const mdPath = path.join(toolsDir, entry);
      try {
        const source = fs.readFileSync(mdPath, 'utf-8');
        const frontmatter = extractFrontmatter(source, mdPath);
        const def = parseDefinition(frontmatter, mdPath, toolsDir);
        registry.definitions.set(def.name, def);
      } catch (err) {
        // Skip files with invalid frontmatter; don't crash the whole registry.
        process.stderr.write(`[ToolRegistry] skipping ${mdPath}: ${err}\n`);
      }
    }

    return registry;
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  size(): number {
    return this.definitions.size;
  }
}
